# 🎬 Director's Memory

### Persistent Creative Decision Memory for Agentic Filmmaking

> **AI shouldn’t replace the director’s decisions. It should remember them.**

Director's Memory is an AI-powered continuity system for film production that gives filmmaking agents persistent memory of approved creative decisions across scenes.

Instead of treating every generated scene as an isolated prompt, Director's Memory remembers what the director already approved, retrieves only the decisions that still apply to the current scene, and checks new scene content for continuity conflicts.



## 🚀 Live Demo

https://directors-memory-4.vercel.app

---

## 🔗 Repository

https://github.com/Zahraishag/directors-memory

---

# 🎯 The Problem

Generative AI can create scenes quickly, but it often loses continuity between generations.

A director may establish that:

- Maya has **short black hair**
- Maya wears a **red coat**
- Maya carries a **silver shoulder bag**
- Night scenes use **cold blue lighting**

A later AI-generated scene may unexpectedly introduce:

- Different hair
- Different wardrobe
- Missing props
- Different lighting

Each individual generation may look convincing, but the film gradually loses visual continuity.

Traditional chat history is not enough for a structured, multi-scene production workflow.

---

# 💡 The Solution

Director's Memory separates the filmmaking workflow into three responsibilities:

### 1. Gemini observes the current scene

Gemini analyzes the current scene and extracts structured visual attributes such as:

- Hair
- Wardrobe
- Props
- Lighting
- Location
- Time of day

### 2. ClickHouse remembers approved creative decisions

Director decisions are stored as persistent structured production memory in ClickHouse Cloud.

Each decision can include:

- Character
- Attribute
- Approved value
- Effective starting scene
- Effective ending scene
- Status
- Source
- Reasoning

### 3. The Continuity Engine judges

The application compares what Gemini observes in the current scene with the director decisions that are still active.

It then detects continuity conflicts and helps generate a correction.

> **Gemini observes. ClickHouse remembers. The Continuity Engine judges.**

---

# 🧠 Temporal Creative Memory

Director's Memory does not simply ask:

> What did the director decide?

It also asks:

> Is that decision still active in this scene?

Example:

| Decision | Value | Effective From | Effective Until |
|---|---|---:|---:|
| Hair | Short black hair | Scene 3 | Scene 9 |
| Wardrobe | Red coat | Scene 3 | Scene 9 |
| Prop | Silver shoulder bag | Scene 4 | Scene 9 |
| Lighting | Cold blue nighttime lighting | Scene 5 | Scene 9 |

This means:

### Scene 8

All four decisions are still active.

### Scene 10

Those decisions have expired.

The system therefore avoids carrying old creative constraints forward forever.

---

# ⚡ Runtime Architecture

```text
                 ┌─────────────────────────┐
                 │     Director / User     │
                 └────────────┬────────────┘
                              │
                              ▼
                 ┌─────────────────────────┐
                 │   Director's Memory UI  │
                 │        Vercel           │
                 └────────────┬────────────┘
                              │
               ┌──────────────┴──────────────┐
               │                             │
               ▼                             ▼
      ┌─────────────────┐          ┌─────────────────────┐
      │     Gemini      │          │ /api/get-decisions  │
      │ Scene Analysis  │          │   Memory Retrieval  │
      └────────┬────────┘          └──────────┬──────────┘
               │                              │
               │                              ▼
               │                  ┌──────────────────────────┐
               │                  │ Official ClickHouse MCP  │
               │                  │       run_query          │
               │                  └───────────┬──────────────┘
               │                              │
               │                              ▼
               │                  ┌──────────────────────────┐
               │                  │     ClickHouse Cloud     │
               │                  │ Persistent Film Memory   │
               │                  └───────────┬──────────────┘
               │                              │
               └──────────────┬───────────────┘
                              ▼
                 ┌─────────────────────────┐
                 │    Continuity Engine    │
                 │  Conflict Detection     │
                 └────────────┬────────────┘
                              │
                              ▼
                 ┌─────────────────────────┐
                 │ Suggested Continuity Fix│
                 └─────────────────────────┘
```

---

# 🔌 Official ClickHouse MCP Integration

Director's Memory uses the **official ClickHouse MCP server** as the primary runtime path for retrieving director memory.

The production path is:

```text
Director's Memory
        ↓
Vercel API
        ↓
MCP Client
        ↓
Official ClickHouse MCP
        ↓
run_query
        ↓
ClickHouse Cloud
```

MCP is not used only as a connectivity demonstration.

The actual production-memory query used by the application is executed through the MCP `run_query` tool during runtime.

The API explicitly exposes which transport served the request:

```json
{
  "source": "clickhouse",
  "memory_transport": "mcp"
}
```

This makes the MCP runtime path observable and verifiable.

---

# ✅ Runtime Proof

## Scene 8 — Active Memory

Request:

```text
/api/get-decisions?project_id=project-aurora&character_name=Maya&scene=8
```

Production response:

```json
{
  "success": true,
  "source": "clickhouse",
  "memory_transport": "mcp",
  "project_id": "project-aurora",
  "character_name": "Maya",
  "scene": 8,
  "decisions": [
    {
      "id": "DEC-011",
      "attribute": "hair",
      "value": "Short black hair"
    },
    {
      "id": "DEC-014",
      "attribute": "lighting",
      "value": "Cold blue nighttime lighting"
    },
    {
      "id": "DEC-013",
      "attribute": "prop",
      "value": "Silver shoulder bag"
    },
    {
      "id": "DEC-012",
      "attribute": "wardrobe",
      "value": "Red coat"
    }
  ]
}
```

### Result

Scene 8 retrieves four active production decisions from ClickHouse through the official MCP runtime path.

---

## Scene 10 — Memory Expiration

Request:

```text
/api/get-decisions?project_id=project-aurora&character_name=Maya&scene=10
```

Production response:

```json
{
  "success": true,
  "source": "clickhouse",
  "memory_transport": "mcp",
  "project_id": "project-aurora",
  "character_name": "Maya",
  "scene": 10,
  "decisions": []
}
```

### Result

The MCP query succeeds, but no decisions are returned because the earlier creative decisions expired after Scene 9.

This demonstrates that Director's Memory remembers not only **what was decided**, but also **when the decision should stop applying**.

---

# 🩺 MCP Health Verification

The project includes:

```text
/api/health-mcp
```

A healthy production connection returns:

```json
{
  "ok": true,
  "configured": true,
  "connected": true,
  "tool_called": "list_databases",
  "tool_succeeded": true,
  "available_tools": [
    "list_databases",
    "list_tables",
    "run_query"
  ],
  "status": "connected"
}
```

This verifies that the Vercel application can discover and invoke tools on the ClickHouse MCP server.

---

# 🎥 Demo Flow

The demo is designed to show the full continuity-memory loop.

## Scene 7 — Detect a Continuity Conflict

The application:

1. Analyzes the current scene with Gemini.
2. Retrieves active director decisions.
3. Compares observed attributes with production memory.
4. Surfaces continuity conflicts.
5. Displays the underlying director decision.
6. Generates a continuity correction.
7. Allows the fix to be approved.

The application visibly distinguishes live integrations using:

```text
LIVE · GEMINI
```

and:

```text
LIVE · CLICKHOUSE
```

---

## Scene 8 — Persistent Memory

Scene 8 demonstrates that previously approved production decisions remain available later in the film.

Four active decisions are retrieved:

- Short black hair
- Red coat
- Silver shoulder bag
- Cold blue nighttime lighting

The response confirms:

```json
"memory_transport": "mcp"
```

---

## Scene 10 — Memory Lifecycle

Scene 10 demonstrates that expired decisions are not incorrectly applied forever.

The same runtime MCP query succeeds, but returns:

```json
"decisions": []
```

because those decisions are no longer active.

---

# 🧩 Core Components

## Gemini

Gemini provides current-scene understanding.

It extracts structured visual information for the continuity engine rather than deciding what the director intended.

---

## ClickHouse Cloud

ClickHouse is the persistent production-memory layer.

It stores approved creative decisions in structured form and supports fast scene-aware retrieval.

---

## Official ClickHouse MCP

The official ClickHouse MCP server exposes ClickHouse tools to the agentic workflow.

Available tools include:

```text
list_databases
list_tables
run_query
```

Director's Memory uses:

```text
run_query
```

for live production-memory retrieval.

---

## Continuity Engine

The Continuity Engine compares:

```text
CURRENT SCENE
      vs.
APPROVED DIRECTOR MEMORY
```

It determines whether a conflict exists.

This separation is deliberate:

> **Gemini observes. ClickHouse remembers. The Continuity Engine judges.**

---

# 🗃️ Production Memory Model

Director decisions can include:

```text
project_id
decision_id
character_name
attribute
approved_value
effective_from_scene
effective_until_scene
status
supersedes
source_scene
source_type
reasoning
created_at
```

A retrieved decision is mapped into the application shape:

```text
id
character
attribute
label
value
effectiveFromScene
effectiveUntilScene
status
supersedes
source
```

This gives Director's Memory explicit creative state with lifecycle boundaries.

---

# 🛡️ Resilient Runtime Design

The primary memory route is:

```text
Official ClickHouse MCP
        ↓
ClickHouse Cloud
```

A direct ClickHouse backend path is retained as a resilience fallback.

If the MCP service becomes temporarily unavailable, the production workflow can still retrieve memory through the direct ClickHouse client.

The response identifies which path was used:

```json
"memory_transport": "mcp"
```

or:

```json
"memory_transport": "direct"
```

The tested production submission currently returns:

```json
"memory_transport": "mcp"
```

for the live MCP path.

---

# 🔐 Environment Variables

The project requires server-side environment variables.

```env
GEMINI_API_KEY=

CLICKHOUSE_HOST=
CLICKHOUSE_USERNAME=
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=

CLICKHOUSE_MCP_URL=
CLICKHOUSE_MCP_AUTH_TOKEN=
```

The MCP URL must point to the MCP endpoint, for example:

```env
CLICKHOUSE_MCP_URL=https://your-mcp-service.example.com/mcp
```

Never commit passwords, API keys, or authentication tokens to the repository.

---

# 🛠️ Local Development

Clone the repository:

```bash
git clone https://github.com/Zahraishag/directors-memory.git
cd directors-memory
```

Install dependencies:

```bash
npm install
```

Install the Vercel CLI if necessary:

```bash
npm install -g vercel
```

Configure the required environment variables.

Run:

```bash
vercel dev
```

Then open the local URL provided by Vercel.

---

# 🚀 Production Deployment

The frontend and serverless API are deployed with Vercel.

```bash
vercel --prod
```

Production:

https://directors-memory-4.vercel.app

---

# 📁 Project Structure

```text
directors-memory/
│
├── api/
│   ├── _clickhouse.js
│   ├── _mcp-client.js
│   ├── analyze-scene.js
│   ├── diagnose-clickhouse.js
│   ├── get-decisions.js
│   ├── health-clickhouse.js
│   └── health-mcp.js
│
├── app.js
├── index.html
├── package.json
├── styles.css
├── README.md
└── LICENSE
```

---

# 🌟 What Makes Director's Memory Different?

Many AI filmmaking systems focus on one question:

> What should we generate next?

Director's Memory adds another:

> What has the production already decided?

This changes the role of AI from an isolated generator into a production participant that can operate within persistent creative constraints.

The system gives future agents a structured memory of:

- What was approved
- Who or what the decision applies to
- When it became active
- When it expires
- What decision it may supersede
- Why it was established

---

# 👤 Human Creative Authority

Director's Memory is designed around a human-centered principle:

> **The director remains the creative authority.**

AI may:

- Observe
- Retrieve
- Compare
- Detect
- Suggest

But the approved creative decision belongs to the human director.

The system is designed to preserve human intent rather than replace it.

---

# 🔭 Future Vision

Director's Memory can expand into a shared production-memory layer for multiple filmmaking agents.

Future possibilities include:

- Multi-character continuity
- Camera and lens memory
- Costume history
- Prop lifecycle tracking
- Location continuity
- Set continuity
- Art-direction memory
- Director overrides
- Multi-agent production workflows
- Production approval history
- Automatic screenplay-to-memory ingestion
- Cross-scene visual verification
- Human approval checkpoints
- Creative provenance tracking

The long-term vision is a persistent memory layer that lets AI agents collaborate across a film production without losing the director's intent.

---

# 🏆 Hackathon Project

**Director's Memory — Persistent Creative Decision Memory for Agentic Filmmaking**

Built with:

- Google Gemini
- ClickHouse Cloud
- Official ClickHouse MCP
- Vercel
- Render

---

# 🔗 Project Links

### Live Demo

https://directors-memory-4.vercel.app

### GitHub

https://github.com/Zahraishag/directors-memory

### Demo Video

https://youtu.be/MteNet_rKQg



---

# 👩‍💻 Creator

**Dr. Zahra Al-Ansari**

AI • Human-Centered Intelligent Systems • Education Technology

---

# 🎬 Final Thought

> **Generative AI knows how to create the next scene.  
> Director's Memory helps it remember the film it is already making.**
