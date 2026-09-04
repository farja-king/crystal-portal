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
    for (const col of ["image_url TEXT", "colour_code TEXT", "variant_data TEXT DEFAULT '[]'"]) {
      try { await db.prepare(`ALTER TABLE products ADD COLUMN ${col}`).run(); } catch { /* already exists */ }
    }
    // Guarded here too (not just in products.js) so this file works even if
    // it's ever the first endpoint hit against a fresh DB - same defensive
    // duplication already used for customers.review_requested in
    // review-requests.js.
    await db.prepare(`CREATE TABLE IF NOT EXISTS product_variant_index (variant_id TEXT PRIMARY KEY, product_id TEXT NOT NULL)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_variant_index_product ON product_variant_index (product_id)`).run();

    const body = await request.json().catch(() => ({}));

    // --------------------------------------------- repairMigrationFields --
    // Follow-up audit after the on_website bug: the migration's INSERT
    // hardcodes supplier_ref='' and active=1 on every new row, never reading
    // them from the old row it's superseding - same class of bug as
    // on_website, just for fields that (unlike on_website) vary rarely
    // enough that a spot-check hadn't caught them yet. Confirmed via a
    // sample of Trash: ~18% of old rows have a real supplier_ref (e.g.
    // "TFC100") that every new row for that code was silently dropping.
    // These are code-level attributes (same for every colour/size of a
    // code), so one old row's value is applied to all of that code's new
    // rows - order among multiple old rows for the same code doesn't matter
    // here since they'd already agree.
    if (body.repairMigrationFields) {
      const refResult = await db.prepare(`
        UPDATE products
        SET supplier_ref = (
          SELECT p2.supplier_ref FROM products p2
          WHERE p2.deleted_at IS NOT NULL AND p2.id NOT LIKE 'pencarrie-%'
            AND UPPER(p2.supplier_code) = UPPER(products.supplier_code)
            AND p2.supplier_ref IS NOT NULL AND p2.supplier_ref <> ''
          LIMIT 1
        )
        WHERE id LIKE 'pencarrie-%' AND deleted_at IS NULL
          AND (supplier_ref IS NULL OR supplier_ref = '')
          AND UPPER(supplier_code) IN (
            SELECT UPPER(supplier_code) FROM products
            WHERE deleted_at IS NOT NULL AND id NOT LIKE 'pencarrie-%' AND supplier_ref IS NOT NULL AND supplier_ref <> ''
          )
      `).run();

      const inactiveResult = await db.prepare(`
        UPDATE products
        SET active = 0
        WHERE id LIKE 'pencarrie-%' AND deleted_at IS NULL AND active = 1
          AND UPPER(supplier_code) IN (
            SELECT UPPER(supplier_code) FROM products
            WHERE deleted_at IS NOT NULL AND id NOT LIKE 'pencarrie-%' AND active = 0
          )
      `).run();

      const surchargeResult = await db.prepare(`
        UPDATE products
        SET surcharge_category = (
          SELECT p2.surcharge_category FROM products p2
          WHERE p2.deleted_at IS NOT NULL AND p2.id NOT LIKE 'pencarrie-%'
            AND UPPER(p2.supplier_code) = UPPER(products.supplier_code)
            AND p2.surcharge_category IS NOT NULL AND p2.surcharge_category <> ''
          LIMIT 1
        )
        WHERE id LIKE 'pencarrie-%' AND deleted_at IS NULL
          AND (surcharge_category IS NULL OR surcharge_category = '')
          AND UPPER(supplier_code) IN (
            SELECT UPPER(supplier_code) FROM products
            WHERE deleted_at IS NOT NULL AND id NOT LIKE 'pencarrie-%' AND surcharge_category IS NOT NULL AND surcharge_category <> ''
          )
      `).run();

      return json({
        success: true,
        repairMigrationFields: true,
        supplier_ref_rows_updated: refResult.meta ? refResult.meta.changes : 0,
        deactivated_rows: inactiveResult.meta ? inactiveResult.meta.changes : 0,
        surcharge_category_rows_updated: surchargeResult.meta ? surchargeResult.meta.changes : 0,
      });
    }

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
    // Already-imported new-format tiers, for upsert-without-duplicating on
    // reruns. Since the catalog consolidation, a "pencarrie-" row may hold
    // several tiers in its variant_data rather than being one physical row
    // per colour+size, so this is built by expanding that row's tiers, not
    // read straight off SQL columns.
    const existingNewMap = new Map(); // `${code}|${colour}|${size}` -> { id, sellPrice }
    const productIdByCode = new Map(); // code -> id of the code's active consolidated row (if any)

    // Same fallback used by products.js: a row with no variant_data yet is
    // treated as its own single tier, built from its own colour/size/
    // sell_price columns - this is what makes it safe for this file to run
    // against a row products.js hasn't touched yet.
    function parseTiers(row) {
      let tiers = null;
      try { tiers = JSON.parse(row.variant_data || "[]"); } catch { tiers = null; }
      if (!Array.isArray(tiers) || !tiers.length) {
        return [{ id: row.id, colour: row.colour || "", size: row.size || "", sell_price: row.sell_price ?? null }];
      }
      return tiers;
    }

    const IN_CHUNK = 50;
    for (let i = 0; i < codes.length; i += IN_CHUNK) {
      const chunkCodes = codes.slice(i, i + IN_CHUNK);
      const placeholders = chunkCodes.map(() => "?").join(",");
      const { results } = await db.prepare(
        `SELECT * FROM products
         WHERE UPPER(supplier_code) IN (${placeholders}) AND (customer_id IS NULL OR customer_id = '') AND deleted_at IS NULL`
      ).bind(...chunkCodes).all();

      for (const r of results) {
        const code = r.supplier_code.toUpperCase();
        if (r.id.startsWith("pencarrie-")) {
          productIdByCode.set(code, r.id);
          for (const t of parseTiers(r)) {
            existingNewMap.set(`${code}|${t.colour}|${t.size}`, { id: t.id, sellPrice: t.sell_price ?? null });
          }
        } else {
          if (!oldRowsByCode.has(code)) oldRowsByCode.set(code, []);
          for (const t of parseTiers(r)) oldRowsByCode.get(code).push({ colour: t.colour, size: t.size, sell_price: t.sell_price });
        }
      }
    }

    const profitOf = (sell, cost, vatRate = 0.2) => {
      if (sell === null || sell === undefined) return null;
      const totalCost = Number(cost || 0) * (1 + (Number(vatRate) || 0));
      return Math.round((Number(sell) - totalCost + Number.EPSILON) * 100) / 100;
    };

    // Consolidated write path (see products.js's own file header for the
    // full story): a code's rows all live inside ONE physical row's
    // variant_data now, instead of one physical row per exact colour+size -
    // this is what stops the catalog bloating straight back up on the next
    // full PenCarrie re-import. Tiers within a code are still matched/
    // upserted by the same "pencarrie-<code>-<colour>-<size>" id scheme as
    // before, just written into JSON instead of their own row.
    const tiersByCode = new Map(); // code -> [{ id, colour, size, cost_price, sell_price, vat_rate, colour_code, image_url, brand, title, category }]
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
      const existing = existingNewMap.get(key);

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

      let id, sellPrice;
      if (existing) {
        id = existing.id;
        updatedItems++; // treat as "processed" - actual price-changed vs unchanged isn't tracked post-migration, only during the initial run
        // Never overwrite a price already sitting on this tier (same rule
        // products.js's own upsertTier uses) - only fall back to the
        // migration's carried-forward price if this tier has never had one.
        sellPrice = existing.sellPrice !== null && existing.sellPrice !== undefined ? existing.sellPrice : carriedSellPrice;
      } else {
        id = "pencarrie-" + slugify(code) + "-" + slugify(colour) + "-" + slugify(size);
        newItems++;
        sellPrice = carriedSellPrice;
        if (bestMatch) priceChanges.push({ code, colour, size, cost, carried_sell_price: carriedSellPrice });
      }

      const vatRate = r.vat_rate === undefined || r.vat_rate === null || r.vat_rate === "" ? 0.2 : Number(r.vat_rate);

      if (!dryRun) {
        if (!tiersByCode.has(code)) tiersByCode.set(code, []);
        tiersByCode.get(code).push({
          id, colour, size, cost_price: cost, sell_price: sellPrice, vat_rate: vatRate,
          colour_code: r.colour_code || "", image_url: r.image_url || "",
          brand: r.brand || "", title: r.title || "", category: r.category || "",
        });
      }
    }

    if (!dryRun) {
      // Merges each code's tiers (from this chunk) into its consolidated
      // row - creating that row on its first tier, updating variant_data on
      // every subsequent one. A tier not present in this chunk's rows (e.g.
      // a colour missing from this particular page of the source file) is
      // left untouched, since the merge is keyed by tier id against
      // whatever's already in variant_data, not a full replace.
      const pending = [];
      for (const [code, newTiers] of tiersByCode) {
        const existingProductId = productIdByCode.get(code);
        let mergedTiers, targetRowId;
        if (existingProductId) {
          const row = await db.prepare("SELECT * FROM products WHERE id = ?").bind(existingProductId).first();
          const currentTiers = parseTiers(row);
          const byId = new Map(currentTiers.map((t) => [t.id, t]));
          for (const nt of newTiers) byId.set(nt.id, nt);
          mergedTiers = [...byId.values()];
          targetRowId = existingProductId;
        } else {
          mergedTiers = newTiers;
          targetRowId = newTiers[0].id;
        }

        const defaultTier = mergedTiers[0];
        const rowMeta = newTiers[0]; // supplier/brand/title/category are code-level, same for every tier in this chunk
        if (existingProductId) {
          pending.push(db.prepare(`
            UPDATE products SET supplier = 'PenCarrie', brand = ?, title = ?, category = ?, variant_data = ?,
              colour = ?, size = ?, cost_price = ?, vat_rate = ?, sell_price = ?, profit = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            rowMeta.brand, rowMeta.title, rowMeta.category, JSON.stringify(mergedTiers),
            defaultTier.colour, defaultTier.size, defaultTier.cost_price, defaultTier.vat_rate, defaultTier.sell_price,
            profitOf(defaultTier.sell_price, defaultTier.cost_price, defaultTier.vat_rate), targetRowId
          ));
        } else {
          pending.push(db.prepare(`
            INSERT INTO products (
              id, supplier, supplier_code, supplier_ref, brand, title, colour, size,
              category, cost_price, surcharge_category, vat_rate, sell_price, profit, active, variant_data, updated_at
            ) VALUES (?, 'PenCarrie', ?, '', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
          `).bind(
            targetRowId, code, rowMeta.brand, rowMeta.title, defaultTier.colour, defaultTier.size,
            rowMeta.category, defaultTier.cost_price, defaultTier.vat_rate, defaultTier.sell_price,
            profitOf(defaultTier.sell_price, defaultTier.cost_price, defaultTier.vat_rate), JSON.stringify(mergedTiers)
          ));
        }
        for (const nt of newTiers) {
          pending.push(db.prepare(
            `INSERT INTO product_variant_index (variant_id, product_id) VALUES (?, ?) ON CONFLICT(variant_id) DO UPDATE SET product_id = excluded.product_id`
          ).bind(nt.id, targetRowId));
        }
      }
      const CHUNK_SIZE = 50;
      for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
        await db.batch(pending.slice(i, i + CHUNK_SIZE));
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
