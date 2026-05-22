// ────────────────────────────────────────────────────────────────────────────
// /api/notes — Manual notes (risks, observations) added by Onboarding Managers
// ────────────────────────────────────────────────────────────────────────────
//
//   POST   /api/notes                    body: { hs_object_id, text, type?, author? }
//   DELETE /api/notes?hs_object_id=...&note_id=...
//
//   Reads happen via /api/refresh + /api/cached (notes are merged into each company).
//
// type:    "note" | "risk" | "win"     (default: "note")
// author:  free-text — typically the OM's name or email
// ────────────────────────────────────────────────────────────────────────────

import { addManualNote, deleteManualNote } from "../lib/firebase.js";

const ALLOWED_TYPES = new Set(["note", "risk", "win", "blocker", "update"]);

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
      const { hs_object_id, text, type, author } = body;
      if (!hs_object_id || !text) {
        return res.status(400).json({ error: "hs_object_id + text required" });
      }
      const finalType = ALLOWED_TYPES.has((type || "note").toLowerCase())
        ? (type || "note").toLowerCase()
        : "note";
      await addManualNote(hs_object_id, { type: finalType, text, author });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const id = req.query?.hs_object_id;
      const noteId = req.query?.note_id;
      if (!id || !noteId) return res.status(400).json({ error: "hs_object_id + note_id required" });
      await deleteManualNote(id, noteId);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("notes error:", e);
    return res.status(500).json({ error: e.message || "notes failed" });
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
