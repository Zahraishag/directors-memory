/* ============================================================
   DIRECTOR'S MEMORY — api/get-decisions.js
   Vercel serverless function (Node.js runtime, ESM).

   Role: Director Memory's read path: given a project, character,
   and scene number, it returns every director_decisions row that
   is active for that scene. It does not compare those decisions
   against anything — the Continuity Engine in app.js does that,
   exactly as it already does for the values that used to be
   hardcoded. This endpoint only replaces where those values
   come from.

   Retrieval architecture (as of the MCP integration step):

     Director's Memory frontend
       -> /api/get-decisions              (this file)
       -> MCP client (api/_mcp-client.js)
       -> official mcp-clickhouse server   (separate Render deploy)
       -> ClickHouse Cloud

   The official ClickHouse MCP server (run_query tool) is the
   PRIMARY path. The pre-existing direct @clickhouse/client path
   (api/_clickhouse.js) is kept as a safe backend fallback: if the
   MCP call fails for any reason (server down, auth rejected,
   network error, malformed result), this file transparently
   retries the same logical query directly against ClickHouse
   before giving up. Only if BOTH paths fail does this endpoint
   return success:false.

   Never fabricates a "clickhouse" source: on any failure it
   returns success:false so the client can fall back honestly
   (MEMORY FALLBACK) instead of faking LIVE · CLICKHOUSE. An
   empty decisions array with success:true (Scene 10) remains a
   fully valid live result on either path — "no active decisions
   for this scene" is not a failure.
   ============================================================ */

import { getClickHouseClient, closeClickHouseClient } from "./_clickhouse.js";
import { callMcpTool } from "./_mcp-client.js";

// The official ClickHouse MCP server's SQL-execution tool.
// See: https://github.com/ClickHouse/mcp-clickhouse — "ClickHouse Tools" ->
// run_query. Input: { query: string }. Runs read-only by default.
const MCP_TOOL_NAME = "run_query";

// Used by the direct-driver fallback path only. @clickhouse/client binds
// these as real query parameters (not string interpolation), which is why
// this path doesn't need the escaping helper below.
const DECISIONS_QUERY = `
  SELECT
    decision_id,
    character_name,
    attribute,
    approved_value,
    effective_from_scene,
    effective_until_scene,
    status,
    supersedes,
    source_scene,
    source_type,
    reasoning
  FROM director_decisions
  WHERE project_id = {project_id:String}
    AND character_name = {character_name:String}
    AND status = 'active'
    AND effective_from_scene <= {scene:UInt16}
    AND (
      isNull(effective_until_scene)
      OR effective_until_scene >= {scene:UInt16}
    )
  ORDER BY attribute ASC, effective_from_scene ASC
`;

function toLabel(attribute) {
  if (typeof attribute !== "string" || attribute.length === 0) return "Unknown";
  return attribute.charAt(0).toUpperCase() + attribute.slice(1);
}

function toSourceLabel(row) {
  if (row.reasoning && row.reasoning.trim().length > 0) return row.reasoning;
  if (row.source_scene !== null && row.source_scene !== undefined) {
    return `Director approval — Scene ${row.source_scene}`;
  }
  return row.source_type || "Director approval";
}

/**
 * mapRowToDecision — reshapes a raw ClickHouse row into the same
 * decision shape the Continuity Engine (findActiveDecisions,
 * resolveDecision, detectConflicts in app.js) already expects,
 * so no downstream engine code has to change. Used for rows
 * coming back from EITHER retrieval path (MCP or direct), since
 * both select the same columns.
 */
function mapRowToDecision(row) {
  return {
    id: row.decision_id,
    character: row.character_name,
    attribute: row.attribute,
    label: toLabel(row.attribute),
    value: row.approved_value,
    effectiveFromScene: row.effective_from_scene,
    effectiveUntilScene:
      row.effective_until_scene === null || row.effective_until_scene === undefined
        ? null
        : row.effective_until_scene,
    status: row.status,
    supersedes: row.supersedes ?? null,
    source: toSourceLabel(row)
  };
}

/**
 * escapeSqlLiteral — the MCP run_query tool takes a single raw SQL
 * string (no native parameter binding, unlike @clickhouse/client's
 * query_params). Standard SQL single-quote escaping (doubling any
 * embedded quote) is sufficient here because both interpolated
 * string values are quoted literals in the query below, and the
 * scene number is validated as a finite JS number by the caller
 * before it ever reaches this function — so it is inlined
 * unquoted and can't carry injected SQL text.
 */
function escapeSqlLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function buildMcpDecisionsSql(projectId, characterName, sceneNumber) {
  const safeProjectId = escapeSqlLiteral(projectId);
  const safeCharacterName = escapeSqlLiteral(characterName);

  return `
    SELECT
      decision_id,
      character_name,
      attribute,
      approved_value,
      effective_from_scene,
      effective_until_scene,
      status,
      supersedes,
      source_scene,
      source_type,
      reasoning
    FROM director_decisions
    WHERE project_id = '${safeProjectId}'
      AND character_name = '${safeCharacterName}'
      AND status = 'active'
      AND effective_from_scene <= ${sceneNumber}
      AND (
        isNull(effective_until_scene)
        OR effective_until_scene >= ${sceneNumber}
      )
    ORDER BY attribute ASC, effective_from_scene ASC
  `;
}

/**
 * rowsFromColumnsShape — converts the official mcp-clickhouse run_query
 * result shape:
 *   { columns: ["colA", "colB", ...], rows: [[v1, v2, ...], ...] }
 * into an array of row objects keyed by column name, e.g.:
 *   [{ colA: v1, colB: v2 }, ...]
 * so downstream code (mapRowToDecision) can keep working the same way
 * regardless of which retrieval path produced the rows.
 */
function rowsFromColumnsShape(parsed) {
  const { columns, rows } = parsed;

  if (!Array.isArray(columns)) {
    throw new Error("MCP run_query result 'columns' was not an array");
  }
  if (!Array.isArray(rows)) {
    throw new Error("MCP run_query result 'rows' was not an array");
  }

  return rows.map((row) => {
    const obj = {};
    columns.forEach((columnName, index) => {
      obj[columnName] = Array.isArray(row) ? row[index] : undefined;
    });
    return obj;
  });
}

/**
 * parseMcpRows — the run_query tool returns its result as MCP tool
 * content: normally a single { type: "text", text: "<json>" } block.
 *
 * The PRIMARY, officially-documented shape of that JSON is:
 *   { columns: [...column names...], rows: [[...values...], ...] }
 * which rowsFromColumnsShape() converts into row objects keyed by
 * column name — the same shape @clickhouse/client's JSONEachRow
 * format already produces for the direct-driver path.
 *
 * A bare JSON array of row objects is also accepted as a backwards-
 * compatible fallback shape, in case a future/alternate server build
 * returns pre-shaped rows directly. Anything else — a tool-reported
 * error, non-JSON text, or a JSON value matching neither shape — is
 * treated as a parse failure so the caller falls back to the direct
 * driver instead of guessing at row shape.
 */
function parseMcpRows(toolResult) {
  if (!toolResult || toolResult.isError) {
    const message = Array.isArray(toolResult?.content)
      ? toolResult.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(" ")
      : "";
    throw new Error(message || "MCP run_query reported an error");
  }

  const rawText = Array.isArray(toolResult.content)
    ? toolResult.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
    : "";

  if (!rawText) {
    throw new Error("MCP run_query returned no content");
  }

  const parsed = JSON.parse(rawText);

  // Primary, official shape: { columns: [...], rows: [[...], ...] }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "columns" in parsed && "rows" in parsed) {
    return rowsFromColumnsShape(parsed);
  }

  // Backwards-compatible fallback shape: a bare array of row objects.
  if (Array.isArray(parsed)) {
    return parsed;
  }

  throw new Error("MCP run_query result matched neither the {columns, rows} shape nor a bare row array");
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  const params = req.method === "GET" ? req.query || {} : req.body || {};

  const projectId = typeof params.project_id === "string" ? params.project_id.trim() : "";
  const characterName = typeof params.character_name === "string" ? params.character_name.trim() : "";
  const sceneNumber = Number(params.scene);

  if (!projectId || !characterName || !Number.isFinite(sceneNumber) || sceneNumber < 0) {
    res.status(400).json({
      success: false,
      error: "project_id, character_name, and a numeric scene are required"
    });
    return;
  }

  // ---- PRIMARY PATH: official ClickHouse MCP server (run_query) ----
  // getMcpEnv() inside callMcpTool()/getMcpClient() throws its own "not
  // configured" error if CLICKHOUSE_MCP_URL / CLICKHOUSE_MCP_AUTH_TOKEN are
  // missing, so a missing-config environment falls straight through to the
  // direct-driver fallback below, same as any other MCP failure.
  try {
    const sql = buildMcpDecisionsSql(projectId, characterName, sceneNumber);
    const toolResult = await callMcpTool(MCP_TOOL_NAME, { query: sql });
    const rows = parseMcpRows(toolResult);
    const decisions = rows.map(mapRowToDecision);

    // This is the log line that proves a real MCP round trip served the
    // request (not just a health check): it only ever logs after run_query
    // has returned a real, successfully-parsed result set.
    console.log(
      `[get-decisions] source=mcp tool=${MCP_TOOL_NAME} project_id=${projectId} character_name=${characterName} scene=${sceneNumber} rows=${decisions.length}`
    );

    res.status(200).json({
      success: true,
      source: "clickhouse",
      memory_transport: "mcp",
      project_id: projectId,
      character_name: characterName,
      scene: sceneNumber,
      decisions
    });
    return;
  } catch (mcpErr) {
    // Full detail stays server-side only. Falling through to the direct
    // driver is the intended behavior here, not an error state in itself.
    console.error(
      "[get-decisions] MCP path failed, falling back to direct ClickHouse:",
      mcpErr?.message || mcpErr
    );
  }

  // ---- FALLBACK PATH: direct @clickhouse/client (unchanged behavior) ----
  let client;
  try {
    client = getClickHouseClient();
  } catch (err) {
    console.error("[get-decisions] ClickHouse is not configured:", err.message);
    res.status(200).json({
      success: false,
      source: "fallback",
      error: "ClickHouse unavailable",
      project_id: projectId,
      character_name: characterName,
      scene: sceneNumber,
      decisions: []
    });
    return;
  }

  try {
    const resultSet = await client.query({
      query: DECISIONS_QUERY,
      query_params: {
        project_id: projectId,
        character_name: characterName,
        scene: sceneNumber
      },
      format: "JSONEachRow"
    });

    const rows = await resultSet.json();
    const decisions = rows.map(mapRowToDecision);

    console.log(
      `[get-decisions] source=direct project_id=${projectId} character_name=${characterName} scene=${sceneNumber} rows=${decisions.length}`
    );

    res.status(200).json({
      success: true,
      source: "clickhouse",
      memory_transport: "direct",
      project_id: projectId,
      character_name: characterName,
      scene: sceneNumber,
      decisions
    });
  } catch (err) {
    // Full detail stays server-side only — the client only ever sees a
    // generic message, per the fallback-safe design of this endpoint.
    console.error("[get-decisions] ClickHouse query failed:", err);
    res.status(200).json({
      success: false,
      source: "fallback",
      error: "ClickHouse query failed",
      project_id: projectId,
      character_name: characterName,
      scene: sceneNumber,
      decisions: []
    });
  } finally {
    await closeClickHouseClient(client);
  }
}
