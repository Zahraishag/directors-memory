/* ============================================================
   DIRECTOR'S MEMORY — api/get-decisions.js
   Vercel serverless function (Node.js runtime, ESM).

   Role: the ONLY place that talks to ClickHouse. The browser
   never receives or holds CLICKHOUSE_HOST/USERNAME/PASSWORD —
   they are read here from process.env, populated from Vercel
   Environment Variables at deploy time.

   This endpoint is Director Memory's read path: given a
   project, character, and scene number, it returns every
   director_decisions row that is active for that scene. It does
   not compare those decisions against anything — the
   Continuity Engine in app.js does that, exactly as it already
   does for the values that used to be hardcoded. This endpoint
   only replaces where those values come from.

   Never fabricates a "clickhouse" source: on any failure it
   returns success:false so the client can fall back honestly
   (MEMORY FALLBACK) instead of faking LIVE · CLICKHOUSE.
   ============================================================ */

import { getClickHouseClient, closeClickHouseClient } from "./_clickhouse.js";

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
 * so no downstream engine code has to change.
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

    res.status(200).json({
      success: true,
      source: "clickhouse",
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
