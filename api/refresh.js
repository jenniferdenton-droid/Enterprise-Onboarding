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

import { writeSnapshot, listChannelMappings, listStatusOverrides, listArchivedAccounts, listManualNotes } from "../lib/firebase.js";

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
    // ── Step 1: HubSpot — companies (revenue is on the company record itself
    // as average_l3m_revenue, so no deal join needed anymore) ──
    const companies = await fetchHubSpotCompanies(HUBSPOT_TOKEN);

    // ── Step 1b: Resolve OM + PSM owner IDs to names (non-fatal) ──
    let ownerResolveResult = { ok: false, count: 0, error: null };
    try {
      const ownerMap = await resolveOwners(companies, HUBSPOT_TOKEN);
      ownerResolveResult = {
        ok: true,
        owner_directory_size: Object.keys(ownerMap || {}).length,
        sample_owner_ids: Object.keys(ownerMap || {}).slice(0, 5)
      };
    } catch (e) {
      console.warn("owner resolve failed:", e.message);
      ownerResolveResult = { ok: false, error: e.message };
    }

    // ── Step 2: Slack — discover channels the bot can read ──
    const channels = await listBotChannels(SLACK_BOT_TOKEN);

    // ── Step 2b: Pull persistent channel mappings + status overrides + archived from Firestore ──
    let savedMappings = {};
    let statusOverrides = {};
    let archived = {};
    let manualNotes = {};
    try {
      [savedMappings, statusOverrides, archived, manualNotes] = await Promise.all([
        listChannelMappings(),
        listStatusOverrides(),
        listArchivedAccounts(),
        listManualNotes()
      ]);
    } catch (e) {
      console.warn("Firestore read failed:", e.message);
    }

    // Attach assigned channels + status overrides + archive flag to each company
    for (const c of companies) {
      const m = savedMappings[String(c.hs_object_id)];
      if (m) {
        // Support both legacy single-channel and new multi-channel shapes
        if (Array.isArray(m.channels) && m.channels.length) {
          c.slack_channels = m.channels;
          c.slack_channel_id = m.channels[0].slack_channel_id;
          c.slack_channel_name = m.channels[0].slack_channel_name;
        } else if (m.slack_channel_id) {
          c.slack_channels = [{ slack_channel_id: m.slack_channel_id, slack_channel_name: m.slack_channel_name }];
          c.slack_channel_id = m.slack_channel_id;
          c.slack_channel_name = m.slack_channel_name;
        }
        c.channel_source = m.created_via || "assigned";
      }
      const so = statusOverrides[String(c.hs_object_id)];
      if (so?.status) {
        c.moxie_onboarding_status_override = so.status;
        c.moxie_onboarding_status_override_at = so.updated_at;
      }
      const arc = archived[String(c.hs_object_id)];
      if (arc) {
        c.archived_at = arc.archived_at;
        c.archived_by = arc.archived_by;
        c.archive_reason = arc.reason;
      }
      const mn = manualNotes[String(c.hs_object_id)];
      if (mn?.notes?.length) {
        c.manual_notes = mn.notes;
      }
    }

    // ── Step 3: Map companies to their channels ──
    // Saved mappings (Firestore) win over fuzzy auto-match
    const matches = mapCompaniesToChannels(companies, channels, OVERRIDES, savedMappings);

    // ── Step 4: Pull history from each matched channel (7 days, capped) ──
    const t4 = Date.now();
    const messagesByCompany = await fetchAllChannelHistory(SLACK_BOT_TOKEN, matches, 7);
    console.log(`Slack history fetch took ${Date.now() - t4}ms for ${Object.keys(matches).length} accounts`);

    // ── Step 5: Categorize via Claude ──
    let notes = {};
    if (Object.keys(messagesByCompany).length) {
      const t5 = Date.now();
      notes = await categorizeMessages(messagesByCompany, ANTHROPIC_API_KEY);
      console.log(`Claude categorization took ${Date.now() - t5}ms`);
    }

    // ── Step 5b: AI health score per account (single Claude call) ──
    try {
      const t5b = Date.now();
      const scores = await computeHealthScores(companies, notes, ANTHROPIC_API_KEY);
      for (const c of companies) {
        const key = getCompanyKey(c.name);
        const s = scores[c.hs_object_id] || scores[key];
        if (s) {
          c.health_score = s.score;
          c.health_color = s.color;
          c.health_reasoning = s.reasoning;
        }
      }
      console.log(`Health score took ${Date.now() - t5b}ms`);
    } catch (e) {
      console.warn("Health score failed:", e.message);
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
          .map(ch => ch.name),
        hubspot_field_warnings: fetchHubSpotCompanies._lastFieldErrors || [],
        hubspot_companies_before_lifecycle_filter: fetchHubSpotCompanies._totalBeforeFilter || 0,
        hubspot_lifecycles_seen: fetchHubSpotCompanies._lifecyclesSeen || {},
        hubspot_lifecycle_label_to_value: fetchHubSpotCompanies._stageMap || {},
        hubspot_allowed_stage_values: fetchHubSpotCompanies._allowedStageValues || [],
        owner_resolve: ownerResolveResult
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
  // Pull all 3 active lifecycles. The dashboard tabs control what's visible.
  // Override via HUBSPOT_LIFECYCLES env var if needed.
  const lifecycles = (process.env.HUBSPOT_LIFECYCLES || "pre-launch,onboarding,post-launch customer")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  // Try both segment fields. If either doesn't exist in this HubSpot tenant,
  // log a warning and continue — don't fail the whole refresh.
  // Configurable via HUBSPOT_SEGMENT_FIELDS env var (comma list).
  // NOTE: Moxie's post-launch field has double + trailing underscore (HubSpot
  // legacy naming for "(Post-Launch)" parenthetical labels).
  const segmentFields = (process.env.HUBSPOT_SEGMENT_FIELDS
    || "provider_segment_pre_launch,provider_segment__post_launch_")
    .split(",").map(s => s.trim()).filter(Boolean);

  // Resolve lifecycle stage LABELS → internal VALUES via HubSpot's properties API.
  // Custom lifecycle stages are stored as numeric ids (e.g. "69092992"); built-in
  // ones use the snake_case name ("evangelist"). The properties API gives us both.
  const stageMap = await fetchLifecycleStageMap(token); // { "onboarding": "110575888", "pre-launch": "69092992", ... }
  const allowedLabels = lifecycles.map(s => s.toLowerCase().trim());
  const allowedStageValues = new Set(
    allowedLabels.map(label => (stageMap[label] || label).toString().toLowerCase().trim())
  );
  fetchHubSpotCompanies._stageMap = stageMap;
  fetchHubSpotCompanies._allowedStageValues = [...allowedStageValues];

  const rowsById = new Map();
  const fieldErrors = [];

  // Properties to pull. These match Moxie's HubSpot internal names exactly.
  const REQUESTED_PROPS = [
    "name", "state", "city",
    "provider_segment_pre_launch",
    "provider_segment__post_launch_",
    "lifecyclestage",
    "moxie_onboarding_status", "onboarding_status",
    "kickoff_date",
    "initial_target_launch_date",
    "current_target_launch_date",
    "days_in_onboarding",
    "days_to_close",
    "onboarding_manager",                   // OM owner id
    "provider_success_manager",             // PSM owner id (correct Moxie field name)
    "hubspot_owner_id",                     // generic fallback
    "average_l3m_revenue",                  // L3M monthly revenue (company-direct, no deal join)
    "delayed_reason",                       // why an account is delayed
    "pre_onboarding_reason"                 // pre-onboarding / delayed-kickoff reason
  ];

  // We only filter by SEGMENT in HubSpot (lifecyclestage is filtered in JS below).
  // Reason: HubSpot's EQ is case-sensitive and Moxie's lifecycle values can vary
  // (e.g., "Onboarding" vs "onboarding"). One simple segment filter is bulletproof.
  for (const segField of segmentFields) {
    const filterGroups = [{
      filters: [
        { propertyName: segField, operator: "EQ", value: segment }
      ]
    }];

    let after = undefined;
    let segFieldFailed = false;
    do {
      const r = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          filterGroups,
          properties: REQUESTED_PROPS,
          sorts: [{ propertyName: "kickoff_date", direction: "DESCENDING" }],
          limit: 100,
          after
        })
      });
      if (!r.ok) {
        const errText = await r.text();
        console.warn(`HubSpot segment field "${segField}" failed (${r.status}): ${errText}`);
        fieldErrors.push({ field: segField, status: r.status, error: errText.slice(0, 200) });
        segFieldFailed = true;
        break;
      }
      const data = await r.json();
      for (const row of (data.results || [])) {
        if (!rowsById.has(row.id)) rowsById.set(row.id, row);
      }
      after = data.paging?.next?.after;
    } while (after);

    if (segFieldFailed) continue;  // try the next field, don't abort
  }

  // Track every lifecycle value we saw — so the dashboard /api/refresh response
  // can show us what HubSpot is actually storing (helps debug filter mismatches)
  const allLifecyclesSeen = {};
  for (const row of rowsById.values()) {
    const ls = row.properties?.lifecyclestage || "(empty)";
    allLifecyclesSeen[ls] = (allLifecyclesSeen[ls] || 0) + 1;
  }
  fetchHubSpotCompanies._lifecyclesSeen = allLifecyclesSeen;
  fetchHubSpotCompanies._totalBeforeFilter = rowsById.size;

  // Filter to allowed lifecycle stages — match the raw HubSpot value (which is
  // a numeric id for custom stages, or a snake_case name for built-in stages)
  // against our resolved set of allowed values.
  for (const [id, row] of [...rowsById.entries()]) {
    const ls = (row.properties?.lifecyclestage || "").toString().toLowerCase().trim();
    if (!allowedStageValues.has(ls)) rowsById.delete(id);
  }

  // Reverse-map raw stage values back to canonical labels for the dashboard
  // (so c.lifecyclestage = "onboarding" regardless of whether HubSpot stored it
  // as "Onboarding", "110575888", or anything else).
  const valueToLabel = {};
  for (const [label, value] of Object.entries(stageMap)) {
    valueToLabel[value.toString().toLowerCase().trim()] = label;
  }
  for (const row of rowsById.values()) {
    const raw = (row.properties?.lifecyclestage || "").toString().toLowerCase().trim();
    if (valueToLabel[raw]) {
      // Overwrite the raw value with the human label so the dashboard's lowercase
      // string compare ("onboarding" === c.lifecyclestage) works.
      row.properties.lifecyclestage = valueToLabel[raw];
    }
  }

  // If BOTH fields failed, that's a real problem — surface it
  if (!rowsById.size && fieldErrors.length === segmentFields.length) {
    throw new Error(`All segment fields failed: ${JSON.stringify(fieldErrors)}`);
  }

  // Expose any field warnings in the response meta so the dashboard can show them
  fetchHubSpotCompanies._lastFieldErrors = fieldErrors;

  return Array.from(rowsById.values()).map(row => {
    const p = row.properties || {};
    const rev = parseFloat(p.average_l3m_revenue);
    return {
      hs_object_id: row.id,
      name: p.name || null,
      state: p.state || null,
      city: p.city || null,
      segment_pre_launch: p.provider_segment_pre_launch || null,
      segment_post_launch: p.provider_segment__post_launch_ || null,
      segment: p.provider_segment_pre_launch || p.provider_segment__post_launch_ || null,
      lifecyclestage: (p.lifecyclestage || "").toLowerCase() || null,
      moxie_onboarding_status: p.moxie_onboarding_status || null,
      onboarding_status: p.onboarding_status || null,
      kickoff_date: dateOnly(p.kickoff_date),
      initial_target_launch_date: dateOnly(p.initial_target_launch_date),
      current_target_launch_date: dateOnly(p.current_target_launch_date),
      // Legacy alias kept so any UI code still referencing the old name keeps working
      updated_target_launch_date: dateOnly(p.current_target_launch_date),
      days_in_onboarding: p.days_in_onboarding || null,
      days_to_close: p.days_to_close || null,
      onboarding_manager: p.onboarding_manager || null,
      onboarding_manager_name: null,           // populated by resolveOwners
      provider_success_manager: p.provider_success_manager || null,
      provider_success_manager_name: null,     // populated by resolveOwners
      // Legacy alias so existing UI/digest code keeps working
      practice_success_manager: p.provider_success_manager || null,
      practice_success_manager_name: null,
      monthly_revenue: isNaN(rev) ? null : rev,
      delayed_reason: p.delayed_reason || null,
      pre_onboarding_reason: p.pre_onboarding_reason || null
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// HubSpot owners — resolve owner IDs (OM + PSM) to names + emails
// ────────────────────────────────────────────────────────────────────────────

async function resolveOwners(companies, token) {
  // Collect every unique owner ID we need to look up
  const ownerIds = new Set();
  for (const c of companies) {
    if (c.onboarding_manager) ownerIds.add(String(c.onboarding_manager));
    if (c.provider_success_manager) ownerIds.add(String(c.provider_success_manager));
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

  // Populate the company records (set both new + legacy alias fields)
  for (const c of companies) {
    if (c.onboarding_manager && ownerMap[String(c.onboarding_manager)]) {
      c.onboarding_manager_name = ownerMap[String(c.onboarding_manager)].name;
      c.onboarding_manager_email = ownerMap[String(c.onboarding_manager)].email;
    }
    if (c.provider_success_manager && ownerMap[String(c.provider_success_manager)]) {
      const o = ownerMap[String(c.provider_success_manager)];
      c.provider_success_manager_name = o.name;
      c.provider_success_manager_email = o.email;
      // Legacy alias for existing UI/digest code
      c.practice_success_manager_name = o.name;
      c.practice_success_manager_email = o.email;
    }
  }
  return ownerMap;
}

// ────────────────────────────────────────────────────────────────────────────
// HubSpot — resolve lifecycle stage LABELS to their internal stored VALUES
// ────────────────────────────────────────────────────────────────────────────
// Custom stages are stored as numeric ids (e.g. "69092992"); built-in ones use
// snake_case ("evangelist", "lead"). HubSpot's properties API gives us the
// option list so we can map "Onboarding" → "110575888" automatically.

async function fetchLifecycleStageMap(token) {
  try {
    const r = await fetch("https://api.hubapi.com/crm/v3/properties/companies/lifecyclestage", {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!r.ok) {
      console.warn("Lifecycle property fetch failed:", r.status);
      return {};
    }
    const data = await r.json();
    const map = {};
    for (const opt of (data.options || [])) {
      const label = (opt.label || "").toLowerCase().trim();
      const value = (opt.value || "").toString().toLowerCase().trim();
      if (label && value) map[label] = value;
    }
    return map;
  } catch (e) {
    console.warn("Lifecycle property fetch error:", e.message);
    return {};
  }
}

function dateOnly(s) {
  if (s === null || s === undefined || s === "") return null;
  let d;
  // HubSpot returns datetime fields as ms-since-epoch (often as a numeric string)
  // and date-only fields as "YYYY-MM-DD" strings. Detect numeric input and parse.
  const str = String(s);
  if (/^\d{10,}$/.test(str)) {
    d = new Date(Number(str));
  } else {
    d = new Date(str);
  }
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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

// Stopwords we'll never use as a match token. Kept short on purpose — words like
// "face", "body", "beauty" stay because they're often part of the actual brand
// name (e.g. "Face & Body Boutique" → channel "face-body-boutique").
const STOPWORDS = new Set([
  "the","and","for","with","by","at","of","an","a","to","or","in",
  "med","spa","medspa","inc","llc","co"
]);

// Generic-but-keep words — used as a low-priority fallback when the company
// only has generic words (so we still produce a notes key).
const GENERIC_WORDS = new Set([
  "aesthetics","aesthetic","beauty","wellness","skin","care","clinic",
  "center","studio","boutique","lounge","group"
]);

function getCompanyKey(name) {
  // First significant word for the dashboard notes dictionary
  const words = cleanWords(name);
  return (
    words.find(w => w.length >= 3 && !STOPWORDS.has(w) && !GENERIC_WORDS.has(w))
    || words.find(w => w.length >= 2 && !STOPWORDS.has(w))
    || words[0]
    || ""
  );
}

function getCompanySearchTokens(name) {
  // Tokens for fuzzy channel matching — much more permissive than before:
  //   - allow 2+ char words
  //   - drop only true stopwords
  //   - also emit 2-word hyphenated combinations (so "Re-Glo Aesthetics"
  //     produces "re-glo" which matches channel "re-glo-aesthetics")
  const words = cleanWords(name).filter(w => w.length >= 2 && !STOPWORDS.has(w));
  const tokens = new Set(words);

  // Multi-word combinations
  for (let i = 0; i < words.length - 1; i++) {
    tokens.add(`${words[i]}-${words[i+1]}`);
  }
  if (words.length >= 3) {
    tokens.add(`${words[0]}-${words[1]}-${words[2]}`);
  }

  return [...tokens];
}

function cleanWords(name) {
  return (name || "")
    .toLowerCase()
    .replace(/-\s*\d+$/, "")            // strip trailing "- 2048"
    .replace(/[&]/g, " ")               // ampersands → space
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")                 // also split on internal hyphens
    .split(/\s+/)
    .filter(Boolean);
}

// Match a token against a channel name with word-boundary awareness.
// Short tokens (<4 chars) must match a hyphen-segment exactly.
// Longer tokens can match anywhere in the channel name.
function tokenMatchesChannel(token, channelName) {
  const chSegments = channelName.toLowerCase().split(/[-_\s]+/).filter(Boolean);
  if (token.includes("-")) {
    // multi-word token — substring match (e.g., "re-glo" in "re-glo-aesthetics")
    return channelName.toLowerCase().includes(token);
  }
  if (chSegments.includes(token)) return true;
  if (token.length >= 4) {
    return chSegments.some(seg => seg.includes(token));
  }
  return false;
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

    // 3. Fuzzy match against tokens (word-boundary aware)
    const tokens = getCompanySearchTokens(c.name);
    if (!tokens.length) continue;
    const matched = channels.filter(ch =>
      tokens.some(token => tokenMatchesChannel(token, ch.name))
    );
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
        // Cap at 50 messages per channel — plenty for 7-day window, much faster
        const r = await fetch(
          `https://slack.com/api/conversations.history?channel=${ch.id}&oldest=${oldest}&limit=50`,
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

    // Sort newest first, cap at 5 to keep Claude prompt fast
    allMsgs.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
    if (allMsgs.length) messagesByCompany[companyKey] = allMsgs.slice(0, 5);
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
      model: "claude-haiku-4-5",  // Fast + cheap — categorization doesn't need sonnet
      max_tokens: 4000,
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
// AI Health Score — single Claude call grades all accounts 0-100
// ────────────────────────────────────────────────────────────────────────────

async function computeHealthScores(companies, notesByKey, apiKey) {
  if (!companies.length) return {};

  // Build a compact summary per account for the prompt
  const accountSummaries = companies.map(c => {
    const key = getCompanyKey(c.name);
    const slackNotes = notesByKey[key] || [];
    const blockerCount = slackNotes.filter(n => n.type === "blocker").length;
    const riskCount    = slackNotes.filter(n => n.type === "risk").length;
    const updateCount  = slackNotes.filter(n => n.type === "update").length;
    const recentBlocker = slackNotes.find(n => n.type === "blocker")?.text || null;
    const recentRisk    = slackNotes.find(n => n.type === "risk")?.text || null;
    const manualRisks   = (c.manual_notes || []).filter(n => n.type === "risk" || n.type === "blocker").length;

    const target = c.current_target_launch_date || c.updated_target_launch_date || c.initial_target_launch_date;
    let daysUntilTarget = null;
    if (target) {
      try {
        daysUntilTarget = Math.ceil((new Date(target) - Date.now()) / 86400000);
      } catch { /* */ }
    }

    return {
      id: c.hs_object_id,
      key,
      name: c.name,
      lifecycle: c.lifecyclestage,
      status: c.moxie_onboarding_status_override || c.moxie_onboarding_status,
      days_in_onboarding: c.days_in_onboarding,
      days_until_target: daysUntilTarget,
      delayed_reason: c.delayed_reason,
      pre_onboarding_reason: c.pre_onboarding_reason,
      slack_blocker_count: blockerCount,
      slack_risk_count: riskCount,
      slack_update_count: updateCount,
      recent_blocker: recentBlocker?.slice(0, 200) || null,
      recent_risk: recentRisk?.slice(0, 200) || null,
      manual_risk_count: manualRisks
    };
  });

  const prompt = `You are scoring the onboarding health of enterprise medspa accounts at Moxie (a MedSpa SaaS). Score each account 0-100 where:
- 90-100 (green): Smooth, on track, no significant issues
- 75-89  (green): Healthy with minor risks
- 60-74  (yellow): At risk — delays or single blocker, intervention helpful
- 40-59  (yellow): Significant issues — multiple risks/blockers, needs attention
- 0-39   (red): Critical — likely to churn or fail to launch on time

Weight these signals (higher = worse):
- Slack blockers (heaviest signal) and manual risks logged
- Status = "Delayed Onboarding" or has delayed_reason
- Days_in_onboarding > 60 with no launch in sight (days_until_target negative or far out)
- Pre-onboarding reason filled = client friction before kickoff
- Recent blocker text content (legal, data migration, contract, churn risk = worse)

Pre-launch accounts get a small grace period — being new isn't bad. Launching-soon accounts with no blockers should score high. Overdue accounts with no blockers but past target = still healthy.

Return ONLY a JSON object (no markdown), keyed by company id (string), with this exact shape:

{
  "54662807911": { "score": 78, "color": "green", "reasoning": "On track. Light pre-launch risk noted but no blockers." },
  ...
}

Color: "green" if score >= 75, "yellow" if 40-74, "red" if < 40.
Reasoning: ONE sentence, max 100 chars, specific to this account.

Input accounts:
${JSON.stringify(accountSummaries, null, 2)}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic health ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try { return JSON.parse(match[0]); } catch (e) {
    console.warn("Failed to parse health JSON:", e.message);
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
