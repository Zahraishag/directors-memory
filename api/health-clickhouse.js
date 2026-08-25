/* ============================================================
   DIRECTOR'S MEMORY — api/health-clickhouse.js
   Vercel serverless function (Node.js runtime, ESM).

   Diagnostic endpoint: reports whether ClickHouse environment
   variables are configured, AND whether an authenticated query
   actually succeeds. `.ping()` alone only proves the host is
   reachable — it does not prove the username/password are
   correct — so this runs a real authenticated `SELECT 1` and
   reports `authenticated` based on that, not on ping. Never
   returns credential values, hostnames, or raw error strings
   from the driver — only booleans and a short, generic status.
   ============================================================ */

import { getClickHouseClient, closeClickHouseClient } from "./_clickhouse.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  let client;
  try {
    client = getClickHouseClient();
  } catch (err) {
    console.error("[health-clickhouse] not configured:", err.message);
    res.status(200).json({
      ok: false,
      configured: false,
      authenticated: false,
      status: "not_configured"
    });
    return;
  }

  try {
    // An authenticated round-trip query, not just a ping. `ping()` can
    // succeed purely on network/TLS reachability without ever validating
    // credentials, which is exactly why the previous version of this
    // endpoint reported "connected" as long as the host was reachable,
    // even while every real authenticated query (get-decisions) was
    // failing with Code 516.
    const resultSet = await client.query({
      query: "SELECT 1",
      format: "JSONEachRow"
    });
    await resultSet.json();

    res.status(200).json({
      ok: true,
      configured: true,
      authenticated: true,
      status: "connected"
    });
  } catch (err) {
    console.error("[health-clickhouse] authenticated query failed:", err);
    res.status(200).json({
      ok: false,
      configured: true,
      authenticated: false,
      status: "authentication_or_query_failed"
    });
  } finally {
    await closeClickHouseClient(client);
  }
}
