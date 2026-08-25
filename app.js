/* ============================================================
   DIRECTOR'S MEMORY — app.js
   AI Continuity Agent for Filmmakers (MVP v3 — Live Gemini Vision
   + Live ClickHouse Director Memory)

   Architecture overview
   ----------------------------------------------------------
   1. DATA LAYER            — sceneData, fallbackDirectorDecisions,
                               fallbackAnalysis
   1A. CLICKHOUSE MEMORY LAYER — fetchDirectorDecisions (calls the
                               server-side /api/get-decisions endpoint;
                               ClickHouse credentials never reach this file)
   1B. GEMINI VISION LAYER   — loadSceneImageAsBase64, analyzeSceneWithGemini
                               (calls the server-side /api/analyze-scene
                               endpoint; the API key never reaches this file)
   2. CONTINUITY ENGINE      — findActiveDecisions, resolveDecision,
                               detectConflicts, generateFixPrompt
   3. APPLICATION STATE      — appState, applyVisionResult,
                               applyDecisionsResult, approveFix
   4. UI LAYER               — screen navigation, rendering, events

   Runtime flow (Run Continuity Check):
     Gemini Vision observation  ─┐
                                  ├─▶ Deterministic Continuity Engine ─▶ Conflict / Consistent result
     ClickHouse Director Memory ─┘

   Scene attributes come from a live Gemini Vision analysis of
   assets/scene-07-frame.jpg. Director decisions come from a live
   ClickHouse query. Both have a narrow, honest fallback if the live
   call fails (client never fakes a "live" source). The CONTINUITY
   ENGINE and UI LAYER read only appState.scene.attributes and
   appState.activeDecisions — they don't care whether those came from
   Gemini/ClickHouse or from the fallback paths.
============================================================ */

/* ============================================================
   1. DATA LAYER
   ============================================================ */

/**
 * sceneData — scenes tracked in the current project.
 * In production this would be generated per-scene by the AI
 * pipeline (e.g. Gemini vision output describing the frame).
 */
const sceneData = {
  totalScenesTracked: 7,
  activeContinuityRules: 4,
  currentScene: {
    id: 7,
    title: "Rooftop Escape",
    character: "Maya",
    location: "Rooftop",
    time: "Night",
    description:
      "Maya stands on a rain-soaked rooftop at night. She has long black hair, wears a black coat, and carries a dark duffel bag.",
    // Detected attributes for this scene (would come from an AI vision pass)
    attributes: {
      hair: "Long black hair",
      wardrobe: "Black coat",
      prop: "Black duffel bag",
      lighting: "Cold blue nighttime lighting"
    }
  }
};

/**
 * Gemini Vision configuration.
 *
 * The browser NEVER talks to Gemini directly and never sees an API key.
 * It only ever calls this same-origin endpoint, which is backed by the
 * Vercel serverless function in /api/analyze-scene.js.
 */
const GEMINI_ENDPOINT = "/api/analyze-scene";
const GEMINI_TIMEOUT_MS = 62000; // aligned above api/analyze-scene.js's GEMINI_TIMEOUT_MS (60000ms) so the browser never gives up before the server-side Gemini call could still succeed
const SCENE_IMAGE_PATH = "assets/scene-07-frame.jpg";
const SCENE_IMAGE_MAX_WIDTH = 1280; // resized client-side before upload
const SCENE_IMAGE_JPEG_QUALITY = 0.82;

/**
 * fallbackAnalysis — used only when the live Gemini call fails
 * (network, quota, missing key, timeout). This mirrors the MVP v1
 * scripted demo values exactly, so the demo never breaks on stage.
 * TODO: Store scene analysis history
 */
const fallbackAnalysis = {
  characterVisible: true,
  hair: sceneData.currentScene.attributes.hair,
  wardrobe: sceneData.currentScene.attributes.wardrobe,
  prop: sceneData.currentScene.attributes.prop,
  lighting: sceneData.currentScene.attributes.lighting,
  location: sceneData.currentScene.location,
  timeOfDay: sceneData.currentScene.time,
  confidence: {
    hair: 0.9,
    wardrobe: 0.9,
    prop: 0.9,
    lighting: 0.9,
    location: 0.9
  }
};

/**
 * fallbackDirectorDecisions — used ONLY when the live ClickHouse
 * query in fetchDirectorDecisions() fails (network, credentials,
 * query error, timeout). This mirrors the MVP v1/v2 scripted demo
 * values exactly, so the demo never breaks on stage — but it is no
 * longer part of the main runtime comparison path. When ClickHouse
 * is reachable, the Continuity Engine compares against the live
 * rows in appState.directorDecisionsLive instead.
 *
 * Shape (matches what /api/get-decisions.js returns for each row):
 * {
 *   id, character, attribute, label, value,
 *   effectiveFromScene, effectiveUntilScene,
 *   status, supersedes, source
 * }
 */
const fallbackDirectorDecisions = [
  {
    id: "DEC-011",
    character: "Maya",
    attribute: "hair",
    label: "Hair",
    value: "Short black hair",
    effectiveFromScene: 3,
    effectiveUntilScene: 9,
    status: "active",
    supersedes: null,
    source: "Director approval — Scene 3"
  },
  {
    id: "DEC-012",
    character: "Maya",
    attribute: "wardrobe",
    label: "Wardrobe",
    value: "Red coat",
    effectiveFromScene: 3,
    effectiveUntilScene: 9,
    status: "active",
    supersedes: null,
    source: "Director approval — Scene 3"
  },
  {
    id: "DEC-013",
    character: "Maya",
    attribute: "prop",
    label: "Prop",
    value: "Silver shoulder bag",
    effectiveFromScene: 4,
    effectiveUntilScene: 9,
    status: "active",
    supersedes: null,
    source: "Director approval — Scene 4"
  },
  {
    id: "DEC-014",
    character: null, // global / scene-level decision (not tied to one character)
    attribute: "lighting",
    label: "Lighting",
    value: "Cold blue nighttime lighting",
    effectiveFromScene: 5,
    effectiveUntilScene: 9,
    status: "active",
    supersedes: null,
    source: "Director approval — Scene 5"
  }
];

/* ============================================================
   1A. CLICKHOUSE MEMORY LAYER
   ============================================================
   This layer's only job is retrieving director decisions for the
   current project/character/scene from the server-side
   /api/get-decisions endpoint, which is the only place that talks
   to ClickHouse. Credentials never reach this file. This layer
   never judges continuity itself — see detectConflicts() in the
   CONTINUITY ENGINE for that. ClickHouse remembers; the engine
   judges.
   ============================================================ */

const CLICKHOUSE_ENDPOINT = "/api/get-decisions";
const CLICKHOUSE_TIMEOUT_MS = 32000; // aligned above api/_clickhouse.js's request_timeout (30000ms) so the browser never gives up before the server-side ClickHouse query could still succeed
const PROJECT_ID = "project-aurora";

/**
 * fetchDirectorDecisions — GETs /api/get-decisions for the given
 * project/character/scene and returns either a live ClickHouse
 * result or a graceful failure signal. This function NEVER throws
 * — callers always get back a plain { success, source, decisions }
 * shape, and it NEVER fakes source: "clickhouse" on failure. If the
 * live call fails for any reason, the caller falls back to
 * fallbackDirectorDecisions and the UI shows "MEMORY FALLBACK".
 */
async function fetchDirectorDecisions(projectId, character, sceneNumber) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLICKHOUSE_TIMEOUT_MS);

  try {
    const url = new URL(CLICKHOUSE_ENDPOINT, window.location.origin);
    url.searchParams.set("project_id", projectId);
    url.searchParams.set("character_name", character);
    url.searchParams.set("scene", String(sceneNumber));

    const response = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`ClickHouse endpoint responded with ${response.status}`);
    }

    const data = await response.json();
    if (!data.success || !Array.isArray(data.decisions)) {
      throw new Error("ClickHouse decisions lookup was not successful");
    }

    return { success: true, source: "clickhouse", decisions: data.decisions };
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn("[Director's Memory] Live ClickHouse memory unavailable, using fallback:", err);
    return { success: false, source: "fallback", decisions: fallbackDirectorDecisions };
  }
}

/* ============================================================
   1B. GEMINI VISION LAYER
   ============================================================
   This layer's only job is turning the local frame image into a
   structured observation via the server-side Gemini endpoint.
   It never touches director decisions and never decides what is
   "correct" — see detectConflicts() in the CONTINUITY ENGINE for
   that. Gemini observes; Director Memory judges.
   ============================================================ */

/**
 * loadSceneImageAsBase64 — fetches the local scene frame, downsizes
 * it client-side (max width + JPEG quality below) so we never upload
 * a full-resolution image unnecessarily, and returns base64 + mime.
 */
async function loadSceneImageAsBase64(
  path = SCENE_IMAGE_PATH,
  maxWidth = SCENE_IMAGE_MAX_WIDTH,
  quality = SCENE_IMAGE_JPEG_QUALITY
) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Could not load scene image (${response.status})`);
  }
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const scale = Math.min(1, maxWidth / bitmap.width);
  const targetWidth = Math.round(bitmap.width * scale);
  const targetHeight = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const base64 = dataUrl.split(",")[1];
  return { base64, mimeType: "image/jpeg" };
}

/**
 * analyzeSceneWithGemini — POSTs the frame to /api/analyze-scene and
 * returns either a live Gemini result or a graceful failure signal.
 * This function NEVER throws — callers always get back a plain
 * { success, source, analysis } shape so the demo can't crash on
 * network issues, quota errors, a missing key, or a timeout.
 */
async function analyzeSceneWithGemini(sceneNumber, character) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const { base64, mimeType } = await loadSceneImageAsBase64();

    const response = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: base64,
        mimeType,
        sceneNumber,
        character
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Gemini endpoint responded with ${response.status}`);
    }

    const data = await response.json();
    if (!data.success || !data.analysis) {
      throw new Error("Gemini analysis was not successful");
    }

    return { success: true, source: "gemini", analysis: data.analysis };
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn("[Director's Memory] Live Gemini analysis unavailable, using fallback:", err);
    return { success: false, source: "fallback", analysis: fallbackAnalysis };
  }
}

/* ============================================================
   2. CONTINUITY ENGINE
   Pure functions — no DOM access here. This is the layer that
   would eventually be mirrored server-side (Cloud Function /
   MCP server) once we move off local demo data.
   ============================================================ */

/**
 * A decision is active for a scene when:
 *   sceneNumber >= effectiveFromScene
 *   AND (no effectiveUntilScene OR sceneNumber <= effectiveUntilScene)
 *   AND status === "active"
 */
function isDecisionActiveForScene(decision, sceneNumber) {
  if (decision.status !== "active") return false;
  if (sceneNumber < decision.effectiveFromScene) return false;
  if (
    decision.effectiveUntilScene !== null &&
    decision.effectiveUntilScene !== undefined &&
    sceneNumber > decision.effectiveUntilScene
  ) {
    return false;
  }
  return true;
}

/**
 * resolveDecision — supersedes-aware lookup.
 *
 * Given a full decision list, a character and an attribute,
 * walk the pool of decisions and return whichever one is the
 * "final say" for that character+attribute: if a decision is
 * named in another active decision's `supersedes` field, the
 * older decision is ignored.
 *
 * Not exercised by today's demo dataset (no decision currently
 * supersedes another) but the engine must support it from day
 * one, since production decisions get revised mid-shoot.
 */
function resolveDecision(character, attribute, decisions, sceneNumber) {
  const pool = decisions.filter(
    (d) =>
      d.attribute === attribute &&
      (d.character === character || d.character === null) &&
      isDecisionActiveForScene(d, sceneNumber)
  );

  if (pool.length === 0) return null;

  // Collect every decision id that has been superseded by an
  // active decision in this pool.
  const supersededIds = new Set(
    pool
      .filter((d) => d.supersedes)
      .map((d) => d.supersedes)
  );

  const effective = pool.filter((d) => !supersededIds.has(d.id));

  if (effective.length === 0) return null;

  // If multiple candidates remain, prefer the most recently
  // effective one (highest effectiveFromScene).
  return effective.sort(
    (a, b) => b.effectiveFromScene - a.effectiveFromScene
  )[0];
}

/**
 * findActiveDecisions — every decision in force for a given
 * scene number, already resolved through the supersedes chain.
 */
function findActiveDecisions(sceneNumber, decisions = fallbackDirectorDecisions) {
  const candidates = decisions.filter((d) =>
    isDecisionActiveForScene(d, sceneNumber)
  );

  const pairs = new Set(
    candidates.map((d) => `${d.character || "GLOBAL"}::${d.attribute}`)
  );

  const resolved = [];
  pairs.forEach((pairKey) => {
    const [character, attribute] = pairKey.split("::");
    const decision = resolveDecision(
      character === "GLOBAL" ? null : character,
      attribute,
      decisions,
      sceneNumber
    );
    if (decision) resolved.push(decision);
  });

  return resolved;
}

/**
 * CONCEPT_CANONICALIZATION_RULES — deterministic, concept-based
 * canonicalization, keyed by attribute. This is the reusable
 * replacement for hand-listing exact modifier phrases (which is
 * brittle and only ever covers sentences someone thought to add).
 *
 * Instead, each attribute lists one or more "canonical profiles".
 * A profile is a target canonical value plus the set of core
 * continuity CONCEPTS that must all be present (as whole words,
 * matched via regex — still 100% deterministic text matching, no
 * model call, no fuzzy/semantic judgment) for an observed string to
 * be considered that concept. If every concept in a profile is
 * present in the observed value, the ENTIRE value is canonicalized
 * to that profile's fixed value, regardless of whatever other
 * descriptive words (glow, backlighting, reflections, ambience,
 * etc.) also happen to be present — those are simply irrelevant to
 * continuity and get discarded by the canonicalization itself.
 *
 * If a value is missing one or more required concepts (e.g. "warm"
 * instead of "cold/cool", or no "blue" at all), no profile matches,
 * the value is left as its plain normalized text, and it will
 * correctly fail to match the decision's canonical value — i.e. it
 * still registers as a genuine conflict.
 *
 * New attributes or new canonical states can be supported later by
 * adding more entries here — nothing else in the engine needs to
 * change, which is what makes this reusable rather than a one-off
 * fix for a single sentence.
 */
const CONCEPT_CANONICALIZATION_RULES = {
  lighting: [
    {
      canonicalValue: "cold blue nighttime lighting",
      concepts: [
        /\b(?:cold|cool)\b/, // temperature
        /\bblue\b/, // color
        /\b(?:night|nighttime)\b/, // time of day
        /\blighting\b/ // category
      ]
    }
  ]
};

/**
 * applyConceptCanonicalization — for the given attribute, checks
 * every registered canonical profile against the already
 * whitespace/punctuation-normalized value. The first profile whose
 * concepts are ALL present wins and its fixed canonical value is
 * returned. If no profile fully matches, the normalized value is
 * returned unchanged (so genuinely different values stay different).
 */
function applyConceptCanonicalization(attribute, normalizedValue) {
  const profiles = CONCEPT_CANONICALIZATION_RULES[attribute];
  if (!profiles) return normalizedValue;

  const matchedProfile = profiles.find((profile) =>
    profile.concepts.every((conceptPattern) => conceptPattern.test(normalizedValue))
  );

  return matchedProfile ? matchedProfile.canonicalValue : normalizedValue;
}

/**
 * canonicalizeAttributeValue — the normalization/canonicalization
 * layer required before any continuity comparison. Step 1 is plain
 * deterministic text normalization (casing, whitespace, punctuation).
 * Step 2 is concept-based canonicalization (see above) for any
 * attribute that has registered concept profiles. Neither step ever
 * calls a model or asks Gemini whether something conflicts — Gemini
 * only ever supplies the raw observed string; this function purely
 * standardizes wording so equivalent phrasing compares equal while
 * genuinely different values still compare unequal.
 */
function canonicalizeAttributeValue(attribute, value) {
  if (typeof value !== "string") return "";

  let normalized = value
    .trim()
    .toLowerCase()
    .replace(/[.,;:!]+/g, " ") // drop punctuation anywhere (commas, periods, etc.)
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();

  normalized = applyConceptCanonicalization(attribute, normalized);

  return normalized;
}

/**
 * detectConflicts — compares the scene's current detected
 * attributes against every active director decision. Anything
 * that matches (after deterministic canonicalization, so wording
 * differences like "cool" vs "cold" or "night" vs "nighttime", or
 * extra descriptive modifiers like "with city backlighting", don't
 * create false conflicts) is "consistent"; anything that still
 * differs after canonicalization becomes a conflict card.
 */
function detectConflicts(scene, activeDecisions) {
  const conflicts = [];
  const consistent = [];

  activeDecisions.forEach((decision) => {
    const currentValue = scene.attributes[decision.attribute];
    if (currentValue === undefined) return;

    const matches =
      canonicalizeAttributeValue(decision.attribute, currentValue) ===
      canonicalizeAttributeValue(decision.attribute, decision.value);

    const entry = {
      decisionId: decision.id,
      attribute: decision.attribute,
      label: decision.label,
      current: currentValue,
      expected: decision.value,
      sourceScene: decision.effectiveFromScene,
      decision
    };

    if (matches) {
      consistent.push(entry);
    } else {
      conflicts.push(entry);
    }
  });

  return { conflicts, consistent };
}

/**
 * enforceMutualExclusion — safety net that guarantees a single
 * attribute can never appear in both the conflicts list and the
 * consistent list at the same time. detectConflicts() already keeps
 * these disjoint by construction (each attribute is classified
 * exactly once, as either matching or not matching), but the UI
 * must never be able to render both a conflict card and a
 * consistency card for the same attribute, so this is enforced
 * explicitly as a second, defensive check right before the result
 * reaches appState. If an attribute somehow appeared in both,
 * "conflict" wins — a continuity engine should never silently hide
 * a real difference behind a consistency card.
 */
function enforceMutualExclusion(conflicts, consistent) {
  const conflictAttributes = new Set(conflicts.map((c) => c.attribute));
  const safeConsistent = consistent.filter(
    (c) => !conflictAttributes.has(c.attribute)
  );
  return { conflicts, consistent: safeConsistent };
}

/**
 * generateFixPrompt — builds the corrected prompt text a
 * filmmaker would feed back into their generation tool, plus
 * a structured summary of what's being fixed vs. preserved.
 */
function generateFixPrompt(scene, conflicts, consistent) {
  const conflictByAttr = {};
  conflicts.forEach((c) => (conflictByAttr[c.attribute] = c));

  const hair = conflictByAttr.hair ? conflictByAttr.hair.expected : scene.attributes.hair;
  const wardrobe = conflictByAttr.wardrobe ? conflictByAttr.wardrobe.expected : scene.attributes.wardrobe;
  const prop = conflictByAttr.prop ? conflictByAttr.prop.expected : scene.attributes.prop;
  const lightingConsistent = consistent.find((c) => c.attribute === "lighting");
  const lighting = lightingConsistent ? lightingConsistent.expected : scene.attributes.lighting;

  const promptText =
    `Preserve ${scene.character}'s established appearance and continuity from previous approved scenes.\n\n` +
    `${scene.character} must have ${hair.toLowerCase()}, wear the established ${wardrobe.toLowerCase()}, and carry the ${prop.toLowerCase()}.\n\n` +
    `Maintain the ${lighting.toLowerCase()}.\n\n` +
    `Preserve ${scene.character}'s facial identity, age, body proportions, and cinematic visual style.\n\n` +
    `Do not introduce wardrobe, hairstyle, prop, or identity changes unless explicitly approved by the director.`;

  const fixing = conflicts.map((c) => c.label);
  const preserving = ["Lighting", "Identity", "Location"];

  return { promptText, fixing, preserving };
}

/* ============================================================
   3. APPLICATION STATE
   ============================================================ */

const appState = {
  scene: sceneData.currentScene,
  activeDecisions: [],
  conflicts: [],
  consistent: [],
  fix: null,
  visionSource: null, // "gemini" | "fallback"
  visionAnalysis: null,
  overallConfidence: null,
  decisionsSource: null, // "clickhouse" | "fallback"
  directorDecisionsLive: null // decisions retrieved for this run (live or fallback)
};

/**
 * applyVisionResult — takes the result of analyzeSceneWithGemini()
 * and updates appState.scene.attributes from it, exactly as
 * findActiveDecisions()/detectConflicts() already expect. Those two
 * functions are untouched — they simply read whatever is in
 * appState.scene.attributes, live Gemini values or fallback values.
 */
function applyVisionResult(result) {
  const analysis = result.analysis || fallbackAnalysis;

  appState.visionSource = result.success ? "gemini" : "fallback";
  appState.visionAnalysis = analysis;

  appState.scene.attributes = {
    hair: analysis.hair,
    wardrobe: analysis.wardrobe,
    prop: analysis.prop,
    lighting: analysis.lighting
  };

  const confidenceValues = Object.values(analysis.confidence || {}).filter(
    (v) => typeof v === "number" && !Number.isNaN(v)
  );
  appState.overallConfidence = confidenceValues.length
    ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length
    : null;

  return appState.visionSource;
}

/**
 * applyDecisionsResult — takes the result of fetchDirectorDecisions()
 * and updates appState.directorDecisionsLive from it, exactly as
 * runAnalysis()/findActiveDecisions() already expect. If the live
 * ClickHouse rows come back empty, that's meaningfully different
 * from a failed call, so an empty-but-successful result stays
 * "clickhouse" (0 active decisions is a valid answer) — it never
 * silently swaps in fallback data.
 */
function applyDecisionsResult(result) {
  appState.decisionsSource = result.success ? "clickhouse" : "fallback";
  appState.directorDecisionsLive = result.success
    ? result.decisions
    : fallbackDirectorDecisions;

  return appState.decisionsSource;
}

function runAnalysis() {
  const decisions = appState.directorDecisionsLive || fallbackDirectorDecisions;
  appState.activeDecisions = findActiveDecisions(appState.scene.id, decisions);
  const rawResult = detectConflicts(appState.scene, appState.activeDecisions);
  const result = enforceMutualExclusion(rawResult.conflicts, rawResult.consistent);
  appState.conflicts = result.conflicts;
  appState.consistent = result.consistent;
  return result;
}

function buildFix() {
  appState.fix = generateFixPrompt(
    appState.scene,
    appState.conflicts,
    appState.consistent
  );
  return appState.fix;
}

/**
 * approveFix — marks the fix as applied. In production this is
 * where we'd write the resolution back to the continuity store.
 * TODO: Connect through MCP server
 * TODO: Deploy API layer to Google Cloud
 */
function approveFix() {
  appState.approved = true;
  appState.approvedAt = new Date().toISOString();
  return {
    conflictsResolved: appState.conflicts.length,
    scenesProtected: 1,
    rulesValidated: appState.activeDecisions.length
  };
}

/* ============================================================
   4. UI LAYER
   ============================================================ */

const els = {
  screens: document.querySelectorAll(".screen"),
  navItems: document.querySelectorAll(".nav-item"),
  sidebar: document.getElementById("sidebar"),
  sidebarToggle: document.getElementById("sidebarToggle"),
  sidebarScrim: document.getElementById("sidebarScrim"),
  toast: document.getElementById("toast"),

  btnAnalyzeScene: document.getElementById("btnAnalyzeScene"),
  btnRunCheck: document.getElementById("btnRunCheck"),
  processingSteps: document.getElementById("processingSteps"),

  sceneTitle: document.getElementById("sceneTitle"),
  metaSceneValue: document.getElementById("metaSceneValue"),
  conflictsBackBtn: document.getElementById("conflictsBackBtn"),

  topbarSceneSwitch: document.getElementById("topbarSceneSwitch"),

  memoryTitle: document.getElementById("memoryTitle"),
  memoryBadge: document.getElementById("memoryBadge"),
  memoryStatusPanel: document.getElementById("memoryStatusPanel"),
  memoryStatusText: document.getElementById("memoryStatusText"),
  memoryExplainText: document.getElementById("memoryExplainText"),
  memoryDecisionGrid: document.getElementById("memoryDecisionGrid"),
  memoryEmptyPanel: document.getElementById("memoryEmptyPanel"),
  memoryEmptyText: document.getElementById("memoryEmptyText"),
  memoryEmptyExplain: document.getElementById("memoryEmptyExplain"),
  memoryErrorPanel: document.getElementById("memoryErrorPanel"),
  memoryErrorText: document.getElementById("memoryErrorText"),

  conflictGrid: document.getElementById("conflictGrid"),
  conflictCount: document.getElementById("conflictCount"),
  consistencyList: document.getElementById("consistencyList"),

  sourceBadge: document.getElementById("sourceBadge"),
  geminiGrid: document.getElementById("geminiGrid"),
  geminiConfidence: document.getElementById("geminiConfidence"),
  geminiWarning: document.getElementById("geminiWarning"),

  clickhouseBadge: document.getElementById("clickhouseBadge"),
  clickhouseMeta: document.getElementById("clickhouseMeta"),

  modalOverlay: document.getElementById("modalOverlay"),
  modalTitle: document.getElementById("modalTitle"),
  modalGrid: document.getElementById("modalGrid"),
  modalWhy: document.getElementById("modalWhy"),
  modalClose: document.getElementById("modalClose"),
  btnGenerateFix: document.getElementById("btnGenerateFix"),

  promptText: document.getElementById("promptText"),
  fixingList: document.getElementById("fixingList"),
  preservingList: document.getElementById("preservingList"),
  btnCopyPrompt: document.getElementById("btnCopyPrompt"),
  btnCopyPrompt2: document.getElementById("btnCopyPrompt2"),
  btnApproveFix: document.getElementById("btnApproveFix"),
  btnBackHome: document.getElementById("btnBackHome")
};

const SCREEN_IDS = {
  home: "screen-home",
  scene: "screen-scene",
  processing: "screen-processing",
  conflicts: "screen-conflicts",
  fix: "screen-fix",
  success: "screen-success",
  memory: "screen-memory"
};

let activeDecisionForModal = null;

/* ---------- Scene chrome sync ---------- */
/**
 * updateSceneChrome — keeps every on-screen label that shows the
 * scene number (Scene Review title, metadata grid, conflicts-screen
 * back button) in sync with appState.scene.id. Doesn't touch
 * appState.scene.attributes or trigger any network call — it's pure
 * display. Scene 7's own flow (Run Continuity Check) is unaffected;
 * it still reads appState.scene.id exactly as before.
 */
function updateSceneChrome() {
  const id = appState.scene.id;
  if (els.sceneTitle) els.sceneTitle.textContent = `Scene ${id} — Rooftop Escape`;
  if (els.metaSceneValue) els.metaSceneValue.textContent = String(id);
  if (els.conflictsBackBtn) els.conflictsBackBtn.textContent = `← Scene ${id}`;
}

/* ---------- Top bar scene switch (Scene 7 / 8 / 10) ---------- */
/**
 * Selecting a scene here is a separate, additional path from the
 * existing "Analyze Scene" flow (Home → Scene Review → Run Continuity
 * Check). Scene 8 and Scene 10 have no dedicated frame/description of
 * their own in this demo, so selecting them opens the Director Memory
 * screen and fetches live decisions for that scene number via the SAME
 * fetchDirectorDecisions() used by the Scene 7 continuity check
 * (1A. CLICKHOUSE MEMORY LAYER, above — unmodified) and the SAME
 * findActiveDecisions() used by the Continuity Engine (unmodified), so
 * "what's active for this scene" is always computed by the one engine
 * the rest of the app already trusts — never re-implemented here or
 * hardcoded in the frontend.
 *
 * Scene 7 is different: it's the original, full demo flow (Scene
 * Review → Run Continuity Check → Gemini Vision → ClickHouse Director
 * Memory → Conflicts → View Decision → Generate/Approve Fix), and that
 * flow must stay exactly as it was. So selecting Scene 7 here does NOT
 * open the generic Director Memory screen — it restores Scene 7 state
 * and returns to the Scene Review screen, i.e. the same place the
 * existing "Analyze Scene" button leads to.
 */
els.topbarSceneSwitch?.addEventListener("click", (e) => {
  const btn = e.target.closest(".scene-switch-btn");
  if (!btn) return;

  const selected = Number(btn.dataset.scene);
  if (!Number.isFinite(selected)) return;

  els.topbarSceneSwitch.querySelectorAll(".scene-switch-btn").forEach((b) => {
    const isActive = b === btn;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-selected", String(isActive));
  });

  appState.scene.id = selected;
  updateSceneChrome();

  if (selected === 7) {
    // Restore the original Scene 7 workflow — Scene Review screen,
    // same destination as the "Analyze Scene" button. Run Continuity
    // Check, Gemini Vision, ClickHouse Director Memory, Conflicts,
    // View Decision, and Generate/Approve Fix all continue to work
    // exactly as before from here, untouched.
    showScreen("scene");
    return;
  }

  // Scene 8 / Scene 10: no dedicated frame — go to the scene-aware
  // Director Memory screen and fetch live decisions for this scene.
  showScreen("memory");
  renderMemoryScreen(selected);
});

/**
 * memoryRequestToken — guards against a stale response landing after
 * a newer scene switch. If the director clicks Scene 8 then Scene 10
 * quickly, only the response matching the LATEST click is allowed to
 * render, so Scene 8's content can never flash back in after Scene
 * 10 was already selected.
 */
let memoryRequestToken = 0;
const MEMORY_LOADING_TEXT = "Retrieving active decisions from ClickHouse…";

function resetMemoryScreen(sceneNumber) {
  if (els.memoryTitle) els.memoryTitle.textContent = `Scene ${sceneNumber} — Director Memory`;
  if (els.memoryBadge) {
    els.memoryBadge.textContent = "Checking…";
    els.memoryBadge.classList.remove("badge-live", "badge-fallback");
  }
  if (els.memoryStatusPanel) els.memoryStatusPanel.hidden = false;
  if (els.memoryStatusText) els.memoryStatusText.textContent = MEMORY_LOADING_TEXT;
  if (els.memoryExplainText) els.memoryExplainText.textContent = "";
  if (els.memoryDecisionGrid) els.memoryDecisionGrid.innerHTML = "";
  if (els.memoryEmptyPanel) els.memoryEmptyPanel.hidden = true;
  if (els.memoryErrorPanel) els.memoryErrorPanel.hidden = true;
}

function renderMemoryDecisionCards(decisions) {
  if (!els.memoryDecisionGrid) return;
  els.memoryDecisionGrid.innerHTML = decisions
    .map(
      (d) => `
        <div class="memory-decision-card">
          <div class="memory-decision-head">
            <span class="memory-decision-id">${escapeHtml(d.id)}</span>
            <span class="memory-decision-status">${escapeHtml(d.status)}</span>
          </div>
          <span class="memory-decision-label">${escapeHtml(d.label)}</span>
          <span class="memory-decision-value">${escapeHtml(d.value)}</span>
          <span class="memory-decision-range">Scenes ${d.effectiveFromScene} → ${
        d.effectiveUntilScene ?? "∞"
      }</span>
        </div>`
    )
    .join("");
}

/**
 * renderMemoryScreen — fetches and renders Director Memory for the
 * given scene number via the existing /api/get-decisions endpoint.
 * success:true with an empty decisions array is treated as a normal,
 * valid result (not an error) — it means every prior decision has
 * expired by this scene. A genuine failure only occurs if something
 * in this rendering step itself throws; fetchDirectorDecisions()
 * already never throws and always resolves to a safe
 * { success, source, decisions } shape (falling back honestly, same
 * as the existing Scene 7 flow).
 */
async function renderMemoryScreen(sceneNumber) {
  const token = ++memoryRequestToken;
  resetMemoryScreen(sceneNumber);

  try {
    const result = await fetchDirectorDecisions(PROJECT_ID, "Maya", sceneNumber);
    if (token !== memoryRequestToken) return; // superseded by a newer scene switch

    const isLive = result.success === true;
    const decisions = findActiveDecisions(sceneNumber, result.decisions);

    if (els.memoryBadge) {
      els.memoryBadge.textContent = isLive ? "LIVE · CLICKHOUSE" : "MEMORY FALLBACK";
      els.memoryBadge.classList.toggle("badge-live", isLive);
      els.memoryBadge.classList.toggle("badge-fallback", !isLive);
    }

    if (decisions.length === 0) {
      if (els.memoryStatusPanel) els.memoryStatusPanel.hidden = true;
      if (els.memoryDecisionGrid) els.memoryDecisionGrid.innerHTML = "";
      if (els.memoryEmptyText) {
        els.memoryEmptyText.textContent = isLive
          ? `0 active decisions retrieved for Maya · Scene ${sceneNumber}`
          : `0 active decisions from local fallback memory · Scene ${sceneNumber}`;
      }
      if (els.memoryEmptyExplain) {
        els.memoryEmptyExplain.textContent = `All previous creative decisions expired before Scene ${sceneNumber}.`;
      }
      if (els.memoryEmptyPanel) els.memoryEmptyPanel.hidden = false;
    } else {
      if (els.memoryStatusPanel) els.memoryStatusPanel.hidden = false;
      if (els.memoryStatusText) {
        els.memoryStatusText.textContent = isLive
          ? `${decisions.length} active decisions retrieved for Maya · Scene ${sceneNumber}`
          : `${decisions.length} active decisions from local fallback memory · Scene ${sceneNumber}`;
      }
      if (els.memoryExplainText) {
        els.memoryExplainText.textContent = `These director decisions are still active for Scene ${sceneNumber}. · Scene-aware memory`;
      }
      renderMemoryDecisionCards(decisions);
    }

    if (!isLive) {
      showToast("Live ClickHouse memory unavailable — using local fallback decisions.");
    }
  } catch (err) {
    if (token !== memoryRequestToken) return;
    console.error("[Director's Memory] Memory screen failed unexpectedly:", err);
    if (els.memoryStatusPanel) els.memoryStatusPanel.hidden = true;
    if (els.memoryEmptyPanel) els.memoryEmptyPanel.hidden = true;
    if (els.memoryErrorText) {
      els.memoryErrorText.textContent = "Something went wrong retrieving Director Memory for this scene.";
    }
    if (els.memoryErrorPanel) els.memoryErrorPanel.hidden = false;
    if (els.memoryBadge) {
      els.memoryBadge.textContent = "MEMORY FALLBACK";
      els.memoryBadge.classList.remove("badge-live");
      els.memoryBadge.classList.add("badge-fallback");
    }
  }
}

/* ---------- Screen navigation ---------- */
function showScreen(key) {
  const targetId = SCREEN_IDS[key];
  if (!targetId) return;
  els.screens.forEach((screen) => {
    screen.classList.toggle("is-active", screen.id === targetId);
  });
  // scroll main column back to top on every navigation
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- Toast ---------- */
let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove("is-visible");
  }, 2600);
}

/* ---------- Sidebar (mobile) ---------- */
function openSidebar() {
  els.sidebar.classList.add("is-open");
  els.sidebarScrim.classList.add("is-open");
}
function closeSidebar() {
  els.sidebar.classList.remove("is-open");
  els.sidebarScrim.classList.remove("is-open");
}
els.sidebarToggle?.addEventListener("click", openSidebar);
els.sidebarScrim?.addEventListener("click", closeSidebar);

/* ---------- Sidebar nav ---------- */
els.navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const key = item.dataset.nav;
    els.navItems.forEach((n) => n.classList.remove("is-active"));

    if (key === "overview") {
      item.classList.add("is-active");
      showScreen("home");
    } else if (key === "memory") {
      item.classList.add("is-active");
      showScreen("memory");
      renderMemoryScreen(appState.scene.id);
    } else {
      // Overview stays visually active since the rest are still stubs
      document.querySelector('[data-nav="overview"]').classList.add("is-active");
      showToast("Coming in the next build.");
    }
    closeSidebar();
  });
});

/* ---------- Screen 1 -> Screen 2 ---------- */
els.btnAnalyzeScene.addEventListener("click", () => {
  showScreen("scene");
});

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => {
    showScreen(btn.dataset.back);
  });
});

/* ---------- Run Continuity Check -> Processing -> Conflicts ---------- */
els.btnRunCheck.addEventListener("click", () => {
  showScreen("processing");

  // Kick off the real Gemini Vision call, the real ClickHouse Director
  // Memory lookup, and the step animation together. The animation has
  // its own minimum duration so the demo always reads clearly even on
  // a fast response; Promise.all waits for whichever takes longer, up
  // to each call's own client-side timeout safety net.
  const analysisPromise = analyzeSceneWithGemini(appState.scene.id, appState.scene.character);
  const decisionsPromise = fetchDirectorDecisions(
    PROJECT_ID,
    appState.scene.character,
    appState.scene.id
  );
  const animationPromise = runProcessingAnimation();

  Promise.all([analysisPromise, decisionsPromise, animationPromise]).then(
    ([visionResult, decisionsResult]) => {
      const visionSource = applyVisionResult(visionResult);
      const decisionsSource = applyDecisionsResult(decisionsResult);

      if (visionSource === "fallback") {
        showToast("Live Gemini analysis unavailable — using demo fallback.");
      }
      if (decisionsSource === "fallback") {
        showToast("Live ClickHouse memory unavailable — using local fallback decisions.");
      }

      runAnalysis(); // existing continuity engine — untouched
      renderGeminiPanel();
      renderClickhousePanel();
      renderConflicts();
      renderConsistency();
      showScreen("conflicts");
    }
  );
});

function runProcessingAnimation() {
  return new Promise((resolve) => {
    const items = els.processingSteps.querySelectorAll("li");
    items.forEach((li) => li.classList.remove("is-checking", "is-done"));

    const stepDuration = 230; // 6 steps * 230ms ≈ 1.4s, matches spec's 1–1.5s
    let index = 0;

    function step() {
      if (index > 0) {
        items[index - 1].classList.remove("is-checking");
        items[index - 1].classList.add("is-done");
      }
      if (index < items.length) {
        items[index].classList.add("is-checking");
        index += 1;
        setTimeout(step, stepDuration);
      } else {
        setTimeout(resolve, 220);
      }
    }
    step();
  });
}

/* ---------- Render Gemini Vision Analysis panel ---------- */
function renderGeminiPanel() {
  const analysis = appState.visionAnalysis || fallbackAnalysis;
  const isLive = appState.visionSource === "gemini";

  els.sourceBadge.textContent = isLive ? "LIVE · GEMINI" : "DEMO FALLBACK";
  els.sourceBadge.classList.toggle("badge-live", isLive);
  els.sourceBadge.classList.toggle("badge-fallback", !isLive);

  const rows = [
    ["Hair", analysis.hair],
    ["Wardrobe", analysis.wardrobe],
    ["Prop", analysis.prop],
    ["Lighting", analysis.lighting],
    ["Location", analysis.location]
  ];
  els.geminiGrid.innerHTML = rows
    .map(
      ([label, value]) => `
        <div class="gemini-row">
          <dt class="gemini-label">${escapeHtml(label)}</dt>
          <dd class="gemini-value">${escapeHtml(value || "unknown")}</dd>
        </div>`
    )
    .join("");

  if (appState.overallConfidence !== null) {
    const pct = Math.round(appState.overallConfidence * 100);
    els.geminiConfidence.textContent = `AI confidence: ${pct}%`;
    els.geminiWarning.hidden = appState.overallConfidence >= 0.7;
  } else {
    els.geminiConfidence.textContent = "AI confidence: —";
    els.geminiWarning.hidden = true;
  }
}

/* ---------- Render ClickHouse Director Memory panel ---------- */
function renderClickhousePanel() {
  if (!els.clickhouseBadge) return; // defensive: panel not present in DOM

  const isLive = appState.decisionsSource === "clickhouse";

  els.clickhouseBadge.textContent = isLive ? "LIVE · CLICKHOUSE" : "MEMORY FALLBACK";
  els.clickhouseBadge.classList.toggle("badge-live", isLive);
  els.clickhouseBadge.classList.toggle("badge-fallback", !isLive);

  if (els.clickhouseMeta) {
    const count = appState.activeDecisions.length;
    const noun = count === 1 ? "decision" : "decisions";
    els.clickhouseMeta.textContent = isLive
      ? `${count} active ${noun} retrieved for ${appState.scene.character} · Scene ${appState.scene.id}`
      : `${count} active ${noun} from local fallback memory · Scene ${appState.scene.id}`;
  }
}

/* ---------- Render conflict cards ---------- */
function renderConflicts() {
  els.conflictGrid.innerHTML = "";
  els.conflictCount.textContent = appState.conflicts.length;

  appState.conflicts.forEach((c) => {
    const card = document.createElement("div");
    card.className = "conflict-card";
    card.innerHTML = `
      <span class="conflict-card-title">${escapeHtml(c.label)} Continuity</span>
      <div class="conflict-row">
        <span class="conflict-label">Current</span>
        <span class="conflict-value current">${escapeHtml(c.current)}</span>
      </div>
      <div class="conflict-row">
        <span class="conflict-label">Expected</span>
        <span class="conflict-value expected">${escapeHtml(c.expected)}</span>
      </div>
      <span class="conflict-source">Source: Scene ${c.sourceScene}</span>
      <button class="btn btn-secondary btn-sm" data-decision-id="${c.decisionId}">View Decision</button>
    `;
    els.conflictGrid.appendChild(card);
  });

  els.conflictGrid.querySelectorAll("[data-decision-id]").forEach((btn) => {
    btn.addEventListener("click", () => openDecisionModal(btn.dataset.decisionId));
  });
}

/**
 * Render consistency cards — one per attribute the Continuity
 * Engine classified as matching its active director decision.
 * Driven entirely by appState.consistent (which has already passed
 * through enforceMutualExclusion), so an attribute can never show
 * up here if it's also showing as a conflict card above.
 */
function renderConsistency() {
  els.consistencyList.innerHTML = "";

  appState.consistent.forEach((c) => {
    const card = document.createElement("div");
    card.className = "consistency-card";
    card.innerHTML = `
      <div class="consistency-icon">✓</div>
      <div class="consistency-body">
        <span class="consistency-title">${escapeHtml(c.label)} Continuity</span>
        <span class="consistency-detail">${escapeHtml(c.expected)}</span>
      </div>
      <span class="consistency-status">Consistent</span>
    `;
    els.consistencyList.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ---------- Screen 4: Director Decision modal ---------- */
function openDecisionModal(decisionId) {
  const decisions = appState.directorDecisionsLive || fallbackDirectorDecisions;
  const decision = decisions.find((d) => d.id === decisionId);
  if (!decision) return;
  activeDecisionForModal = decision;

  els.modalTitle.textContent = decision.id;
  els.modalGrid.innerHTML = `
    <div><dt>Character</dt><dd>${escapeHtml(decision.character || "—")}</dd></div>
    <div><dt>Attribute</dt><dd>${escapeHtml(decision.label)}</dd></div>
    <div><dt>Approved value</dt><dd>${escapeHtml(decision.value)}</dd></div>
    <div><dt>Effective scenes</dt><dd>${decision.effectiveFromScene} → ${decision.effectiveUntilScene ?? "∞"}</dd></div>
    <div><dt>Status</dt><dd>${escapeHtml(decision.status.charAt(0).toUpperCase() + decision.status.slice(1))}</dd></div>
    <div><dt>Source</dt><dd>${escapeHtml(decision.source)}</dd></div>
  `;
  els.modalWhy.textContent = `Scene ${appState.scene.id} falls inside the active decision range, so ${
    decision.character || appState.scene.character
  }'s established ${decision.label.toLowerCase()} continuity must be preserved.`;

  els.modalOverlay.classList.add("is-open");
}

function closeModal() {
  els.modalOverlay.classList.remove("is-open");
}
els.modalClose.addEventListener("click", closeModal);
els.modalOverlay.addEventListener("click", (e) => {
  if (e.target === els.modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.modalOverlay.classList.contains("is-open")) {
    closeModal();
  }
});

/* ---------- Screen 5: Generate fix ---------- */
els.btnGenerateFix.addEventListener("click", () => {
  closeModal();
  const fix = buildFix();
  renderFix(fix);
  showScreen("fix");
});

function renderFix(fix) {
  els.promptText.textContent = fix.promptText;

  els.fixingList.innerHTML = fix.fixing
    .map((label) => `<li>${escapeHtml(label)}</li>`)
    .join("");
  els.preservingList.innerHTML = fix.preserving
    .map((label) => `<li>${escapeHtml(label)}</li>`)
    .join("");
}

async function copyPromptToClipboard() {
  const text = els.promptText.textContent;
  try {
    await navigator.clipboard.writeText(text);
    showToast("Prompt copied to clipboard.");
  } catch (err) {
    // Fallback for environments without Clipboard API access
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      showToast("Prompt copied to clipboard.");
    } catch (fallbackErr) {
      showToast("Could not copy automatically — please copy manually.");
    }
    document.body.removeChild(textarea);
  }
}
els.btnCopyPrompt.addEventListener("click", copyPromptToClipboard);
els.btnCopyPrompt2.addEventListener("click", copyPromptToClipboard);

/* ---------- Approve fix -> Success ---------- */
els.btnApproveFix.addEventListener("click", () => {
  approveFix();
  showScreen("success");
});

els.btnBackHome.addEventListener("click", () => {
  showScreen("home");
});

/* ---------- Init ---------- */
updateSceneChrome();
showScreen("home");
