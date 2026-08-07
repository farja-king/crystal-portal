// Shared HTML shell for every customer-facing notification email (step
// updates, review requests, payment reminders) - one consistent look
// (header bar, card, footer with shop details) instead of each sender
// building its own plain paragraph of text. Each caller only supplies the
// bit that's actually unique to that email: heading, body copy, and an
// optional single call-to-action button.
const SHOP_ADDRESS = "26 Grove Street, Raunds, NN9 6DS";
const SHOP_EMAIL = "hello@embroidery.click";
const SHOP_PHONE = "07530 576197";

export function emailShell({ heading, bodyHtml, ctaText, ctaUrl, ctaColor = "#4f46e5" }) {
  return `
  <div style="background:#f1f5f9;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;">
        <tr>
          <td style="padding:18px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="width:32px;height:32px;background:#4f46e5;border-radius:8px;text-align:center;vertical-align:middle;color:#fff;font-weight:bold;font-size:16px;font-family:Arial,Helvetica,sans-serif;">C</td>
              <td style="padding-left:10px;color:#ffffff;font-size:15px;font-weight:600;">Crystal Custom Embroidery</td>
            </tr></table>
          </td>
        </tr>
      </table>
      <div style="padding:32px 28px;color:#0f172a;">
        ${heading ? `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${heading}</h1>` : ""}
        <div style="font-size:14px;line-height:1.65;color:#334155;">${bodyHtml}</div>
        ${ctaText && ctaUrl ? `
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 4px;"><tr>
          <td style="background:${ctaColor};border-radius:8px;">
            <a href="${ctaUrl}" style="display:inline-block;color:#ffffff;text-decoration:none;padding:12px 26px;font-weight:600;font-size:14px;font-family:Arial,Helvetica,sans-serif;">${ctaText}</a>
          </td>
        </tr></table>` : ""}
      </div>
      <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;line-height:1.6;">
        ${SHOP_ADDRESS} &middot; ${SHOP_EMAIL} &middot; ${SHOP_PHONE}
      </div>
    </div>
  </div>`;
}

export function googleMapsDirectionsUrl() {
  return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(SHOP_ADDRESS);
}
