// ────────────────────────────────────────────────────────────────────────────
// /api/digest — Email a blocker/risk digest from the latest Firestore snapshot
// ────────────────────────────────────────────────────────────────────────────
// Usage:
//   GET /api/digest                 → uses DIGEST_TO_EMAILS env var
//   GET /api/digest?to=foo@bar.com  → override recipient (?to=a@b.com,c@d.com)
//   GET /api/digest?dry=1           → render the HTML in-browser, do NOT send
//
// Required env vars:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   GMAIL_FROM_EMAIL
//   DIGEST_TO_EMAILS   — comma list of default recipients
//
// Optional:
//   DASHBOARD_PASSWORD
//
// Schedule it: add a Vercel Cron Job to hit /api/digest every Monday 8am.
// ────────────────────────────────────────────────────────────────────────────

import { readSnapshot, listRecipients } from "../lib/firebase.js";
import { sendEmail } from "../lib/gmail.js";

export default async function handler(req, res) {
  // Same auth pattern as /api/refresh. See refresh.js for the full explainer.
  // Short version: validate the Bearer/header IF they're present, but don't
  // require them. Vercel Authentication gates the URL for humans.
  const bearer = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (bearer && process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized (bad bearer)" });
  }
  if (process.env.DASHBOARD_PASSWORD) {
    const userKey = req.headers["x-dashboard-key"];
    if (userKey && userKey !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: "unauthorized (bad key)" });
    }
  }

  try {
    const snap = await readSnapshot();
    if (!snap) {
      return res.status(404).json({ error: "no cached snapshot — hit /api/refresh first" });
    }

    const { html, summary } = buildDigestHtml(snap);
    const dry = req.query?.dry === "1";

    if (dry) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(html);
    }

    // Recipient resolution order:
    //   1. ?to=foo@bar.com  (explicit override on the request)
    //   2. Firestore digest_recipients (active only) — managed from the dashboard
    //   3. DIGEST_TO_EMAILS env var (fallback for initial setup / disaster recovery)
    const toParam = req.query?.to;
    let recipients = [];
    let source = "none";

    if (toParam) {
      recipients = toParam.split(",").map(s => s.trim()).filter(Boolean);
      source = "query";
    } else {
      try {
        const list = await listRecipients();
        recipients = list.filter(r => r.active !== false && r.email).map(r => r.email);
        source = "firestore";
      } catch (e) {
        console.warn("recipient read failed, falling back to env:", e.message);
      }
      if (!recipients.length) {
        recipients = (process.env.DIGEST_TO_EMAILS || "").split(",").map(s => s.trim()).filter(Boolean);
        source = "env";
      }
    }

    if (!recipients.length) {
      return res.status(400).json({
        error: "no recipients — add some via /api/recipients (or the dashboard panel), or set DIGEST_TO_EMAILS, or pass ?to=..."
      });
    }

    const subject = `Moxie Enterprise Onboarding · ${summary.blockerCount} blockers, ${summary.riskCount} risks`;
    const sent = await sendEmail({ to: recipients, subject, html });

    return res.status(200).json({ ok: true, sent_to: recipients, recipient_source: source, ...summary, message_id: sent.id });
  } catch (e) {
    console.error("digest error:", e);
    return res.status(500).json({ error: e.message || "digest failed" });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Render the digest HTML from a cached snapshot
// ────────────────────────────────────────────────────────────────────────────

function buildDigestHtml(snap) {
  const { companies = [], notes = {}, synced_at } = snap;
  const companyByKey = {};
  for (const c of companies) {
    const key = (c.name || "").toLowerCase().split(/\s+/)[0];
    companyByKey[key] = c;
  }

  const rows = [];
  let blockerCount = 0;
  let riskCount = 0;

  for (const [key, items] of Object.entries(notes)) {
    for (const item of items) {
      if (item.type === "blocker") blockerCount++;
      else if (item.type === "risk") riskCount++;
      const c = companyByKey[key] || findCompanyLoosely(companies, key);
      rows.push({ key, name: c?.name || key, type: item.type, date: item.date, text: item.text, company: c });
    }
  }

  // Sort blocker → risk → update, then date desc
  const order = { blocker: 0, risk: 1, update: 2 };
  rows.sort((a, b) => (order[a.type] - order[b.type]) || (b.date || "").localeCompare(a.date || ""));

  const blockers = rows.filter(r => r.type === "blocker");
  const risks    = rows.filter(r => r.type === "risk");
  const updates  = rows.filter(r => r.type === "update").slice(0, 10);

  const renderSection = (title, color, list) => {
    if (!list.length) return "";
    const items = list.map(r => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;vertical-align:top;">
          <div style="font-weight:600;color:#1a1a1a;">${escapeHtml(r.name)}</div>
          <div style="color:#666;font-size:12px;">${escapeHtml(r.date || "")}${r.company?.onboarding_status ? " · " + escapeHtml(r.company.onboarding_status) : ""}</div>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#1a1a1a;font-size:14px;">
          ${escapeHtml(r.text)}
        </td>
      </tr>
    `).join("");
    return `
      <h2 style="font-size:16px;margin:24px 0 8px;color:${color};">${title} (${list.length})</h2>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:-apple-system,Segoe UI,sans-serif;">
        ${items}
      </table>
    `;
  };

  const html = `
<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f8f7f4;font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
    <div style="border-bottom:2px solid #4F0751;padding-bottom:12px;margin-bottom:16px;">
      <div style="color:#4F0751;font-weight:700;font-size:20px;">Moxie · Enterprise Onboarding Digest</div>
      <div style="color:#666;font-size:13px;margin-top:4px;">
        ${companies.length} accounts · ${blockerCount} blockers · ${riskCount} risks · synced ${escapeHtml(synced_at || "")}
      </div>
    </div>
    ${renderSection("🚨 Blockers", "#b00020", blockers)}
    ${renderSection("⚠️ Risks", "#9a6f00", risks)}
    ${renderSection("📌 Recent Updates", "#5eb89e", updates)}
    <div style="margin-top:24px;color:#999;font-size:12px;border-top:1px solid #eee;padding-top:12px;">
      Generated by Moxie Onboarding Dashboard · <a href="https://moxie-onboarding-dashboard.vercel.app" style="color:#4F0751;">Open dashboard</a>
    </div>
  </div>
</body></html>
  `.trim();

  return {
    html,
    summary: {
      blockerCount,
      riskCount,
      updateCount: updates.length,
      companies: companies.length
    }
  };
}

function findCompanyLoosely(companies, key) {
  const k = (key || "").toLowerCase();
  return companies.find(c => (c.name || "").toLowerCase().includes(k));
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
