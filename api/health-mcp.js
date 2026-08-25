/* ============================================================
   DIRECTOR'S MEMORY — api/health-mcp.js
   Vercel serverless function (Node.js runtime, ESM).

   Diagnostic endpoint for the NEW MCP integration path only.
   Mirrors the shape/spirit of api/health-clickhouse.js but for
   the official mcp-clickhouse server instead of the direct
   @clickhouse/client path.

   It proves three separate things, in order, and reports each
   independently so a failure is easy to localize:
     1. configured  — required env vars are present
     2. connected   — MCP session handshake succeeded (transport +
                       auth token accepted by the MCP server)
     3. tool_called  — a real MCP tool (list_databases) executed
                        against ClickHouse and returned data

   Does NOT touch /api/get-decisions, does NOT touch the direct
   ClickHouse fallback path, and does NOT return secret material
   (no MCP URL, no token, no raw ClickHouse error text).
   ============================================================ */

import { getMcpClient, closeMcpClient } from "./_mcp-client.js";

// Which tool this diagnostic calls to prove a *real* round trip
// happened (not just a handshake). Overridable via env so the
// same endpoint can be pointed at a different harmless tool
// without a code change.
const TEST_TOOL = process.env.CLICKHOUSE_MCP_TEST_TOOL || "list_databases";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  let client;

  // Step 1: configured + connected. getMcpClient() validates env vars
  // first (throws "not configured" before any network call) and then
  // performs the MCP handshake, so a thrown error here cleanly separates
  // "missing env vars" from "env vars present but handshake failed".
  try {
    client = await getMcpClient({ timeoutMs: 10000 });
  } catch (err) {
    const notConfigured = /not configured/i.test(err?.message || "");
    console.error("[health-mcp] connect failed:", err?.message || err);
    res.status(200).json({
      ok: false,
      configured: !notConfigured,
      connected: false,
      tool_called: null,
      status: notConfigured ? "not_configured" : "connection_failed"
    });
    return;
  }

  // Step 2: connected (handshake succeeded — client already holds an
  // open MCP session at this point, so connection + auth are proven).
  let availableTools = [];
  try {
    const toolsResult = await client.listTools();
    availableTools = (toolsResult?.tools || []).map((t) => t.name);
  } catch (err) {
    console.error("[health-mcp] tools/list failed:", err?.message || err);
    await closeMcpClient(client);
    res.status(200).json({
      ok: false,
      configured: true,
      connected: true,
      tool_called: null,
      status: "tools_list_failed"
    });
    return;
  }

  // Step 3: call a real tool. list_databases takes no arguments and is
  // read-only, so it's safe to call unconditionally in production.
  try {
    const result = await client.callTool({ name: TEST_TOOL, arguments: {} });

    // MCP tool results are { content: [{type: "text", text: "..."}], isError }.
    // We only surface a short, sanitized preview — never the full raw
    // payload — to keep this endpoint safe to leave deployed.
    const rawText = Array.isArray(result?.content)
      ? result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
      : "";

    const preview = rawText.length > 400 ? `${rawText.slice(0, 400)}…` : rawText;

    res.status(200).json({
      ok: !result?.isError,
      configured: true,
      connected: true,
      tool_called: TEST_TOOL,
      tool_succeeded: !result?.isError,
      available_tools: availableTools,
      result_preview: preview,
      status: result?.isError ? "tool_call_failed" : "connected"
    });
  } catch (err) {
    console.error("[health-mcp] tool call failed:", err?.message || err);
    res.status(200).json({
      ok: false,
      configured: true,
      connected: true,
      tool_called: TEST_TOOL,
      tool_succeeded: false,
      available_tools: availableTools,
      status: "tool_call_failed"
    });
  } finally {
    await closeMcpClient(client);
  }
}
