// A minimal, dependency-free ZIP writer with traditional PKZIP ("ZipCrypto")
// password encryption - built by hand rather than pulling in a library
// because nothing in Cloudflare Workers' runtime reliably does AES-encrypted
// ZIP creation, and this codebase deliberately has zero npm dependencies
// anywhere. Entries are stored uncompressed (method 0) rather than
// DEFLATE-compressed - correctness matters far more than file size for a
// backup, and a hand-written DEFLATE encoder is a second, much larger place
// to get subtly wrong.
//
// ZipCrypto is NOT strong encryption (it's crackable with widely available
// tools) - this exists purely as a second, casual-access layer on top of
// Google Drive's own account-level access control, matching what was
// explicitly asked for.
//
// Two ways to use this:
//   - buildEncryptedZip(entries, password): everything in memory at once,
//     for small archives. Simple, and what this file was originally
//     verified against (see the commit history / 7-Zip round-trip test).
//   - The individual pieces below (encryptEntryData, buildLocalFileHeader,
//     buildCentralDirectoryRecord, buildEndOfCentralDirectory) for
//     functions/api/drive-backup-export.js's streaming path, which writes
//     one entry at a time straight into a chunked upload rather than
//     holding the whole backup in memory - see that file for why.
//
// Format reference: PKWARE's APPNOTE.TXT, sections 4.3 (ZIP structure) and
// 6.1 (traditional encryption).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// The classic 3-key PKZIP stream cipher. Keys are re-derived from the
// password for every entry (matches how real zip tools do it) rather than
// reused across entries.
function makeZipCryptoKeystream(password) {
  let key0 = 0x12345678,
    key1 = 0x23456789,
    key2 = 0x34567890;

  function crcByte(crc, b) {
    return (CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  function updateKeys(b) {
    key0 = crcByte(key0, b);
    key1 = (Math.imul((key1 + (key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    key2 = crcByte(key2, key1 >>> 24);
  }
  for (let i = 0; i < password.length; i++) updateKeys(password.charCodeAt(i) & 0xff);

  return function encryptByte(plainByte) {
    const temp = (key2 | 2) >>> 0;
    const keystreamByte = (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
    const cipherByte = (plainByte ^ keystreamByte) & 0xff;
    updateKeys(plainByte); // keys advance using the PLAINTEXT byte, per spec
    return cipherByte;
  };
}

// The 12-byte encryption header prepended to each entry's data: 11 random
// bytes plus one verification byte (the high byte of the entry's CRC-32) -
// lets a zip tool confirm the password is right before decrypting the whole
// entry. The header itself is encrypted the same way as the file data.
export function encryptEntryData(password, plainBytes, crc) {
  const encryptByte = makeZipCryptoKeystream(password);
  const header = new Uint8Array(12);
  crypto.getRandomValues(header);
  header[11] = (crc >>> 24) & 0xff;

  const out = new Uint8Array(12 + plainBytes.length);
  for (let i = 0; i < 12; i++) out[i] = encryptByte(header[i]);
  for (let i = 0; i < plainBytes.length; i++) out[12 + i] = encryptByte(plainBytes[i]);
  return out;
}

export function dosDateTime(date) {
  const dosTime = ((date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1)) & 0xffff;
  const dosDate = ((Math.max(0, date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()) & 0xffff;
  return { dosTime, dosDate };
}

function u16(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}
function u32(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

export function concatAll(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// entry: { name, crc, compressedSize, uncompressedSize, dosTime, dosDate }
export function buildLocalFileHeader(entry) {
  const nameBytes = new TextEncoder().encode(entry.name);
  return concatAll([
    u32(0x04034b50),
    u16(20), // version needed
    u16(0x0001), // general purpose flag: bit 0 = encrypted
    u16(0), // method: stored
    u16(entry.dosTime),
    u16(entry.dosDate),
    u32(entry.crc),
    u32(entry.compressedSize),
    u32(entry.uncompressedSize),
    u16(nameBytes.length),
    u16(0), // extra field length
    nameBytes,
  ]);
}

// entry: same shape as buildLocalFileHeader's, plus `offset` (byte position
// of that entry's local header within the final file).
export function buildCentralDirectoryRecord(entry) {
  const nameBytes = new TextEncoder().encode(entry.name);
  return concatAll([
    u32(0x02014b50),
    u16(20), // version made by
    u16(20), // version needed
    u16(0x0001),
    u16(0),
    u16(entry.dosTime),
    u16(entry.dosDate),
    u32(entry.crc),
    u32(entry.compressedSize),
    u32(entry.uncompressedSize),
    u16(nameBytes.length),
    u16(0), // extra field length
    u16(0), // comment length
    u16(0), // disk number start
    u16(0), // internal attributes
    u32(0), // external attributes
    u32(entry.offset),
    nameBytes,
  ]);
}

export function buildEndOfCentralDirectory({ entryCount, centralDirectorySize, centralDirectoryOffset }) {
  return concatAll([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // disk with central directory start
    u16(entryCount),
    u16(entryCount),
    u32(centralDirectorySize),
    u32(centralDirectoryOffset),
    u16(0), // comment length
  ]);
}

/**
 * Builds a password-protected ZIP file from a list of entries, all in
 * memory at once. Fine for small archives; see this file's header comment
 * for the streaming alternative used for anything backup-sized.
 * @param {{ name: string, data: Uint8Array }[]} entries
 * @param {string} password
 * @returns {Uint8Array} the complete .zip file
 */
export function buildEncryptedZip(entries, password) {
  const { dosTime, dosDate } = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const crc = crc32(entry.data);
    const encrypted = encryptEntryData(password, entry.data, crc);
    const meta = {
      name: entry.name,
      crc,
      compressedSize: encrypted.length,
      uncompressedSize: entry.data.length,
      dosTime,
      dosDate,
      offset,
    };
    const localHeader = buildLocalFileHeader(meta);
    localParts.push(localHeader, encrypted);
    centralParts.push(buildCentralDirectoryRecord(meta));
    offset += localHeader.length + encrypted.length;
  }

  const centralDirectory = concatAll(centralParts);
  const endRecord = buildEndOfCentralDirectory({
    entryCount: entries.length,
    centralDirectorySize: centralDirectory.length,
    centralDirectoryOffset: offset,
  });

  return concatAll([...localParts, centralDirectory, endRecord]);
}
