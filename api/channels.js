// ────────────────────────────────────────────────────────────────────────────
// /api/channels — Slack channel management for Enterprise medspas
// ────────────────────────────────────────────────────────────────────────────
//
// Endpoints (single file, multiplexed on req.method + ?action=):
//
//   GET  /api/channels
//        → returns { mappings, bot_channels }
//          - mappings:     { [hs_object_id]: { slack_channel_id, slack_channel_name, ... } }
//          - bot_channels: [{ id, name, is_private }]  (channels the bot is in)
//
//   POST /api/channels?action=assign
//        body: { hs_object_id, company_name, slack_channel_id, slack_channel_name }
//        → links an existing Slack channel to a HubSpot company in Firestore
//
//   POST /api/channels?action=create
//        body: { hs_object_id, company_name, channel_name (optional), is_private (optional) }
//        → creates a NEW Slack channel via Slack API, bot is auto-added,
//          saves mapping to Firestore
//
//   DELETE /api/channels?hs_object_id=...
//        → removes the mapping
//
// Required env vars:
//   SLACK_BOT_TOKEN, FIREBASE_*  (see refresh.js header)
//
// Required Slack scopes (add in Slack app config → OAuth & Permissions):
//   channels:manage  — create + manage public channels
//   channels:read    — list public channels
//   channels:join    — bot can join public channels (used by /create flow + auto-discovery)
//   groups:write     — create private channels (only if you set is_private:true)
//   groups:read      — list private channels
//   chat:write       — post welcome message after creating
// ────────────────────────────────────────────────────────────────────────────

import {
  listChannelMappings,
  getChannelMapping,
  saveChannelMapping,
  deleteChannelMapping
} from "../lib/firebase.js";

export default async function handler(req, res) {
  if (process.env.DASHBOARD_PASSWORD) {
    if (req.headers["x-dashboard-key"] !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!SLACK_BOT_TOKEN) return res.status(500).json({ error: "SLACK_BOT_TOKEN not set" });

  try {
    if (req.method === "GET") {
      const [mappings, bot_channels] = await Promise.all([
        listChannelMappings(),
        listBotChannels(SLACK_BOT_TOKEN)
      ]);
      return res.status(200).json({ mappings, bot_channels });
    }

    if (req.method === "DELETE") {
      const id = req.query?.hs_object_id;
      if (!id) return res.status(400).json({ error: "hs_object_id required" });
      await deleteChannelMapping(id);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const action = req.query?.action || body.action;

      if (action === "assign") {
        const { hs_object_id, company_name, slack_channel_id, slack_channel_name } = body;
        if (!hs_object_id || !slack_channel_id) {
          return res.status(400).json({ error: "hs_object_id + slack_channel_id required" });
        }
        // Best-effort: ensure bot is in the channel
        const joinResult = await tryJoinChannel(SLACK_BOT_TOKEN, slack_channel_id);
        await saveChannelMapping(hs_object_id, {
          company_name: company_name || null,
          slack_channel_id,
          slack_channel_name: slack_channel_name || null,
          created_via: "assigned_existing",
          bot_joined: joinResult.ok,
          bot_join_error: joinResult.error || null
        });
        return res.status(200).json({ ok: true, joined: joinResult.ok, error: joinResult.error || null });
      }

      if (action === "create") {
        const { hs_object_id, company_name, channel_name, is_private } = body;
        if (!hs_object_id || !company_name) {
          return res.status(400).json({ error: "hs_object_id + company_name required" });
        }
        const desired = channel_name || slugifyChannelName(company_name);
        const create = await createSlackChannel(SLACK_BOT_TOKEN, desired, !!is_private);
        if (!create.ok) return res.status(500).json({ error: `Slack create failed: ${create.error}` });

        await saveChannelMapping(hs_object_id, {
          company_name,
          slack_channel_id: create.channel.id,
          slack_channel_name: create.channel.name,
          created_via: "auto_created",
          bot_joined: true
        });

        // Optional welcome message — non-fatal
        await postWelcome(SLACK_BOT_TOKEN, create.channel.id, company_name);

        return res.status(200).json({
          ok: true,
          channel: { id: create.channel.id, name: create.channel.name, is_private: !!is_private }
        });
      }

      return res.status(400).json({ error: "unknown action — use ?action=assign or ?action=create" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("channels error:", e);
    return res.status(500).json({ error: e.message || "channels failed" });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Slack helpers
// ────────────────────────────────────────────────────────────────────────────

async function listBotChannels(token) {
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
  // Sort alphabetically for nicer UX in the dropdown
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

async function createSlackChannel(token, name, isPrivate) {
  const r = await fetch("https://slack.com/api/conversations.create", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ name, is_private: !!isPrivate })
  });
  const data = await r.json();
  return data; // { ok, channel: {id, name, ...}, error? }
}

async function tryJoinChannel(token, channelId) {
  // Only works for public channels. Private channels require a human to /invite the bot.
  const r = await fetch("https://slack.com/api/conversations.join", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: channelId })
  });
  const data = await r.json();
  if (!data.ok) return { ok: false, error: data.error };
  return { ok: true };
}

async function postWelcome(token, channelId, companyName) {
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        channel: channelId,
        text: `:rocket: Channel created for *${companyName}* onboarding. Moxie Onboarding Reader is now listening — blockers, risks, and progress notes will flow into the Enterprise Onboarding dashboard.`
      })
    });
  } catch { /* non-fatal */ }
}

// Slack channel name rules: lowercase, no spaces, no special chars, max 80 chars
function slugifyChannelName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/-\s*\d+$/, "")               // strip "- 2096" trailing IDs
    .replace(/[^a-z0-9\s-]/g, "")          // drop special chars
    .trim()
    .replace(/\s+/g, "-")                  // spaces → hyphens
    .replace(/-+/g, "-")                   // collapse multi-hyphens
    .replace(/^-|-$/g, "")
    .slice(0, 78);
}

// ────────────────────────────────────────────────────────────────────────────
// Request body parser (Vercel functions don't auto-parse for non-Next.js)
// ────────────────────────────────────────────────────────────────────────────

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let chunks = "";
    req.on("data", c => chunks += c);
    req.on("end", () => {
      try { resolve(JSON.parse(chunks || "{}")); } catch { resolve({}); }
    });
  });
}
