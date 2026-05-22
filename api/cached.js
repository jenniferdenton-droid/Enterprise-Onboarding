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

import {
  readSnapshot,
  listChannelMappings,
  listStatusOverrides,
  listArchivedAccounts,
  listManualNotes
} from "../lib/firebase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (process.env.DASHBOARD_PASSWORD) {
    const userKey = req.headers["x-dashboard-key"];
    if (userKey && userKey !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: "unauthorized (bad key)" });
    }
  }

  try {
    // Track read success/failure separately so a single failing collection
    // doesn't accidentally clear data from other working collections.
    const reads = {
      channels: { ok: false, data: {} },
      status:   { ok: false, data: {} },
      archived: { ok: false, data: {} },
      notes:    { ok: false, data: {} }
    };

    const [snap] = await Promise.all([
      readSnapshot(),
      listChannelMappings()
        .then(d => { reads.channels = { ok: true, data: d || {} }; })
        .catch(e => console.warn("channels read:", e.message)),
      listStatusOverrides()
        .then(d => { reads.status = { ok: true, data: d || {} }; })
        .catch(e => console.warn("status read:", e.message)),
      listArchivedAccounts()
        .then(d => { reads.archived = { ok: true, data: d || {} }; })
        .catch(e => console.warn("archived read:", e.message)),
      listManualNotes()
        .then(d => { reads.notes = { ok: true, data: d || {} }; })
        .catch(e => console.warn("notes read:", e.message))
    ]);

    if (!snap) {
      return res.status(404).json({
        error: "no cached snapshot yet — hit /api/refresh first"
      });
    }

    // OVERLAY policy: only OVERLAY when Firestore has the data.
    // NEVER clear snapshot data based on absence — that risks deleting the
    // user's view of valid data when a read fails. Stale > lost.
    const companies = (snap.companies || []).map(c => {
      const id = String(c.hs_object_id);
      const merged = { ...c };

      // Channel mappings — overlay if present, else leave snapshot's value
      if (reads.channels.ok) {
        const m = reads.channels.data[id];
        if (m) {
          if (Array.isArray(m.channels) && m.channels.length) {
            merged.slack_channels = m.channels;
            merged.slack_channel_id = m.channels[0].slack_channel_id;
            merged.slack_channel_name = m.channels[0].slack_channel_name;
          } else if (m.slack_channel_id) {
            merged.slack_channels = [{ slack_channel_id: m.slack_channel_id, slack_channel_name: m.slack_channel_name }];
            merged.slack_channel_id = m.slack_channel_id;
            merged.slack_channel_name = m.slack_channel_name;
          }
        }
      }

      // Status override
      if (reads.status.ok) {
        const so = reads.status.data[id];
        if (so?.status) {
          merged.moxie_onboarding_status_override = so.status;
          merged.moxie_onboarding_status_override_at = so.updated_at;
        }
      }

      // Archive flag
      if (reads.archived.ok) {
        const arc = reads.archived.data[id];
        if (arc) {
          merged.archived_at = arc.archived_at;
          merged.archived_by = arc.archived_by;
          merged.archive_reason = arc.reason;
        }
      }

      // Manual notes
      if (reads.notes.ok) {
        const mn = reads.notes.data[id];
        if (mn?.notes?.length) {
          merged.manual_notes = mn.notes;
        }
      }

      return merged;
    });

    // Don't cache — every reload should pick up the latest mutations
    res.setHeader("Cache-Control", "no-store, max-age=0");

    return res.status(200).json({
      ...snap,
      companies,
      _live_overlay: true,
      _overlay_status: {
        channels:  reads.channels.ok ? `${Object.keys(reads.channels.data).length} mappings` : "read FAILED",
        status:    reads.status.ok   ? `${Object.keys(reads.status.data).length} overrides`  : "read FAILED",
        archived:  reads.archived.ok ? `${Object.keys(reads.archived.data).length} archived` : "read FAILED",
        notes:     reads.notes.ok    ? `${Object.keys(reads.notes.data).length} note sets`   : "read FAILED"
      }
    });
  } catch (e) {
    console.error("cached error:", e);
    return res.status(500).json({ error: e.message || "read failed" });
  }
}
