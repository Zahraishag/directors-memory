/* ============================================================
   DIRECTOR'S MEMORY — api/analyze-scene.js
   Vercel serverless function (Node.js runtime, ESM).

   Role: the ONLY place that talks to the Gemini API. The
   browser never receives or holds GEMINI_API_KEY — it is read
   here from process.env, which is populated from Vercel
   Environment Variables at deploy time.

   Gemini's job in this system is narrow and deliberate:
   it OBSERVES the current frame ("what is in the frame?").
   It never decides what the frame *should* contain — that is
   the Director Memory's job, enforced by the continuity engine
   in app.js. This endpoint returns raw visual observations
   only; it does not compare against director decisions.

   TODO: Store scene analysis history
   TODO: Move API layer to Google Cloud
   ============================================================ */

import { GoogleGenAI } from "@google/genai";

// Kept as its own constant so the model can be swapped in one place
// as Gemini's model lineup evolves.
const MODEL_NAME = "gemini-3.6-flash";

// Hard timeout so a slow/hanging Gemini call never freezes the demo.
// The frontend also enforces its own timeout as a second safety net.
const GEMINI_TIMEOUT_MS = 15000;

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// Structured output schema — Gemini is constrained to return exactly
// this shape, so the continuity engine downstream never has to guess
// at field names or types.
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    characterVisible: {
      type: "boolean",
      description: "Whether a human character is clearly visible in the frame."
    },
    hair: {
      type: "string",
      description:
        "Short factual description of the visible character's hair (length + color). Use 'unknown' if not clearly visible."
    },
    wardrobe: {
      type: "string",
      description:
        "Short factual description of the visible character's main outer garment/color. Use 'unknown' if not clearly visible."
    },
    prop: {
      type: "string",
      description:
        "Short factual description of any bag/prop the character is carrying, including color and type. Use 'unknown' if none is visible or it can't be determined."
    },
    lighting: {
      type: "string",
      description: "Short factual description of the scene's lighting (color temperature, time-of-day mood)."
    },
    location: {
      type: "string",
      description: "Short factual description of where the scene is set."
    },
    timeOfDay: {
      type: "string",
      description: "Day, Night, Dusk, Dawn, or Unknown."
    },
    confidence: {
      type: "object",
      description: "Confidence for each visual attribute, from 0 to 1.",
      properties: {
        hair: { type: "number", minimum: 0, maximum: 1 },
        wardrobe: { type: "number", minimum: 0, maximum: 1 },
        prop: { type: "number", minimum: 0, maximum: 1 },
        lighting: { type: "number", minimum: 0, maximum: 1 },
        location: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["hair", "wardrobe", "prop", "lighting", "location"]
    }
  },
  required: [
    "characterVisible",
    "hair",
    "wardrobe",
    "prop",
    "lighting",
    "location",
    "timeOfDay",
    "confidence"
  ]
};

function buildPrompt(character, sceneNumber) {
  return [
    "You are a visual continuity inspector reviewing a single frame from a film production.",
    `The character in focus is "${character || "unknown"}", scene number ${sceneNumber ?? "unknown"}.`,
    "Report ONLY short, factual visual observations of what is literally visible in the frame.",
    "Do not write a narrative or literary description. Do not infer backstory, emotion, or intent.",
    "For each attribute, describe only what you can actually see.",
    "If an attribute cannot be determined with reasonable confidence, set its value to the exact string \"unknown\" and give it a low confidence score — never invent or guess a value.",
    "Respond strictly according to the provided JSON schema."
  ].join(" ");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ success: false, error: "Invalid JSON body" });
      return;
    }
  }
  body = body || {};

  const { imageBase64, mimeType, sceneNumber, character } = body;

  if (!imageBase64 || typeof imageBase64 !== "string" || imageBase64.length < 100) {
    res.status(400).json({ success: false, error: "Missing or invalid imageBase64" });
    return;
  }

  const safeMimeType =
    typeof mimeType === "string" && ALLOWED_MIME_TYPES.has(mimeType)
      ? mimeType
      : "image/jpeg";

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[analyze-scene] GEMINI_API_KEY is not configured in the environment.");
    res.status(500).json({ success: false, error: "Gemini analysis failed" });
    return;
  }

  const ai = new GoogleGenAI({ apiKey });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [
        {
          role: "user",
          parts: [
            { text: buildPrompt(character, sceneNumber) },
            { inlineData: { mimeType: safeMimeType, data: imageBase64 } }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: ANALYSIS_SCHEMA
      },
      abortSignal: controller.signal
    });

    clearTimeout(timeoutId);

    const rawText = response.text;
    if (!rawText) {
      throw new Error("Empty response from Gemini");
    }

    let analysis;
    try {
      analysis = JSON.parse(rawText);
    } catch (parseErr) {
      console.error("[analyze-scene] Gemini returned non-JSON output:", rawText);
      res.status(500).json({ success: false, error: "Gemini analysis failed" });
      return;
    }

    res.status(200).json({
      success: true,
      source: "gemini",
      analysis
    });
  } catch (err) {
    clearTimeout(timeoutId);
    // Full detail stays server-side only — the client only ever sees a
    // generic message, per the fallback-safe design of this endpoint.
    console.error("[analyze-scene] Gemini request failed:", err);
    res.status(500).json({ success: false, error: "Gemini analysis failed" });
  }
}
