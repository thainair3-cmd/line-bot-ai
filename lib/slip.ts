import { messagingApi } from "@line/bot-sdk";
import type { Readable } from "node:stream";
import {
  SLIP_DOWNLOAD_TIMEOUT_MS,
  SLIP_MAX_IMAGE_BYTES,
  SLIP_TOTAL_BUDGET_MS,
  SLIP_VERIFY_TIMEOUT_MS,
} from "./constants";

const EASYSLIP_VERIFY_URL = "https://api.easyslip.com/v2/verify/bank";

export const SLIP_REPLY = {
  duplicate: "สลิปนี้เคยส่งเข้ามาแล้วค่ะ รบกวนตรวจสอบอีกครั้ง หรือรอเจ้าหน้าที่ติดต่อกลับนะคะ 🙏",
  receiverMismatch: "บัญชีผู้รับในสลิปไม่ตรงกับบัญชีของร้านค่ะ รบกวนตรวจสอบอีกครั้งนะคะ 🙏",
  notFound:
    "น้องแอดมินไม่พบ QR Code ในรูปนี้ค่ะ ถ้าเป็นสลิปโอนเงิน รบกวนส่งรูปที่เห็น QR ชัด ๆ อีกครั้งนะคะ 🙏",
  pending: "สลิปธนาคารกรุงเทพที่เพิ่งโอนอาจยังตรวจไม่ได้ค่ะ รบกวนส่งใหม่อีกครั้งในอีก 5 นาทีนะคะ 🙏",
  tooLarge: "รูปนี้มีขนาดใหญ่เกินไปค่ะ (เกิน 4 MB) รบกวนส่งรูปสลิปที่ขนาดเล็กลงอีกครั้งนะคะ 🙏",
  error: "ขออภัยค่ะ ระบบตรวจสลิปขัดข้องชั่วคราว เจ้าหน้าที่จะตรวจสอบให้โดยเร็วที่สุดนะคะ 🙏",
} as const;

// ---- EasySlip v2 response types (only the fields we use) ----

type SlipParty = {
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
      receiver?: SlipParty;
    };
  };
};

type EasySlipFailure = { success: false; error?: { code?: string; message?: string } };

class SlipError extends Error {
  code: string;
  httpStatus?: number;
  constructor(code: string, httpStatus?: number) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
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

function sniffImageType(buf: Buffer): { mime: string; ext: string } {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { mime: "image/png", ext: "png" };
  if (buf[0] === 0x47 && buf[1] === 0x49) return { mime: "image/gif", ext: "gif" };
  if (buf.subarray(8, 12).toString("ascii") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return { mime: "image/jpeg", ext: "jpg" };
}

async function verifyWithEasySlip(image: Buffer, apiKey: string, timeoutMs: number): Promise<EasySlipSuccess["data"]> {
  const { mime, ext } = sniffImageType(image);
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(image)], { type: mime }), `slip.${ext}`);
  form.append("checkDuplicate", "true");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(EASYSLIP_VERIFY_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    throw new SlipError(controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
  }

  let json: EasySlipSuccess | EasySlipFailure | null = null;
  try {
    json = (await res.json()) as EasySlipSuccess | EasySlipFailure;
  } catch {
    // non-JSON body
  }
  if (!json) throw new SlipError("INVALID_RESPONSE", res.status);
  if (!json.success) throw new SlipError(json.error?.code ?? "UNKNOWN_ERROR", res.status);
  return json.data;
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

/** Slip names are often truncated/masked ("ไทยแน่ x", "THAINAI***"); match if any visible part overlaps the shop name. */
function nameMatches(slipName: string, shopName: string): boolean {
  const shop = normalizeName(shopName);
  if (!shop) return false;
  const parts = normalizeName(slipName)
    .split(/\*+|x{2,}|\.+/i)
    .map((p) => p.replace(/x$/i, ""))
    .filter((p) => p.length >= 3);
  return parts.some((p) => shop.includes(p) || p.includes(shop));
}

/** true/false = checked; null = skipped because no shop env is configured. */
function checkReceiver(receiver: SlipParty | undefined): boolean | null {
  const shopDigits = process.env.SHOP_ACCOUNT_LAST_DIGITS?.trim();
  const shopName = process.env.SHOP_ACCOUNT_NAME?.trim();
  if (!shopDigits && !shopName) {
    console.warn("SLIP_RECEIVER_CHECK_SKIPPED", { reason: "SHOP_ACCOUNT_LAST_DIGITS and SHOP_ACCOUNT_NAME not set" });
    return null;
  }

  const account = receiver?.account;
  const slipAccount = account?.bank?.account;
  if (shopDigits && slipAccount && accountMatches(slipAccount, shopDigits)) return true;

  if (shopName) {
    const names = [account?.name?.th, account?.name?.en].filter((n): n is string => Boolean(n));
    if (names.some((n) => nameMatches(n, shopName))) return true;
  }
  return false;
}

// ---- Formatting ----

function formatThaiDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAmount(amount: number | undefined): string {
  if (typeof amount !== "number") return "-";
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- Main ----

/** Verifies a LINE image message as a bank transfer slip and returns the reply text for the customer. */
export async function checkSlip(messageId: string, contentProviderType: string): Promise<string> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const apiKey = process.env.EASYSLIP_API_KEY?.trim();
  if (!apiKey) {
    console.error("SLIP_DISABLED", { reason: "EASYSLIP_API_KEY not set" });
    return SLIP_REPLY.error;
  }

  try {
    if (contentProviderType !== "line") throw new SlipError("UNSUPPORTED_CONTENT_PROVIDER");

    const image = await withTimeout(
      getBlobClient().getMessageContent(messageId).then(readImage),
      SLIP_DOWNLOAD_TIMEOUT_MS,
      "LINE_DOWNLOAD_TIMEOUT",
    );

    // EasySlip gets up to 7s, but never past the overall budget.
    const verifyTimeout = Math.min(SLIP_VERIFY_TIMEOUT_MS, SLIP_TOTAL_BUDGET_MS - elapsed());
    if (verifyTimeout <= 0) throw new SlipError("TIMEOUT");
    const data = await verifyWithEasySlip(image, apiKey, verifyTimeout);

    const receiverMatched = data.isDuplicate ? undefined : checkReceiver(data.rawSlip.receiver);
    const amount = data.amountInSlip ?? data.rawSlip.amount?.amount;
    console.log("SLIP_RESULT", {
      isDuplicate: data.isDuplicate,
      amountInSlip: amount,
      transRef: data.rawSlip.transRef,
      receiverMatched,
      elapsedMs: elapsed(),
    });

    if (data.isDuplicate) return SLIP_REPLY.duplicate;
    if (receiverMatched === false) return SLIP_REPLY.receiverMismatch;
    return (
      `ได้รับสลิปเรียบร้อยค่ะ ✅ ยอด ${formatAmount(amount)} บาท วันที่ ${formatThaiDate(data.rawSlip.date)} ` +
      `เลขอ้างอิง ${data.rawSlip.transRef}\nเจ้าหน้าที่จะดำเนินการต่อให้นะคะ`
    );
  } catch (err) {
    const code = err instanceof SlipError ? err.code : "UNEXPECTED_ERROR";
    const httpStatus = err instanceof SlipError ? err.httpStatus : (err as { status?: number })?.status;
    console.error("SLIP_ERROR", { code, httpStatus, elapsedMs: elapsed() });

    switch (code) {
      case "IMAGE_TOO_LARGE":
      case "IMAGE_SIZE_TOO_LARGE":
        return SLIP_REPLY.tooLarge;
      case "SLIP_NOT_FOUND":
        return SLIP_REPLY.notFound;
      case "SLIP_PENDING":
        return SLIP_REPLY.pending;
      default:
        return SLIP_REPLY.error;
    }
  }
}
