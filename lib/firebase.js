// ────────────────────────────────────────────────────────────────────────────
// lib/firebase.js — Shared Firestore client (server-side, Vercel functions)
// ────────────────────────────────────────────────────────────────────────────
// Requires env vars (set in Vercel Project Settings → Environment Variables):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY    (paste the full -----BEGIN PRIVATE KEY----- block;
//                            real newlines OR literal \n both work)
//
// Firestore document used by this app:
//   collection: "dashboard"
//   doc:        "latest"
//   fields:     { companies, notes, synced_at, meta }
// ────────────────────────────────────────────────────────────────────────────

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

let _db = null;

export function getDb() {
  if (_db) return _db;

  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    // Vercel UI sometimes escapes newlines — normalize both formats
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        "Firebase env vars missing: need FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
      );
    }

    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey })
    });
  }

  _db = getFirestore();
  return _db;
}

// Cache helpers -- one row per snapshot in dashboard/latest
export async function writeSnapshot(payload) {
  const db = getDb();
  await db.collection("dashboard").doc("latest").set({
    ...payload,
    cached_at: new Date().toISOString()
  });
}

export async function readSnapshot() {
  const db = getDb();
  const snap = await db.collection("dashboard").doc("latest").get();
  return snap.exists ? snap.data() : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Channel mappings -- collection "channel_mappings", doc id = hubspot company id
//   { hs_object_id, company_name, slack_channel_id, slack_channel_name,
//     assigned_by, assigned_at, created_via }
// ────────────────────────────────────────────────────────────────────────────

export async function listChannelMappings() {
  const db = getDb();
  const snap = await db.collection("channel_mappings").get();
  const out = {};
  snap.forEach(doc => { out[doc.id] = doc.data(); });
  return out;
}

export async function getChannelMapping(hsCompanyId) {
  const db = getDb();
  const doc = await db.collection("channel_mappings").doc(String(hsCompanyId)).get();
  return doc.exists ? doc.data() : null;
}

// Save (or append) a channel mapping. Multi-channel support: maintains an
// array of channels and dedupes by slack_channel_id. The first channel in the
// array also lives at the top-level slack_channel_id field for backward compat.
export async function saveChannelMapping(hsCompanyId, payload) {
  const db = getDb();
  const ref = db.collection("channel_mappings").doc(String(hsCompanyId));
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() : {};

  // Normalize existing channels into an array
  let channels = Array.isArray(existingData.channels) ? [...existingData.channels] : [];
  if (!channels.length && existingData.slack_channel_id) {
    channels.push({
      slack_channel_id: existingData.slack_channel_id,
      slack_channel_name: existingData.slack_channel_name,
      added_at: existingData.assigned_at || new Date().toISOString()
    });
  }

  // Append the new channel if it's not already in the array
  if (payload.slack_channel_id) {
    const already = channels.find(c => c.slack_channel_id === payload.slack_channel_id);
    if (!already) {
      channels.push({
        slack_channel_id: payload.slack_channel_id,
        slack_channel_name: payload.slack_channel_name,
        added_at: new Date().toISOString()
      });
    }
  }

  await ref.set({
    hs_object_id: String(hsCompanyId),
    company_name: payload.company_name || existingData.company_name || null,
    channels,
    // Keep top-level fields as the FIRST channel for backward-compat reads
    slack_channel_id: channels[0]?.slack_channel_id || null,
    slack_channel_name: channels[0]?.slack_channel_name || null,
    created_via: payload.created_via || existingData.created_via || "assigned_existing",
    assigned_at: new Date().toISOString()
  }, { merge: true });
}

// Remove ONE channel from the mapping (by slack_channel_id). If the mapping
// becomes empty, the whole doc is deleted.
export async function removeChannelFromMapping(hsCompanyId, slackChannelId) {
  const db = getDb();
  const ref = db.collection("channel_mappings").doc(String(hsCompanyId));
  const existing = await ref.get();
  if (!existing.exists) return;
  const data = existing.data();
  const channels = (data.channels || []).filter(c => c.slack_channel_id !== slackChannelId);
  if (!channels.length) {
    await ref.delete();
    return;
  }
  await ref.set({
    channels,
    slack_channel_id: channels[0].slack_channel_id,
    slack_channel_name: channels[0].slack_channel_name
  }, { merge: true });
}

export async function deleteChannelMapping(hsCompanyId) {
  const db = getDb();
  await db.collection("channel_mappings").doc(String(hsCompanyId)).delete();
}

// ────────────────────────────────────────────────────────────────────────────
// Digest recipients -- collection "digest_recipients", doc id = email
//   { email, name, role, active, added_at }
// ────────────────────────────────────────────────────────────────────────────

function recipientId(email) {
  // Firestore doc IDs can't contain slashes or dots-at-edges; encode the email safely
  return String(email || "").trim().toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
}

export async function listRecipients() {
  const db = getDb();
  const snap = await db.collection("digest_recipients").orderBy("added_at", "asc").get().catch(async () => {
    // Fallback if the index doesn't exist yet — unordered read
    return await db.collection("digest_recipients").get();
  });
  const out = [];
  snap.forEach(doc => out.push({ id: doc.id, ...doc.data() }));
  return out;
}

export async function addRecipient({ email, name, role }) {
  if (!email) throw new Error("email required");
  const db = getDb();
  const id = recipientId(email);
  await db.collection("digest_recipients").doc(id).set({
    email: email.trim().toLowerCase(),
    name: name || null,
    role: role || null,
    active: true,
    added_at: new Date().toISOString()
  }, { merge: true });
  return id;
}

export async function removeRecipient(id) {
  const db = getDb();
  await db.collection("digest_recipients").doc(id).delete();
}

export async function setRecipientActive(id, active) {
  const db = getDb();
  await db.collection("digest_recipients").doc(id).set({ active: !!active }, { merge: true });
}

// ────────────────────────────────────────────────────────────────────────────
// Status overrides -- collection "status_overrides", doc id = hs_object_id
//   { status, updated_by, updated_at }
// ────────────────────────────────────────────────────────────────────────────

export async function listStatusOverrides() {
  const db = getDb();
  const snap = await db.collection("status_overrides").get();
  const out = {};
  snap.forEach(doc => { out[doc.id] = doc.data(); });
  return out;
}

export async function setStatusOverride(hsCompanyId, status, updatedBy) {
  const db = getDb();
  await db.collection("status_overrides").doc(String(hsCompanyId)).set({
    hs_object_id: String(hsCompanyId),
    status,
    updated_by: updatedBy || null,
    updated_at: new Date().toISOString()
  }, { merge: true });
}

export async function clearStatusOverride(hsCompanyId) {
  const db = getDb();
  await db.collection("status_overrides").doc(String(hsCompanyId)).delete();
}

// ────────────────────────────────────────────────────────────────────────────
// Archived accounts -- collection "archived_accounts", doc id = hs_object_id
//   { hs_object_id, company_name, archived_at, archived_by, reason? }
// ────────────────────────────────────────────────────────────────────────────

export async function listArchivedAccounts() {
  const db = getDb();
  const snap = await db.collection("archived_accounts").get();
  const out = {};
  snap.forEach(doc => { out[doc.id] = doc.data(); });
  return out;
}

export async function archiveAccount(hsCompanyId, payload) {
  const db = getDb();
  await db.collection("archived_accounts").doc(String(hsCompanyId)).set({
    hs_object_id: String(hsCompanyId),
    company_name: payload?.company_name || null,
    archived_by: payload?.archived_by || null,
    reason: payload?.reason || null,
    archived_at: new Date().toISOString()
  }, { merge: true });
}

export async function unarchiveAccount(hsCompanyId) {
  const db = getDb();
  await db.collection("archived_accounts").doc(String(hsCompanyId)).delete();
}

// ────────────────────────────────────────────────────────────────────────────
// Manual notes -- collection "manual_notes", doc id = hs_object_id
//   { hs_object_id, notes: [{ id, type, text, author, created_at }] }
// ────────────────────────────────────────────────────────────────────────────

export async function listManualNotes() {
  const db = getDb();
  const snap = await db.collection("manual_notes").get();
  const out = {};
  snap.forEach(doc => { out[doc.id] = doc.data(); });
  return out;
}

export async function addManualNote(hsCompanyId, { type, text, author }) {
  if (!text) throw new Error("note text required");
  const db = getDb();
  const ref = db.collection("manual_notes").doc(String(hsCompanyId));
  const existing = await ref.get();
  const data = existing.exists ? existing.data() : { notes: [] };
  const notes = Array.isArray(data.notes) ? [...data.notes] : [];

  notes.unshift({
    id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: (type || "note").toLowerCase(),
    text: String(text).trim(),
    author: author || null,
    created_at: new Date().toISOString()
  });

  await ref.set({
    hs_object_id: String(hsCompanyId),
    notes,
    updated_at: new Date().toISOString()
  }, { merge: true });
}

export async function deleteManualNote(hsCompanyId, noteId) {
  const db = getDb();
  const ref = db.collection("manual_notes").doc(String(hsCompanyId));
  const existing = await ref.get();
  if (!existing.exists) return;
  const data = existing.data();
  const notes = (data.notes || []).filter(n => n.id !== noteId);
  if (!notes.length) {
    await ref.delete();
    return;
  }
  await ref.set({ notes, updated_at: new Date().toISOString() }, { merge: true });
}
