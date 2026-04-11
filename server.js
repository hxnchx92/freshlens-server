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

function monthMap() {
  return {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    aug: "08",
    august: "08",
    sep: "09",
    sept: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
  };
}

function detectDateLabel(raw, notes) {
  const text = `${raw || ""} ${notes || ""}`.toLowerCase();

  if (text.includes("use by")) return "use_by";
  if (text.includes("best before")) return "best_before";
  if (text.includes("expiry")) return "expiry";
  if (text.includes("sell by")) return "sell_by";

  return "unknown";
}

/**
 * IMPORTANT RULE:
 * Only parse a year when it appears as its own clear date token,
 * not when it is embedded in a code like AY023 / B11 / LOT2023 etc.
 */
function extractTrustedDate(raw) {
  if (!raw || typeof raw !== "string") {
    return {
      expiryDateISO: null,
      notes: "No visible date text found.",
    };
  }

  const text = raw.trim();
  const months = monthMap();

  // Case 1: DD MM YY / DD-MM-YY / DD/MM/YY / DD.MM.YY
  let m = text.match(/\b(\d{1,2})[\/.\- ](\d{1,2})[\/.\- ](\d{2}|\d{4})\b/);
  if (m) {
    const dd = pad(m[1]);
    const mm = pad(m[2]);
    let yyyy = String(m[3]);

    if (yyyy.length === 2) {
      const yy = Number(yyyy);
      yyyy = yy >= 70 ? `19${pad(yy)}` : `20${pad(yy)}`;
    }

    return {
      expiryDateISO: `${yyyy}-${mm}-${dd}`,
      notes: "",
    };
  }

  // Case 2: YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  m = text.match(/\b(\d{4})[\/.\- ](\d{1,2})[\/.\- ](\d{1,2})\b/);
  if (m) {
    const yyyy = m[1];
    const mm = pad(m[2]);
    const dd = pad(m[3]);

    return {
      expiryDateISO: `${yyyy}-${mm}-${dd}`,
      notes: "",
    };
  }

  // Case 3: 27 APR 23 / 27 APR 2026
  m = text.match(/\b(\d{1,2})[ ,\/.\-]+([A-Za-z]{3,9})[ ,\/.\-]+(\d{2}|\d{4})\b/i);
  if (m) {
    const dd = pad(m[1]);
    const mon = months[m[2].toLowerCase()];
    if (!mon) {
      return {
        expiryDateISO: null,
        notes: "Month text was unclear.",
      };
    }

    let yyyy = String(m[3]);
    if (yyyy.length === 2) {
      const yy = Number(yyyy);
      yyyy = yy >= 70 ? `19${pad(yy)}` : `20${pad(yy)}`;
    }

    return {
      expiryDateISO: `${yyyy}-${mon}-${dd}`,
      notes: "",
    };
  }

  // Case 4: APR 27 23 / APR 27 2026
  m = text.match(/\b([A-Za-z]{3,9})[ ,\/.\-]+(\d{1,2})[ ,\/.\-]+(\d{2}|\d{4})\b/i);
  if (m) {
    const mon = months[m[1].toLowerCase()];
    if (!mon) {
      return {
        expiryDateISO: null,
        notes: "Month text was unclear.",
      };
    }

    const dd = pad(m[2]);
    let yyyy = String(m[3]);
    if (yyyy.length === 2) {
      const yy = Number(yyyy);
      yyyy = yy >= 70 ? `19${pad(yy)}` : `20${pad(yy)}`;
    }

    return {
      expiryDateISO: `${yyyy}-${mon}-${dd}`,
      notes: "",
    };
  }

  // Case 5: 27 APR (NO YEAR)
  m = text.match(/\b(\d{1,2})[ ,\/.\-]+([A-Za-z]{3,9})\b/i);
  if (m) {
    return {
      expiryDateISO: null,
      notes: "Day and month detected, but year is not visible.",
    };
  }

  // Case 6: APR 27 (NO YEAR)
  m = text.match(/\b([A-Za-z]{3,9})[ ,\/.\-]+(\d{1,2})\b/i);
  if (m) {
    return {
      expiryDateISO: null,
      notes: "Month and day detected, but year is not visible.",
    };
  }

  return {
    expiryDateISO: null,
    notes: "Date format is unclear or incomplete.",
  };
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
- Read only what is clearly visible.
- Never invent a year.
- Never convert a batch code or lot code into a year.
- If you see "27 APR" and no clear year next to it, rawDateText should be "27 APR" and expiryDateISO must be null.
- Ignore batch codes, timestamps, lot numbers, and manufacturing codes unless they are clearly part of the printed expiry date.
- For itemName, prefer the product name if clearly visible.
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
              text:
                "Extract the grocery item name and printed expiry information from this image. Do not treat batch codes like AY023 as a year. Only use a year if it is clearly printed as part of the date.",
            },
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
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
        notes: "Invalid JSON from model.",
      };
    }

    const trusted = extractTrustedDate(parsed.rawDateText);

    return res.json({
      itemName: parsed.itemName || null,
      category: parsed.category || "other",
      rawDateText: parsed.rawDateText || null,
      dateLabel: detectDateLabel(parsed.rawDateText, parsed.notes || parsed.dateLabel) || "unknown",
      expiryDateISO: trusted.expiryDateISO,
      confidence: trusted.expiryDateISO ? parsed.confidence || "medium" : "medium",
      notes: trusted.notes || parsed.notes || "",
    });
  } catch (e) {
    console.error("Scan error:", e);
    return res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`FreshLens server running on ${PORT}`);
});