/* ============================================================
   DIRECTOR'S MEMORY — api/_mcp-client.js
   Small shared helper, server-side only.

   Builds an MCP client that talks to the OFFICIAL ClickHouse
   MCP server (https://github.com/ClickHouse/mcp-clickhouse)
   over its Streamable HTTP transport.

   Architecture:
     Director's Memory frontend
       -> Vercel API route (this repo's /api/*.js)
       -> MCP client (this file)
       -> official mcp-clickhouse server (separate deployment)
       -> ClickHouse Cloud

   This module never touches CLICKHOUSE_HOST/USERNAME/PASSWORD —
   those stay owned by api/_clickhouse.js and the direct-driver
   path. The MCP path has its own, separate credential: a bearer
   token for the MCP server itself. The MCP server process (a
   separate deployment, not this Vercel project) is the only
   thing that holds real ClickHouse credentials for this path.

   Never imported by the browser bundle — this file only ever
   runs inside Vercel serverless functions.
   ============================================================ */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * getMcpEnv — reads and validates the MCP connection env vars
 * without ever logging their values. Throws a generic error (no
 * secret material) if anything is missing so callers can fail
 * safely / report "not configured" instead of crashing.
 */
export function getMcpEnv() {
  const url = process.env.CLICKHOUSE_MCP_URL?.trim();
  const token = process.env.CLICKHOUSE_MCP_AUTH_TOKEN?.trim();

  const missing = [];
  if (!url) missing.push("CLICKHOUSE_MCP_URL");
  // Token is required in production. It is intentionally NOT optional here —
  // this project must never run with CLICKHOUSE_MCP_AUTH_DISABLED=true
  // against a network-reachable MCP server.
  if (!token) missing.push("CLICKHOUSE_MCP_AUTH_TOKEN");

  if (missing.length > 0) {
    throw new Error(`MCP client is not configured: missing ${missing.join(", ")}`);
  }

  return { url, token };
}

/**
 * getMcpClient — connects to the official mcp-clickhouse server
 * over Streamable HTTP and returns a ready-to-use MCP client.
 * Serverless functions are short-lived, so — same pattern as
 * api/_clickhouse.js — we connect, use, and close per invocation
 * rather than pooling a long-lived connection.
 */
export async function getMcpClient({ timeoutMs = 10000 } = {}) {
  const { url, token } = getMcpEnv();

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });

  const client = new Client(
    { name: "directors-memory", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport, { timeout: timeoutMs });

  return client;
}

/**
 * closeMcpClient — best-effort close, never throws. Mirrors
 * closeClickHouseClient in api/_clickhouse.js so both integration
 * paths fail the same safe way.
 */
export async function closeMcpClient(client) {
  if (!client) return;
  try {
    await client.close();
  } catch {
    // Closing a client should never be able to fail the response.
  }
}

/**
 * callMcpTool — convenience wrapper: connect, call one tool,
 * close, return the raw MCP tool result. Callers are responsible
 * for interpreting result.content / result.isError.
 */
export async function callMcpTool(toolName, args = {}, opts = {}) {
  let client;
  try {
    client = await getMcpClient(opts);
    const result = await client.callTool({ name: toolName, arguments: args });
    return result;
  } finally {
    await closeMcpClient(client);
  }
}
