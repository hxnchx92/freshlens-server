require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3001;
const MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  console.warn("Missing SUPABASE_URL in server environment");
}

if (!SUPABASE_ANON_KEY) {
  console.warn("Missing SUPABASE_ANON_KEY in server environment");
}

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("Missing SUPABASE_SERVICE_ROLE_KEY in server environment");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function cleanJsonText(text = "") {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function safeJsonParse(text) {
  const cleaned = cleanJsonText(text);
  return JSON.parse(cleaned);
}

function monthNameToNumber(input = "") {
  const m = String(input || "").trim().toUpperCase();

  const map = {
    JAN: "01",
    FEB: "02",
    MAR: "03",
    APR: "04",
    MAY: "05",
    JUN: "06",
    JUL: "07",
    AUG: "08",
    SEP: "09",
    SEPT: "09",
    OCT: "10",
    NOV: "11",
    DEC: "12",
  };

  return map[m] || null;
}

function daysInMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

function isValidYMD(year, month, day) {
  const yyyy = Number(year);
  const mm = Number(month);
  const dd = Number(day);

  if (
    !Number.isInteger(yyyy) ||
    !Number.isInteger(mm) ||
    !Number.isInteger(dd)
  ) {
    return false;
  }

  if (yyyy < 2024 || yyyy > 2100) return false;
  if (mm < 1 || mm > 12) return false;

  const maxDay = daysInMonth(yyyy, mm);
  if (dd < 1 || dd > maxDay) return false;

  return true;
}

function toIso(year, month, day) {
  const yyyy = String(year);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeWhitespace(text = "") {
  return String(text || "")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickFutureOrCurrentYear(month, day) {
  const now = new Date();
  const currentYear = now.getFullYear();

  const thisYearCandidate = new Date(
    currentYear,
    Number(month) - 1,
    Number(day)
  );
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (thisYearCandidate >= today) {
    return String(currentYear);
  }

  return String(currentYear + 1);
}

function normalizeDateFromText(rawDateText = "", dateLabel = "unknown") {
  const original = String(rawDateText || "").trim();
  const text = normalizeWhitespace(original).toUpperCase();

  if (!text) {
    return {
      rawDateText: "",
      expiryDateISO: "",
      partialDateText: "",
      notes: "No date found.",
    };
  }

  let m;

  // 1) DAY + MONTH, e.g. 14 APR
  m = text.match(/\b(\d{1,2})\s+([A-Z]{3,4})\b/);
  if (m) {
    const day = String(m[1]).padStart(2, "0");
    const month = monthNameToNumber(m[2]);

    if (month) {
      const year = pickFutureOrCurrentYear(month, day);

      if (isValidYMD(year, month, day)) {
        return {
          rawDateText: original,
          expiryDateISO: toIso(year, month, day),
          partialDateText: "",
          notes:
            dateLabel === "use_by"
              ? "Use by date found."
              : dateLabel === "best_before"
              ? "Best before date found."
              : "Printed date found.",
        };
      }
    }
  }

  // 2) DD/MM/YY or DD-MM-YYYY or DD.MM.YYYY
  m = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    const day = String(m[1]).padStart(2, "0");
    const month = String(m[2]).padStart(2, "0");
    let year = String(m[3]);

    if (year.length === 2) {
      year = `20${year}`;
    }

    if (isValidYMD(year, month, day)) {
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, day),
        partialDateText: "",
        notes:
          dateLabel === "use_by"
            ? "Use by date found."
            : "Best before or printed date found.",
      };
    }
  }

  // 3) DD MM YY or DD MM YYYY
  m = text.match(/\b(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})\b/);
  if (m) {
    const day = String(m[1]).padStart(2, "0");
    const month = String(m[2]).padStart(2, "0");
    let year = String(m[3]);

    if (year.length === 2) {
      year = `20${year}`;
    }

    if (isValidYMD(year, month, day)) {
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, day),
        partialDateText: "",
        notes:
          dateLabel === "use_by"
            ? "Use by date found."
            : "Best before or printed date found.",
      };
    }
  }

  // 4) MONTH YY, e.g. OCT 27
  m = text.match(/\b([A-Z]{3,4})\s+(\d{2})\b/);
  if (m) {
    const month = monthNameToNumber(m[1]);
    const year = `20${m[2]}`;

    if (month) {
      const lastDay = daysInMonth(year, month);
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, lastDay),
        partialDateText: `${m[1]} ${m[2]}`,
        notes: "Best before month/year found. End of month assumed.",
      };
    }
  }

  // 5) MM/YYYY or MM-YYYY or MM.YYYY
  m = text.match(/\b(\d{1,2})[\/\-.](\d{4})\b/);
  if (m) {
    const month = String(m[1]).padStart(2, "0");
    const year = String(m[2]);

    if (Number(month) >= 1 && Number(month) <= 12) {
      const lastDay = daysInMonth(year, month);
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, lastDay),
        partialDateText: `${month}/${year}`,
        notes: "Best before month/year found. End of month assumed.",
      };
    }
  }

  // 6) MM YYYY
  m = text.match(/\b(\d{1,2})\s+(\d{4})\b/);
  if (m) {
    const month = String(m[1]).padStart(2, "0");
    const year = String(m[2]);

    if (Number(month) >= 1 && Number(month) <= 12) {
      const lastDay = daysInMonth(year, month);
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, lastDay),
        partialDateText: `${month} ${year}`,
        notes: "Best before month/year found. End of month assumed.",
      };
    }
  }

  // 7) END: DEC 2026 or DEC 2026
  m = text.match(/\b(?:END[:\s]*)?([A-Z]{3,4})\s+(\d{4})\b/);
  if (m) {
    const month = monthNameToNumber(m[1]);
    const year = String(m[2]);

    if (month) {
      const lastDay = daysInMonth(year, month);
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, lastDay),
        partialDateText: `${m[1]} ${year}`,
        notes: "Best before month/year found. End of month assumed.",
      };
    }
  }

  // 8) E01 2027 / E03 2027 / EO1 2027
  m = text.match(/\bE[O0]?(\d{1,2})\s*(\d{4})\b/);
  if (m) {
    const month = String(m[1]).padStart(2, "0");
    const year = String(m[2]);

    if (Number(month) >= 1 && Number(month) <= 12) {
      const lastDay = daysInMonth(year, month);
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, lastDay),
        partialDateText: `E${month} ${year}`,
        notes: "Best before month/year found. End of month assumed.",
      };
    }
  }

  return {
    rawDateText: original,
    expiryDateISO: "",
    partialDateText: original,
    notes: "Date format is unclear or incomplete.",
  };
}

async function getUserFromBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";

  if (!token) {
    throw new Error("Missing access token.");
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error) {
    throw new Error(error.message || "Invalid access token.");
  }

  if (!user?.id) {
    throw new Error("User not found from token.");
  }

  return user;
}

app.get("/", (req, res) => {
  res.json({ ok: true, message: "FreshLens server running" });
});

app.post("/api/scan-grocery", async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required." });
    }

    const prompt = `
You are extracting grocery information from a product photo.

Return VALID JSON ONLY.
No markdown.
No code fences.

There are two possible scan types:

1. PRODUCT SCAN
- extract product name
- write a short helpful note about what the item is

2. EXPIRY SCAN
- extract the printed date text exactly as visible
- identify the date label

Date label rules:
- "use_by" = safety date
- "best_before" = quality date
- "printed_date" = visible printed date but label not clearly shown
- "unknown" = no clear label

Important date guidance:
- Use By common formats:
  - 15 APR
  - 15/04/26
  - 15 04 26
- Best Before common formats:
  - OCT 27
  - 10/2027
  - 03 2028
  - End: DEC 2026

Important:
- Focus on the main product shown in the image
- Product name should be short, clean and user-friendly
- Do not include category
- Notes should be brief and practical

If the image is mainly the front of a product, return:
{
  "scanType": "product",
  "itemName": "string",
  "notes": "short note"
}

If the image is mainly an expiry/date image, return:
{
  "scanType": "expiry",
  "rawDateText": "exact visible date text only",
  "dateLabel": "use_by|best_before|printed_date|unknown",
  "notes": "short note"
}
`;

    const response = await client.responses.create({
      model: MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${imageBase64}`,
            },
          ],
        },
      ],
    });

    const text = response.output_text || "";
    const parsed = safeJsonParse(text);

    if (parsed.scanType === "product") {
      const itemName = String(parsed.itemName || "").trim();

      return res.json({
        itemName,
        notes: String(parsed.notes || "").trim(),
      });
    }

    const rawDateText = String(parsed.rawDateText || "").trim();
    const dateLabel = String(parsed.dateLabel || "unknown")
      .trim()
      .toLowerCase();

    const normalized = normalizeDateFromText(rawDateText, dateLabel);

    return res.json({
      rawDateText: normalized.rawDateText,
      partialDateText: normalized.partialDateText,
      expiryDateISO: normalized.expiryDateISO,
      dateLabel,
      notes: normalized.notes || String(parsed.notes || "").trim(),
    });
  } catch (error) {
    console.error("scan-grocery error:", error?.message || error);
    return res.status(500).json({
      error: error?.message || "Failed to scan grocery item.",
    });
  }
});

app.post("/api/recipes", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!items.length) {
      return res.status(400).json({ error: "No items provided." });
    }

    const cleanedItems = items
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 10);

    if (!cleanedItems.length) {
      return res.status(400).json({ error: "No valid items provided." });
    }

    const prompt = `
You are a helpful cooking assistant.

Create 3 simple recipe ideas using these ingredients/items:
${cleanedItems.join(", ")}

Rules:
- Return VALID JSON ONLY
- No markdown
- No code fences
- Keep recipes realistic and simple
- Use British wording where sensible
- Each recipe must have:
  - title
  - description
  - ingredients (array of strings)
  - steps (array of strings)

Return exactly:
{
  "recipes": [
    {
      "title": "Recipe title",
      "description": "Short description",
      "ingredients": ["ingredient 1", "ingredient 2"],
      "steps": ["step 1", "step 2"]
    }
  ]
}
`;

    const response = await client.responses.create({
      model: MODEL,
      input: prompt,
    });

    const text = response.output_text || "";
    const parsed = safeJsonParse(text);

    return res.json({
      recipes: Array.isArray(parsed?.recipes) ? parsed.recipes : [],
    });
  } catch (error) {
    console.error("recipes error:", error?.message || error);
    return res.status(500).json({
      error: error?.message || "Failed to generate recipes.",
    });
  }
});

app.post("/api/delete-account", async (req, res) => {
  try {
    const user = await getUserFromBearerToken(req);
    const userId = user.id;

    // Delete user's inventory items first
    const { error: deleteItemsError } = await supabaseAdmin
      .from("items")
      .delete()
      .eq("user_id", userId);

    if (deleteItemsError) {
      throw new Error(deleteItemsError.message || "Failed to delete items.");
    }

    // Delete auth user last
    const { error: deleteUserError } =
      await supabaseAdmin.auth.admin.deleteUser(userId);

    if (deleteUserError) {
      throw new Error(
        deleteUserError.message || "Failed to delete auth user."
      );
    }

    return res.json({
      ok: true,
      message: "Account deleted successfully.",
    });
  } catch (error) {
    console.error("delete-account error:", error?.message || error);
    return res.status(500).json({
      error: error?.message || "Failed to delete account.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`FreshLens server running on port ${PORT}`);
});
