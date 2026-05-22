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

  const timing = { start: Date.now() };

  try {
    // ── Step 1: HubSpot — companies + deal revenue + launch-date history ──
    const t1 = Date.now();
    const companies = await fetchHubSpotCompanies(HUBSPOT_TOKEN);
    timing.hubspot_companies_ms = Date.now() - t1;

    // Run revenue + launch-history enrichments in parallel — both independent
    const t1b = Date.now();
    await Promise.all([
      enrichWithDealRevenue(companies, HUBSPOT_TOKEN).catch(e => console.warn("deal revenue:", e.message)),
      fetchLaunchDateHistory(companies, HUBSPOT_TOKEN).catch(e => console.warn("launch history:", e.message))
    ]);
    timing.hubspot_enrichment_ms = Date.now() - t1b;

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

    // Mode controls how much of the pipeline runs:
    //   "hubspot"    = HubSpot pull only, no Slack, no AI (~10s)
    //   "slack"      = HubSpot + Slack pull (raw messages), NO AI (~15-20s) — fast data verification
    //   "ai"         = AI categorization ONLY for the given ?section= lifecycle stage (~10-15s)
    //                  reads from last snapshot, runs AI on filtered accounts, merges back
    //   (default)    = full pipeline including Slack + AI categorization (~30-45s)
    //
    // Optional ?section= filters AI to one lifecycle stage:
    //   "onboarding" | "pre-launch" | "post-launch customer"
    //   When set, AI only runs on accounts in that stage; other stages keep their previous AI notes.
    const mode = (req.query?.mode || "").toLowerCase();
    const section = (req.query?.section || "").toLowerCase().trim();
    const hubspotOnly = mode === "hubspot";
    const aiOnly = mode === "ai";
    const skipAI = mode === "slack" || mode === "hubspot";

    // ── Step 2: Slack — discover channels the bot can read ──
    const channels = hubspotOnly ? [] : await listBotChannels(SLACK_BOT_TOKEN);

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

    // ── Step 3-5: Slack + AI (skipped in hubspot-only mode) ──
    let matches = {};
    let messagesByCompany = {};
    let notes = {};

    if (!hubspotOnly) {
      // ARCHIVED accounts are excluded from Slack pull + AI entirely so we
      // don't burn tokens or fetch history for completed/archived medspas.
      // They stay in `companies` so the Archived tab still works.
      const activeCompanies = companies.filter(c => !c.archived_at);
      const archivedCount = companies.length - activeCompanies.length;
      if (archivedCount > 0) {
        console.log(`Excluding ${archivedCount} archived account(s) from Slack + AI`);
      }
      // Map active companies to their channels (saved mappings win over fuzzy auto-match)
      matches = mapCompaniesToChannels(activeCompanies, channels, OVERRIDES, savedMappings);

      // PHASE 1: Pull raw Slack history (NO AI yet — just data collection).
      // 14 BUSINESS days. Override via SLACK_HISTORY_BUSINESS_DAYS env var.
      const historyDays = parseInt(process.env.SLACK_HISTORY_BUSINESS_DAYS) || 14;
      const t4 = Date.now();
      messagesByCompany = await fetchAllChannelHistory(SLACK_BOT_TOKEN, matches, historyDays);
      timing.slack_history_ms = Date.now() - t4;
      console.log(`Slack raw pull (${historyDays} business days, with threads) took ${timing.slack_history_ms}ms for ${Object.keys(matches).length} accounts`);

      // Attach raw messages to each company for transparency / debugging
      for (const c of companies) {
        const key = getCompanyKey(c.name);
        if (messagesByCompany[key]) {
          c.raw_slack_messages = messagesByCompany[key].map(m => ({
            date: m.date,
            channel: m.channel,
            text: m.text,
            ts: m.ts
          }));
        }
      }

      // PHASE 2: AI analysis on the raw messages
      if (skipAI) {
        console.log(`Skipping AI categorization (mode=${mode}) — raw messages saved for review`);
        // Preserve existing AI notes from previous full-run cache if available
        try {
          const { readSnapshot } = await import("../lib/firebase.js");
          const cached = await readSnapshot();
          if (cached?.notes) notes = cached.notes;
        } catch (e) { /* non-fatal */ }
      } else if (Object.keys(messagesByCompany).length) {
        // Build the set of messages we'll send to AI. If ?section= specified,
        // only include accounts in that lifecycle stage — keeps each AI call short.
        let messagesToAnalyze = messagesByCompany;
        let priorNotes = {};

        if (section) {
          const sectionKeys = new Set(
            companies
              .filter(c => !c.archived_at) // archived accounts excluded from AI
              .filter(c => (c.lifecyclestage || "").toLowerCase().trim() === section)
              .map(c => getCompanyKey(c.name))
          );
          messagesToAnalyze = Object.fromEntries(
            Object.entries(messagesByCompany).filter(([k]) => sectionKeys.has(k))
          );
          // Load prior notes from other sections — we'll merge ours into them
          try {
            const { readSnapshot } = await import("../lib/firebase.js");
            const cached = await readSnapshot();
            if (cached?.notes) priorNotes = cached.notes;
          } catch (e) { /* non-fatal */ }
          console.log(`AI section=${section}: ${Object.keys(messagesToAnalyze).length} accounts to analyze`);
        }

        const t5 = Date.now();
        const newNotes = await categorizeMessages(messagesToAnalyze, ANTHROPIC_API_KEY);
        timing.claude_categorize_ms = Date.now() - t5;
        console.log(`Claude categorization (chunked parallel) took ${timing.claude_categorize_ms}ms`);

        // Merge: section's new notes override prior section notes for those accounts
        notes = section ? { ...priorNotes, ...newNotes } : newNotes;
      }

      // AI health score — DISABLED for now. The UI hides the badge (Leslie is
      // training the model separately). Skipping this step saves ~5-10s of
      // Claude time so /api/refresh stays under the 60s Vercel budget while
      // the categorize step does 25-msg-per-account analysis.
      // To re-enable later: uncomment + restore the call to computeHealthScores.
      handler._lastHealthResult = { ok: false, reason: "disabled — UI hidden, model in training" };
    } else {
      // In hubspot-only mode, preserve existing health scores + notes from cache
      // so they don't disappear when only HubSpot data is refreshed.
      try {
        const { readSnapshot } = await import("../lib/firebase.js");
        const cached = await readSnapshot();
        if (cached?.companies) {
          const byId = Object.fromEntries(cached.companies.map(c => [String(c.hs_object_id), c]));
          for (const c of companies) {
            const prev = byId[String(c.hs_object_id)];
            if (prev) {
              if (prev.health_score != null) {
                c.health_score = prev.health_score;
                c.health_color = prev.health_color;
                c.health_reasoning = prev.health_reasoning;
              }
            }
          }
          if (cached.notes) notes = cached.notes;
        }
      } catch (e) {
        console.warn("Cache read for HubSpot-only mode failed:", e.message);
      }
    }

    // Track when AI last ran — used by the dashboard to dedupe same-day re-runs
    // and avoid wasting Anthropic tokens. Slack-only / HubSpot-only runs don't reset it.
    let lastAiRunAt = null;
    if (!skipAI) {
      lastAiRunAt = new Date().toISOString();
    } else {
      // Preserve previous last_ai_run_at when only Slack/HubSpot ran
      try {
        const { readSnapshot } = await import("../lib/firebase.js");
        const cached = await readSnapshot();
        lastAiRunAt = cached?.last_ai_run_at || null;
      } catch (e) { /* non-fatal */ }
    }

    const payload = {
      companies,
      notes,
      synced_at: new Date().toISOString(),
      last_ai_run_at: lastAiRunAt,
      meta: {
        mode: hubspotOnly ? "hubspot" : (skipAI ? "slack" : "full"),
        company_count: companies.length,
        archived_count: companies.filter(c => c.archived_at).length,
        active_count: companies.filter(c => !c.archived_at).length,
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
        owner_resolve: ownerResolveResult,
        health_score_result: handler._lastHealthResult || { ok: false, reason: "skipped (hubspot-only mode)" },
        deal_revenue_result: enrichWithDealRevenue._lastResult || { ok: false, reason: "not yet run" },
        timing_ms: { ...timing, total_ms: Date.now() - timing.start },
        slack_raw_total: Object.values(messagesByCompany).reduce((sum, msgs) => sum + msgs.length, 0),
        slack_raw_by_account: Object.fromEntries(
          Object.entries(messagesByCompany).map(([k, msgs]) => [k, msgs.length])
        )
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
    "medspa_id",                            // Moxie internal medspa id — joins to Deal.medspa_id__sync_
    "provider_segment_pre_launch",
    "provider_segment__post_launch_",
    "lifecyclestage",
    "moxie_onboarding_status", "onboarding_status",
    "kickoff_date",
    "initial_target_launch_date",
    "updated_target_launch_date",           // primary target launch field (Moxie naming)
    "current_target_launch_date",           // legacy alias kept for safety
    "days_in_onboarding",
    "days_to_close",
    "onboarding_manager",                   // OM owner id
    "provider_success_manager",             // PSM owner id (correct Moxie field name)
    "hubspot_owner_id",                     // generic fallback
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
    // Primary launch date = updated_target_launch_date (Moxie's canonical field).
    // Fall back to current_target_launch_date if updated is empty.
    const target = p.updated_target_launch_date || p.current_target_launch_date;
    return {
      hs_object_id: row.id,
      medspa_id: p.medspa_id || null,
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
      updated_target_launch_date: dateOnly(target),
      // Alias for any old code path
      current_target_launch_date: dateOnly(target),
      days_in_onboarding: p.days_in_onboarding || null,
      days_to_close: p.days_to_close || null,
      onboarding_manager: p.onboarding_manager || null,
      onboarding_manager_name: null,           // populated by resolveOwners
      provider_success_manager: p.provider_success_manager || null,
      provider_success_manager_name: null,     // populated by resolveOwners
      // Legacy alias so existing UI/digest code keeps working
      practice_success_manager: p.provider_success_manager || null,
      practice_success_manager_name: null,
      monthly_revenue: null,                   // populated by enrichWithDealRevenue
      delayed_reason: p.delayed_reason || null,
      pre_onboarding_reason: p.pre_onboarding_reason || null
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Deal revenue enrichment — Moxie joins Deal→Company via custom field
//   Deal.medspa_id__sync_  ==  Company.medspa_id
// We use a single batched HubSpot search instead of N association calls.
// ────────────────────────────────────────────────────────────────────────────

async function enrichWithDealRevenue(companies, token) {
  // Build map of medspa_id → company object so we can route results back
  const medspaToCompany = {};
  const medspaIds = [];
  for (const c of companies) {
    if (c.medspa_id) {
      const id = String(c.medspa_id);
      medspaToCompany[id] = c;
      medspaIds.push(id);
    }
  }
  if (!medspaIds.length) {
    enrichWithDealRevenue._lastResult = { ok: true, matched: 0, reason: "no companies have medspa_id" };
    return;
  }

  // HubSpot search caps `values` at 100 — chunk if more
  const chunks = [];
  for (let i = 0; i < medspaIds.length; i += 100) {
    chunks.push(medspaIds.slice(i, i + 100));
  }

  let matched = 0;
  let dealCount = 0;
  let lastError = null;

  for (const chunk of chunks) {
    try {
      // Paginate through deals matching this batch of medspa_ids
      let after = undefined;
      do {
        const r = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            filterGroups: [{
              filters: [
                { propertyName: "medspa_id__sync_", operator: "IN", values: chunk }
              ]
            }],
            properties: ["medspa_id__sync_", "monthly_medspa_revenue", "dealname", "dealstage", "createdate"],
            sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
            limit: 100,
            after
          })
        });
        if (!r.ok) {
          lastError = `${r.status}: ${await r.text()}`;
          console.warn(`Deal revenue search failed: ${lastError}`);
          break;
        }
        const data = await r.json();
        for (const deal of (data.results || [])) {
          dealCount++;
          const id = String(deal.properties?.medspa_id__sync_ || "");
          const rev = parseFloat(deal.properties?.monthly_medspa_revenue);
          if (!id || isNaN(rev) || rev <= 0) continue;
          const c = medspaToCompany[id];
          if (!c) continue;
          // If the company already has a revenue (from an earlier deal), keep the higher one
          if (!c.monthly_revenue || rev > c.monthly_revenue) {
            c.monthly_revenue = rev;
            matched++;
          }
        }
        after = data.paging?.next?.after;
      } while (after);
    } catch (e) {
      lastError = e.message;
      console.warn("Deal revenue enrichment error:", e.message);
    }
  }

  enrichWithDealRevenue._lastResult = {
    ok: !lastError,
    companies_with_medspa_id: medspaIds.length,
    deals_returned: dealCount,
    matched,
    error: lastError
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Launch date change detection — uses HubSpot property history.
// Fills c.launch_date_change_type ("pushed_back" | "moved_up" | "removed"),
//        c.launch_date_previous_value, c.launch_date_changed_at.
// ────────────────────────────────────────────────────────────────────────────

async function fetchLaunchDateHistory(companies, token) {
  if (!companies.length) return;
  // HubSpot batch read supports max 100 ids per call
  const batches = [];
  for (let i = 0; i < companies.length; i += 100) {
    batches.push(companies.slice(i, i + 100));
  }

  await Promise.all(batches.map(async (batch) => {
    try {
      const r = await fetch("https://api.hubapi.com/crm/v3/objects/companies/batch/read", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: batch.map(c => ({ id: c.hs_object_id })),
          properties: ["updated_target_launch_date"],
          propertiesWithHistory: ["updated_target_launch_date"]
        })
      });
      if (!r.ok) {
        console.warn("Launch date history batch failed:", r.status);
        return;
      }
      const data = await r.json();
      for (const row of (data.results || [])) {
        const history = row.propertiesWithHistory?.updated_target_launch_date;
        if (!Array.isArray(history) || history.length < 2) continue;

        // History is newest first
        const current = history[0];
        const previous = history[1];

        // Convert both to date-only strings for comparison
        const currVal = current.value ? dateOnly(current.value) : null;
        const prevVal = previous.value ? dateOnly(previous.value) : null;

        let changeType = null;
        if (currVal === prevVal) continue; // no real change
        if (!currVal) changeType = "removed";
        else if (!prevVal) continue; // first set, not a change
        else if (new Date(currVal) > new Date(prevVal)) changeType = "pushed_back";
        else changeType = "moved_up";

        // Find the company and attach
        const c = companies.find(c => String(c.hs_object_id) === String(row.id));
        if (c) {
          c.launch_date_change_type = changeType;
          c.launch_date_previous_value = prevVal;
          c.launch_date_changed_at = current.timestamp || null;
        }
      }
    } catch (e) {
      console.warn("Launch date history fetch error:", e.message);
    }
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

// 14 BUSINESS days = walk back skipping weekends
function businessDaysAgoEpoch(days) {
  const d = new Date();
  let count = 0;
  while (count < days) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

async function fetchAllChannelHistory(token, matches, businessDaysBack) {
  // 14 business days ≈ 20 calendar days. We compute the exact epoch.
  const oldest = businessDaysAgoEpoch(businessDaysBack);
  const messagesByCompany = {};

  await Promise.all(Object.entries(matches).map(async ([companyKey, chs]) => {
    const allMsgs = [];
    await Promise.all(chs.map(async (ch) => {
      try {
        // Cap at 150 messages per channel — covers the 14-business-day window
        const r = await fetch(
          `https://slack.com/api/conversations.history?channel=${ch.id}&oldest=${oldest}&limit=150`,
          { headers: { "Authorization": `Bearer ${token}` } }
        );
        const data = await r.json();
        if (!data.ok) {
          console.warn(`Slack history ${ch.name} (${ch.id}): ${data.error}`);
          return;
        }

        // First pass: collect top-level messages
        const topLevel = [];
        for (const m of (data.messages || [])) {
          if (!m.text) continue;
          if (m.subtype && m.subtype !== "thread_broadcast") continue;
          topLevel.push(m);
        }

        // Second pass: for messages with threads, fetch replies + merge inline
        await Promise.all(topLevel.map(async (m) => {
          let mergedText = m.text;
          if (m.reply_count > 0 && m.thread_ts) {
            try {
              const tr = await fetch(
                `https://slack.com/api/conversations.replies?channel=${ch.id}&ts=${m.thread_ts}&limit=20`,
                { headers: { "Authorization": `Bearer ${token}` } }
              );
              const td = await tr.json();
              if (td.ok && Array.isArray(td.messages) && td.messages.length > 1) {
                const replies = td.messages.slice(1).filter(r => r.text);
                if (replies.length) {
                  const replyText = replies.map(r => `  ↳ ${r.text}`).join("\n");
                  mergedText = `${m.text}\n${replyText}`;
                }
              }
            } catch { /* non-fatal */ }
          }

          allMsgs.push({
            channel: ch.name,
            text: mergedText,
            ts: m.ts,
            reply_count: m.reply_count || 0,
            date: new Date(parseFloat(m.ts) * 1000)
              .toLocaleDateString("en-US", { month: "short", day: "numeric" })
          });
        }));
      } catch (e) {
        console.warn(`Channel ${ch.name} fetch failed:`, e.message);
      }
    }));

    // Sort newest first. Cap at 20 messages per company so Claude has solid
    // context but doesn't blow the output token budget.
    // Also filter out obvious noise BEFORE sending to AI.
    allMsgs.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
    const NOISE_PATTERNS = [
      /^(thanks!?|thank you|ty|np|👍|ok|okay|got it|yes|no|sure|sounds good|will do|on it)$/i,
      /^was added to /,
      /^joined #/,
      /^renamed the channel/,
      /^made this channel/,
      /^set the channel topic/,
      /^set the channel purpose/
    ];
    const filtered = allMsgs.filter(m => {
      const t = (m.text || "").trim();
      if (t.length < 3) return false;
      return !NOISE_PATTERNS.some(p => p.test(t));
    });
    if (filtered.length) {
      // Trim each message to 500 chars to keep prompt size reasonable
      messagesByCompany[companyKey] = filtered.slice(0, 20).map(m => ({
        ...m,
        text: (m.text || "").slice(0, 500)
      }));
    }
  }));

  return messagesByCompany;
}

// ────────────────────────────────────────────────────────────────────────────
// Claude — Categorize Slack messages as blocker / risk / update
// ────────────────────────────────────────────────────────────────────────────

async function categorizeMessages(messagesByCompany, apiKey) {
  const keys = Object.keys(messagesByCompany);
  if (!keys.length) return {};

  // CHUNKED PARALLEL CATEGORIZATION
  // Each chunk handles 3 accounts. Smaller chunks = each Claude call generates
  // ~30 items max (3 × 10) instead of 80+, so each call finishes in ~8-10s
  // instead of timing out. Parallelism handles the count (e.g. 25 accounts → 9 chunks).
  const CHUNK_SIZE = 3;
  const chunks = [];
  for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
    const chunk = {};
    for (const k of keys.slice(i, i + CHUNK_SIZE)) {
      chunk[k] = messagesByCompany[k].map(m => ({ date: m.date, text: m.text }));
    }
    chunks.push(chunk);
  }

  const promptFor = (chunkInput) => `You are analyzing 14 business days of Slack conversation history for Moxie's enterprise medspa onboarding accounts. Each account has its own channel.

TASK: For each account, extract every substantive distinct event/topic from the messages. The goal is THOROUGH COVERAGE — be GENEROUS in what you include, not minimal. Aim for 10-15 items per account if the conversation supports it.

⚠️ CRITICAL — DO NOT OVER-CONSOLIDATE:
- Each distinct event = its OWN entry, even if related to the same topic
- BAD: One entry combining "service menu in progress", "PatientNow export by 6/1", "contract ends Aug 31", "launch June 16" into one item
- GOOD: 4 separate entries — one per fact
- Only merge messages if they are LITERALLY the same back-and-forth (e.g., a question + answer)

CATEGORIES:

1. "blocker" — A CURRENT issue actively preventing forward progress, NOT resolved later in the window
2. "risk" — A CURRENT concern, NOT resolved later
3. "update" — Progress notes, milestones, decisions, completed items. ALSO previously-blocked items that have been RESOLVED (prefix with "✓ Resolved: ")

RESOLUTION TRACKING:
- If a blocker/risk gets resolved later, emit ONE update entry: type=update, text="✓ Resolved: <original> — <how>"
- Example: "Migration no-show" + later "Rescheduled to 5/26" → type=update, text="✓ Resolved: Migration no-show — rescheduled to 5/26"

WHAT TO INCLUDE (be thorough):
- Vendor account setups (Allergan, Galderma, Merz, Crown, Revance, etc.)
- Migration calls scheduled, completed, no-shows, rescheduled
- Contract negotiations, financial decisions, credits offered
- Marketing strategy meetings + outcomes (campaigns, budgets, channels)
- Payroll, bookkeeping, A2P, Stripe, phone system setup status
- Compliance/laser registration items
- PSM/OM handoff events
- Specific dollar amounts, dates, vendor names mentioned
- Strategy discussions (Mother's Day, gift card pushes, event planning, etc.)
- Personnel changes (channel adds, role assignments)
- Target launch date changes with rationale

WHAT TO SKIP:
- Pure social messages ("thanks!", "excited!", "you guys are amazing")
- Channel join/leave notifications
- Empty thank-yous

Preserve specific names, dates, dollar amounts, vendor names. Each entry should be 1-2 sentences, SPECIFIC enough that a manager reading just the digest can act on it.

Return ONLY a JSON object (no markdown) keyed by account name. Each account should have 10-15 items if conversation supports it, ordered: blockers > risks > updates (newest first within each):

{
  "aw": [
    {"type":"risk","date":"May 22","text":"PatientNow data extraction due by 6/1/26 — if delayed, will push launch past 6/16"},
    {"type":"update","date":"May 22","text":"AW Medspa fully onboarded into Moxie Payroll (Joaquin)"},
    {"type":"update","date":"May 21","text":"✓ Resolved: PatientNow contract conflict — Moxie covering early termination at $499/mo × 3 months ($1500 approved by Leslie)"},
    {"type":"update","date":"May 20","text":"Marketing aligned: take over from Bullseye, $4/unit Dysport campaign + Christmas in July gift card push, ~6 weeks ramp"},
    {"type":"update","date":"May 19","text":"A2P submitted by Christina"},
    {"type":"update","date":"May 18","text":"Vendor accounts set up — Allergan, Galderma, Merz, Crown, Revance all live"},
    {"type":"update","date":"May 17","text":"Handoff to PSM Angie Wing — form submitted to HS"},
    {"type":"update","date":"May 16","text":"Target launch moved from 6/1 → 6/16/26 due to net-new EMR migration complexity"},
    {"type":"update","date":"May 15","text":"✓ Resolved: Migration deep-dive no-show — rescheduled and completed"},
    {"type":"update","date":"May 14","text":"OSHA / laser compliance binder sent (laser maintenance logs, fridge temp logs)"},
    ...
  ],
  ...
}

Input messages by account (most recent first):
${JSON.stringify(chunkInput, null, 2)}`;

  // Fire all chunk calls in parallel
  const chunkResults = await Promise.all(chunks.map(async (chunk) => {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 8000,  // safely under claude-haiku ceiling; each chunk handles ~10 accounts
          messages: [{ role: "user", content: promptFor(chunk) }]
        })
      });
      if (!r.ok) {
        console.warn(`Anthropic chunk ${r.status}: ${await r.text()}`);
        return {};
      }
      const data = await r.json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return {};
      try { return JSON.parse(m[0]); } catch { return {}; }
    } catch (e) {
      console.warn("Chunk categorize failed:", e.message);
      return {};
    }
  }));

  // Merge all chunk results into a single object
  return Object.assign({}, ...chunkResults);
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function parseJsonEnv(name) {
  const v = process.env[name];
  if (!v) return {};
  try { return JSON.parse(v); } catch { return {}; }
}
