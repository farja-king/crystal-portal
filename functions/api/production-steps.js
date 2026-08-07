// Visual per-order production tracker - a customer's payment/quote status
// (tracked in orders.js) is a different thing from where the physical job
// actually is on the shop floor. Each order gets its own ordered list of
// steps (seeded with a sensible default the first time it's opened, then
// freely editable - add/rename/reorder/delete), each with optional notes
// and photos.
import { emailShell, googleMapsDirectionsUrl } from "../_lib/email-template.js";

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const bucket = env.DESIGN_FILES;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // notify: true for the two milestones a customer actually cares about
  // hearing from us about - the middle three are useful for Martin to track
  // but not the kind of thing worth an email each time. Fully editable
  // afterward, same as everything else about these steps.
  const DEFAULT_STEPS = [
    { title: "Artwork approved", notify: true },
    { title: "Garments ordered", notify: false },
    { title: "In production", notify: false },
    { title: "Quality check", notify: false },
    { title: "Ready for collection/dispatch", notify: true },
    // Not notify-enabled itself - the customer-facing "hope you enjoyed it,
    // please leave a review" follow-up is a separate, schedulable flow (the
    // "Confirmed Pickup?" checkbox on the main list - see
    // functions/api/review-requests.js), not this step's own tick.
    { title: "Order collected", notify: false },
  ];

  if (!bucket) {
    return json({ error: "File storage isn't set up yet - the DESIGN_FILES R2 bucket binding is missing from this Pages project." }, 500);
  }

  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Emailed the moment a step flagged notify_customer is first marked done
  // (see the PUT handler below) - same Resend setup and email_log table as
  // design-proofs.js/payment-reminders.js, so this shows up for free in the
  // order's existing Communication History panel.
  async function sendStepNotification(orderId, stepTitle) {
    if (!env.RESEND_API_KEY) return { sent: false, reason: "Email isn't set up yet - the RESEND_API_KEY secret is missing." };
    const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
    if (!order) return { sent: false, reason: "Order not found" };
    const to = (order.customer_email || "").trim();
    if (!to) return { sent: false, reason: "No email address on file for this customer" };

    const fromAddress = env.RESEND_FROM_EMAIL || "Crystal Custom Embroidery <onboarding@resend.dev>";
    const replyToAddress = env.RESEND_REPLY_TO || "hello@embroidery.click";
    const docNumber = order.doc_type === "invoice" ? order.invoice_number : order.quote_number;
    const name = escapeHtml(order.customer_name);
    const lowerTitle = stepTitle.toLowerCase();

    // Genuinely different wording per milestone rather than one generic
    // "reached the next stage" line for everything - a step whose title
    // wasn't anticipated (a custom one Martin typed in) still gets a
    // sensible fallback.
    let subject, heading, bodyHtml, ctaText, ctaUrl;
    if (/collection|dispatch|ready/.test(lowerTitle)) {
      subject = `Your order's ready! - ${docNumber}`;
      heading = "Your collection's ready! 🎉";
      bodyHtml = `<p>Hi ${name},</p>
        <p>Great news - order <strong>${escapeHtml(docNumber)}</strong> is finished and ready for you to collect whenever suits.</p>
        <p>We're at <strong>26 Grove Street, Raunds, NN9 6DS</strong> - tap below for directions if you need them.</p>`;
      ctaText = "Get Directions";
      ctaUrl = googleMapsDirectionsUrl();
    } else if (/artwork/.test(lowerTitle)) {
      subject = `Artwork approved - ${docNumber}`;
      heading = "Your artwork's approved ✓";
      bodyHtml = `<p>Hi ${name},</p>
        <p>Just a quick update - the artwork for order <strong>${escapeHtml(docNumber)}</strong> has been approved and we're moving ahead with production.</p>
        <p>We'll let you know as it progresses.</p>`;
    } else if (/order|garment/.test(lowerTitle)) {
      subject = `Garments ordered - ${docNumber}`;
      heading = "Your garments are on order";
      bodyHtml = `<p>Hi ${name},</p>
        <p>Order <strong>${escapeHtml(docNumber)}</strong> has moved forward - the garments have now been ordered in ahead of decoration.</p>`;
    } else if (/production/.test(lowerTitle)) {
      subject = `Now in production - ${docNumber}`;
      heading = "Your order's in production";
      bodyHtml = `<p>Hi ${name},</p>
        <p>Order <strong>${escapeHtml(docNumber)}</strong> is now being decorated on the machines. Not long to go!</p>`;
    } else if (/quality|check/.test(lowerTitle)) {
      subject = `Quality checked - ${docNumber}`;
      heading = "Passed quality check ✓";
      bodyHtml = `<p>Hi ${name},</p>
        <p>Order <strong>${escapeHtml(docNumber)}</strong> has been through our quality check and is looking great.</p>`;
    } else {
      subject = `Order update: ${stepTitle} - ${docNumber}`;
      heading = "An update on your order";
      bodyHtml = `<p>Hi ${name},</p>
        <p>Order <strong>${escapeHtml(docNumber)}</strong> has reached the next stage: <strong>${escapeHtml(stepTitle)}</strong>.</p>
        <p>We'll keep you updated as it progresses.</p>`;
    }
    const html = emailShell({ heading, bodyHtml, ctaText, ctaUrl });

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromAddress, to: [to], reply_to: replyToAddress, subject, html }),
      });
      if (!res.ok) return { sent: false, reason: "Resend rejected the email" };
      try {
        await db.prepare(
          "INSERT INTO email_log (id, order_id, sent_to, subject) VALUES (?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), orderId, to, subject).run();
      } catch (e) {
        // email_log table doesn't exist yet (send-email.js/payment-reminders.js
        // create it lazily) - the email still sent, just not logged this time
      }
      return { sent: true };
    } catch (e) {
      return { sent: false, reason: e.message };
    }
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS production_steps (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        notes TEXT,
        position INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_production_steps_order ON production_steps (order_id)").run();
    // notify_customer - whether marking this step done should email the
    // customer. notified_at - when that email last actually went out
    // (cleared on reopen, so re-completing a step can notify again).
    for (const col of ["notify_customer INTEGER DEFAULT 0", "notified_at TEXT"]) {
      try {
        await db.prepare(`ALTER TABLE production_steps ADD COLUMN ${col}`).run();
      } catch {
        // already exists
      }
    }

    await db.prepare(`
      CREATE TABLE IF NOT EXISTS production_step_images (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT,
        size_bytes INTEGER DEFAULT 0,
        r2_key TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_production_step_images_step ON production_step_images (step_id)").run();

    const url = new URL(request.url);

    // Streams a step photo's bytes - same trust level as every other
    // internal image endpoint here (design-proofs.js, design-files.js),
    // not auth-gated beyond the portal's own login.
    if (request.method === "GET" && url.searchParams.get("view")) {
      const row = await db.prepare("SELECT * FROM production_step_images WHERE id = ?").bind(url.searchParams.get("view")).first();
      if (!row) return json({ error: "Image not found" }, 404);
      const obj = await bucket.get(row.r2_key);
      if (!obj) return json({ error: "File missing from storage" }, 404);
      return new Response(obj.body, {
        headers: {
          "Content-Type": row.content_type || "application/octet-stream",
          "Content-Disposition": `inline; filename="${row.filename.replace(/"/g, "")}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // GET ?all=1 - a lightweight one-line-per-order summary (current step
    // title, done/total count) for every order that already has a tracker
    // started - backs the small production-status badge on the main
    // Quotes & Invoices list. Deliberately does NOT seed the default
    // pipeline for orders that have never had their tracker opened - an
    // order with no steps yet just shows no badge, rather than silently
    // starting a tracker for every order in the list.
    if (request.method === "GET" && url.searchParams.get("all")) {
      const { results: allSteps } = await db.prepare(
        "SELECT order_id, title, status FROM production_steps ORDER BY order_id, position ASC"
      ).all();
      const byOrder = {};
      for (const s of allSteps) {
        (byOrder[s.order_id] = byOrder[s.order_id] || []).push(s);
      }
      const summary = {};
      for (const orderId in byOrder) {
        const steps = byOrder[orderId]; // ordered by position ASC
        const doneSteps = steps.filter((s) => s.status === "done");
        // The badge should echo what's actually been ticked off, not what's
        // coming up next - "Artwork approved" stays showing until Garments
        // ordered is itself ticked, not the moment it becomes the next
        // pending step.
        const lastDone = doneSteps[doneSteps.length - 1];
        summary[orderId] = {
          current_title: lastDone ? lastDone.title : null,
          all_done: doneSteps.length === steps.length,
          total: steps.length,
          done_count: doneSteps.length,
        };
      }
      return json(summary);
    }

    // GET ?orphaned=1 - steps/images whose order was deleted before
    // orders.js's deleteOrphanedProductionSteps cleanup existed (or from any
    // gap before this endpoint learns about a new deletion path) - same
    // one-off maintenance pattern as design-proofs.js/design-files.js.
    if (request.method === "GET" && url.searchParams.get("orphaned")) {
      const { results } = await db.prepare(`
        SELECT i.id, i.filename, i.size_bytes, i.created_at
        FROM production_step_images i LEFT JOIN orders o ON o.id = i.order_id
        WHERE o.id IS NULL ORDER BY i.created_at DESC
      `).all();
      return json(results);
    }

    // GET ?order_id=X - the whole tracker for one order, seeding the
    // default pipeline the very first time it's ever opened.
    if (request.method === "GET") {
      const orderId = url.searchParams.get("order_id");
      if (!orderId) return json({ error: "order_id is required" }, 400);

      const { results: existing } = await db.prepare(
        "SELECT id FROM production_steps WHERE order_id = ? LIMIT 1"
      ).bind(orderId).all();

      if (!existing.length) {
        for (let i = 0; i < DEFAULT_STEPS.length; i++) {
          await db.prepare(
            "INSERT INTO production_steps (id, order_id, title, position, notify_customer) VALUES (?, ?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), orderId, DEFAULT_STEPS[i].title, i, DEFAULT_STEPS[i].notify ? 1 : 0).run();
        }
      }

      const { results: steps } = await db.prepare(
        "SELECT * FROM production_steps WHERE order_id = ? ORDER BY position ASC"
      ).bind(orderId).all();
      const { results: images } = await db.prepare(
        "SELECT id, step_id, filename, content_type, created_at FROM production_step_images WHERE order_id = ? ORDER BY created_at ASC"
      ).bind(orderId).all();

      const imagesByStep = {};
      for (const img of images) {
        (imagesByStep[img.step_id] = imagesByStep[img.step_id] || []).push(img);
      }
      return json(steps.map((s) => ({ ...s, images: imagesByStep[s.id] || [] })));
    }

    if (request.method === "POST") {
      const contentType = request.headers.get("content-type") || "";

      // Multipart - attaching a photo to a step.
      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        const stepId = form.get("step_id");
        const orderId = form.get("order_id");
        if (!stepId || !orderId) return json({ error: "step_id and order_id are required" }, 400);
        const file = form.get("file");
        if (!file || typeof file !== "object" || !("arrayBuffer" in file)) {
          return json({ error: "No file provided" }, 400);
        }
        const id = crypto.randomUUID();
        const key = `production-steps/${orderId}/${stepId}/${id}-${file.name}`;
        await bucket.put(key, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type || "application/octet-stream" },
        });
        await db.prepare(`
          INSERT INTO production_step_images (id, step_id, order_id, filename, content_type, size_bytes, r2_key)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(id, stepId, orderId, file.name, file.type || "application/octet-stream", file.size || 0, key).run();
        return json({ success: true, id });
      }

      // JSON - adds a new step at the end of this order's list.
      const data = await request.json();
      if (!data.order_id || !data.title) return json({ error: "order_id and title are required" }, 400);
      const { results: existing } = await db.prepare(
        "SELECT MAX(position) AS maxPos FROM production_steps WHERE order_id = ?"
      ).bind(data.order_id).all();
      const nextPos = (existing[0] && Number.isFinite(existing[0].maxPos) ? existing[0].maxPos : -1) + 1;
      const id = crypto.randomUUID();
      await db.prepare(
        "INSERT INTO production_steps (id, order_id, title, position) VALUES (?, ?, ?, ?)"
      ).bind(id, data.order_id, String(data.title).slice(0, 200), nextPos).run();
      return json({ success: true, id });
    }

    if (request.method === "PUT") {
      const data = await request.json();
      if (!data.id) return json({ error: "id is required" }, 400);
      const existing = await db.prepare("SELECT * FROM production_steps WHERE id = ?").bind(data.id).first();
      if (!existing) return json({ error: "Step not found" }, 404);

      // Swaps this step's position with the one immediately before/after it
      // - simple move up/down rather than free drag-and-drop.
      if (data.action === "move") {
        const { results: siblings } = await db.prepare(
          "SELECT id, position FROM production_steps WHERE order_id = ? ORDER BY position ASC"
        ).bind(existing.order_id).all();
        const idx = siblings.findIndex((s) => s.id === data.id);
        const swapIdx = data.direction === "up" ? idx - 1 : idx + 1;
        if (idx === -1 || swapIdx < 0 || swapIdx >= siblings.length) return json({ success: true });
        const a = siblings[idx], b = siblings[swapIdx];
        await db.prepare("UPDATE production_steps SET position = ? WHERE id = ?").bind(b.position, a.id).run();
        await db.prepare("UPDATE production_steps SET position = ? WHERE id = ?").bind(a.position, b.id).run();
        return json({ success: true });
      }

      const title = data.title !== undefined ? String(data.title).slice(0, 200) : existing.title;
      const notes = data.notes !== undefined ? String(data.notes).slice(0, 2000) : existing.notes;
      const status = data.status === "done" ? "done" : data.status === "pending" ? "pending" : existing.status;
      const notifyCustomer = data.notify_customer !== undefined ? (data.notify_customer ? 1 : 0) : existing.notify_customer;
      const justCompleted = status === "done" && existing.status !== "done";
      const completedAt = status === "done"
        ? (existing.status === "done" ? existing.completed_at : new Date().toISOString())
        : null;
      // Reopening clears notified_at so a later re-completion can notify
      // again - notified_at means "when the customer was last told about
      // THIS completion", not "has this step ever emailed".
      let notifiedAt = status === "done" ? existing.notified_at : null;

      await db.prepare(
        "UPDATE production_steps SET title = ?, notes = ?, status = ?, notify_customer = ?, completed_at = ?, notified_at = ? WHERE id = ?"
      ).bind(title, notes, status, notifyCustomer, completedAt, notifiedAt, data.id).run();

      let emailResult = null;
      if (justCompleted && notifyCustomer) {
        emailResult = await sendStepNotification(existing.order_id, title);
        if (emailResult.sent) {
          notifiedAt = new Date().toISOString();
          await db.prepare("UPDATE production_steps SET notified_at = ? WHERE id = ?").bind(notifiedAt, data.id).run();
        }
      }
      return json({ success: true, notified_at: notifiedAt, email: emailResult });
    }

    if (request.method === "DELETE") {
      const data = await request.json();

      if (data.action === "purge_orphaned") {
        const { results: orphanedImages } = await db.prepare(`
          SELECT i.id, i.r2_key FROM production_step_images i LEFT JOIN orders o ON o.id = i.order_id WHERE o.id IS NULL
        `).all();
        if (orphanedImages.length) {
          await Promise.all(orphanedImages.filter((i) => i.r2_key).map((i) => bucket.delete(i.r2_key).catch(() => {})));
          const imgIds = orphanedImages.map((i) => i.id);
          await db.prepare(`DELETE FROM production_step_images WHERE id IN (${imgIds.map(() => "?").join(",")})`).bind(...imgIds).run();
        }
        // The orphaned steps themselves (an order with no steps left never
        // shows up in the ?orphaned=1 image list above, so this needs its
        // own lookup rather than following on from the images just purged).
        const { results: orphanedSteps } = await db.prepare(`
          SELECT s.id FROM production_steps s LEFT JOIN orders o ON o.id = s.order_id WHERE o.id IS NULL
        `).all();
        if (orphanedSteps.length) {
          const stepIds = orphanedSteps.map((s) => s.id);
          await db.prepare(`DELETE FROM production_steps WHERE id IN (${stepIds.map(() => "?").join(",")})`).bind(...stepIds).run();
        }
        return json({ success: true, purged: orphanedImages.length });
      }

      if (data.image_id) {
        const row = await db.prepare("SELECT r2_key FROM production_step_images WHERE id = ?").bind(data.image_id).first();
        if (row) {
          if (row.r2_key) await bucket.delete(row.r2_key);
          await db.prepare("DELETE FROM production_step_images WHERE id = ?").bind(data.image_id).run();
        }
        return json({ success: true });
      }

      if (!data.id) return json({ error: "id is required" }, 400);
      const { results: images } = await db.prepare(
        "SELECT r2_key FROM production_step_images WHERE step_id = ?"
      ).bind(data.id).all();
      await Promise.all(images.filter((i) => i.r2_key).map((i) => bucket.delete(i.r2_key).catch(() => {})));
      await db.prepare("DELETE FROM production_step_images WHERE step_id = ?").bind(data.id).run();
      await db.prepare("DELETE FROM production_steps WHERE id = ?").bind(data.id).run();
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
