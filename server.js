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
const RECIPE_MODEL = process.env.OPENAI_RECIPE_MODEL || "gpt-4.1-mini";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  return JSON.parse(cleanJsonText(text));
}

function normalizeWhitespace(text = "") {
  return String(text || "")
    .replace(/[|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function monthNameToNumber(input = "") {
  const m = String(input || "").trim().toUpperCase();

  const map = {
    JAN: "01",
    JANUARY: "01",
    FEB: "02",
    FEBRUARY: "02",
    MAR: "03",
    MARCH: "03",
    APR: "04",
    APRIL: "04",
    MAY: "05",
    JUN: "06",
    JUNE: "06",
    JUL: "07",
    JULY: "07",
    AUG: "08",
    AUGUST: "08",
    SEP: "09",
    SEPT: "09",
    SEPTEMBER: "09",
    OCT: "10",
    OCTOBER: "10",
    NOV: "11",
    NOVEMBER: "11",
    DEC: "12",
    DECEMBER: "12",
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

  if (!Number.isInteger(yyyy) || !Number.isInteger(mm) || !Number.isInteger(dd)) {
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

function pickFutureOrCurrentYear(month, day) {
  const now = new Date();
  const currentYear = now.getFullYear();

  const candidate = new Date(currentYear, Number(month) - 1, Number(day));
  const today = new Date(currentYear, now.getMonth(), now.getDate());

  return candidate >= today ? String(currentYear) : String(currentYear + 1);
}

function normalizeDateFromText(rawDateText = "", dateLabel = "unknown") {
  const original = String(rawDateText || "").trim();

  let text = normalizeWhitespace(original).toUpperCase();

  text = text
    .replace(/BEST\s*(IF\s*)?(USED\s*)?BY/g, " ")
    .replace(/BEST\s*WHEN\s*USED\s*BY/g, " ")
    .replace(/BEST\s*BEFORE/g, " ")
    .replace(/USE\s*BY/g, " ")
    .replace(/USED\s*BY/g, " ")
    .replace(/EXPIRY/g, " ")
    .replace(/EXPIRES/g, " ")
    .replace(/EXP/g, " ")
    .replace(/BBE/g, " ")
    .replace(/BB/g, " ")
    .replace(/LOT/g, " ")
    .replace(/BATCH/g, " ")
    .replace(/:/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return {
      rawDateText: "",
      expiryDateISO: "",
      partialDateText: "",
      notes: "No date found.",
    };
  }

  let m;

  m = text.match(
    /\b(\d{1,2})\s*(0CT|OCT|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|NOV|DEC|[A-Z]{3,9})\s*(20\d{2}|\d{2})\b/
  );

  if (m) {
    const day = String(m[1]).padStart(2, "0");
    const monthText = String(m[2]).replace("0CT", "OCT");
    const month = monthNameToNumber(monthText);
    let year = String(m[3]);

    if (year.length === 2) year = `20${year}`;

    if (month && isValidYMD(year, month, day)) {
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, day),
        partialDateText: "",
        notes:
          dateLabel === "best_before"
            ? "Best before date found."
            : dateLabel === "use_by"
            ? "Use by date found."
            : "Printed date found.",
      };
    }
  }

  m = text.match(/\b([A-Z]{3,9})\s*(\d{1,2})\s*(20\d{2}|\d{2})\b/);

  if (m) {
    const month = monthNameToNumber(m[1]);
    const day = String(m[2]).padStart(2, "0");
    let year = String(m[3]);

    if (year.length === 2) year = `20${year}`;

    if (month && isValidYMD(year, month, day)) {
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, day),
        partialDateText: "",
        notes: "Printed date found.",
      };
    }
  }

  m = text.match(/\b(20\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);

  if (m) {
    const year = String(m[1]);
    const month = String(m[2]).padStart(2, "0");
    const day = String(m[3]).padStart(2, "0");

    if (isValidYMD(year, month, day)) {
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, day),
        partialDateText: "",
        notes: "ISO date format found.",
      };
    }
  }

  m = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);

  if (m) {
    const first = Number(m[1]);
    const second = Number(m[2]);
    let year = String(m[3]);

    if (year.length === 2) year = `20${year}`;

    let day;
    let month;

    if (first > 12) {
      day = String(first).padStart(2, "0");
      month = String(second).padStart(2, "0");
    } else if (second > 12) {
      month = String(first).padStart(2, "0");
      day = String(second).padStart(2, "0");
    } else {
      day = String(first).padStart(2, "0");
      month = String(second).padStart(2, "0");
    }

    if (isValidYMD(year, month, day)) {
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, day),
        partialDateText: "",
        notes: "Numeric date format found.",
      };
    }
  }

  m = text.match(/\b(\d{1,2})\s+(\d{1,2})\s+(20\d{2}|\d{2})\b/);

  if (m) {
    const day = String(m[1]).padStart(2, "0");
    const month = String(m[2]).padStart(2, "0");
    let year = String(m[3]);

    if (year.length === 2) year = `20${year}`;

    if (isValidYMD(year, month, day)) {
      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, day),
        partialDateText: "",
        notes: "Spaced numeric date found.",
      };
    }
  }

  m = text.match(/\b(\d{1,2})\s*([A-Z]{3,9})\b/);

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
          notes: "Day and month found. Year assumed.",
        };
      }
    }
  }

  m = text.match(/\b([A-Z]{3,9})\s*(20\d{2}|\d{2})\b/);

  if (m) {
    const month = monthNameToNumber(m[1]);
    let year = String(m[2]);

    if (year.length === 2) year = `20${year}`;

    if (month) {
      const lastDay = daysInMonth(year, month);

      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, lastDay),
        partialDateText: `${m[1]} ${year}`,
        notes: "Month/year found. End of month assumed.",
      };
    }
  }

  m = text.match(/\b(\d{1,2})[\/\-.](20\d{2})\b/);

  if (m) {
    const month = String(m[1]).padStart(2, "0");
    const year = String(m[2]);

    if (Number(month) >= 1 && Number(month) <= 12) {
      const lastDay = daysInMonth(year, month);

      return {
        rawDateText: original,
        expiryDateISO: toIso(year, month, lastDay),
        partialDateText: `${month}/${year}`,
        notes: "Month/year numeric format found. End of month assumed.",
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
    const { imageBase64, scanMode } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required." });
    }

    const prompt = `
You are FreshLens AI. Extract grocery product information from the image.

Return VALID JSON ONLY.
No markdown.
No code fences.

The app scanMode is: "${scanMode || "unknown"}".

CRITICAL PRIORITY RULE:
If scanMode is "product", your FIRST priority is the PRODUCT NAME.
You must look for the largest / most consumer-facing product name or brand + product name on the packaging.
Do NOT focus only on the expiry date.
Do NOT return expiry-only if any product name or brand/product title is visible.

When scanMode is "product":
Return one of these:

A) If product name AND expiry/date are visible:
{
  "scanType": "combined",
  "itemName": "clean product name",
  "rawDateText": "exact visible expiry/best-before/use-by date text only",
  "dateLabel": "use_by|best_before|printed_date|unknown",
  "notes": "short note"
}

B) If product name is visible but no expiry/date is readable:
{
  "scanType": "product",
  "itemName": "clean product name",
  "notes": "short note"
}

C) Only if NO product name or brand/product title is visible, but a date is visible:
{
  "scanType": "expiry",
  "rawDateText": "exact visible expiry/best-before/use-by date text only",
  "dateLabel": "use_by|best_before|printed_date|unknown",
  "notes": "product name not visible"
}

When scanMode is "expiry":
Your first priority is the printed expiry/use-by/best-before date.
If product name is also visible, include it and return combined.
If only date is visible, return expiry.

DATE RULES:
- Focus on the printed food date, not batch codes or times.
- Ignore batch codes.
- Ignore lot codes.
- Ignore timestamps.
- Ignore manufacturing codes.
- Ignore serial numbers.
- If the label says "Best if used by", use "best_before".
- If the label says "Best when used by", use "best_before".
- If the label says "Best before", use "best_before".
- If the label says "Use by", use "use_by".
- If no label is clear but a date is visible, use "printed_date".

Recognise date formats like:
- 21 MAR2027
- 21MAR2027
- 21 MAR 2027
- 05OCT26
- OCT 27
- 10/2027
- 15/04/26
- 03/21/2027

PRODUCT NAME RULES:
- Extract the most likely consumer-facing grocery item name.
- Prefer the main product title on the package over small text near the expiry date.
- Keep itemName short and clean.
- Do not include weight, barcode, batch number, expiry date, or storage instructions.
- If a brand and product title are both visible, include both only if it helps identify the item.
- Do not invent a product name if truly unreadable.

Return JSON only.
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
    const scanType = String(parsed.scanType || "unknown").trim().toLowerCase();

    if (scanType === "product") {
      return res.json({
        scanType: "product",
        itemName: String(parsed.itemName || "").trim(),
        notes: String(parsed.notes || "").trim(),
        rawDateText: "",
        partialDateText: "",
        expiryDateISO: "",
        dateLabel: "unknown",
      });
    }

    if (scanType === "combined") {
      const rawDateText = String(parsed.rawDateText || "").trim();
      const dateLabel = String(parsed.dateLabel || "unknown").trim().toLowerCase();
      const normalized = normalizeDateFromText(rawDateText, dateLabel);

      return res.json({
        scanType: "combined",
        itemName: String(parsed.itemName || "").trim(),
        rawDateText: normalized.rawDateText,
        partialDateText: normalized.partialDateText,
        expiryDateISO: normalized.expiryDateISO,
        dateLabel,
        notes: normalized.notes || String(parsed.notes || "").trim(),
      });
    }

    const rawDateText = String(parsed.rawDateText || "").trim();
    const dateLabel = String(parsed.dateLabel || "unknown").trim().toLowerCase();
    const normalized = normalizeDateFromText(rawDateText, dateLabel);

    return res.json({
      scanType: "expiry",
      itemName: String(parsed.itemName || "").trim(),
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

    const previousRecipes = Array.isArray(req.body?.previousRecipes)
      ? req.body.previousRecipes
      : [];

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

    const previousRecipeText =
      previousRecipes.length > 0
        ? `
PREVIOUS RECIPES ALREADY GENERATED (do NOT repeat or make variations of these):

${previousRecipes.join("\n")}
`
        : "";

    // Rotate a random "angle" each call so identical ingredients don't
    // collapse to the same default dish every time.
    const diversityAngles = [
      "Lead with global cuisines: Thai, Mexican, Indian, Japanese, Middle Eastern, Italian, Korean, Ethiopian.",
      "Favour savoury dishes and main courses over sweet or breakfast options.",
      "Focus on healthy, light meals: salads, grain bowls, soups, and fresh no-cook dishes.",
      "Focus on comfort food and hearty family dinners from different countries.",
      "Mix in snacks, party food, and small plates rather than full meals.",
      "Prioritise quick no-cook or one-pan meals using minimal extra ingredients.",
    ];

    const chosenAngle =
      diversityAngles[Math.floor(Math.random() * diversityAngles.length)];

    // A random seed nudges the model away from deterministic defaults.
    const varietySeed = Math.random().toString(36).slice(2, 8);

    const prompt = `
You are a professional chef and meal planner.

Using these ingredients:

${cleanedItems.join(", ")}

${previousRecipeText}

Create EXACTLY 6 genuinely different recipes.

VARIETY FOCUS FOR THIS BATCH:
${chosenAngle}

HARD DIVERSITY RULES:
- Each recipe MUST use a different cuisine where possible (e.g. Italian, Thai, Mexican, Indian, Middle Eastern, Japanese, Korean).
- Each recipe MUST use a different cooking method (baked, grilled, simmered, blended, raw/no-cook, pan-fried, roasted).
- Each recipe MUST be a different meal type (breakfast, lunch, dinner, dessert, snack, drink, salad, side).
- Do NOT default to the most obvious dish for an ingredient. For example, for strawberries do NOT keep making waffles, pancakes, or smoothies.
- No two recipes may share the same core format or be renamed versions of each other.
- If an ingredient only supports a few obvious recipes, combine it with common household staples to unlock different dishes.
- Every recipe title must be unique and specific.

Return ONLY valid JSON in this exact shape (no markdown, no commentary):

{
  "recipes": [
    {
      "title": "Recipe title",
      "description": "Short description",
      "ingredients": ["ingredient"],
      "steps": ["step"]
    }
  ]
}

(Variety token: ${varietySeed})
`;

    const response = await client.responses.create({
      model: RECIPE_MODEL,
      input: prompt,
      temperature: 1.0,
      top_p: 0.95,
    });

    const text = response.output_text || "";
    const parsed = safeJsonParse(text);

    return res.json({
      recipes: Array.isArray(parsed?.recipes)
        ? parsed.recipes.slice(0, 6)
        : [],
    });
  } catch (error) {
    console.error("recipes error:", error?.message || error);
    return res.status(500).json({
      error: error?.message || "Failed to generate recipes.",
    });
  }
});

app.post("/api/recipe-image", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();

    if (!title) {
      return res.status(400).json({
        error: "Recipe title required.",
      });
    }

    const result = await client.images.generate({
      model: "gpt-image-1",
      prompt: `
Professional food photography.

Recipe title:
${title}

Description:
${description || "A fresh homemade meal."}

Style:
- realistic food photo
- natural lighting
- appetising plating
- clean kitchen or table setting
- square image
- no text
- no watermark
- no people
`,
      size: "1024x1024",
    });

    const imageBase64 = result?.data?.[0]?.b64_json || null;

    return res.json({
      imageUrl: imageBase64
        ? `data:image/png;base64,${imageBase64}`
        : null,
    });
  } catch (error) {
    console.error("recipe-image error:", error?.message || error);

    return res.status(500).json({
      error: error?.message || "Failed to generate recipe image.",
    });
  }
});

app.post("/api/delete-account", async (req, res) => {
  try {
    const user = await getUserFromBearerToken(req);
    const userId = user.id;

    const { error: deleteItemsError } = await supabaseAdmin
      .from("items")
      .delete()
      .eq("user_id", userId);

    if (deleteItemsError) {
      throw new Error(deleteItemsError.message || "Failed to delete items.");
    }

    const { error: deleteUserError } =
      await supabaseAdmin.auth.admin.deleteUser(userId);

    if (deleteUserError) {
      throw new Error(deleteUserError.message || "Failed to delete auth user.");
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