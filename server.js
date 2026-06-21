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
app.post("/api/recipes", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items)
      ? req.body.items
      : [];

    const previousRecipes = Array.isArray(req.body?.previousRecipes)
      ? req.body.previousRecipes
      : [];

    if (!items.length) {
      return res.status(400).json({
        error: "No items provided.",
      });
    }

    const cleanedItems = items
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 15);

    const cleanedPreviousRecipes = previousRecipes
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 50);

    const previousRecipeText =
      cleanedPreviousRecipes.length > 0
        ? `
DO NOT return any of these recipes:

${cleanedPreviousRecipes.join("\n")}
`
        : "";

    const prompt = `
You are a professional chef and meal planner.

Using these ingredients:

${cleanedItems.join(", ")}

${previousRecipeText}

Create EXACTLY 6 REALISTIC recipes.

IMPORTANT:

- Recipes must be real dishes people actually cook.
- Recipes must feel like recipes from BBC Good Food, Jamie Oliver, Tesco, Waitrose, AllRecipes or similar.
- Do not invent weird recipes.
- Do not create fake recipe names.
- Use UK cooking style.
- Use common pantry ingredients where needed.
- Include:
  - quick meal
  - healthy meal
  - comfort food
  - family meal
  - lunch idea
  - leftover idea

Rules:

- Recipe titles must be realistic.
- Ingredients must be detailed.
- Steps must be detailed.
- 5-10 ingredients.
- 4-8 steps.
- Return EXACTLY 6 recipes.

Return ONLY valid JSON.

{
  "recipes": [
    {
      "title": "Recipe title",
      "description": "Short description",
      "ingredients": [
        "ingredient"
      ],
      "steps": [
        "step"
      ]
    }
  ]
}
`;

    const response = await client.responses.create({
      model: RECIPE_MODEL,
      input: prompt,
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
      error:
        error?.message ||
        "Failed to generate recipes.",
    });
  }
});