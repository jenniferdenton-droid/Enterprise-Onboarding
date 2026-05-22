// ────────────────────────────────────────────────────────────────────────────
// /api/recipients — Manage the weekly-digest recipient list (Firestore-backed)
// ────────────────────────────────────────────────────────────────────────────
//
// Endpoints:
//   GET    /api/recipients                          → { recipients: [...] }
//   POST   /api/recipients                          → add or upsert one
//          body: { email, name?, role? }
//   PATCH  /api/recipients?id=<id>                  → toggle active
//          body: { active: true|false }
//   DELETE /api/recipients?id=<id>                  → remove
//
// Required env vars: FIREBASE_*  (see refresh.js header)
// Optional: DASHBOARD_PASSWORD  — if set, requests must send x-dashboard-key
// ────────────────────────────────────────────────────────────────────────────

import {
  listRecipients,
  addRecipient,
  removeRecipient,
  setRecipientActive
} from "../lib/firebase.js";

export default async function handler(req, res) {
  if (process.env.DASHBOARD_PASSWORD) {
    const userKey = req.headers["x-dashboard-key"];
    if (userKey && userKey !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: "unauthorized (bad key)" });
    }
  }

  try {
    if (req.method === "GET") {
      const recipients = await listRecipients();
      return res.status(200).json({ recipients });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const { email, name, role } = body;
      if (!email) return res.status(400).json({ error: "email required" });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) {
        return res.status(400).json({ error: "invalid email format" });
      }
      const id = await addRecipient({ email, name, role });
      return res.status(200).json({ ok: true, id });
    }

    if (req.method === "PATCH") {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const body = await readBody(req);
      await setRecipientActive(id, !!body.active);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ error: "id required" });
      await removeRecipient(id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("recipients error:", e);
    return res.status(500).json({ error: e.message || "recipients failed" });
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
