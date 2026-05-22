// ────────────────────────────────────────────────────────────────────────────
// /api/status — Dashboard-level status overrides for HubSpot company records
// ────────────────────────────────────────────────────────────────────────────
//
// Edits made here are stored in Firestore and merged into /api/refresh + /api/cached
// responses as `moxie_onboarding_status_override`. They do NOT write back to HubSpot.
// (Add HubSpot write here later if Operations wants the change to round-trip.)
//
//   POST   /api/status        body: { hs_object_id, status, updated_by? }
//   DELETE /api/status?hs_object_id=... → clear override
// ────────────────────────────────────────────────────────────────────────────

import { setStatusOverride, clearStatusOverride } from "../lib/firebase.js";

const ALLOWED = new Set([
  "Onboarding",
  "In Progress",
  "Delayed Onboarding",
  "On Hold",
  "At Risk",
  "Ready to Launch",
  "Launched",
  "Churned"
]);

export default async function handler(req, res) {
  if (process.env.DASHBOARD_PASSWORD) {
    const userKey = req.headers["x-dashboard-key"];
    if (userKey && userKey !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: "unauthorized (bad key)" });
    }
  }

  try {
    if (req.method === "POST") {
      const body = await readBody(req);
      const { hs_object_id, status, updated_by } = body;
      if (!hs_object_id || !status) {
        return res.status(400).json({ error: "hs_object_id + status required" });
      }
      if (!ALLOWED.has(status)) {
        return res.status(400).json({ error: `status must be one of: ${[...ALLOWED].join(", ")}` });
      }
      await setStatusOverride(hs_object_id, status, updated_by);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const id = req.query?.hs_object_id;
      if (!id) return res.status(400).json({ error: "hs_object_id required" });
      await clearStatusOverride(id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("status error:", e);
    return res.status(500).json({ error: e.message || "status failed" });
  }
}

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

export const ALLOWED_STATUSES = [...ALLOWED];
