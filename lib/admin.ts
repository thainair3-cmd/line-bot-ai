// Admin group (quote stage 3): setup, sending quote requests to the group, discounts, price
// edits, choosing the issuing company, approval with a BQ number, and rejection.
// Storage and LINE push are injected (AdminDeps), so tests run with an in-memory store.
// Imports use .ts extensions so `node --test` can load this file without a bundler.
import { timingSafeEqual } from "node:crypto";
import { calcQuote, formatBaht, formatQuantity, formatSatang } from "./pricing.ts";
import type { IssuerKey, QuoteItem, QuoteRequest } from "./checkout.ts";

// ---- Issuing companies ----

export const ISSUERS: Record<IssuerKey, { label: string; aliases: RegExp }> = {
  wujin: { label: "วู่จิน", aliases: /วู่?จิน|wu\s*jin/i },
  kreungyen: { label: "เครื่องเย็น", aliases: /เครื่องเย็น|kreung\s*yen/i },
};

export function parseIssuer(text: string): IssuerKey | null {
  for (const key of Object.keys(ISSUERS) as IssuerKey[]) if (ISSUERS[key].aliases.test(text)) return key;
  return null;
}

/** Terms printed on every quote (stage 4 PDF). */
export const QUOTE_TERMS = { validityDays: 3, payment: "เงินสด" } as const;

// ---- Storage / LINE interface ----

export type ApprovedQuote = {
  quoteNo: string; // BQ6911-0001
  requestId: string;
  shortId: number;
  userId: string;
  issuer: IssuerKey;
  issuerLabel: string;
  customer: QuoteRequest["customer"];
  items: (QuoteItem & { discountPercent: number; lineTotal: number })[];
  subtotal: number; // baht
  vat: number;
  total: number;
  reference: string;
  quoteDate: string; // YYYY-MM-DD, Bangkok
  validityDays: number;
  payment: string;
  approvedAt: string; // ISO
};

export interface AdminStore {
  getAdminGroup(): Promise<string | null>;
  setAdminGroup(groupId: string): Promise<void>;
  /** Pending requests, oldest first. */
  listPending(): Promise<QuoteRequest[]>;
  getByShortId(shortId: number): Promise<QuoteRequest | null>;
  /** Gives the request a short id if it has none (requests from before stage 3) and saves it. */
  ensureShortId(req: QuoteRequest): Promise<QuoteRequest>;
  saveRequest(req: QuoteRequest): Promise<void>;
  removePending(requestId: string): Promise<void>;
  /** Atomic counter (Redis INCR) for the BQ sequence of a yymm prefix. */
  nextQuoteSeq(yymm: string): Promise<number>;
  saveApproved(q: ApprovedQuote): Promise<void>;
}

export type AdminDeps = {
  store: AdminStore;
  /** LINE push (to a group or a user). Must not throw. */
  push: (to: string, messages: string[]) => Promise<void>;
  setupCode: string | undefined; // env ADMIN_SETUP_CODE
  now?: () => Date;
};

// ---- Text helpers ----

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";
export const toArabicDigits = (s: string) => s.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));

const MAX_LINE_TEXT = 5_000;

/** Splits long text into LINE-sized messages on line breaks (max 5 per reply/push). */
export function chunkText(text: string, max = MAX_LINE_TEXT): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > max && cur) {
      out.push(cur);
      cur = line.slice(0, max);
    } else cur = next.slice(0, max);
  }
  if (cur) out.push(cur);
  return out.slice(0, 5);
}

// ---- Draft calculation (code only, never Gemini) ----

export function calcDraft(items: QuoteItem[]) {
  const q = calcQuote(items.map((i) => ({ unitPrice: i.unitPrice, quantity: i.quantity, discountPercent: i.discountPercent ?? 0 })));
  return q; // satang
}

function withTotals(req: QuoteRequest): QuoteRequest {
  const q = calcDraft(req.items);
  return { ...req, subtotal: q.subtotal / 100, vat: q.vat / 100, total: q.total / 100 };
}

function formatItems(items: QuoteItem[]): string[] {
  const q = calcDraft(items);
  return items.map((i, k) => {
    const unit = i.unit ? ` ${i.unit}` : "";
    const disc = i.discountPercent ? ` ลด ${formatQuantity(i.discountPercent)}%` : "";
    const changed = i.listPrice !== undefined && i.listPrice !== i.unitPrice ? ` (เดิม ${formatBaht(i.listPrice)})` : "";
    return `${k + 1}. ${i.name}\n   ${formatQuantity(i.quantity)}${unit} × ${formatBaht(i.unitPrice)}${changed}${disc} = ${formatSatang(q.lineTotals[k])}`;
  });
}

function formatTotals(items: QuoteItem[]): string[] {
  const q = calcDraft(items);
  return [`รวมเป็นเงิน ${formatSatang(q.subtotal)} บาท`, `VAT 7% ${formatSatang(q.vat)} บาท`, `รวมทั้งสิ้น ${formatSatang(q.total)} บาท`];
}

const companyLine = (c: QuoteRequest["customer"]) => `${c.companyName}${c.branch ? ` (${c.branch})` : ""}`;

/** Full draft for the admin group (customer details may be shown there). */
export function formatDraft(req: QuoteRequest): string {
  const id = req.shortId ?? "?";
  const c = req.customer;
  return [
    `📋 คำขอใบเสนอราคา #${id}`,
    `ลูกค้า: ${companyLine(c)}`,
    `ที่อยู่: ${c.address}`,
    `โทร: ${c.phone}`,
    `บริษัทผู้ออกใบ: ${req.issuer ? ISSUERS[req.issuer].label : "ยังไม่เลือก"}`,
    `อ้างอิง: ${req.reference || "-"}`,
    "",
    ...formatItems(req.items),
    "",
    ...formatTotals(req.items),
    "",
    `คำสั่ง: ส่วนลด #${id} 1-2=10% | ราคา #${id} 1=1200 | บริษัท #${id} วู่จิน หรือ เครื่องเย็น | อ้างอิง #${id} ข้อความ | อนุมัติ #${id} | ยกเลิก #${id}`,
  ].join("\n");
}

/** Message to the customer after approval (stage 4 will add the PDF link). */
export function formatCustomerApproval(q: ApprovedQuote): string {
  return [
    `ใบเสนอราคาเลขที่ ${q.quoteNo} ค่ะ`,
    "",
    ...formatItems(q.items),
    "",
    ...formatTotals(q.items),
    "",
    "ไฟล์ใบเสนอราคาจะส่งตามมาค่ะ",
  ].join("\n");
}

// ---- BQ number ----

/** BQ{yy}{mm}: Thai Buddhist year (2 digits) and month in Bangkok time. Nov 2026 -> "6911". */
export function quoteYYMM(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value) + 543;
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${String(year % 100).padStart(2, "0")}${month}`;
}

export const formatQuoteNo = (yymm: string, seq: number) => `BQ${yymm}-${String(seq).padStart(4, "0")}`;

function bangkokDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(now); // YYYY-MM-DD
}

// ---- Commands ----

export const HELP = [
  "คำสั่งกลุ่มแอดมิน:",
  "รายการรอ",
  "ดู #12",
  "ส่วนลด #12 1-2=23% 3=43%  หรือ  ส่วนลด #12 ทั้งหมด=20%",
  "ราคา #12 3=1200",
  "บริษัท #12 วู่จิน  หรือ  บริษัท #12 เครื่องเย็น",
  "อ้างอิง #12 ข้อความ",
  "อนุมัติ #12",
  "ยกเลิก #12",
].join("\n");

const SETUP_RE = /^ตั้งเป็นกลุ่มแอดมิน\s*(\S+)\s*$/;
const COMMAND_RE = /^(รายการรอ|ดู|ส่วนลด|ราคา|บริษัท|อ้างอิง|อนุมัติ|ยกเลิก)\s*([\s\S]*)$/;
const ID_RE = /^#?\s*(\d+)\s*([\s\S]*)$/;

function codeMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** "1-2=23% 3=43%" -> [{from:1,to:2,value:23},{from:3,to:3,value:43}]; "ทั้งหมด=20%" -> all lines. */
function parseLineValues(spec: string, lineCount: number, kind: "percent" | "price"): { line: number; value: number }[] | null {
  const s = spec.replace(/,(?=\d{3}(?!\d))/g, ""); // 1,200 -> 1200
  const re = /(ทั้งหมด|\d+(?:\s*-\s*\d+)?)\s*=\s*(\d+(?:\.\d+)?)\s*(%?)/g;
  const out: { line: number; value: number }[] = [];
  for (const m of s.matchAll(re)) {
    const value = Number(m[2]);
    if (kind === "percent" && (value < 0 || value > 100)) return null;
    if (kind === "price" && m[3]) return null;
    let from = 1;
    let to = lineCount;
    if (m[1] !== "ทั้งหมด") {
      const [a, b] = m[1].split("-").map((x) => Number(x.trim()));
      from = a;
      to = b ?? a;
    }
    if (from < 1 || to > lineCount || from > to) return null;
    for (let line = from; line <= to; line++) out.push({ line, value });
  }
  // Everything except separators must have been understood.
  const leftover = s.replace(re, "").replace(/[\s,]/g, "");
  if (out.length === 0 || leftover) return null;
  return out;
}

export type AdminResult = {
  /** true = the bot owns this message (setup command or admin group): never fall back to Gemini. */
  handled: boolean;
  /** Reply in the group (empty = stay silent). */
  messages: string[];
};

const silent: AdminResult = { handled: true, messages: [] };
const notMine: AdminResult = { handled: false, messages: [] };

/** Pushes a pending request's draft into the admin group (if one is set). */
export async function sendDraftToAdminGroup(req: QuoteRequest, deps: AdminDeps): Promise<boolean> {
  const groupId = await deps.store.getAdminGroup();
  if (!groupId) return false; // stays in quote:pending until a group is set
  await deps.push(groupId, chunkText(formatDraft(withTotals(req))));
  console.log("QUOTE_DRAFT_SENT", { shortId: req.shortId, itemCount: req.items.length });
  return true;
}

/**
 * A text message in a LINE group. Handles "ตั้งเป็นกลุ่มแอดมิน <code>" in any group and the
 * admin commands in the admin group. Wrong/missing code: silent.
 */
export async function handleGroupText(text: string, groupId: string | undefined, deps: AdminDeps): Promise<AdminResult> {
  const t = toArabicDigits(text.trim());
  const now = deps.now?.() ?? new Date();

  const setup = SETUP_RE.exec(t);
  if (setup) {
    const expected = deps.setupCode?.trim();
    if (!groupId || !expected || !codeMatches(setup[1], expected)) return silent;
    await deps.store.setAdminGroup(groupId);
    console.log("ADMIN_GROUP_SET", {});
    // Requests created before the group existed are sent now.
    for (const req of await deps.store.listPending()) {
      await sendDraftToAdminGroup(await deps.store.ensureShortId(req), deps);
    }
    return { handled: true, messages: ["ตั้งเป็นกลุ่มแอดมินเรียบร้อยค่ะ"] };
  }

  const adminGroup = await deps.store.getAdminGroup();
  if (!groupId || adminGroup !== groupId) return notMine;

  // Admin group: only commands get a reply; any other text is ignored.
  const cmd = COMMAND_RE.exec(t);
  if (!cmd) return silent;
  const [, name, rest] = cmd;

  if (name === "รายการรอ") {
    const pending = await deps.store.listPending();
    if (pending.length === 0) return { handled: true, messages: ["ไม่มีคำขอที่รออนุมัติค่ะ"] };
    const lines = pending.map((r0) => {
      const r = withTotals(r0);
      const issuer = r.issuer ? ISSUERS[r.issuer].label : "ยังไม่เลือกบริษัท";
      return `#${r.shortId ?? "?"} ${companyLine(r.customer)} · ${r.items.length} รายการ · ${formatBaht(r.total)} บาท · ${issuer}`;
    });
    return { handled: true, messages: chunkText([`คำขอที่รออนุมัติ ${pending.length} รายการ`, ...lines].join("\n")) };
  }

  const idm = ID_RE.exec(rest.trim());
  if (!idm) return { handled: true, messages: [HELP] };
  const shortId = Number(idm[1]);
  const args = idm[2].trim();
  const found = await deps.store.getByShortId(shortId);
  if (!found) return { handled: true, messages: [`ไม่พบคำขอ #${shortId} ค่ะ`] };
  if (found.status !== "pending") {
    const state = found.status === "approved" ? `อนุมัติแล้ว (${found.quoteNo})` : "ยกเลิกแล้ว";
    return { handled: true, messages: [`คำขอ #${shortId} ${state}ค่ะ`] };
  }
  let req = withTotals(found);

  const saveAndShow = async (next: QuoteRequest): Promise<AdminResult> => {
    const updated = withTotals(next);
    await deps.store.saveRequest(updated);
    return { handled: true, messages: chunkText(formatDraft(updated)) };
  };

  switch (name) {
    case "ดู":
      return { handled: true, messages: chunkText(formatDraft(req)) };

    case "ส่วนลด": {
      const values = parseLineValues(args, req.items.length, "percent");
      if (!values) return { handled: true, messages: [`รูปแบบไม่ถูกต้องค่ะ ตัวอย่าง: ส่วนลด #${shortId} 1-2=23% 3=43% หรือ ส่วนลด #${shortId} ทั้งหมด=20%`] };
      const items = req.items.map((i) => ({ ...i }));
      for (const v of values) items[v.line - 1].discountPercent = v.value;
      return saveAndShow({ ...req, items });
    }

    case "ราคา": {
      const values = parseLineValues(args, req.items.length, "price");
      if (!values) return { handled: true, messages: [`รูปแบบไม่ถูกต้องค่ะ ตัวอย่าง: ราคา #${shortId} 3=1200 (ราคาต่อหน่วยก่อน VAT)`] };
      const items = req.items.map((i) => ({ ...i }));
      for (const v of values) {
        const item = items[v.line - 1];
        if (item.listPrice === undefined) item.listPrice = item.unitPrice;
        item.unitPrice = v.value;
      }
      return saveAndShow({ ...req, items });
    }

    case "บริษัท": {
      const issuer = parseIssuer(args);
      if (!issuer) return { handled: true, messages: [`รูปแบบไม่ถูกต้องค่ะ ตัวอย่าง: บริษัท #${shortId} วู่จิน หรือ บริษัท #${shortId} เครื่องเย็น`] };
      return saveAndShow({ ...req, issuer });
    }

    case "อ้างอิง": {
      if (!args) return { handled: true, messages: [`รูปแบบไม่ถูกต้องค่ะ ตัวอย่าง: อ้างอิง #${shortId} PO-1234 (พิมพ์ - เพื่อลบ)`] };
      return saveAndShow({ ...req, reference: args === "-" ? "" : args.slice(0, 200) });
    }

    case "ยกเลิก": {
      await deps.store.saveRequest({ ...req, status: "rejected", rejectedAt: now.toISOString() });
      await deps.store.removePending(req.requestId);
      console.log("QUOTE_REJECTED", { shortId });
      return { handled: true, messages: [`ยกเลิกคำขอ #${shortId} แล้วค่ะ`] };
    }

    case "อนุมัติ": {
      if (!req.issuer) {
        return { handled: true, messages: [`ยังไม่ได้เลือกบริษัทผู้ออกใบค่ะ พิมพ์ "บริษัท #${shortId} วู่จิน" หรือ "บริษัท #${shortId} เครื่องเย็น" ก่อนอนุมัตินะคะ`] };
      }
      const yymm = quoteYYMM(now);
      const quoteNo = formatQuoteNo(yymm, await deps.store.nextQuoteSeq(yymm));
      const q = calcDraft(req.items);
      const approved: ApprovedQuote = {
        quoteNo,
        requestId: req.requestId,
        shortId,
        userId: req.userId,
        issuer: req.issuer,
        issuerLabel: ISSUERS[req.issuer].label,
        customer: req.customer,
        items: req.items.map((i, k) => ({ ...i, discountPercent: i.discountPercent ?? 0, lineTotal: q.lineTotals[k] / 100 })),
        subtotal: q.subtotal / 100,
        vat: q.vat / 100,
        total: q.total / 100,
        reference: req.reference ?? "",
        quoteDate: bangkokDate(now),
        validityDays: QUOTE_TERMS.validityDays,
        payment: QUOTE_TERMS.payment,
        approvedAt: now.toISOString(),
      };
      await deps.store.saveApproved(approved);
      req = { ...req, status: "approved", quoteNo, approvedAt: approved.approvedAt };
      await deps.store.saveRequest(req);
      await deps.store.removePending(req.requestId);
      console.log("QUOTE_APPROVED", { quoteNo, itemCount: approved.items.length, total: approved.total });
      await deps.push(req.userId, chunkText(formatCustomerApproval(approved)));
      return { handled: true, messages: [`อนุมัติ ${quoteNo} แล้วค่ะ`] };
    }
  }
  return { handled: true, messages: [HELP] };
}
