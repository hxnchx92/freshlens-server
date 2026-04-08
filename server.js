require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = Number(process.env.PORT || 3001);
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/api/scan-grocery", async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 required" });
    }

    console.log("📸 Image length:", imageBase64.length);

    const dataUrl = `data:image/jpeg;base64,${imageBase64}`;

    const system = `
You are the AI for a grocery expiry app.
Return JSON only with keys:
- itemName: string or null
- category: one of dairy, meat, fish, produce, pantry, frozen, beverage, bakery, other
- expiryDateISO: YYYY-MM-DD or null
- confidence: high | medium | low
- notes: short string

Rules:
- Never guess a date.
- Prefer Use By / Expiry over Best Before.
- If the date is unclear, set expiryDateISO to null.
`;

    const response = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the grocery item and expiry date from this image." },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    });

    const text = response.choices?.[0]?.message?.content || "{}";
    console.log("🧠 AI RAW:", text);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {
        itemName: null,
        category: "other",
        expiryDateISO: null,
        confidence: "low",
        notes: "Invalid JSON from model."
      };
    }

    if (parsed.expiryDateISO && !/^\\d{4}-\\d{2}-\\d{2}$/.test(parsed.expiryDateISO)) {
      parsed.expiryDateISO = null;
      parsed.confidence = "low";
      parsed.notes = "Date format invalid or unclear.";
    }

    return res.json(parsed);
  } catch (e) {
    console.error("🔥 Scan error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`FreshLens server running on ${PORT}`);
});