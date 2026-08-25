/* ============================================================
   DIRECTOR'S MEMORY — api/_clickhouse.js
   Small shared helper, server-side only.

   Reads ClickHouse Cloud connection details from environment
   variables (populated from Vercel Environment Variables at
   deploy time) and builds a client. Never imported by the
   browser bundle — this file only ever runs inside Vercel
   serverless functions, so the credentials never leave the
   server.
   ============================================================ */

import { createClient } from "@clickhouse/client";

/**
 * getClickHouseEnv — reads and validates the four required
 * environment variables without ever logging their values.
 * Throws a generic error (no secret material) if anything is
 * missing so callers can fail safely into the fallback path.
 */
export function getClickHouseEnv() {
  // .trim() defensively strips accidental leading/trailing whitespace or
  // newline characters that can end up in a Vercel env var value after a
  // copy-paste (e.g. from a "reveal password" UI or a terminal). This class
  // of bug is invisible in the Vercel dashboard but breaks Basic Auth,
  // since the trimmed value the server expects no longer byte-for-byte
  // matches the untrimmed value the client sends — ClickHouse then reports
  // it as a generic "authentication failed" rather than "malformed input".
  const host = process.env.CLICKHOUSE_HOST?.trim();
  const username = process.env.CLICKHOUSE_USERNAME?.trim();
  const password = process.env.CLICKHOUSE_PASSWORD?.trim();
  const database = process.env.CLICKHOUSE_DATABASE?.trim();

  const missing = [];
  if (!host) missing.push("CLICKHOUSE_HOST");
  if (!username) missing.push("CLICKHOUSE_USERNAME");
  if (!password) missing.push("CLICKHOUSE_PASSWORD");
  if (!database) missing.push("CLICKHOUSE_DATABASE");

  if (missing.length > 0) {
    // Names of missing vars only — never their values.
    throw new Error(`ClickHouse is not configured: missing ${missing.join(", ")}`);
  }

  return { host, username, password, database };
}

/**
 * getClickHouseClient — builds a fresh client for a single
 * request/response cycle. Serverless functions are short-lived,
 * so we open, use, and close per invocation rather than pooling.
 */
export function getClickHouseClient() {
  const { host, username, password, database } = getClickHouseEnv();
  return createClient({
    // `url` is the current, non-deprecated config key in
    // @clickhouse/client ^1.23.1 ("host" still works as an alias but logs
    // a deprecation warning internally). Functionally equivalent — this
    // is a clarity fix, not the auth fix.
    url: host,
    username,
    password,
    database,
    request_timeout: 10000
  });
}

/**
 * closeClickHouseClient — best-effort close, never throws.
 */
export async function closeClickHouseClient(client) {
  if (!client) return;
  try {
    await client.close();
  } catch {
    // Closing a client should never be able to fail the response.
  }
}
