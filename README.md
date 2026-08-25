# Director's Memory

**AI Continuity Agent for Filmmakers**

> AI generates scenes. Director's Memory protects the story.

**MVP v2 — Real Gemini Vision Analysis.** Scene 7's visual attributes are
now extracted live from the real frame (`assets/scene-07-frame.jpg`) by
Gemini, server-side, instead of being hardcoded. See
[MVP v1 vs. MVP v2](#mvp-v1-vs-mvp-v2) below.

---

## What is Director's Memory?

Filmmakers using AI to generate scenes hit a recurring problem: the AI has no
memory of what it decided last shot. A character's hairstyle, wardrobe,
props, lighting, age, or location can silently drift from one generated
scene to the next — because each generation is an isolated prompt, not a
continuation of a production.

**Director's Memory** is an agent that sits between the director and the
generation tool. It remembers every approved production decision, checks new
scenes against that memory, flags anything that breaks continuity, and
proposes a corrected prompt that restores the director's original vision —
without the director having to manually track every detail across every
scene.

## Problem

- AI scene generation has no persistent memory of prior creative decisions.
- Continuity errors (hair, wardrobe, props, lighting, age, location) slip
  through unnoticed until review — costing re-generation time and breaking
  audience immersion.
- Directors currently track continuity manually, in notes or spreadsheets,
  which doesn't scale across a full production.

## Solution

Director's Memory acts as a **continuity layer** on top of any AI generation
pipeline:

1. **Remember** — store every approved director decision (character,
   attribute, value, and the scene range it applies to).
2. **Compare** — when a new scene is generated, compare its detected
   attributes against every decision currently in force.
3. **Detect** — surface conflicts clearly, with the current value, the
   expected value, and the decision that established it.
4. **Fix** — generate a corrected prompt that restores continuity while
   explicitly preserving everything that was already correct (lighting,
   identity, location).
5. **Approve** — the director approves the fix, and the resolution becomes
   part of the project's continuity record.

## How the demo works

This MVP ships with a scripted demo scenario so a judge can see the full
loop in under a minute, with no setup:

1. **Overview** — project stats: scenes tracked, director decisions, active
   continuity rules.
2. **Scene Review** — Scene 7, "Rooftop Escape," with its current AI-generated
   description and metadata.
3. **Run Continuity Check** — the frame is sent to Gemini Vision for real
   analysis while a short animation walks through identity, wardrobe,
   props, lighting, and active decisions. A **LIVE · GEMINI** badge and a
   **Gemini Vision Analysis** panel show exactly what Gemini detected in
   the frame, with a confidence score, before any comparison happens.
4. **Conflict Detection** — those live-detected attributes are compared
   against Director Memory, surfacing conflicts (hair, wardrobe, prop),
   plus a confirmation that lighting is consistent.
5. **Director Memory** — clicking "View Decision" opens the exact approved
   decision (id, value, effective scene range, source) behind a conflict.
6. **Generate Fix** — a corrected prompt is generated and can be copied to
   the clipboard, along with a clear "fixing vs. preserving" summary.
7. **Approve Fix** — confirms the resolution and shows production impact
   (errors prevented, scenes protected, rules validated).

Director decisions (DEC-011 → DEC-014) are still defined locally in
`app.js` — there is no persistent backend for those yet. What changed in
v2 is where the *scene's* attributes come from: they're now the live
output of a real Gemini Vision call instead of a hardcoded object.

## MVP v1 vs. MVP v2

| | MVP v1 | MVP v2 |
|---|---|---|
| Scene attributes | Hardcoded in `app.js` (`sceneData.currentScene.attributes`) | Extracted live by Gemini Vision from `assets/scene-07-frame.jpg` |
| Where Gemini runs | Not used | Server-side only, in `api/analyze-scene.js` (Vercel Function) |
| API key exposure | N/A | Never sent to the browser — read from `process.env.GEMINI_API_KEY` server-side |
| Failure behavior | N/A | Falls back to the same v1 scripted attributes, with a toast + `DEMO FALLBACK` badge |
| Continuity engine | `findActiveDecisions` / `detectConflicts` / `generateFixPrompt` | **Unchanged.** Same functions, now fed live data instead of static data |

The data flow end to end:

```
Gemini Vision  →  Continuity Engine  →  Director Memory  →  Conflict Detection  →  Fix Prompt
(observes the      (isDecisionActiveForScene,   (source of truth:      (compares live vs.    (generateFixPrompt uses
 current frame)      resolveDecision,             DEC-011 → DEC-014)     expected values)       the corrected, approved
                      findActiveDecisions,                                                       values from Director
                      detectConflicts — untouched)                                                Memory, not from Gemini)
```

This split is the core philosophy of the project and is intentionally
enforced by the architecture, not just convention:

- **Gemini observes.** It only ever answers "what is visibly in this
  frame?" — hair, wardrobe, prop, lighting, location, time of day — as
  short factual values, never a creative description, and it must return
  `"unknown"` rather than invent a value it isn't confident about.
- **Director Memory decides.** The approved decisions (`directorDecisions`
  in `app.js`) are the only source of truth for what a scene *should*
  contain. Gemini's output is never treated as ground truth.
- **The Continuity Engine judges.** `detectConflicts()` is the only place
  "current" and "expected" are compared — and it doesn't care whether
  "current" came from Gemini or from the fallback object.

## Architecture

```
Browser                          Server (Vercel Functions)
────────                         ─────────────────────────
1. Load assets/scene-07-frame.jpg
2. Resize to ≤1280px, JPEG q=0.82
3. POST { imageBase64, mimeType,
          sceneNumber, character }
                │
                ▼
        /api/analyze-scene ───────►  api/analyze-scene.js
                                      • validates input (400 on bad request)
                                      • reads GEMINI_API_KEY from env
                                      • calls @google/genai, model
                                        gemini-3.6-flash, with a strict
                                        responseSchema (structured JSON)
                                      • returns { success, source, analysis }
                                        or a generic 500 (no stack traces)
                │
                ◄───────────────────
        (in parallel with the above)
3b. GET /api/get-decisions
      ?project_id=project-aurora
      &character_name=Maya&scene=7 ─►  api/get-decisions.js
                                      • validates query params (400 on bad request)
                                      • reads CLICKHOUSE_HOST/USERNAME/
                                        PASSWORD/DATABASE from env
                                      • queries director_decisions via
                                        @clickhouse/client with parameterized
                                        values (project_id, character_name,
                                        scene)
                                      • returns { success, source: "clickhouse",
                                        decisions } or success:false with a
                                        generic error (never fakes "clickhouse")
                │
                ◄───────────────────
4. appState.scene.attributes = { hair, wardrobe, prop, lighting } from Gemini
   analysis (or fallback); appState.directorDecisionsLive = decisions from
   ClickHouse (or fallback)
5. runAnalysis() → findActiveDecisions() → detectConflicts()   [UNCHANGED]
6. renderGeminiPanel() + renderClickhousePanel() + renderConflicts()
```

`app.js` layering:

```
app.js
├── 1. DATA LAYER
│     sceneData                   — scene metadata + local frame reference
│     fallbackDirectorDecisions   — approved production decisions, used only
│                                   if the live ClickHouse call fails
│     fallbackAnalysis            — v1-equivalent attributes, used only if
│                                   the live Gemini call fails
│
├── 1A. CLICKHOUSE MEMORY LAYER  (new in v3)
│     fetchDirectorDecisions()   — calls /api/get-decisions, never throws;
│                                  always resolves to a usable result and
│                                  never fakes source: "clickhouse"
│
├── 1B. GEMINI VISION LAYER  (v2)
│     loadSceneImageAsBase64()   — reads + resizes the frame client-side
│     analyzeSceneWithGemini()   — calls /api/analyze-scene, never throws;
│                                  always resolves to a usable result
│
├── 2. CONTINUITY ENGINE (pure functions, no DOM access — UNTOUCHED)
│     isDecisionActiveForScene(decision, sceneNumber)
│     resolveDecision(character, attribute, decisions, sceneNumber)
│     findActiveDecisions(sceneNumber, decisions)
│     detectConflicts(scene, activeDecisions)
│     generateFixPrompt(scene, conflicts, consistent)
│
├── 3. APPLICATION STATE
│     appState              — scene, live decisions, conflicts, fix,
│                              vision result, decisions source
│     applyVisionResult() / applyDecisionsResult() / runAnalysis() /
│     buildFix() / approveFix()
│
└── 4. UI LAYER
      screen navigation, rendering, modal, toast, clipboard,
      Gemini Vision Analysis panel (LIVE·GEMINI/DEMO FALLBACK badge),
      Director Memory panel (LIVE·CLICKHOUSE/MEMORY FALLBACK badge)
```

**Decision activity rule (unchanged):**
A decision is active for a scene when
`sceneNumber >= effectiveFromScene`, and if `effectiveUntilScene` is set,
`sceneNumber <= effectiveUntilScene`, and `status === "active"`. This rule
lives entirely in the client-side continuity engine — `api/get-decisions.js`
does an equivalent filter in SQL so ClickHouse only ever returns rows that
are already active for the requested scene, but the engine re-derives
activity itself rather than trusting the network response blindly.

**Supersedes (unchanged):**
Each decision may carry a `supersedes: "DEC-XXX"` field. When a newer active
decision supersedes an older one for the same `character + attribute` pair,
`resolveDecision()` drops the older decision from consideration. The current
demo dataset doesn't need this (no decision has been revised yet), but the
engine supports it from day one, since real productions revise decisions
mid-shoot.

**ClickHouse schema (`default.director_decisions`):**
`project_id`, `decision_id`, `character_name`, `attribute`, `approved_value`,
`effective_from_scene`, `effective_until_scene` (nullable), `status`,
`supersedes` (nullable), `source_scene` (nullable), `source_type`,
`reasoning`, `created_at`. `api/get-decisions.js` maps each row into the same
shape the continuity engine already expects (`id`, `character`, `attribute`,
`label`, `value`, `effectiveFromScene`, `effectiveUntilScene`, `status`,
`supersedes`, `source`), so nothing downstream of the API had to change.

## Reliability: fallback behavior

The live demo must never break on stage, so failure is handled deliberately,
identically for both live integrations:

- If Gemini fails for **any** reason — network, quota, missing/invalid API
  key, timeout, malformed response — `analyzeSceneWithGemini()` catches it
  and returns the same `fallbackAnalysis` object MVP v1 used to hardcode.
  The UI shows **DEMO FALLBACK** instead of **LIVE · GEMINI**, plus a toast.
- If ClickHouse fails for **any** reason — network, missing/invalid
  credentials, query error, timeout — `fetchDirectorDecisions()` catches it
  and returns the same `fallbackDirectorDecisions` array MVP v1/v2 used to
  hardcode. The UI shows **MEMORY FALLBACK** instead of **LIVE · CLICKHOUSE**,
  plus a toast: *"Live ClickHouse memory unavailable — using local fallback
  decisions."*
- Neither client-side layer ever fabricates a "live" source label — the
  badge only ever reflects what the corresponding API call actually
  returned this run.
- The rest of the flow — conflict detection, View Decision, Generate Fix,
  Approve Fix — behaves identically regardless of source, because the
  continuity engine only ever reads `appState.scene.attributes` and
  `appState.directorDecisionsLive`.
- Server-side, both endpoints have their own timeouts and never return a
  stack trace to the client — only a generic message, with the real error
  logged to the Vercel function's server console.
- `GET /api/health-clickhouse` reports `{ ok, configured, status }` for
  connectivity checks without exposing host, credentials, or driver error
  text.

## Future integrations

The intended integrations not yet implemented, marked with `// TODO:`
comments in `app.js`, are:

- **MCP Server** — expose `findActiveDecisions`, `detectConflicts`, and
  `approveFix` as tools an MCP-connected AI agent (or the generation tool
  itself) can call directly.
- **Google Cloud** — move the API layer currently living in Vercel Functions
  to a dedicated Cloud Run / Cloud Functions service if/when it needs to
  front more than Gemini + ClickHouse.
- **Scene analysis history** — store each Gemini observation (not just the
  latest one) so continuity can be audited across the whole production.

## How to run locally

The frontend is still plain HTML/CSS/JS, but `/api/analyze-scene` and
`/api/get-decisions` now need the Vercel dev server (a plain static server
won't run the serverless functions):

```bash
npm install
npm i -g vercel   # if you don't already have the Vercel CLI
vercel dev
```

Then open the printed local URL (typically `http://localhost:3000`).

Add your credentials to a local `.env` file first (see below) — `vercel dev`
reads it automatically. If you skip this, the demo still works end to end
via the fallback paths, just without live Gemini or live ClickHouse results.

```bash
# .env  (do not commit this file)
GEMINI_API_KEY=your_key_here
CLICKHOUSE_HOST=https://your-service.clickhouse.cloud:8443
CLICKHOUSE_USERNAME=your_username
CLICKHOUSE_PASSWORD=your_password
CLICKHOUSE_DATABASE=default
```

## Environment variable setup

**Never commit or hardcode any of these anywhere in the frontend.** Each is
only ever read server-side: `GEMINI_API_KEY` in `api/analyze-scene.js`, and
the four `CLICKHOUSE_*` variables in `api/get-decisions.js` and
`api/health-clickhouse.js` (via the shared `api/_clickhouse.js` helper).

On Vercel:

1. Open your project (`directors-memory-4`) in the **Vercel Dashboard**.
2. Go to **Settings → Environment Variables**.
3. Add the following variables:
   - `GEMINI_API_KEY` — your Gemini API key
   - `CLICKHOUSE_HOST` — your ClickHouse Cloud service URL, including
     scheme and port (e.g. `https://xxxxx.clickhouse.cloud:8443`)
   - `CLICKHOUSE_USERNAME` — your ClickHouse username
   - `CLICKHOUSE_PASSWORD` — your ClickHouse password
   - `CLICKHOUSE_DATABASE` — `default`
   - **Environment:** Production (and Preview/Development if you want
     those to have live results too)
4. Save, then **Redeploy** the project — environment variable changes
   don't apply to already-running deployments.

Get a Gemini API key from Google AI Studio, and your ClickHouse Cloud
connection details from the `directors-memory` service's **Connect** panel,
if you don't have them yet.

## How to deploy

**Vercel** (recommended — this project is built for Vercel Functions)
```bash
npm i -g vercel
vercel --prod
```
Framework preset: "Other". No build command needed — `index.html`,
`styles.css`, `app.js`, and `assets/` are served statically, and
`api/analyze-scene.js`, `api/get-decisions.js`, and
`api/health-clickhouse.js` are auto-detected as Vercel Functions. Make sure
`GEMINI_API_KEY` and the four `CLICKHOUSE_*` variables are set in
Environment Variables *before* your first production deploy (or redeploy
after adding them). This project already deploys to the existing Vercel
project `directors-memory-4` — no new project needed.

**Netlify**
The frontend (static files) will deploy fine via drag-and-drop or the
Netlify CLI, but the `api/*.js` files are written as Vercel Functions and
won't run as-is on Netlify — they would need to be ported to Netlify
Functions first. Without that, the demo still runs completely via the
built-in fallback paths.

## Test checklist

- [ ] `GET /api/analyze-scene` → `405 Method not allowed`
- [ ] `POST /api/analyze-scene` with no `imageBase64` → `400`
- [ ] `POST /api/analyze-scene` with `GEMINI_API_KEY` unset → `500`, generic
      message, real error only in the Vercel function logs
- [ ] `GET /api/get-decisions` with missing `project_id`/`character_name`/
      `scene` → `400`
- [ ] `GET /api/get-decisions?project_id=project-aurora&character_name=Maya&scene=7`
      with ClickHouse configured → `success:true`, `source:"clickhouse"`,
      4 decisions returned
- [ ] Same call with `CLICKHOUSE_*` vars unset → `success:false`,
      `source:"fallback"`, generic error, real error only in the Vercel
      function logs
- [ ] `GET /api/health-clickhouse` → `{ ok, configured, status }`, no
      credentials or hostnames in the response
- [ ] With valid credentials: Run Continuity Check → **LIVE · GEMINI** and
      **LIVE · CLICKHOUSE** badges, Gemini Vision Analysis panel populated,
      Director Memory panel shows 4 active decisions, **3 Continuity
      Conflicts Detected** (Hair, Wardrobe, Prop), Lighting shown as
      Consistent
- [ ] Temporarily break the Gemini key/network → **DEMO FALLBACK** badge,
      toast shown, rest of the flow unaffected
- [ ] Temporarily break ClickHouse credentials/network → **MEMORY FALLBACK**
      badge, toast shown, conflicts still detected correctly from the local
      fallback decisions, rest of the flow unaffected
- [ ] Conflict cards → View Decision modal → Generate Continuity Fix →
      Copy Prompt (clipboard) → Approve Fix → Continuity Restored
- [ ] Mobile viewport: sidebar toggle, stacked layout, all buttons reachable

## File structure

```
director's-memory/
├── index.html                Screens, sidebar, top bar, modal, toast
├── styles.css                Design tokens + cinematic dark theme
├── app.js                    Data layer, ClickHouse memory layer,
│                              Gemini Vision layer, continuity engine,
│                              UI wiring
├── api/
│   ├── analyze-scene.js      Vercel Function — server-side Gemini call
│   ├── get-decisions.js      Vercel Function — live ClickHouse decisions
│   ├── health-clickhouse.js  Vercel Function — ClickHouse connectivity check
│   └── _clickhouse.js        Shared server-side ClickHouse client helper
├── package.json               @google/genai + @clickhouse/client deps
├── assets/
│   └── scene-07-frame.jpg    Scene 7 cinematic reference frame
└── README.md                 This file
```
