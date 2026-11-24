import { ApiError, GoogleGenAI, ThinkingLevel, type GenerateContentConfig } from "@google/genai";
import {
  DEFAULT_REPLY,
  GEMINI_DEFAULT_MODEL,
  GEMINI_FALLBACK_MODELS,
  GEMINI_MAX_OUTPUT_TOKENS,
  GEMINI_MIN_RETRY_MS,
  GEMINI_TEMPERATURE,
  GEMINI_TIMEOUT_MS,
  LINE_TEXT_MAX_LENGTH,
} from "./constants";

const SYSTEM_INSTRUCTION = `<role>
คุณคือ "น้องแอดมิน" ผู้ดูแลแชท LINE ของ ไทยแน่ (Thainair)
แทนตัวเองว่า "น้องแอดมิน" เสมอ (ห้ามใช้ ฉัน/ดิฉัน/เรา/AI/บอท)
</role>
<constraints>
- ตอบโดยใช้ข้อมูลใน <faq> เท่านั้น
- ห้ามแต่งหรือเดา ราคา เวลาทำการ ที่ตั้ง เบอร์โทร สต็อกสินค้า โปรโมชั่น หรือข้อมูลใด ๆ ที่ไม่มีใน <faq>
- "คำถาม" ในแต่ละแถวของ <faq> อาจเป็นรายการคีย์เวิร์ดคั่นด้วย comma ถ้าข้อความลูกค้าตรงหรือใกล้เคียงคีย์เวิร์ดใด ให้ตอบด้วยคำตอบของแถวนั้น
- ลูกค้าอาจถามด้วยคำต่างจากใน FAQ ให้เทียบความหมาย ไม่ต้องตรงทุกคำ
- ถ้าลูกค้าพิมพ์สั้นหรือกว้าง เช่น "ท่อ" "ทองแดง" "ราคา" ให้สรุปภาพรวมจากแถวใน <faq> ที่เกี่ยวข้อง แล้วถามกลับเพื่อให้ได้รายละเอียดที่ต้องการ (เช่น บอกว่ามีท่อทองแดง Type ใดบ้างตามที่มีใน <faq> แล้วถามว่าต้องการขนาดไหน)
- ลูกค้าอาจระบุ Type และขนาดแบบย่อ เช่น "ท่อ L 1/2" หรือ "L 4 หุน" ให้จับคู่กับแถวใน <faq> ที่ตรงทั้ง Type และขนาด (1 หุน = 1/8 นิ้ว เช่น 4 หุน = 1/2 นิ้ว, 2 หุน = 1/4 นิ้ว, 6 หุน = 3/4 นิ้ว, 8 หุน = 1 นิ้ว)
- ใช้ข้อความนี้ทุกตัวอักษร เฉพาะเมื่อไม่มีแถวใดใน <faq> เกี่ยวข้องกับข้อความลูกค้าเลยจริง ๆ: "${DEFAULT_REPLY}"
- ถ้าลูกค้าทักทายเฉย ๆ (สวัสดี, hello) ให้ทักกลับสั้น ๆ และถามว่ามีอะไรให้ช่วย
- โทน: สุภาพทางการ ลงท้ายด้วย "ค่ะ"/"นะคะ" ใช้อีโมจินิดหน่อย (ไม่เกิน 1 ตัวต่อข้อความ เช่น 🙏 😊)
- ความยาว: สั้นกระชับ 1-3 ประโยค
</constraints>
<output_format>
ภาษาไทย ข้อความธรรมดา ห้ามใช้ markdown (ห้าม **, #, -, ตาราง, ลิงก์แบบ [](...))
</output_format>`;

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

function buildContents(faq: string, question: string): string {
  return `<faq>\n${faq}\n</faq>\n<question>\n${question}\n</question>`;
}

/** Strips stray markdown characters and enforces LINE's 5000-character limit. */
export function cleanReply(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2") // [label](url) -> label url
    .replace(/[*#`]/g, "")
    .trim()
    .slice(0, LINE_TEXT_MAX_LENGTH);
}

class GeminiTimeoutError extends Error {
  constructor(ms: number) {
    super(`Gemini timed out after ${ms}ms`);
  }
}

/** Model from env GEMINI_MODEL if set, otherwise the code default. */
function primaryModel(): string {
  return process.env.GEMINI_MODEL?.trim() || GEMINI_DEFAULT_MODEL;
}

/** First fallback that differs from the primary model. */
function fallbackModel(primary: string): string | undefined {
  return GEMINI_FALLBACK_MODELS.find((m) => m !== primary);
}

/**
 * Lowest thinking setting per model family:
 * Gemini 3.x supports thinkingLevel MINIMAL; Gemini 2.5 flash-lite has thinking off by default
 * (no MINIMAL level), so send no thinkingConfig for it or any non-3.x model.
 */
function thinkingConfigFor(model: string): GenerateContentConfig["thinkingConfig"] {
  return /^gemini-[3-9]/.test(model) ? { thinkingLevel: ThinkingLevel.MINIMAL } : undefined;
}

/** 429 = quota exhausted, 503 = model overloaded: worth one retry on another model. */
function isRetryable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 429 || err.status === 503);
}

async function callModel(model: string, contents: string, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GeminiTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      getClient().models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: GEMINI_TEMPERATURE,
          maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          thinkingConfig: thinkingConfigFor(model),
          abortSignal: controller.signal,
        },
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function askGemini(faq: string, question: string): Promise<string> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const contents = buildContents(faq, question);

  const primary = primaryModel();
  const fallback = fallbackModel(primary);
  const attempts = fallback ? [primary, fallback] : [primary];

  try {
    for (let i = 0; i < attempts.length; i++) {
      const model = attempts[i];
      // All attempts share one overall budget of GEMINI_TIMEOUT_MS.
      const remainingMs = GEMINI_TIMEOUT_MS - elapsed();

      try {
        const response = await callModel(model, contents, remainingMs);
        const finishReason = response.candidates?.[0]?.finishReason;
        console.log("GEMINI_RESULT", {
          model,
          attempt: i + 1,
          finishReason,
          thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount,
          candidatesTokenCount: response.usageMetadata?.candidatesTokenCount,
          elapsedMs: elapsed(),
        });

        const text = cleanReply(response.text ?? "");
        if (finishReason === "MAX_TOKENS" || text === "") return DEFAULT_REPLY;
        return text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof ApiError ? err.status : undefined;
        const hasNext = i + 1 < attempts.length;
        const timeLeft = GEMINI_TIMEOUT_MS - elapsed();
        const willRetry = hasNext && isRetryable(err) && timeLeft >= GEMINI_MIN_RETRY_MS;

        console.error("GEMINI_ERROR", {
          model,
          attempt: i + 1,
          status,
          message,
          elapsedMs: elapsed(),
          retryWith: willRetry ? attempts[i + 1] : undefined,
        });
        if (!willRetry) return DEFAULT_REPLY;
      }
    }
    return DEFAULT_REPLY;
  } finally {
    // Logged on every request, success or failure.
    console.log("GEMINI_ELAPSED", { elapsedMs: elapsed() });
  }
}
