// ────────────────────────────────────────────────────────────────────────────
// lib/gmail.js — Send email via Gmail API using OAuth refresh token
// ────────────────────────────────────────────────────────────────────────────
// Requires env vars:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN    (long-lived; generate once via OAuth Playground)
//   GMAIL_FROM_EMAIL        (must match the account that authorized the refresh token)
//
// The Gmail account must have the scope: https://www.googleapis.com/auth/gmail.send
// ────────────────────────────────────────────────────────────────────────────

import { google } from "googleapis";

function getGmailClient() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN
  } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error(
      "Google env vars missing: need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN"
    );
  }

  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );
  oauth2.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth: oauth2 });
}

/**
 * Send an HTML email via Gmail.
 * @param {Object} opts
 * @param {string|string[]} opts.to      — recipient(s)
 * @param {string}          opts.subject
 * @param {string}          opts.html
 * @param {string}          [opts.from]  — defaults to GMAIL_FROM_EMAIL
 */
export async function sendEmail({ to, subject, html, from }) {
  const sender = from || process.env.GMAIL_FROM_EMAIL;
  if (!sender) throw new Error("GMAIL_FROM_EMAIL not set");

  const recipients = Array.isArray(to) ? to.join(", ") : to;
  const raw = [
    `From: ${sender}`,
    `To: ${recipients}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    html
  ].join("\r\n");

  const encoded = Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const gmail = getGmailClient();
  const resp = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded }
  });
  return { id: resp.data.id, threadId: resp.data.threadId };
}
