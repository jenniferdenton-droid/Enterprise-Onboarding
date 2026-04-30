# Moxie · Enterprise Onboarding Dashboard

Internal dashboard tracking enterprise medspa onboarding accounts. Pulls from HubSpot (companies + deals) and Slack (categorized risks/blockers/updates).

## Phase 1 — Deploy via GitHub → Vercel (Today)

Repo is git-initialized with an initial commit on `main`. Push to GitHub once, connect Vercel once, and from then on **every `git push` auto-deploys**.

### Step 1 — Create the GitHub repo

**Option A — GitHub CLI (fastest):**
```bash
cd moxie-onboarding-dashboard
gh repo create moxie-onboarding-dashboard --private --source=. --remote=origin --push
```

**Option B — GitHub web UI:**
1. Go to [github.com/new](https://github.com/new)
2. Name: `moxie-onboarding-dashboard` · Visibility: **Private** · Don't initialize with README
3. Click Create
4. Then run locally:
   ```bash
   cd moxie-onboarding-dashboard
   git remote add origin https://github.com/<YOUR-ORG>/moxie-onboarding-dashboard.git
   git push -u origin main
   ```

### Step 2 — Connect Vercel to the GitHub repo

1. Go to [vercel.com/new](https://vercel.com/new)
2. Click **Import Git Repository** → authorize GitHub if prompted
3. Pick `moxie-onboarding-dashboard` from the list → click **Import**
4. Framework Preset: **Other** (it's vanilla HTML — no build step needed)
5. Root Directory: `./` (leave default)
6. Click **Deploy**

Vercel will deploy immediately and watch the repo. Every future `git push origin main` triggers an auto-deploy. PRs get auto-generated preview URLs.

### Step 3 — Lock down the URL (required)

This dashboard exposes account-level revenue and at-risk customer notes. **Do not leave it publicly accessible.** In Vercel:
- Project Settings → **Deployment Protection** → enable **Vercel Authentication** (restricts access to your Vercel team — included on Pro)
- Or enable **Password Protection** if you need to share with non-Vercel users

### Daily workflow after setup

```bash
# edit index.html (e.g., update SLACK_NOTES, add a company to seed data)
git add -A
git commit -m "Update Slack notes for Rivkin"
git push
# Vercel auto-deploys in ~20 seconds
```

---

## Phase 2 — Live HubSpot + Slack Sync

### Architecture

```
Browser
   │
   ▼
/api/refresh  (Vercel serverless function)
   │
   ├──► Anthropic API (claude-sonnet-4-5)
   │       ├─► HubSpot MCP  → companies + deals
   │       └─► Slack MCP    → recent messages → categorize as blocker/risk/update
   │
   ▼
{ companies: [...], notes: { "rivkin": [...], ... } }
```

### Setup steps

1. **Rename the template:**
   ```bash
   mv api/refresh.js.template api/refresh.js
   ```

2. **Add Vercel env vars** (Project Settings → Environment Variables):

   | Variable | Value | Notes |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | `sk-ant-...` | From console.anthropic.com |
   | `HUBSPOT_MCP_URL` | `https://mcp.hubspot.com/anthropic` | HubSpot's hosted MCP |
   | `SLACK_MCP_URL` | (Slack MCP URL) | Salesforce Slack MCP endpoint |
   | `DASHBOARD_PASSWORD` | (optional) | Shared secret for /api/refresh |

3. **Verify HubSpot MCP auth.** HubSpot MCP requires OAuth — first request will return an auth URL. Complete it once with the Moxie HubSpot admin account.

4. **Verify Slack MCP auth.** Same OAuth dance for Slack workspace.

5. **Redeploy** (just push — Vercel auto-deploys from GitHub):
   ```bash
   git add -A
   git commit -m "Activate live refresh: rename refresh.js.template -> refresh.js"
   git push
   ```

6. **Test:** Click Refresh on the dashboard. Loading overlay should show, then live data populates and the "Static deploy" banner disappears.

### What `/api/refresh` does

1. Calls HubSpot MCP — pulls all Enterprise + evangelist companies, joins associated deal `monthly_medspa_revenue` into each company record.
2. Calls Slack MCP — searches `#enterprise-onboarding` and related channels for the past 14 days, filtered to messages mentioning each account.
3. Asks Claude to categorize each Slack message as `blocker`, `risk`, or `update` and summarize to 1-2 sentences.
4. Returns `{ companies, notes }` to the browser.

### Cost estimate (Phase 2)

- Per refresh: ~2 Anthropic API calls, ~5–10K input tokens + ~2K output ≈ **$0.05–0.10/refresh**
- If a user clicks Refresh 10x/day across the team → **<$15/month**
- HubSpot + Slack MCP usage included with existing tool subscriptions

---

## Phase 3 — Polish (optional)

- **Auto-refresh** every 30 min via Vercel Cron Jobs (writes to a KV store; dashboard reads from KV instead of triggering live every load)
- **Alerts** — post to `#enterprise-leadership` Slack when a new blocker is detected
- **Notion mirror** — push the dashboard state to a Notion database for execs who prefer Notion
- **Revenue rollup card** — total monthly revenue at risk in delayed accounts

---

## File structure

```
moxie-onboarding-dashboard/
├── index.html              # Static dashboard (Phase 1)
├── vercel.json             # Vercel config + security headers
├── api/
│   └── refresh.js.template # Phase 2 serverless function (rename to .js when ready)
└── README.md               # This file
```

## Owner ID reference

These are hardcoded in `index.html` — update if the team changes:

| ID | Name |
|---|---|
| 742416394 | Sarah Bremer |
| 381256294 | Ali Gludt |
| 75919105 | Rachel Ulreich |
| 1619212666 | MJ Chevalier |
| 80103033 | Madison Plumb |
