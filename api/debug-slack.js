// ────────────────────────────────────────────────────────────────────────────
// /api/debug-slack — Show what scopes the deployed SLACK_BOT_TOKEN actually has
// ────────────────────────────────────────────────────────────────────────────
// Calls Slack's auth.test to verify the token + reads the x-oauth-scopes header
// to show every scope currently granted. Hit this URL whenever Slack throws
// missing_scope to see what's actually on the deployed token vs what's needed.
// ────────────────────────────────────────────────────────────────────────────

const REQUIRED = [
  "channels:read",
  "groups:read",
  "channels:history",
  "groups:history",
  "channels:join",
  "channels:manage",
  "chat:write",
  "users:read"
];

export default async function handler(req, res) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: "SLACK_BOT_TOKEN not set in env" });

  try {
    const r = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` }
    });
    const data = await r.json();
    const scopesHeader = r.headers.get("x-oauth-scopes") || "";
    const activeScopes = scopesHeader.split(",").map(s => s.trim()).filter(Boolean);

    const missing = REQUIRED.filter(s => !activeScopes.includes(s));

    return res.status(200).json({
      slack_ok: data.ok,
      bot_user_id: data.user_id,
      bot_name: data.user,
      team: data.team,
      url: data.url,
      token_starts_with: token.slice(0, 12) + "...",
      active_scopes: activeScopes,
      missing_required_scopes: missing,
      scopes_look_good: missing.length === 0,
      raw_auth_test: data
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
