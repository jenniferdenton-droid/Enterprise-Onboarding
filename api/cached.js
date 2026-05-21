// ────────────────────────────────────────────────────────────────────────────
// /api/cached — Fast read of the last /api/refresh snapshot from Firestore
// ────────────────────────────────────────────────────────────────────────────
// Use this from the dashboard on page load (instant ~50ms) instead of /api/refresh
// (which can take 20-30s). User clicks "Refresh" to invoke /api/refresh and re-write
// the cache.
//
// Required env vars:
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
//
// Optional:
//   DASHBOARD_PASSWORD  — same gating as /api/refresh
//
// Returns: { companies, notes, synced_at, cached_at, meta }  (whatever was last written)
//          or 404 if no snapshot exists yet.
// ────────────────────────────────────────────────────────────────────────────

import { readSnapshot } from "../lib/firebase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (process.env.DASHBOARD_PASSWORD) {
    if (req.headers["x-dashboard-key"] !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  try {
    const snap = await readSnapshot();
    if (!snap) {
      return res.status(404).json({
        error: "no cached snapshot yet — hit /api/refresh first"
      });
    }
    // Cache headers — let Vercel edge cache for 60s; stale-while-revalidate up to 5 min
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(snap);
  } catch (e) {
    console.error("cached error:", e);
    return res.status(500).json({ error: e.message || "read failed" });
  }
}
