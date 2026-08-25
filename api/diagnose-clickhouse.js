/* ============================================================
   DIRECTOR'S MEMORY — api/diagnose-clickhouse.js
   Vercel serverless function (Node.js runtime, ESM).

   TEMPORARY diagnostic endpoint. Reports the SHAPE of the
   ClickHouse env vars — not their values — so a whitespace/
   newline or wrong-length credential can be spotted without
   ever exposing the password, full host, or username.

   Safe to leave deployed (nothing secret is returned), but this
   is a debugging aid, not part of the product surface — remove
   it once authentication is confirmed working end-to-end.
   ============================================================ */

function analyzeValue(raw) {
  if (raw === undefined) {
    return { exists: false };
  }
  const trimmed = raw.trim();
  return {
    exists: true,
    length: raw.length,
    trimmed_length: trimmed.length,
    // If these differ, the raw env var has leading/trailing whitespace
    // or a newline character — the classic copy-paste bug.
    has_leading_or_trailing_whitespace: raw.length !== trimmed.length,
    contains_newline: /[\r\n]/.test(raw)
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const hostRaw = process.env.CLICKHOUSE_HOST;
  const usernameRaw = process.env.CLICKHOUSE_USERNAME;
  const passwordRaw = process.env.CLICKHOUSE_PASSWORD;
  const databaseRaw = process.env.CLICKHOUSE_DATABASE;

  let hostProtocol = null;
  let hostHasPort8443 = null;
  let hostParseError = null;
  if (hostRaw) {
    try {
      const parsed = new URL(hostRaw.trim());
      hostProtocol = parsed.protocol.replace(":", "");
      hostHasPort8443 = parsed.port === "8443";
    } catch (err) {
      hostParseError = "unparseable_url";
    }
  }

  res.status(200).json({
    ok: true,
    env: {
      CLICKHOUSE_HOST: analyzeValue(hostRaw),
      CLICKHOUSE_USERNAME: analyzeValue(usernameRaw),
      CLICKHOUSE_PASSWORD: analyzeValue(passwordRaw),
      CLICKHOUSE_DATABASE: analyzeValue(databaseRaw)
    },
    host_protocol: hostProtocol,
    host_port_is_8443: hostHasPort8443,
    host_parse_error: hostParseError,
    // Safe to show in full: this is expected to be a short, non-secret
    // logical database name, not a credential.
    database_name: databaseRaw ? databaseRaw.trim() : null
  });
}
