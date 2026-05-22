// ────────────────────────────────────────────────────────────────────────────
// /api/archive — Mark an account as archived (kept in Firestore, hidden from dashboard)
// ────────────────────────────────────────────────────────────────────────────
//   POST   /api/archive      body: { hs_object_id, company_name, archived_by?, reason? }
//   DELETE /api/archive?hs_object_id=...   → unarchive
// ────────────────────────────────────────────────────────────────────────────

import { archiveAccount, unarchiveAccount } from "../lib/firebase.js";

export default async function handler(req, res) {
  if (process.env.DASHBOARD_PASSWORD) {
    if (req.headers["x-dashboard-key"] !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  try {
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body.hs_object_id) return res.status(400).json({ error: "hs_object_id required" });
      await archiveAccount(body.hs_object_id, body);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const id = req.query?.hs_object_id;
      if (!id) return res.status(400).json({ error: "hs_object_id required" });
      await unarchiveAccount(id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("archive error:", e);
    return res.status(500).json({ error: e.message || "archive failed" });
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
