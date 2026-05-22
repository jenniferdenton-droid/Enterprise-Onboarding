// ────────────────────────────────────────────────────────────────────────────
// /api/refresh — Live HubSpot + Slack sync for Moxie Enterprise Onboarding
// ────────────────────────────────────────────────────────────────────────────
//
// Architecture:
//   1. Pulls Enterprise-segment companies in lifecycle stages
//      (pre-launch, onboarding, post-launch customer) + deal revenue from HubSpot
//   2. Auto-discovers Slack channels the bot is a member of
//   3. Fuzzy-matches each company to its dedicated channel(s) by name
//      (e.g., "Rivkin Westside Aesthetics" → "rivkin-aesthetics", "rivkin-migration")
//   4. Pulls last 14 days of messages from matched channels
//   5. Classifies each message via Claude as blocker / risk / update
//   6. Writes the snapshot to Firestore so /api/cached can serve fast reads
//
// Required Vercel env vars:
//   HUBSPOT_TOKEN          — pat-na1-...   (HubSpot Private App token)
//   SLACK_BOT_TOKEN        — xoxb-...      (Slack Bot User OAuth token)
//   ANTHROPIC_API_KEY      — sk-ant-...    (Anthropic API key)
//   FIREBASE_PROJECT_ID    — Firestore project (cache write)
//   FIREBASE_CLIENT_EMAIL  — Firebase service account email
//   FIREBASE_PRIVATE_KEY   — Firebase service account private key
//
// Optional:
//   HUBSPOT_SEGMENT        — single value for provider_segment_pre_launch
//                            (default: "Enterprise")
//   HUBSPOT_LIFECYCLES     — comma list of lifecyclestage values to include
//                            (default: "pre-launch,onboarding,post-launch customer")
//   DASHBOARD_PASSWORD     — if set, requests must include x-dashboard-key header
//   SLACK_CHANNEL_OVERRIDES — JSON map for tricky matches:
//       {"chinitas":"dailyn-gonzalez","face & body":"karin-otto-face-and-body"}
//
// Returns: { companies, notes, synced_at, meta }
// ────────────────────────────────────────────────────────────────────────────

import { writeSnapshot, listChannelMappings, listStatusOverrides } from "../lib/firebase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Auth model:
  //   - Human access is gated by Vercel Authentication at the deployment level
  //     (Project → Settings → Deployment Protection). Browsers reach this function
  //     only AFTER Vercel has authenticated them, with no special headers.
  //   - Vercel cron bypasses deployment protection and sends:
  //         Authorization: Bearer ${CRON_SECRET}
  //     We validate that ONLY if the header is present — its absence is normal
  //     for human requests.
  //   - Optional: x-dashboard-key can still be used by programmatic clients
  //     (curl, Postman) if DASHBOARD_PASSWORD is set.
  const bearer = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (bearer && process.env.CRON_SECRET && bearer !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized (bad bearer)" });
  }
  if (process.env.DASHBOARD_PASSWORD) {
    const userKey = req.headers["x-dashboard-key"];
    // Only enforce IF a key header is sent; absent header = browser/cron, allowed.
    if (userKey && userKey !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: "unauthorized (bad key)" });
    }
  }

  const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const OVERRIDES = parseJsonEnv("SLACK_CHANNEL_OVERRIDES");

  const missing = [];
  if (!HUBSPOT_TOKEN)     missing.push("HUBSPOT_TOKEN");
  if (!SLACK_BOT_TOKEN)   missing.push("SLACK_BOT_TOKEN");
  if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (missing.length) return res.status(500).json({ error: `Missing env vars: ${missing.join(", ")}` });

  try {
    // ── Step 1: HubSpot — companies + deal revenue ──
    const companies = await fetchHubSpotCompanies(HUBSPOT_TOKEN);
    await enrichWithDealRevenue(companies, HUBSPOT_TOKEN);

    // ── Step 1b: Resolve OM + PSM owner IDs to names (non-fatal) ──
    try { await resolveOwners(companies, HUBSPOT_TOKEN); }
    catch (e) { console.warn("owner resolve failed:", e.message); }

    // ── Step 2: Slack — discover channels the bot can read ──
    const channels = await listBotChannels(SLACK_BOT_TOKEN);

    // ── Step 2b: Pull persistent channel mappings + status overrides from Firestore ──
    let savedMappings = {};
    let statusOverrides = {};
    try {
      [savedMappings, statusOverrides] = await Promise.all([
        listChannelMappings(),
        listStatusOverrides()
      ]);
    } catch (e) {
      console.warn("Firestore read failed:", e.message);
    }

    // Attach assigned channels + dashboard status overrides to each company
    for (const c of companies) {
      const m = savedMappings[String(c.hs_object_id)];
      if (m) {
        c.slack_channel_id = m.slack_channel_id;
        c.slack_channel_name = m.slack_channel_name;
        c.channel_source = m.created_via || "assigned";
      }
      const so = statusOverrides[String(c.hs_object_id)];
      if (so?.status) {
        c.moxie_onboarding_status_override = so.status;
        c.moxie_onboarding_status_override_at = so.updated_at;
      }
    }

    // ── Step 3: Map companies to their channels ──
    // Saved mappings (Firestore) win over fuzzy auto-match
    const matches = mapCompaniesToChannels(companies, channels, OVERRIDES, savedMappings);

    // ── Step 4: Pull history from each matched channel ──
    const messagesByCompany = await fetchAllChannelHistory(SLACK_BOT_TOKEN, matches, 14);

    // ── Step 5: Categorize via Claude ──
    let notes = {};
    if (Object.keys(messagesByCompany).length) {
      notes = await categorizeMessages(messagesByCompany, ANTHROPIC_API_KEY);
    }

    const payload = {
      companies,
      notes,
      synced_at: new Date().toISOString(),
      meta: {
        company_count: companies.length,
        channels_discovered: channels.length,
        accounts_with_channels: Object.keys(matches).length,
        accounts_with_notes: Object.keys(notes).length,
        unmatched_channels: channels
          .filter(ch => !Object.values(matches).flat().some(m => m.id === ch.id))
          .map(ch => ch.name)
      }
    };

    // ── Step 6: Write to Firestore so /api/cached can serve fast reads ──
    try {
      await writeSnapshot(payload);
      payload.meta.cache_written = true;
    } catch (e) {
      // Cache write is best-effort; never fail the request because of it
      console.warn("Firestore cache write failed:", e.message);
      payload.meta.cache_written = false;
      payload.meta.cache_error = e.message;
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error("refresh error:", e);
    return res.status(500).json({ error: e.message || "refresh failed" });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HubSpot
// ────────────────────────────────────────────────────────────────────────────

async function fetchHubSpotCompanies(token) {
  // Filter: (provider_segment_pre_launch = Enterprise  OR  provider_segment_post_launch = Enterprise)
  //         AND lifecyclestage IN (pre-launch, onboarding, post-launch customer)
  //
  // HubSpot search caps filterGroups at 5 and within a group filters are AND'd,
  // so we do TWO passes (one per segment field) and dedupe by hs_object_id.
  const segment = (process.env.HUBSPOT_SEGMENT || "Enterprise").trim();
  const lifecycles = (process.env.HUBSPOT_LIFECYCLES || "pre-launch,onboarding,post-launch customer")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const segmentFields = ["provider_segment_pre_launch", "provider_segment_post_launch"];
  const rowsById = new Map();

  for (const segField of segmentFields) {
    const filterGroups = lifecycles.map(ls => ({
      filters: [
        { propertyName: segField, operator: "EQ", value: segment },
        { propertyName: "lifecyclestage", operator: "EQ", value: ls }
      ]
    }));

    let after = undefined;
    do {
      const r = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          filterGroups,
          properties: [
            "name", "state", "city",
            "provider_segment_pre_launch", "provider_segment_post_launch", "lifecyclestage",
            "moxie_onboarding_status", "onboarding_status",
            "kickoff_date", "initial_target_launch_date", "updated_target_launch_date",
            "days_in_onboarding",
            "onboarding_manager",                  // OM owner id
            "practice_success_manager",            // PSM owner id (post-launch)
            "practice_success_manager__at_launch_", // PSM at-launch owner id (HubSpot internal name varies)
            "hubspot_owner_id"
          ],
          sorts: [{ propertyName: "kickoff_date", direction: "DESCENDING" }],
          limit: 100,
          after
        })
      });
      if (!r.ok) throw new Error(`HubSpot companies (${segField}) ${r.status}: ${await r.text()}`);
      const data = await r.json();
      for (const row of (data.results || [])) {
        if (!rowsById.has(row.id)) rowsById.set(row.id, row);
      }
      after = data.paging?.next?.after;
    } while (after);
  }

  return Array.from(rowsById.values()).map(row => ({
    hs_object_id: row.id,
    name: row.properties.name || null,
    state: row.properties.state || null,
    city: row.properties.city || null,
    segment_pre_launch: row.properties.provider_segment_pre_launch || null,
    segment_post_launch: row.properties.provider_segment_post_launch || null,
    segment: row.properties.provider_segment_pre_launch || row.properties.provider_segment_post_launch || null,
    lifecyclestage: (row.properties.lifecyclestage || "").toLowerCase() || null,
    moxie_onboarding_status: row.properties.moxie_onboarding_status || null,
    onboarding_status: row.properties.onboarding_status || null,
    kickoff_date: dateOnly(row.properties.kickoff_date),
    initial_target_launch_date: dateOnly(row.properties.initial_target_launch_date),
    updated_target_launch_date: dateOnly(row.properties.updated_target_launch_date),
    days_in_onboarding: row.properties.days_in_onboarding || null,
    onboarding_manager: row.properties.onboarding_manager || null,
    onboarding_manager_name: null,             // populated by resolveOwners
    practice_success_manager: row.properties.practice_success_manager
      || row.properties.practice_success_manager__at_launch_
      || null,
    practice_success_manager_name: null,       // populated by resolveOwners
    monthly_revenue: null
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// HubSpot owners — resolve owner IDs (OM + PSM) to names + emails
// ────────────────────────────────────────────────────────────────────────────

async function resolveOwners(companies, token) {
  // Collect every unique owner ID we need to look up
  const ownerIds = new Set();
  for (const c of companies) {
    if (c.onboarding_manager) ownerIds.add(String(c.onboarding_manager));
    if (c.practice_success_manager) ownerIds.add(String(c.practice_success_manager));
  }
  if (!ownerIds.size) return {};

  // Pull the full owner directory once (cheaper than N individual lookups)
  const ownerMap = {}; // id -> { name, email }
  let after = undefined;
  do {
    const url = `https://api.hubapi.com/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`;
    const r = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
    if (!r.ok) {
      console.warn(`HubSpot owners ${r.status}: ${await r.text()}`);
      break;
    }
    const data = await r.json();
    for (const o of (data.results || [])) {
      const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || `Owner #${o.id}`;
      ownerMap[String(o.id)] = { name, email: o.email || null };
    }
    after = data.paging?.next?.after;
  } while (after);

  // Populate the company records
  for (const c of companies) {
    if (c.onboarding_manager && ownerMap[String(c.onboarding_manager)]) {
      c.onboarding_manager_name = ownerMap[String(c.onboarding_manager)].name;
      c.onboarding_manager_email = ownerMap[String(c.onboarding_manager)].email;
    }
    if (c.practice_success_manager && ownerMap[String(c.practice_success_manager)]) {
      c.practice_success_manager_name = ownerMap[String(c.practice_success_manager)].name;
      c.practice_success_manager_email = ownerMap[String(c.practice_success_manager)].email;
    }
  }
  return ownerMap;
}

async function enrichWithDealRevenue(companies, token) {
  await Promise.all(companies.map(async (c) => {
    try {
      const a = await fetch(
        `https://api.hubapi.com/crm/v4/objects/companies/${c.hs_object_id}/associations/deals`,
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      if (!a.ok) return;
      const assoc = await a.json();
      const dealIds = (assoc.results || []).map(r => r.toObjectId).filter(Boolean);
      if (!dealIds.length) return;

      const d = await fetch(
        `https://api.hubapi.com/crm/v3/objects/deals/${dealIds[0]}?properties=monthly_medspa_revenue,dealname`,
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      if (!d.ok) return;
      const deal = await d.json();
      const rev = parseFloat(deal.properties?.monthly_medspa_revenue);
      if (!isNaN(rev) && rev > 0) c.monthly_revenue = rev;
    } catch { /* non-fatal */ }
  }));
}

function dateOnly(s) {
  if (!s) return null;
  try { return new Date(s).toISOString().slice(0, 10); } catch { return s; }
}

// ────────────────────────────────────────────────────────────────────────────
// Slack — discover channels and pull history
// ────────────────────────────────────────────────────────────────────────────

async function listBotChannels(token) {
  // users.conversations returns channels the bot is a member of
  const all = [];
  let cursor = "";
  do {
    const url = "https://slack.com/api/users.conversations?types=public_channel,private_channel&limit=200" +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
    const data = await r.json();
    if (!data.ok) throw new Error(`Slack list: ${data.error}`);
    for (const ch of (data.channels || [])) {
      all.push({ id: ch.id, name: ch.name, is_private: !!ch.is_private });
    }
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);
  return all;
}

// Words that don't uniquely identify a medspa account
const GENERIC_WORDS = new Set([
  "the","and","for","with","by","at","of","an","a",
  "aesthetics","aesthetic","medspa","med","spa","beauty","wellness",
  "skin","body","face","care","clinic","center","studio","boutique",
  "lounge","group","co","inc","llc"
]);

function getCompanyKey(name) {
  // First significant non-generic word, used as the dashboard's notes key
  const words = (name || "")
    .toLowerCase()
    .replace(/-\s*\d+$/, "")
    .replace(/[^a-z\s&]/g, " ")
    .split(/\s+/);
  return words.find(w => w.length >= 3 && !GENERIC_WORDS.has(w)) || words[0] || "";
}

function getCompanySearchWords(name) {
  // All distinctive words used for fuzzy channel matching
  return (name || "")
    .toLowerCase()
    .replace(/-\s*\d+$/, "")
    .replace(/[^a-z\s&]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !GENERIC_WORDS.has(w));
}

function mapCompaniesToChannels(companies, channels, overrides, savedMappings = {}) {
  const result = {}; // companyKey -> [{id, name}]
  const usedChannels = new Set();
  const channelById = Object.fromEntries(channels.map(ch => [ch.id, ch]));

  for (const c of companies) {
    const key = getCompanyKey(c.name);
    if (!key) continue;

    // 1. Persistent Firestore mapping wins (assigned via /api/channels)
    const saved = savedMappings[String(c.hs_object_id)];
    if (saved && saved.slack_channel_id) {
      const ch = channelById[saved.slack_channel_id]
        || { id: saved.slack_channel_id, name: saved.slack_channel_name, is_private: false };
      result[key] = [ch];
      usedChannels.add(ch.id);
      continue;
    }

    // 2. Manual env-var override
    if (overrides[key]) {
      const sub = overrides[key].toLowerCase();
      const matched = channels.filter(ch => ch.name.toLowerCase().includes(sub));
      if (matched.length) {
        result[key] = matched;
        matched.forEach(m => usedChannels.add(m.id));
        continue;
      }
    }

    // 3. Fuzzy match against significant words
    const words = getCompanySearchWords(c.name);
    if (!words.length) continue;
    const matched = channels.filter(ch => {
      const chName = ch.name.toLowerCase();
      return words.some(w => chName.includes(w));
    });
    if (matched.length) {
      result[key] = matched;
      matched.forEach(m => usedChannels.add(m.id));
    }
  }
  return result;
}

async function fetchAllChannelHistory(token, matches, daysBack) {
  const oldest = Math.floor(Date.now() / 1000 - daysBack * 86400);
  const messagesByCompany = {};

  await Promise.all(Object.entries(matches).map(async ([companyKey, chs]) => {
    const allMsgs = [];
    await Promise.all(chs.map(async (ch) => {
      try {
        const r = await fetch(
          `https://slack.com/api/conversations.history?channel=${ch.id}&oldest=${oldest}&limit=200`,
          { headers: { "Authorization": `Bearer ${token}` } }
        );
        const data = await r.json();
        if (!data.ok) {
          console.warn(`Slack history ${ch.name} (${ch.id}): ${data.error}`);
          return;
        }
        for (const m of (data.messages || [])) {
          if (!m.text) continue;
          if (m.subtype && m.subtype !== "thread_broadcast") continue;
          allMsgs.push({
            channel: ch.name,
            text: m.text,
            ts: m.ts,
            date: new Date(parseFloat(m.ts) * 1000)
              .toLocaleDateString("en-US", { month: "short", day: "numeric" })
          });
        }
      } catch (e) {
        console.warn(`Channel ${ch.name} fetch failed:`, e.message);
      }
    }));

    // Sort newest first, cap at 12 to keep Claude prompt manageable
    allMsgs.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
    if (allMsgs.length) messagesByCompany[companyKey] = allMsgs.slice(0, 12);
  }));

  return messagesByCompany;
}

// ────────────────────────────────────────────────────────────────────────────
// Claude — Categorize Slack messages as blocker / risk / update
// ────────────────────────────────────────────────────────────────────────────

async function categorizeMessages(messagesByCompany, apiKey) {
  if (!Object.keys(messagesByCompany).length) return {};

  // Strip ts/channel from prompt input — Claude only needs date + text
  const promptInput = {};
  for (const [k, msgs] of Object.entries(messagesByCompany)) {
    promptInput[k] = msgs.map(m => ({ date: m.date, text: m.text }));
  }

  const prompt = `You are categorizing Slack messages from Moxie's enterprise medspa onboarding channels. Each account has its own channel; all messages below are about the named account.

For each account, classify each message as ONE of:
- "blocker" — actively preventing forward progress (legal issues, missing data, vendor delays, contract disputes, customer threatening to walk)
- "risk"    — concern or potential issue (timeline slip, customer hesitation, scope creep, expectation gaps, sales-promised features that may not deliver)
- "update"  — neutral or positive progress note (kickoff complete, milestone hit, scheduled call, document received)

Summarize each message to 1-2 concise sentences. Preserve specific names, dates, dollar amounts, and product/vendor names (Nextech, Portrait, BLVD, Hart, PatientNow, etc.). Drop pleasantries and chitchat. Skip purely social messages.

Return ONLY a JSON object (no markdown, no explanation, no preamble) keyed by the same account keys as the input. For each account, return up to 5 of the most important and recent messages, newest first:

{
  "rivkin": [
    {"type":"blocker","date":"Apr 29","text":"<concise summary>"},
    ...
  ],
  ...
}

Input messages by account:
${JSON.stringify(promptInput, null, 2)}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { return JSON.parse(m[0]); } catch (e) {
    console.warn("Failed to parse Claude JSON:", e.message);
    return {};
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function parseJsonEnv(name) {
  const v = process.env[name];
  if (!v) return {};
  try { return JSON.parse(v); } catch { return {}; }
}
