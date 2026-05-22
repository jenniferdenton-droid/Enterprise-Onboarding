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

export async function saveChannelMapping(hsCompanyId, payload) {
  const db = getDb();
  await db.collection("channel_mappings").doc(String(hsCompanyId)).set({
    hs_object_id: String(hsCompanyId),
    ...payload,
    assigned_at: new Date().toISOString()
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
