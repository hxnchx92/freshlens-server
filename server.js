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

function pad(v) {
  return String(v).padStart(2, "0");
}

function hasVisibleYear(raw) {
  if (!raw || typeof raw !== "string") return false;

  const cleaned = raw.trim();

  if (/\b\d{4}\b/.test(cleaned)) return true;
  if (/\b\d{2}\b/.test(cleaned) && /(\d{1,2})[\/.\- ](\d{1,2})[\/.\- ](\d{2})/.test(cleaned)) return true;
  if (/([A-Za-z]+)[ ,\-\/]+(\d{1,2})[ ,\-\/]+(\d{2}|\d{4})/i.test(cleaned)) return true;
  if (/(\d{1,2})[ ,\-\/]+([A-Za-z]+)[ ,\-\/]+(\d{2}|\d{4})/i.test(cleaned)) return true;

  return false;
}

function normalizeVisibleDate(raw) {
  if (!raw || typeof raw !== "string") return null;

  let cleaned = raw
    .trim()
    .replace(/\b(best before|use by|expiry|exp|bb|sell by)\b/gi, "")
    .replace(/[^\w\s/.\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // DD MM YY / DD-MM-YY / DD/MM/YY / DD.MM.YY
  let m = cleaned.match(/^(\d{1,2})[\/.\- ](\d{1,2})[\/.\- ](\d{2,4})/);
  if (m) {
    const dd = pad(m[1]);
    const mm = pad(m[2]);
    let yyyy = String(m[3]);

    if (yyyy.length === 2) {
      const yy = Number(yyyy);
      yyyy = yy >= 70 ? `19${pad(yy)}` : `20${pad(yy)}`;
    }

    return `${yyyy}-${mm}-${dd}`;
  }

  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  m = cleaned.match(/^(\d{4})[\/.\- ](\d{1,2})[\/.\- ](\d{1,2})$/);
  if (m) {
    const yyyy = m[1];
    const mm = pad(m[2]);
    const dd = pad(m[3]);
    return `${yyyy}-${mm}-${dd}`;
  }

  const months = {
    jan: "01", january: "01",
    feb: "02", february: "02",
    mar: "03", march: "03",
    apr: "04", april: "04",
    may: "05",
    jun: "06", june: "06",
    jul: "07", july: "07",
    aug: "08", august: "08",
    sep: "09", sept: "09", september: "09",
    oct: "10", october: "10",
    nov: "11", november: "11",
    dec: "12", december: "12",
  };

  // 16 Oct 26 / 16 October 2026
  m = cleaned.match(/^(\d{1,2})[ ,\-\/]+([A-Za-z]+)[ ,\-\/]+(\d{2}|\d{4})$/i);
  if (m) {
    const dd = pad(m[1]);
    const mm = months[m[2].toLowerCase()];
    if (!mm) return null;

    let yyyy = String(m[3]);
    if (yyyy.length === 2) {
      const yy = Number(yyyy);
      yyyy = yy >= 70 ? `19${pad(yy)}` : `20${pad(yy)}`;
    }

    return `${yyyy}-${mm}-${dd}`;
  }

  // Oct 16 26 / October 16 2026
  m = cleaned.match(/^([A-Za-z]+)[ ,\-\/]+(\d{1,2})[ ,\-\/]+(\d{2}|\d{4})$/i);
  if (m) {
    const mm = months[m[1].toLowerCase()];
    if (!mm) return null;

    const dd = pad(m[2]);
    let yyyy = String(m[3]);
    if (yyyy.length === 2) {
      const yy = Number(yyyy);
      yyyy = yy >= 70 ? `19${pad(yy)}` : `20${pad(yy)}`;
    }

    return `${yyyy}-${mm}-${dd}`;
  }

  // IMPORTANT:
  // If only day + month is visible like "27 APR", do NOT guess year.
  return null;
}

function detectDateLabel(raw, notes) {
  const text = `${raw || ""} ${notes || ""}`.toLowerCase();

  if (text.includes("use by")) return "use_by";
  if (text.includes("best before")) return "best_before";
  if (text.includes("expiry")) return "expiry";
  if (text.includes("sell by")) return "sell_by";

  return "unknown";
}

app.post("/api/scan-grocery", async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 required" });
    }

    const dataUrl = `data:image/jpeg;base64,${imageBase64}`;

    const system = `
You are the AI for a grocery expiry app.

Return JSON only with keys:
- itemName: string or null
- category: one of dairy, meat, fish, produce, pantry, frozen, beverage, bakery, snack, other
- rawDateText: string or null
- dateLabel: one of use_by, expiry, best_before, sell_by, unknown
- expiryDateISO: string or null
- confidence: high | medium | low
- notes: short string

Rules:
- Read only what is actually visible in the image.
- Never invent a year if the year is not visible.
- If the image only shows day and month, set expiryDateISO to null.
- Prefer Use By / Expiry over Best Before if multiple dates exist.
- If only Best Before exists, use it.
- rawDateText should contain the visible printed date as closely as possible.
- If there is no clearly visible year, expiryDateISO must be null.
- Never invent a date not visible in the image.
- For itemName, prefer the front-of-pack product name if clearly visible. If not clear, return null.
`;

    const response = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract the grocery item name and printed expiry information from this image. If the year is not visible, do not guess it."
            },
            {
              type: "image_url",
              image_url: { url: dataUrl }
            }
          ]
        }
      ]
    });

    const text = response.choices?.[0]?.message?.content || "{}";
    console.log("AI RAW:", text);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {
        itemName: null,
        category: "other",
        rawDateText: null,
        dateLabel: "unknown",
        expiryDateISO: null,
        confidence: "low",
        notes: "Invalid JSON from model."
      };
    }

    parsed.dateLabel = detectDateLabel(parsed.rawDateText, parsed.notes) || parsed.dateLabel || "unknown";

    // If raw date has no visible year, force ISO to null
    if (parsed.rawDateText && !hasVisibleYear(parsed.rawDateText)) {
      parsed.expiryDateISO = null;
      parsed.notes = "Day and month detected, but year is not visible.";
      parsed.confidence = "medium";
    } else if (!parsed.expiryDateISO && parsed.rawDateText) {
      parsed.expiryDateISO = normalizeVisibleDate(parsed.rawDateText);
    }

    if (parsed.expiryDateISO && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.expiryDateISO)) {
      parsed.expiryDateISO = normalizeVisibleDate(parsed.expiryDateISO);
    }

    if (!parsed.expiryDateISO && !parsed.notes) {
      parsed.notes = "Date format is unclear or incomplete.";
    }

    return res.json({
      itemName: parsed.itemName || null,
      category: parsed.category || "other",
      rawDateText: parsed.rawDateText || null,
      dateLabel: parsed.dateLabel || "unknown",
      expiryDateISO: parsed.expiryDateISO || null,
      confidence: parsed.confidence || "low",
      notes: parsed.notes || ""
    });
  } catch (e) {
    console.error("Scan error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`FreshLens server running on ${PORT}`);
});