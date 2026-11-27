import { messagingApi } from "@line/bot-sdk";
import type { Readable } from "node:stream";
import {
  SLIP_DOWNLOAD_TIMEOUT_MS,
  SLIP_MAX_IMAGE_BYTES,
  SLIP_MIN_IMAGE_FALLBACK_MS,
  SLIP_QR_DECODE_BUDGET_MS,
  SLIP_TOTAL_BUDGET_MS,
  SLIP_VERIFY_TIMEOUT_MS,
} from "./constants";
import { buildSlipFlex, type CardParty, type SlipStatus } from "./slip-flex";
import { decodeQr } from "./qr";
import { EASYSLIP_VERIFY_URL, buildImageRequest, buildPayloadRequest, sniffImageType, type EasySlipRequest } from "./easyslip-request";


/**
 * What to send back for an image. `messages` is tried first; if LINE rejects it (e.g. invalid Flex),
 * the caller sends `fallbackText` as a plain text message instead.
 */
export type SlipReply = { messages: messagingApi.Message[]; fallbackText?: string };

const textMessage = (text: string): messagingApi.TextMessage => ({ type: "text", text });

export const SLIP_REPLY = {
  okShort: "ได้รับสลิปเรียบร้อยค่ะ เจ้าหน้าที่จะดำเนินการต่อให้นะคะ 🙏",
  duplicate: "สลิปนี้เคยส่งเข้ามาแล้วค่ะ รบกวนตรวจสอบอีกครั้ง หรือรอเจ้าหน้าที่ติดต่อกลับนะคะ 🙏",
  receiverMismatch: "บัญชีผู้รับในสลิปไม่ตรงกับบัญชีของร้านค่ะ รบกวนตรวจสอบอีกครั้งนะคะ 🙏",
  notFound:
    "น้องแอดมินไม่พบ QR Code ในรูปนี้ค่ะ ถ้าเป็นสลิปโอนเงิน รบกวนส่งรูปที่เห็น QR ชัด ๆ อีกครั้งนะคะ 🙏",
  pending: "สลิปธนาคารกรุงเทพที่เพิ่งโอนอาจยังตรวจไม่ได้ค่ะ รบกวนส่งใหม่อีกครั้งในอีก 5 นาทีนะคะ 🙏",
  tooLarge: "รูปนี้มีขนาดใหญ่เกินไปค่ะ (เกิน 4 MB) รบกวนส่งรูปสลิปที่ขนาดเล็กลงอีกครั้งนะคะ 🙏",
  error: "ขออภัยค่ะ ระบบตรวจสลิปขัดข้องชั่วคราว เจ้าหน้าที่จะตรวจสอบให้โดยเร็วที่สุดนะคะ 🙏",
  validation:
    "น้องแอดมินตรวจสลิปนี้อัตโนมัติไม่ได้ค่ะ รบกวนส่งรูปสลิปจากแอปธนาคารโดยตรง (ไม่ใช่ภาพแคปหน้าจอ) อีกครั้ง หรือรอเจ้าหน้าที่ตรวจสอบให้นะคะ 🙏",
  resend: "รบกวนส่งรูปสลิปอีกครั้งนะคะ 🙏",
} as const;

// ---- EasySlip v2 response types (only the fields we use) ----

type SlipParty = {
  bank?: { id?: string; name?: string; short?: string };
  account?: {
    name?: { th?: string; en?: string };
    bank?: { type?: string; account?: string };
    proxy?: { type?: string; account?: string };
  };
};

type EasySlipSuccess = {
  success: true;
  data: {
    isDuplicate: boolean;
    amountInSlip?: number;
    rawSlip: {
      transRef: string;
      date: string;
      amount?: { amount?: number };
      sender?: SlipParty;
      receiver?: SlipParty;
    };
  };
};

type EasySlipFailure = { success: false; error?: { code?: string; message?: string } };

class SlipError extends Error {
  code: string;
  httpStatus?: number;
  /** EasySlip's error.message (sanitised before logging). */
  apiMessage?: string;
  constructor(code: string, httpStatus?: number, apiMessage?: string) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
    this.apiMessage = apiMessage;
  }
}

// ---- Helpers ----

let blobClient: messagingApi.MessagingApiBlobClient | null = null;
function getBlobClient(): messagingApi.MessagingApiBlobClient {
  if (!blobClient) {
    blobClient = new messagingApi.MessagingApiBlobClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
    });
  }
  return blobClient;
}

function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SlipError(code)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Reads the LINE image into memory only (never written anywhere), stopping once it exceeds the size limit. */
async function readImage(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > SLIP_MAX_IMAGE_BYTES) {
      stream.destroy();
      throw new SlipError("IMAGE_TOO_LARGE");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// Next.js patches global fetch (caching/dedupe); call the original one for EasySlip uploads.
function rawFetch(): typeof fetch {
  const f = globalThis.fetch as typeof fetch & { _nextOriginalFetch?: typeof fetch };
  return f._nextOriginalFetch ?? f;
}

/** One EasySlip call. `timing.ms` accumulates the time spent waiting on EasySlip. */
async function postEasySlip(
  req: EasySlipRequest,
  timeoutMs: number,
  timing: { ms: number },
): Promise<EasySlipSuccess["data"]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let res: Response;
  let json: EasySlipSuccess | EasySlipFailure | null = null;
  try {
    try {
      res = await rawFetch()(EASYSLIP_VERIFY_URL, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
    } catch {
      throw new SlipError(controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR");
    }
    try {
      json = (await res.json()) as EasySlipSuccess | EasySlipFailure;
    } catch {
      if (controller.signal.aborted) throw new SlipError("TIMEOUT");
      // non-JSON body
    }
  } finally {
    clearTimeout(timer);
    timing.ms += Date.now() - startedAt;
  }
  if (!json) throw new SlipError("INVALID_RESPONSE", res.status);
  if (!json.success) throw new SlipError(json.error?.code ?? "UNKNOWN_ERROR", res.status, json.error?.message);
  return json.data;
}

/** Errors where uploading the image after a failed payload verify cannot help. */
function isFinalPayloadError(code: string): boolean {
  return code === "TIMEOUT" || code === "SLIP_PENDING" || /QUOTA|UNAUTHORI|FORBIDDEN|API_KEY|PERMISSION|LIMIT|EXPIRED/i.test(code);
}

/** EasySlip's message for logs: QR text and long digit runs (account / reference numbers) removed. */
function safeApiMessage(message: string | undefined, payload: string | null): string | undefined {
  if (!message) return undefined;
  let m = message;
  if (payload) m = m.split(payload).join("[qr]");
  return m.replace(/\d{6,}/g, "[n]").slice(0, 200);
}

// ---- Receiver check ----

/** Masked account like "xxx-x-x1234-x": compare right-aligned against the shop digits; mask chars match anything. */
function accountMatches(slipAccount: string, shopDigits: string): boolean {
  const masked = slipAccount.replace(/[^0-9xX*]/g, "").toLowerCase();
  const shop = shopDigits.replace(/\D/g, "");
  const visible = masked.replace(/\D/g, "");
  if (!shop || visible.length < 3) return false;

  // Rule 1: the visible digits equal the end of the shop digits (env holds what the slip shows).
  if (shop.endsWith(visible)) return true;

  // Rule 2: right-aligned positional match (env holds the real last digits or the full number).
  let compared = 0;
  for (let i = 1; i <= Math.min(masked.length, shop.length); i++) {
    const m = masked[masked.length - i];
    if (!/\d/.test(m)) continue;
    if (m !== shop[shop.length - i]) return false;
    compared++;
  }
  return compared >= 3;
}

const NAME_NOISE = [
  /\(มหาชน\)/g,
  /บริษัท/g,
  /บจก\.?/g,
  /หจก\.?/g,
  /จำกัด/g,
  /\bcompany\b/gi,
  /\bco\.?,?/gi,
  /\bltd\.?/gi,
  /\blimited\b/gi,
];

function normalizeName(name: string): string {
  let n = name;
  for (const re of NAME_NOISE) n = n.replace(re, "");
  return n.replace(/\s+/g, "").toLowerCase();
}

/**
 * Slip names are often truncated/masked ("ไทยแน่ x", "THAINAI***"). A visible part (3+ chars) matches if it
 * contains or is contained in the shop name. Returns 0 for no match, otherwise overlap / longer length (0..1],
 * so the shop name closest in length to what the slip shows scores highest.
 */
function nameMatchScore(slipName: string, shopName: string): number {
  const shop = normalizeName(shopName);
  if (!shop) return 0;
  const parts = normalizeName(slipName)
    .split(/\*+|x{2,}|\.+/i)
    .map((p) => p.replace(/x$/i, ""))
    .filter((p) => p.length >= 3);
  let best = 0;
  for (const p of parts) {
    if (shop.includes(p) || p.includes(shop)) {
      best = Math.max(best, Math.min(p.length, shop.length) / Math.max(p.length, shop.length));
    }
  }
  return best;
}

/** Comma-separated env list, each value trimmed, empty values dropped. A single value (no comma) is a 1-item list. */
function envList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * matched: true/false = checked; null = skipped because no shop env is configured.
 * matchedBy/matchedIndex: which list matched and the 0-based position of the value in it (no names/numbers).
 */
type ReceiverCheck = { matched: boolean | null; matchedBy?: "account" | "name"; matchedIndex?: number };

function checkReceiver(receiver: SlipParty | undefined): ReceiverCheck {
  const shopDigitsList = envList("SHOP_ACCOUNT_LAST_DIGITS");
  const shopNameList = envList("SHOP_ACCOUNT_NAME");
  if (shopDigitsList.length === 0 && shopNameList.length === 0) {
    console.warn("SLIP_RECEIVER_CHECK_SKIPPED", { reason: "SHOP_ACCOUNT_LAST_DIGITS and SHOP_ACCOUNT_NAME not set" });
    return { matched: null };
  }

  const account = receiver?.account;
  const slipAccount = account?.bank?.account;
  if (slipAccount) {
    const i = shopDigitsList.findIndex((digits) => accountMatches(slipAccount, digits));
    if (i >= 0) return { matched: true, matchedBy: "account", matchedIndex: i };
  }

  // Names can overlap (e.g. "ไทยแน่" vs "ไทยแน่ เทรดดิ้ง"): pick the shop name with the best match score.
  const names = [account?.name?.th, account?.name?.en].filter((n): n is string => Boolean(n));
  let best = -1;
  let bestScore = 0;
  shopNameList.forEach((shopName, idx) => {
    const score = Math.max(0, ...names.map((n) => nameMatchScore(n, shopName)));
    if (score > bestScore) {
      best = idx;
      bestScore = score;
    }
  });
  if (best >= 0) return { matched: true, matchedBy: "name", matchedIndex: best };

  return { matched: false };
}

// ---- Formatting ----

/** Thai date in Bangkok time: "25 พ.ย. 2569 10:43", or with shortYear "25 พ.ย. 69 10:43". */
function formatThaiDate(iso: string, shortYear = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "-";
  return d.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: shortYear ? "2-digit" : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Card view of a party: bank short code, name and the account number exactly as EasySlip returns it (masked). */
function toCardParty(p: SlipParty | undefined): CardParty {
  return {
    bankShort: p?.bank?.short,
    name: p?.account?.name?.th || p?.account?.name?.en,
    account: p?.account?.bank?.account || p?.account?.proxy?.account,
  };
}

function formatAmount(amount: number | undefined): string {
  if (typeof amount !== "number") return "-";
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- Main ----

export type SlipContext = {
  /** LINE source.type: "user" (1:1), "group" or "room". Logged; never the group/user id. */
  sourceType: string;
};

/**
 * Verifies a LINE image message as a bank transfer slip.
 * 1:1 chat: verified results (ok / duplicate / receiver mismatch) reply with a Flex card plus a short text;
 * errors reply with plain text only.
 * Group/room: the Flex card only (no short text), and a non-slip image (SLIP_NOT_FOUND) gets no reply (null).
 */
export async function checkSlip(
  messageId: string,
  contentProviderType: string,
  ctx: SlipContext = { sourceType: "user" },
): Promise<SlipReply | null> {
  const reply = await checkSlipInner(messageId, contentProviderType, ctx);
  if (reply === null) return null;
  return typeof reply === "string" ? { messages: [textMessage(reply)] } : reply;
}

async function checkSlipInner(
  messageId: string,
  contentProviderType: string,
  ctx: SlipContext,
): Promise<SlipReply | string | null> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const { sourceType } = ctx;
  const inGroup = sourceType === "group" || sourceType === "room";

  const apiKey = process.env.EASYSLIP_API_KEY?.trim();
  if (!apiKey) {
    console.error("SLIP_DISABLED", { reason: "EASYSLIP_API_KEY not set", sourceType });
    return SLIP_REPLY.error;
  }

  // Diagnostics for SLIP_RESULT / SLIP_ERROR (never the QR text, names or account numbers).
  const diag: {
    method?: "payload" | "image";
    payloadLength?: number;
    qrDecodeMs?: number;
    qrAttempt?: string | null;
    imageBytes?: number;
    contentType?: string;
    payloadErrorCode?: string;
  } = {};
  const easyslip = { ms: 0 }; // total time waiting on EasySlip
  let qrPayload: string | null = null;
  const remaining = () => SLIP_TOTAL_BUDGET_MS - elapsed();
  const timings = () => ({ easyslipMs: easyslip.ms, totalMs: elapsed() });

  try {
    if (contentProviderType !== "line") throw new SlipError("UNSUPPORTED_CONTENT_PROVIDER");

    // The original LINE bytes: sent as-is for the image upload (sharp only reads a copy for the QR).
    const image = await withTimeout(
      getBlobClient().getMessageContent(messageId).then(readImage),
      Math.min(SLIP_DOWNLOAD_TIMEOUT_MS, remaining()),
      "LINE_DOWNLOAD_TIMEOUT",
    );
    diag.imageBytes = image.length;
    diag.contentType = sniffImageType(image).mime;

    // 1) Read the QR ourselves (own time budget, separate from the EasySlip timeout).
    const qr = await decodeQr(image, SLIP_QR_DECODE_BUDGET_MS);
    diag.qrDecodeMs = qr.ms;
    diag.qrAttempt = qr.attempt;
    const payloadReq = buildPayloadRequest(qr.payload, apiKey); // null if no QR / blank QR text
    qrPayload = payloadReq ? (qr.payload as string).trim() : null;

    // Each EasySlip call may wait up to SLIP_VERIFY_TIMEOUT_MS (>= 10s), within the overall budget.
    const verifyTimeout = () => {
      const ms = Math.min(SLIP_VERIFY_TIMEOUT_MS, remaining());
      if (ms <= 0) throw new SlipError("TIMEOUT");
      return ms;
    };
    const sendImage = () => {
      diag.method = "image";
      return postEasySlip(buildImageRequest(image, apiKey), verifyTimeout(), easyslip);
    };

    let data: EasySlipSuccess["data"];
    if (payloadReq && qrPayload) {
      diag.method = "payload";
      diag.payloadLength = qrPayload.length;
      try {
        data = await postEasySlip(payloadReq, verifyTimeout(), easyslip);
      } catch (err) {
        // 2) Payload rejected (e.g. not a slip QR): upload the image, but only if a full
        //    EasySlip wait still fits. A payload TIMEOUT never falls back.
        const code = err instanceof SlipError ? err.code : "UNEXPECTED_ERROR";
        if (isFinalPayloadError(code) || remaining() < SLIP_MIN_IMAGE_FALLBACK_MS) throw err;
        diag.payloadErrorCode = code;
        data = await sendImage();
      }
    } else {
      data = await sendImage();
    }

    const receiverCheck = data.isDuplicate ? undefined : checkReceiver(data.rawSlip.receiver);
    const receiverMatched = receiverCheck?.matched;
    const amount = data.amountInSlip ?? data.rawSlip.amount?.amount;
    console.log("SLIP_RESULT", {
      isDuplicate: data.isDuplicate,
      amountInSlip: amount,
      transRef: data.rawSlip.transRef,
      receiverMatched,
      matchedBy: receiverCheck?.matchedBy,
      matchedIndex: receiverCheck?.matchedIndex,
      ...diag,
      sourceType,
      ...timings(),
    });

    const status: SlipStatus = data.isDuplicate
      ? "duplicate"
      : receiverMatched === false
        ? "receiverMismatch"
        : "ok";

    const plainText = {
      duplicate: SLIP_REPLY.duplicate,
      receiverMismatch: SLIP_REPLY.receiverMismatch,
      ok:
        `ได้รับสลิปเรียบร้อยค่ะ ✅ ยอด ${formatAmount(amount)} บาท วันที่ ${formatThaiDate(data.rawSlip.date)} ` +
        `เลขอ้างอิง ${data.rawSlip.transRef}\nเจ้าหน้าที่จะดำเนินการต่อให้นะคะ`,
    }[status];

    const flex = buildSlipFlex({
      status,
      amountText: formatAmount(amount),
      dateText: formatThaiDate(data.rawSlip.date, true),
      transRef: data.rawSlip.transRef || "-",
      sender: toCardParty(data.rawSlip.sender),
      receiver: toCardParty(data.rawSlip.receiver),
    });
    // In groups the card alone is enough; 1:1 chats also get the short text.
    if (inGroup) return { messages: [flex], fallbackText: plainText };

    const shortText = status === "ok" ? SLIP_REPLY.okShort : plainText;
    return { messages: [flex, textMessage(shortText)], fallbackText: plainText };
  } catch (err) {
    const code = err instanceof SlipError ? err.code : "UNEXPECTED_ERROR";
    const httpStatus = err instanceof SlipError ? err.httpStatus : (err as { status?: number })?.status;
    console.error("SLIP_ERROR", {
      code,
      httpStatus,
      easyslipMessage: err instanceof SlipError ? safeApiMessage(err.apiMessage, qrPayload) : undefined,
      ...diag,
      sourceType,
      ...timings(),
    });

    switch (code) {
      case "IMAGE_TOO_LARGE":
      case "IMAGE_SIZE_TOO_LARGE":
        return SLIP_REPLY.tooLarge;
      case "VALIDATION_ERROR":
        // Payload and/or image were both tried and rejected.
        return SLIP_REPLY.validation;
      case "LINE_DOWNLOAD_TIMEOUT":
        return SLIP_REPLY.resend;
      case "SLIP_NOT_FOUND":
        // A normal photo in a group: stay silent so the group isn't spammed.
        return inGroup ? null : SLIP_REPLY.notFound;
      case "SLIP_PENDING":
        return SLIP_REPLY.pending;
      default:
        return SLIP_REPLY.error;
    }
  }
}
