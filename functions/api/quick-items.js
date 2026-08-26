// Crystal Quick's OWN garment catalog - entirely separate from the real
// Garments catalog (functions/api/products.js). Martin wants categories and
// garments he defines just for the app, with their own colours/sizes, not
// derived from (or writing back into) the 6000+ row supplier catalog at
// all - a genuinely independent system, not a view onto the same data.
//
// Two tables: quick_categories (name, order, hidden) and quick_items
// (belongs to a category; title, colours[], sizes[], one sell price, order,
// hidden). A garment here has ONE price regardless of which colour/size is
// picked - if variant-specific pricing is ever needed this is the file to
// extend, not products.js.
export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });

  try {
    await db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS quick_categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sort_order INTEGER DEFAULT 0,
          hidden INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS quick_items (
          id TEXT PRIMARY KEY,
          category_id TEXT NOT NULL,
          title TEXT NOT NULL,
          colours TEXT DEFAULT '[]',
          sizes TEXT DEFAULT '[]',
          sell_price REAL DEFAULT 0,
          sort_order INTEGER DEFAULT 0,
          hidden INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `),
    ]);

    if (request.method === "GET") {
      const p = new URL(request.url).searchParams;
      const categoryId = (p.get("category_id") || "").trim();

      if (categoryId) {
        const { results } = await db.prepare(
          "SELECT * FROM quick_items WHERE category_id = ? ORDER BY sort_order, title"
        ).bind(categoryId).all();
        return json({ items: results.map(parseItem) });
      }

      // Default: everything at once - both lists are expected to stay
      // small (hand-curated, not a supplier import), so there's no
      // pagination/filtering machinery like products.js needs.
      const [categories, items] = await db.batch([
        db.prepare("SELECT * FROM quick_categories ORDER BY sort_order, name"),
        db.prepare("SELECT * FROM quick_items ORDER BY sort_order, title"),
      ]);
      return json({
        categories: categories.results,
        items: items.results.map(parseItem),
      });
    }

    if (request.method === "POST") {
      const data = await request.json();

      if (data.resource === "category") {
        const id = crypto.randomUUID();
        const name = (data.name || "").trim();
        if (!name) return json({ error: "name is required" }, 400);
        const maxRow = await db.prepare("SELECT MAX(sort_order) AS m FROM quick_categories").first();
        const sortOrder = (maxRow && maxRow.m !== null ? maxRow.m : -1) + 1;
        await db.prepare(
          "INSERT INTO quick_categories (id, name, sort_order) VALUES (?, ?, ?)"
        ).bind(id, name, sortOrder).run();
        return json({ success: true, id });
      }

      if (data.resource === "item") {
        const id = crypto.randomUUID();
        const title = (data.title || "").trim();
        if (!title) return json({ error: "title is required" }, 400);
        if (!data.category_id) return json({ error: "category_id is required" }, 400);
        const maxRow = await db.prepare(
          "SELECT MAX(sort_order) AS m FROM quick_items WHERE category_id = ?"
        ).bind(data.category_id).first();
        const sortOrder = (maxRow && maxRow.m !== null ? maxRow.m : -1) + 1;
        await db.prepare(`
          INSERT INTO quick_items (id, category_id, title, colours, sizes, sell_price, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id, data.category_id, title,
          JSON.stringify(Array.isArray(data.colours) ? data.colours : []),
          JSON.stringify(Array.isArray(data.sizes) ? data.sizes : []),
          Number(data.sell_price) || 0,
          sortOrder
        ).run();
        return json({ success: true, id });
      }

      return json({ error: "resource must be 'category' or 'item'" }, 400);
    }

    if (request.method === "PUT") {
      const data = await request.json();

      if (data.resource === "category") {
        const existing = await db.prepare("SELECT * FROM quick_categories WHERE id = ?").bind(data.id).first();
        if (!existing) return json({ error: "Category not found" }, 404);
        await db.prepare(`
          UPDATE quick_categories SET name = ?, sort_order = ?, hidden = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).bind(
          data.name !== undefined ? data.name.trim() : existing.name,
          data.sort_order !== undefined ? data.sort_order : existing.sort_order,
          data.hidden !== undefined ? (data.hidden ? 1 : 0) : existing.hidden,
          data.id
        ).run();
        return json({ success: true });
      }

      if (data.resource === "item") {
        const existing = await db.prepare("SELECT * FROM quick_items WHERE id = ?").bind(data.id).first();
        if (!existing) return json({ error: "Item not found" }, 404);
        await db.prepare(`
          UPDATE quick_items SET title = ?, colours = ?, sizes = ?, sell_price = ?, sort_order = ?, hidden = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          data.title !== undefined ? data.title.trim() : existing.title,
          data.colours !== undefined ? JSON.stringify(data.colours) : existing.colours,
          data.sizes !== undefined ? JSON.stringify(data.sizes) : existing.sizes,
          data.sell_price !== undefined ? Number(data.sell_price) || 0 : existing.sell_price,
          data.sort_order !== undefined ? data.sort_order : existing.sort_order,
          data.hidden !== undefined ? (data.hidden ? 1 : 0) : existing.hidden,
          data.id
        ).run();
        return json({ success: true });
      }

      return json({ error: "resource must be 'category' or 'item'" }, 400);
    }

    if (request.method === "DELETE") {
      const data = await request.json();

      if (data.resource === "category") {
        // Cascades - a category with no items left in it is meaningless
        // here (unlike the real catalog, there's no "uncategorised" bucket
        // for these to fall back into), so deleting the category deletes
        // its items too. Confirmed client-side before this is ever called.
        await db.batch([
          db.prepare("DELETE FROM quick_items WHERE category_id = ?").bind(data.id),
          db.prepare("DELETE FROM quick_categories WHERE id = ?").bind(data.id),
        ]);
        return json({ success: true });
      }

      if (data.resource === "item") {
        await db.prepare("DELETE FROM quick_items WHERE id = ?").bind(data.id).run();
        return json({ success: true });
      }

      return json({ error: "resource must be 'category' or 'item'" }, 400);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function parseItem(row) {
  let colours = [];
  let sizes = [];
  try { colours = JSON.parse(row.colours || "[]"); } catch {}
  try { sizes = JSON.parse(row.sizes || "[]"); } catch {}
  return { ...row, colours, sizes };
}
