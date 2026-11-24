export const DEFAULT_REPLY =
  "ขออภัยค่ะ เรื่องนี้น้องแอดมินขอส่งต่อให้เจ้าหน้าที่ติดต่อกลับโดยเร็วที่สุดนะคะ 🙏";

export const NON_TEXT_REPLY =
  "ขออภัยค่ะ ตอนนี้น้องแอดมินตอบได้เฉพาะข้อความตัวอักษรนะคะ 🙏";

// Gemini
// Default model (override with env GEMINI_MODEL) and the fallback tried once on 429/503.
// Both are stable flash-lite models with separate quotas.
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_FALLBACK_MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];
// Only retry if at least this much of the overall budget is left.
export const GEMINI_MIN_RETRY_MS = 2_000;
export const GEMINI_TEMPERATURE = 1.0; // do not lower
export const GEMINI_MAX_OUTPUT_TOKENS = 1024; // Gemini 3.x counts thinking + answer together
export const GEMINI_TIMEOUT_MS = 8_500;

// Google Sheet FAQ
export const SHEET_CACHE_TTL_MS = 60_000;
export const SHEET_FETCH_TIMEOUT_MS = 1_000; // on timeout, getFaq() falls back to the stale cache

// LINE
export const LINE_TEXT_MAX_LENGTH = 5_000;
