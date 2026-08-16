// Full PenCarrie catalog import - genuine new-item + cost-price import, not
// just the colour/size backfill import-colours-sizes.js does. Source is
// PenCarrie's own trade-pricing export (one row per real SKU: style code +
// colourway + size, with Single/Pack/Carton List Price tiers and a VAT Rate)
// - a completely different, richer file than the Shopify-style product
// export used for colour/size only. Carton List Price is used as cost_price
// (confirmed against a real invoice: PenCarrie account pays the Carton tier).
//
// The pre-existing catalog modelled PenCarrie products coarsely - one row
// per SIZE TIER (e.g. "S - XXL", "3XL", "4XL - 5XL") with most colours
// collapsed into a single generic "Colours" bucket row and only a colour
// with genuinely different pricing (e.g. Arctic White) broken out on its
// own. This import switches to one row per EXACT colour + exact size,
// matching what PenCarrie actually charges (confirmed: Deep Black and
// Arctic White have different Carton List Prices) and the same approach
// already used for Uneek.
//
// New rows always get a generated id ("pencarrie-<code>-<colour>-<size>"),
// distinguishing them from the old coarse rows (whose id scheme predates
// this app and is unknown). sell_price is carried forward from whichever
// old row's size-tier contains the new row's exact size, matching colour
// name first and falling back to the generic "Colours" bucket - so existing
// customer-facing pricing isn't lost in the switch, just split more
// accurately. Upserts by matching (supplier_code, colour, size) against
// already-imported new-format rows, so re-running this (e.g. resumed after
// an interruption) is safe and won't create duplicates.
//
// Two-phase: each call imports one chunk of rows (dryRun by default). Once
// every chunk for a run has been imported for real, a separate
// { finalize: true, codes: [...] } call soft-deletes the superseded old
// coarse rows for those codes (deleted_at, same universal-Trash pattern as
// everywhere else in this app - fully recoverable, never a hard delete).
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  function slugify(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  // Same ordering products.js's own sizeRank() uses, for expanding an old
  // tier string like "S - XXL" or "4XL - 5XL" into the individual sizes it
  // covers. "3XL" alone (no " - ") is just that one size.
  const LETTER_SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL", "6XL", "7XL", "8XL"];
  function expandSizeRange(raw) {
    const s = String(raw || "").trim().toUpperCase();
    if (!s) return [];
    if (s.includes(" - ")) {
      const [a, b] = s.split(" - ").map((x) => x.trim());
      const ai = LETTER_SIZE_ORDER.indexOf(a);
      const bi = LETTER_SIZE_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1 && ai <= bi) return LETTER_SIZE_ORDER.slice(ai, bi + 1);
      return [a, b].filter(Boolean);
    }
    return [s];
  }

  try {
    for (const col of ["image_url TEXT", "colour_code TEXT"]) {
      try { await db.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run(); } catch { /* already exists */ }
    }

    const body = await request.json().catch(() => ({}));

    // ------------------------------------------------- backfillOnWebsite --
    // One-off repair: the migration's carry-forward only carried sell_price,
    // not on_website, so every PenCarrie product already live on the site
    // lost that flag when its old (now-trashed) row was retired - the new
    // exact colour/size rows all defaulted to on_website=0. This restores
    // it: any code with an on_website=1 row sitting in Trash (the old
    // format, id NOT LIKE 'pencarrie-%') gets on_website=1 applied to all of
    // its live new-format rows.
    if (body.backfillOnWebsite) {
      const result = await db.prepare(`
        UPDATE products
        SET on_website = 1
        WHERE id LIKE 'pencarrie-%' AND deleted_at IS NULL
          AND UPPER(supplier_code) IN (
            SELECT UPPER(supplier_code) FROM products
            WHERE deleted_at IS NOT NULL AND on_website = 1 AND id NOT LIKE 'pencarrie-%'
          )
      `).run();
      return json({ success: true, backfillOnWebsite: true, rows_updated: result.meta ? result.meta.changes : 0 });
    }

    // -------------------------------------------------------- finalize --
    if (body.finalize) {
      const codes = Array.isArray(body.codes) ? [...new Set(body.codes.map((c) => String(c).trim().toUpperCase()).filter(Boolean))] : [];
      if (!codes.length) return json({ error: "finalize requires a non-empty codes array" }, 400);

      let retired = 0;
      const IN_CHUNK = 50;
      for (let i = 0; i < codes.length; i += IN_CHUNK) {
        const chunk = codes.slice(i, i + IN_CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const result = await db.prepare(
          `UPDATE products SET deleted_at = CURRENT_TIMESTAMP
           WHERE UPPER(supplier_code) IN (${placeholders}) AND id NOT LIKE 'pencarrie-%'
             AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL`
        ).bind(...chunk).run();
        retired += result.meta ? result.meta.changes : 0;
      }
      return json({ success: true, finalize: true, codes: codes.length, retired_old_rows: retired });
    }

    // ---------------------------------------------------------- import --
    const dryRun = body.dryRun !== false;
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return json({ error: "No rows in payload" }, 400);

    const codes = [...new Set(rows.map((r) => String(r.code || "").trim().toUpperCase()).filter(Boolean))];

    // Real colourway names PenCarrie actually uses for each code, from this
    // chunk's own rows - lets the fallback-bucket check below be "is this
    // old row's colour NOT a real colourway for this code" instead of
    // guessing every placeholder label the original (unknown, pre-this-app)
    // import might have used. Confirmed in practice: AT001's bucket row is
    // literally "Colours", 001M's is "All Colours" - no single fixed string
    // covers both, but neither is ever a genuine PenCarrie colourway name.
    const newColoursByCode = new Map(); // code -> Set of uppercase colour names
    for (const r of rows) {
      const code = String(r.code || "").trim().toUpperCase();
      const colour = String(r.colour || "").trim().toUpperCase();
      if (!code || !colour) continue;
      if (!newColoursByCode.has(code)) newColoursByCode.set(code, new Set());
      newColoursByCode.get(code).add(colour);
    }

    // Old (pre-migration) coarse rows for these codes - used to carry
    // sell_price forward. New-format rows (id LIKE 'pencarrie-%') are
    // excluded here on purpose: they're not a pricing source, they're what
    // this same import already wrote on an earlier chunk/run.
    const oldRowsByCode = new Map(); // code -> [{ colour, size, sell_price }]
    // Already-imported new-format rows, for upsert-without-duplicating on
    // reruns.
    const existingNewMap = new Map(); // `${code}|${colour}|${size}` -> id

    const IN_CHUNK = 50;
    for (let i = 0; i < codes.length; i += IN_CHUNK) {
      const chunkCodes = codes.slice(i, i + IN_CHUNK);
      const placeholders = chunkCodes.map(() => "?").join(",");
      const { results } = await db.prepare(
        `SELECT id, supplier_code, colour, size, sell_price FROM products
         WHERE UPPER(supplier_code) IN (${placeholders}) AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL`
      ).bind(...chunkCodes).all();

      for (const r of results) {
        const code = r.supplier_code.toUpperCase();
        if (r.id.startsWith("pencarrie-")) {
          existingNewMap.set(`${code}|${r.colour}|${r.size}`, r.id);
        } else {
          if (!oldRowsByCode.has(code)) oldRowsByCode.set(code, []);
          oldRowsByCode.get(code).push({ colour: r.colour, size: r.size, sell_price: r.sell_price });
        }
      }
    }

    const stmt = db.prepare(`
      INSERT INTO products (
        id, supplier, supplier_code, supplier_ref, brand, title, colour, size,
        category, cost_price, surcharge_category, vat_rate, sell_price, profit, active,
        image_url, colour_code, updated_at
      ) VALUES (?, 'PenCarrie', ?, '', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        supplier = 'PenCarrie',
        supplier_code = excluded.supplier_code,
        brand = excluded.brand,
        title = excluded.title,
        colour = excluded.colour,
        size = excluded.size,
        category = excluded.category,
        cost_price = excluded.cost_price,
        vat_rate = excluded.vat_rate,
        active = excluded.active,
        image_url = excluded.image_url,
        colour_code = excluded.colour_code,
        sell_price = CASE WHEN products.sell_price IS NULL THEN excluded.sell_price ELSE products.sell_price END,
        profit = CASE
          WHEN products.sell_price IS NOT NULL THEN ROUND(products.sell_price - excluded.cost_price, 2)
          WHEN excluded.sell_price IS NOT NULL THEN ROUND(excluded.sell_price - excluded.cost_price, 2)
          ELSE NULL
        END,
        updated_at = CURRENT_TIMESTAMP
    `);

    const profitOf = (sell, cost, vatRate = 0.2) => {
      if (sell === null || sell === undefined) return null;
      const totalCost = Number(cost || 0) * (1 + (Number(vatRate) || 0));
      return Math.round((Number(sell) - totalCost + Number.EPSILON) * 100) / 100;
    };

    const batch = [];
    let newItems = 0;
    let updatedItems = 0;
    let unchangedItems = 0;
    let carriedPrices = 0;
    const priceChanges = [];

    for (const r of rows) {
      const code = String(r.code || "").trim().toUpperCase();
      const colour = String(r.colour || "").trim();
      const size = String(r.size || "").trim();
      if (!code) continue;
      const cost = Number(r.cost_price);
      if (!isFinite(cost)) continue;

      const key = `${code}|${colour}|${size}`;
      const existingId = existingNewMap.get(key);

      // Carry sell_price forward from whichever old row's size range covers
      // this exact size - exact colour name match preferred, falling back
      // to an old row whose colour ISN'T a real colourway PenCarrie uses for
      // this code (i.e. it's some kind of placeholder/bucket label,
      // whatever the original import happened to call it).
      let carriedSellPrice = null;
      const oldRows = oldRowsByCode.get(code) || [];
      const realColoursForCode = newColoursByCode.get(code);
      const sizeUpper = size.toUpperCase();
      let bestMatch = null;
      for (const old of oldRows) {
        const oldSizeUpper = String(old.size || "").trim().toUpperCase();
        const sizeMatches = oldSizeUpper === "ALL" || expandSizeRange(old.size).includes(sizeUpper);
        if (!sizeMatches) continue;
        const oldColourUpper = String(old.colour || "").trim().toUpperCase();
        if (oldColourUpper === colour.toUpperCase()) { bestMatch = old; break; } // exact colour wins outright
        if (!bestMatch && realColoursForCode && !realColoursForCode.has(oldColourUpper)) bestMatch = old; // not a real colourway -> it's a bucket row
      }
      if (bestMatch && bestMatch.sell_price !== null && bestMatch.sell_price !== undefined) {
        carriedSellPrice = Number(bestMatch.sell_price);
        carriedPrices++;
      }

      let id;
      if (existingId) {
        id = existingId;
        updatedItems++; // treat as "processed" - actual price-changed vs unchanged isn't tracked post-migration, only during the initial run
      } else {
        id = "pencarrie-" + slugify(code) + "-" + slugify(colour) + "-" + slugify(size);
        newItems++;
        if (bestMatch) priceChanges.push({ code, colour, size, cost, carried_sell_price: carriedSellPrice });
      }

      const vatRate = r.vat_rate === undefined || r.vat_rate === null || r.vat_rate === "" ? 0.2 : Number(r.vat_rate);

      if (!dryRun) {
        batch.push(stmt.bind(
          id, code, r.brand || "", r.title || "", colour, size,
          r.category || "", cost, vatRate, carriedSellPrice, profitOf(carriedSellPrice, cost, vatRate),
          r.image_url || "", r.colour_code || ""
        ));
      }
    }

    if (!dryRun) {
      const CHUNK_SIZE = 50;
      for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
        await db.batch(batch.slice(i, i + CHUNK_SIZE));
      }
    }

    return json({
      success: true,
      dryRun,
      processed: rows.length,
      new_items: newItems,
      updated_items: updatedItems,
      unchanged_items: unchangedItems,
      carried_prices: carriedPrices,
      codes: codes,
      sample_price_changes: priceChanges.slice(0, 10),
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
