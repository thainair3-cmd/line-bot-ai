export const DEFAULT_REPLY =
  "ขออภัยค่ะ เรื่องนี้น้องแอดมินขอส่งต่อให้เจ้าหน้าที่ติดต่อกลับโดยเร็วที่สุดนะคะ 🙏";

export const NON_TEXT_REPLY =
  "ขออภัยค่ะ ตอนนี้น้องแอดมินตอบได้เฉพาะข้อความตัวอักษรนะคะ 🙏";

// Gemini
export const GEMINI_MODEL = "gemini-3.5-flash";
export const GEMINI_TEMPERATURE = 1.0; // do not lower
export const GEMINI_MAX_OUTPUT_TOKENS = 1024; // Gemini 3.x counts thinking + answer together
export const GEMINI_TIMEOUT_MS = 7_000;

// Google Sheet FAQ
export const SHEET_CACHE_TTL_MS = 60_000;
export const SHEET_FETCH_TIMEOUT_MS = 2_000;

// LINE
export const LINE_TEXT_MAX_LENGTH = 5_000;
