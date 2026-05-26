// ────────────────────────────────────────────────────────────────────────────
// /api/digest — Weekly digest: Onboarding + Pre-launch + Post-launch
// ────────────────────────────────────────────────────────────────────────────
// Usage:
//   GET /api/digest                 → triggers refresh first, then sends to DIGEST_TO_EMAILS + Firestore recipients
//   GET /api/digest?to=a@b.com      → override recipient
//   GET /api/digest?dry=1           → render HTML in-browser, do NOT send
//   GET /api/digest?skip_refresh=1  → skip the pre-send refresh (use existing cache)
//
// Sections, in order: Onboarding → Pre-launch → Post-launch
// Each row: current target launch, GMV at risk, launch date change flag, blockers/risks summary.
//
// Env vars:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//   GMAIL_FROM_EMAIL
//   DIGEST_TO_EMAILS   — comma list of default recipients
// ────────────────────────────────────────────────────────────────────────────

import { readSnapshot, listRecipients } from "../lib/firebase.js";
import { sendEmail } from "../lib/gmail.js";

export default async function handler(req, res) {
  // Lenient auth — see refresh.js for the full pattern
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
    // NOTE: We no longer internally trigger /api/refresh here.
    // - Manual sends: the dashboard's "Send digest now" button calls /api/refresh
    //   first, then /api/digest. This avoids stacking two 30-60s operations
    //   inside a single Vercel function timeout.
    // - Cron sends: a separate Friday 21:30 UTC cron hits /api/refresh, then
    //   the 22:00 UTC cron hits /api/digest 30 minutes later.

    // Read snapshot
    const snap = await readSnapshot();
    if (!snap) return res.status(404).json({ error: "no snapshot — hit /api/refresh first" });

    // STEP 3: Build digest HTML
    const { html, summary } = buildDigestHtml(snap);

    // Dry run — return HTML for preview
    if (req.query?.dry === "1") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(html);
    }

    // STEP 4: Resolve recipients
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
        console.warn("recipient read failed:", e.message);
      }
      if (!recipients.length) {
        recipients = (process.env.DIGEST_TO_EMAILS || "").split(",").map(s => s.trim()).filter(Boolean);
        source = "env";
      }
    }

    if (!recipients.length) {
      return res.status(400).json({ error: "no recipients — add some via the dashboard panel or DIGEST_TO_EMAILS" });
    }

    // STEP 5: Send (subject is plain ASCII to avoid encoding issues)
    const subject = `Moxie Enterprise Onboarding and Pre-launch Weekly Update - ${summary.dateLabel}`;
    const sent = await sendEmail({ to: recipients, subject, html });

    return res.status(200).json({
      ok: true,
      sent_to: recipients,
      recipient_source: source,
      subject,
      ...summary,
      message_id: sent.id
    });
  } catch (e) {
    console.error("digest error:", e);
    return res.status(500).json({ error: e.message || "digest failed" });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Build the digest HTML
// ────────────────────────────────────────────────────────────────────────────

function buildDigestHtml(snap) {
  const { companies = [], notes = {}, synced_at } = snap;

  // Archived accounts are excluded from the digest entirely (matches the
  // Slack/AI pipeline which also skips them).
  const active = companies.filter(c => !c.archived_at);

  // Bucket by lifecycle stage
  const onboarding   = active.filter(c => (c.lifecyclestage || "").toLowerCase() === "onboarding");
  const preLaunch    = active.filter(c => (c.lifecyclestage || "").toLowerCase() === "pre-launch");
  const postLaunch   = active.filter(c => (c.lifecyclestage || "").toLowerCase() === "post-launch customer");

  // Aggregate metrics — Post-launch accounts are EXCLUDED from the header KPIs
  // (Active / Blockers / Risks / GMV at Risk). Rationale: the weekly digest's
  // KPI row is about accounts still being onboarded or about to launch; post-
  // launch customers belong to PSM territory and would skew the totals.
  // Post-launch accounts still appear in their own digest section below.
  let blockerCount = 0, riskCount = 0;
  let blockerOnboarding = 0, blockerPreLaunch = 0;
  let riskOnboarding = 0, riskPreLaunch = 0;
  let gmvAtRiskOnboarding = 0;
  let gmvAtRiskPreLaunch = 0;

  // Walk every account to count — but only Onboarding + Pre-launch feed the KPIs
  for (const c of active) {
    const stage = (c.lifecyclestage || "").toLowerCase();
    if (stage !== "onboarding" && stage !== "pre-launch") continue; // skip post-launch + anything else
    const key = getCompanyKey(c.name);
    const accountNotes = notes[key] || [];
    const allNotes = [...accountNotes, ...(c.manual_notes || [])];
    for (const n of allNotes) {
      if (n.type === "blocker") {
        blockerCount++;
        if (stage === "onboarding") blockerOnboarding++;
        else if (stage === "pre-launch") blockerPreLaunch++;
      }
      if (n.type === "risk") {
        riskCount++;
        if (stage === "onboarding") riskOnboarding++;
        else if (stage === "pre-launch") riskPreLaunch++;
      }
    }
    // GMV at risk = monthly_revenue for delayed / blocked accounts — bucketed by stage
    const status = (c.moxie_onboarding_status_override || c.moxie_onboarding_status || "").toLowerCase();
    const hasBlockers = allNotes.some(n => n.type === "blocker");
    const isAtRisk = status.includes("delayed") || status.includes("at risk") || status.includes("on hold") || !!c.delayed_reason || hasBlockers;
    if (isAtRisk && c.monthly_revenue) {
      const rev = parseFloat(c.monthly_revenue) || 0;
      if (stage === "onboarding") gmvAtRiskOnboarding += rev;
      else if (stage === "pre-launch") gmvAtRiskPreLaunch += rev;
    }
  }

  // Date label
  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const html = `
<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f8f7f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <div style="max-width:780px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">

    <div style="border-bottom:2px solid #4F0751;padding-bottom:14px;margin-bottom:18px;">
      <div style="color:#4F0751;font-weight:700;font-size:22px;line-height:1.2;">Moxie Enterprise Onboarding &amp; Pre-launch</div>
      <div style="color:#666;font-size:13px;margin-top:6px;">Weekly Update &middot; ${escapeHtml(dateLabel)}</div>
      <div style="font-size:11px;margin-top:6px;">
        For more details, <a href="https://enterprise-onboarding-woad.vercel.app" style="color:#4F0751;text-decoration:underline;">click here to view the dashboard</a>
      </div>
    </div>

    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:18px;">
      <tr>
        ${kpi("Active Accounts", `${onboarding.length + preLaunch.length}`, "#4F0751", `${onboarding.length} Onboarding · ${preLaunch.length} Pre-launch`)}
        ${kpi("Blockers", `${blockerCount}`, "#b00020", `${blockerOnboarding} Onboarding · ${blockerPreLaunch} Pre-launch`)}
        ${kpi("Risks", `${riskCount}`, "#9a6f00", `${riskOnboarding} Onboarding · ${riskPreLaunch} Pre-launch`)}
        ${kpi("GMV at Risk · Onboarding", fmtMoney(gmvAtRiskOnboarding), "#b00020")}
        ${kpi("GMV at Risk · Pre-launch", fmtMoney(gmvAtRiskPreLaunch), "#b00020")}
      </tr>
    </table>

    ${renderSection("Onboarding", onboarding, notes, "#4F0751")}
    ${renderSection("Pre-launch", preLaunch, notes, "#AC8342")}
    ${renderSection("Post-launch Customers", postLaunch, notes, "#5eb89e")}

    <div style="margin-top:24px;color:#999;font-size:11px;border-top:1px solid #eee;padding-top:14px;line-height:1.5;">
      Generated by Moxie Enterprise Onboarding Dashboard &middot;
      <a href="https://enterprise-onboarding-woad.vercel.app" style="color:#4F0751;">Open dashboard</a>
      &middot; Synced ${escapeHtml(synced_at || "")}
    </div>
  </div>
</body></html>
  `.trim();

  return {
    html,
    summary: {
      dateLabel,
      blockerCount,
      riskCount,
      blockerOnboarding,
      blockerPreLaunch,
      riskOnboarding,
      riskPreLaunch,
      gmvAtRiskOnboarding,
      gmvAtRiskPreLaunch,
      activeCount: active.length,
      onboardingCount: onboarding.length,
      preLaunchCount: preLaunch.length,
      postLaunchCount: postLaunch.length
    }
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Section / row renderers
// ────────────────────────────────────────────────────────────────────────────

function renderSection(title, accounts, notesByKey, color) {
  if (!accounts.length) {
    return `<h2 style="font-size:17px;margin:22px 0 10px;color:${color};">${title} (0)</h2>
            <div style="color:#999;font-size:12px;font-style:italic;">No accounts in this stage.</div>`;
  }

  // Sort: launch date changes first, then by target launch ascending
  accounts.sort((a, b) => {
    if (a.launch_date_change_type && !b.launch_date_change_type) return -1;
    if (!a.launch_date_change_type && b.launch_date_change_type) return 1;
    const aT = a.updated_target_launch_date || a.current_target_launch_date || "9999";
    const bT = b.updated_target_launch_date || b.current_target_launch_date || "9999";
    return aT.localeCompare(bT);
  });

  const rows = accounts.map(c => renderAccountRow(c, notesByKey)).join("");

  return `
    <h2 style="font-size:17px;margin:22px 0 10px;color:${color};border-bottom:1px solid #eee;padding-bottom:6px;">
      ${title} (${accounts.length})
    </h2>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:-apple-system,Segoe UI,sans-serif;">
      ${rows}
    </table>
  `;
}

function renderAccountRow(c, notesByKey) {
  const display = (c.name || "").replace(/-\s*\d+$/, "").trim();
  const key = getCompanyKey(c.name);
  const slackNotes = notesByKey[key] || [];

  // Bucket by type
  const blockers = slackNotes.filter(n => n.type === "blocker");
  const risks    = slackNotes.filter(n => n.type === "risk");
  // Updates: filter to past 7 days + cap at top 3 to keep the digest skimmable.
  // Blockers & Risks stay full detail — those are the action items.
  const allUpdates = slackNotes.filter(n => n.type === "update");
  const updates = pickRecentUpdates(allUpdates, 7).slice(0, 3);

  // Launch date (with "Removed" handling)
  const launchRemoved = c.launch_date_change_type === "removed";
  const target = launchRemoved ? null : (c.updated_target_launch_date || c.current_target_launch_date || c.initial_target_launch_date);

  // Launch change badge — sits NEXT TO the target launch date.
  // Format: "<icon> <label> from <PREV> to <NEW>" so readers see the new date,
  // not the date the change was recorded (which used to confuse people).
  let changeBadge = "";
  if (c.launch_date_change_type) {
    const t = c.launch_date_change_type;
    const prev = c.launch_date_previous_value ? fmtDate(c.launch_date_previous_value) : "—";
    const newTarget = c.updated_target_launch_date || c.current_target_launch_date || null;
    const color = t === "pushed_back" ? "#b00020" : t === "moved_up" ? "#2e8a6a" : "#b00020";
    const icon = t === "pushed_back" ? "⬇" : t === "moved_up" ? "⬆" : "❌";
    const label = t === "pushed_back" ? "Pushed back" : t === "moved_up" ? "Moved up" : "Removed";
    const toPart = t === "removed"
      ? " (no target set)"
      : (newTarget ? ` to ${fmtDate(newTarget)}` : "");
    changeBadge = `<span style="display:inline-block;font-size:11px;font-weight:600;color:${color};background:${color}1a;padding:2px 8px;border-radius:10px;margin-left:8px;">${icon} ${label} from ${prev}${toPart}</span>`;
  }

  // Revenue — sits next to target launch with "Revenue:" label
  const rev = parseFloat(c.monthly_revenue);
  const revStr = isNaN(rev) || rev === 0
    ? `<span style="color:#999;font-size:11px;margin-left:14px;font-style:italic;"><strong>Revenue:</strong> TBD</span>`
    : `<span style="color:#1a1a1a;font-size:11px;margin-left:14px;"><strong>Revenue:</strong> ${fmtMoney(rev)}/mo</span>`;

  // Target launch
  const targetStr = launchRemoved
    ? `<span style="color:#b00020;font-weight:600;">Removed</span>`
    : target
      ? `<strong>${fmtDate(target)}</strong>`
      : `<span style="color:#999;font-style:italic;">No target set</span>`;

  // Manager line
  const om = c.onboarding_manager_name || "";
  const psm = c.practice_success_manager_name || c.provider_success_manager_name || "";
  const mgrLine = [om && `OM: ${om}`, psm && `PSM: ${psm}`].filter(Boolean).join(" &middot; ");

  // Reasons
  const reasons = [];
  if (c.delayed_reason) reasons.push(`<strong style="color:#b00020;">Delayed:</strong> ${escapeHtml(c.delayed_reason)}`);

  // HubSpot link
  const hsUrl = c.hs_object_id ? `https://app.hubspot.com/contacts/22420370/record/0-2/${c.hs_object_id}` : null;

  // Provider name → link to HubSpot
  const nameLink = hsUrl
    ? `<a href="${hsUrl}" style="color:#4F0751;text-decoration:none;border-bottom:1px dotted #4F0751;">${escapeHtml(display)}</a>`
    : escapeHtml(display);

  // Render buckets — Blockers + Risks stay full detail (these need action),
  // Updates get truncated to keep the digest skimmable.
  const renderBucket = (label, color, icon, items) => {
    if (!items.length) return "";
    const list = items.map(n => `
      <li style="font-size:12px;color:#1a1a1a;margin-bottom:4px;line-height:1.5;">
        ${escapeHtml(n.text)}
        <span style="color:#999;font-size:10px;">(${escapeHtml(n.date || "")})</span>
      </li>`).join("");
    return `
      <div style="margin-top:8px;">
        <div style="font-size:11px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.5px;">${icon} ${label} (${items.length})</div>
        <ul style="margin:4px 0 0 18px;padding:0;">${list}</ul>
      </div>
    `;
  };

  // Updates renderer: tighter — short truncated text, no bullets, semicolon-joined.
  const renderUpdatesShort = (items, totalCount) => {
    if (!items.length) return "";
    const trim = (t) => {
      const s = (t || "").trim();
      return s.length > 120 ? s.slice(0, 117) + "…" : s;
    };
    const line = items.map(n => `${escapeHtml(trim(n.text))} <span style="color:#999;">(${escapeHtml(n.date || "")})</span>`).join(" &nbsp;·&nbsp; ");
    const moreNote = totalCount > items.length
      ? `<span style="color:#999;font-size:10px;font-style:italic;"> +${totalCount - items.length} more — open dashboard for full list</span>`
      : "";
    return `
      <div style="margin-top:8px;">
        <div style="font-size:11px;font-weight:700;color:#2e8a6a;text-transform:uppercase;letter-spacing:0.5px;">📌 Updates from the past 7 days</div>
        <div style="font-size:12px;color:#1a1a1a;margin-top:4px;line-height:1.5;">${line}${moreNote}</div>
      </div>
    `;
  };

  return `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #eee;vertical-align:top;">
        <div style="font-weight:700;font-size:15px;">
          ${nameLink}
        </div>
        <div style="color:#1a1a1a;font-size:12px;margin-top:5px;">
          <strong>Target Launch:</strong> ${targetStr} ${changeBadge} ${revStr}
        </div>
        ${mgrLine ? `<div style="color:#666;font-size:11px;margin-top:3px;">${mgrLine}</div>` : ''}
        ${reasons.length ? `<div style="margin-top:6px;font-size:12px;color:#1a1a1a;">${reasons.join("<br>")}</div>` : ''}
        ${renderBucket("Blockers", "#b00020", "🚨", blockers)}
        ${renderBucket("Risks",    "#9a6f00", "⚠️", risks)}
        ${renderUpdatesShort(updates, allUpdates.length)}
        ${(blockers.length + risks.length + allUpdates.length === 0)
          ? `<div style="margin-top:6px;font-size:11px;color:#999;font-style:italic;">No Slack updates in the past 14 business days.</div>`
          : ''}
      </td>
    </tr>
  `;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function kpi(label, value, color, breakdown) {
  // Optional `breakdown` renders below the number as a small grey sub-line
  // (e.g. "12 Onboarding · 8 Pre-launch"). Used on Active / Blockers / Risks.
  const subline = breakdown
    ? `<div style="font-size:10px;color:#666;margin-top:4px;line-height:1.3;">${breakdown}</div>`
    : "";
  return `
    <td style="text-align:center;padding:12px 6px;background:${color}0d;border-radius:8px;width:20%;vertical-align:top;">
      <div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;line-height:1.3;min-height:24px;">${label}</div>
      <div style="font-size:20px;font-weight:700;color:${color};margin-top:4px;">${value}</div>
      ${subline}
    </td>
  `;
}

function fmtDate(s) {
  if (!s) return "—";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(m[2])-1]} ${parseInt(m[3])}, ${m[1]}`;
  }
  try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch { return s; }
}

function fmtMoney(n) {
  const v = parseFloat(n);
  if (isNaN(v) || v === 0) return "$0";
  if (v >= 1000000) return `$${(v/1000000).toFixed(1)}M`;
  if (v >= 1000) return `$${Math.round(v/1000)}k`;
  return `$${Math.round(v)}`;
}

function getCompanyKey(name) {
  return (name || "").toLowerCase().split(/\s+/)[0];
}

// Parse "Mon D" (e.g. "May 22") + current year and return a Date — used to
// filter updates to a rolling window. Falls back to "always include" if the
// date string is missing or unparseable, so we never silently drop notes.
function parseNoteDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^([A-Za-z]{3,9})\s+(\d{1,2})/);
  if (!m) return null;
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const mo = months[m[1].slice(0,3).toLowerCase()];
  const day = parseInt(m[2]);
  if (mo == null || isNaN(day)) return null;
  const now = new Date();
  let yr = now.getFullYear();
  // If the parsed date is more than 60 days in the future, assume it's actually
  // last year (e.g. parsing "Dec 28" in early January).
  const d = new Date(yr, mo, day);
  if ((d.getTime() - now.getTime()) > 60 * 86400000) {
    d.setFullYear(yr - 1);
  }
  return d;
}

// Sort updates newest-first and keep only those within `days` calendar days.
// Items without a parseable date are kept (we'd rather show a maybe-recent
// item than silently drop it).
function pickRecentUpdates(items, days) {
  const cutoff = Date.now() - days * 86400000;
  const withDate = items.map(n => ({ n, d: parseNoteDate(n.date) }));
  // Newest first; undated items float to the top (treated as "recent enough")
  withDate.sort((a, b) => {
    const aT = a.d ? a.d.getTime() : Date.now();
    const bT = b.d ? b.d.getTime() : Date.now();
    return bT - aT;
  });
  return withDate
    .filter(({ d }) => d == null || d.getTime() >= cutoff)
    .map(({ n }) => n);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
