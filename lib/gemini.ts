import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  DEFAULT_REPLY,
  GEMINI_MAX_OUTPUT_TOKENS,
  GEMINI_MODEL,
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
- ถ้าไม่มีข้อมูลใน <faq> หรือไม่แน่ใจ ให้ตอบข้อความนี้ทุกตัวอักษร: "${DEFAULT_REPLY}"
- ลูกค้าอาจถามด้วยคำต่างจากใน FAQ ให้เทียบความหมาย ไม่ต้องตรงทุกคำ
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
  constructor() {
    super(`Gemini timed out after ${GEMINI_TIMEOUT_MS}ms`);
  }
}

export async function askGemini(faq: string, question: string): Promise<string> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GeminiTimeoutError());
    }, GEMINI_TIMEOUT_MS);
  });

  try {
    const response = await Promise.race([
      getClient().models.generateContent({
        model: GEMINI_MODEL,
        contents: buildContents(faq, question),
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: GEMINI_TEMPERATURE,
          maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          // FAQ lookup needs no deep reasoning: use the lowest thinking level (Gemini 3.x).
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          abortSignal: controller.signal,
        },
      }),
      timeout,
    ]);

    const finishReason = response.candidates?.[0]?.finishReason;
    console.log("GEMINI_RESULT", {
      finishReason,
      thoughtsTokenCount: response.usageMetadata?.thoughtsTokenCount,
      candidatesTokenCount: response.usageMetadata?.candidatesTokenCount,
      elapsedMs: Date.now() - startedAt,
    });

    const text = cleanReply(response.text ?? "");
    if (finishReason === "MAX_TOKENS" || text === "") return DEFAULT_REPLY;
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("GEMINI_ERROR", { message, elapsedMs: Date.now() - startedAt });
    return DEFAULT_REPLY;
  } finally {
    clearTimeout(timer);
    // Logged on every request, success or failure.
    console.log("GEMINI_ELAPSED", { elapsedMs: Date.now() - startedAt });
  }
}
