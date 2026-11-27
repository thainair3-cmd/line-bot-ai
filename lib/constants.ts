export const DEFAULT_REPLY =
  "ขออภัยค่ะ เรื่องนี้น้องแอดมินขอส่งต่อให้เจ้าหน้าที่ติดต่อกลับโดยเร็วที่สุดนะคะ 🙏";

export const UNSUPPORTED_MESSAGE_REPLY =
  "ขออภัยค่ะ ตอนนี้น้องแอดมินรองรับเฉพาะข้อความตัวอักษรและรูปสลิปโอนเงินนะคะ 🙏";

// Groups / rooms
export const GROUP_JOIN_REPLY =
  "สวัสดีค่ะ น้องแอดมินพร้อมช่วยตรวจสลิปโอนเงินในกลุ่มนี้แล้วค่ะ ส่งรูปสลิปเข้ามาได้เลยนะคะ 🙏";
// In a group, text is only answered when it starts with this name (an optional leading "@" is allowed).
export const GROUP_TRIGGER = "น้องแอดมิน";

// Slip verification (EasySlip). The whole slip flow must finish within SLIP_TOTAL_BUDGET_MS.
export const SLIP_TOTAL_BUDGET_MS = 9_000;
export const SLIP_DOWNLOAD_TIMEOUT_MS = 4_000;
export const SLIP_VERIFY_TIMEOUT_MS = 7_000;
// QR is decoded on the server first (fast JSON "payload" verify); this caps all decode attempts.
export const SLIP_QR_DECODE_BUDGET_MS = 1_500;
// After a failed payload verify, fall back to uploading the image only if this much time is left.
export const SLIP_MIN_IMAGE_FALLBACK_MS = 2_500;
export const SLIP_MAX_IMAGE_BYTES = 4 * 1024 * 1024; // EasySlip limit: 4 MB

// Gemini
// Default model (override with env GEMINI_MODEL) and the fallback tried once on 429/503.
// Both are stable flash-lite models with separate quotas.
export const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_FALLBACK_MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];
// Only retry if at least this much of the overall budget is left.
export const GEMINI_MIN_RETRY_MS = 2_000;
export const GEMINI_TEMPERATURE = 1.0; // do not lower
export const GEMINI_MAX_OUTPUT_TOKENS = 1024; // Gemini 3.x counts thinking + answer together
export const GEMINI_TIMEOUT_MS = 8_500; // overall budget for all attempts
export const GEMINI_FIRST_ATTEMPT_TIMEOUT_MS = 4_500; // leaves ~4s for the fallback model

// Google Sheet FAQ
export const SHEET_CACHE_TTL_MS = 60_000;
export const SHEET_FETCH_TIMEOUT_MS = 1_000; // on timeout, getFaq() falls back to the stale cache

// LINE
export const LINE_TEXT_MAX_LENGTH = 5_000;

// Products sheet ("สินค้า")
export const PRODUCTS_CACHE_TTL_MS = 5 * 60_000;
export const PRODUCTS_FETCH_TIMEOUT_MS = 1_500; // on timeout, getProducts() falls back to the stale cache

// Memory + cart (Upstash Redis, 1:1 chat only)
export const REDIS_TIMEOUT_MS = 800; // per request; on failure the bot continues without memory
export const MEMORY_MAX_MESSAGES = 10; // last 10 messages (customer + bot) per user
export const MEMORY_MAX_TEXT_LENGTH = 500; // each stored message is cut to this length
export const MEMORY_TTL_SECONDS = 24 * 60 * 60;
export const CART_TTL_SECONDS = 3 * 24 * 60 * 60;
// 1:1 chat: Gemini must finish by this point (measured from the start of the event) so the reply
// and the Redis save still fit in Vercel's 10s limit.
export const CHAT_GEMINI_DEADLINE_MS = 8_000;
