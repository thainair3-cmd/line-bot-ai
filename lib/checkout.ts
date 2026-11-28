// Quote checkout (1:1 chat): collect the customer's company details, confirm, then create a
// pending quote request. Pure decisions only (no Redis / Gemini), so tests can drive it.
// Imports use .ts extensions so `node --test` can load this file without a bundler.
import { calcQuote } from "./pricing.ts";
import { formatSummary, type Cart } from "./cart-ops.ts";

export type Customer = {
  companyName: string;
  branch: string; // "สำนักงานใหญ่" or "สาขา ..."
  address: string;
  phone: string;
};
export type CustomerDraft = Partial<Customer>;

/**
 * collecting: waiting for the company details; useExisting: asked "use the saved details?";
 * confirm: details complete, waiting for "ยืนยัน". purpose "edit" = "แก้ข้อมูลบริษัท" (save only).
 */
export type CheckoutState = {
  stage: "collecting" | "useExisting" | "confirm";
  purpose: "quote" | "edit";
  draft: CustomerDraft;
};

export type QuoteItem = {
  code: string;
  name: string;
  unit: string;
  quantity: number;
  unitPrice: number; // before VAT; the admin may change it ("ราคา #12 3=1200")
  listPrice?: number; // the sheet price, kept when the admin changes unitPrice
  discountPercent?: number; // set by the admin ("ส่วนลด #12 1-2=23%")
};

export type IssuerKey = "wujin" | "kreungyen";

export type QuoteRequest = {
  requestId: string;
  /** Short number for admin commands (#1, #2, ...), assigned when the request is queued. */
  shortId?: number;
  status: "pending" | "approved" | "rejected";
  userId: string;
  customer: Customer;
  items: QuoteItem[];
  subtotal: number; // baht, before VAT (recomputed by the admin draft)
  vat: number;
  total: number;
  createdAt: string; // ISO
  issuer?: IssuerKey; // company issuing the quote; required before approval
  reference?: string;
  quoteNo?: string; // BQyymm-nnnn, set on approval
  approvedAt?: string;
  rejectedAt?: string;
};

/** What chat.ts must do after a checkout step. */
export type CheckoutStep = {
  /** true: the message is not part of checkout; handle it as a normal chat message (state kept). */
  passThrough: boolean;
  messages: string[];
  /** New checkout state; null = checkout finished or cancelled; undefined = unchanged. */
  state?: CheckoutState | null;
  saveCustomer?: { customer: Customer; isNew: boolean };
  quote?: QuoteRequest;
  clearCart?: boolean;
};

export const FIELD_LABELS: Record<keyof Customer, string> = {
  companyName: "ชื่อบริษัท",
  branch: "สำนักงานใหญ่หรือสาขา",
  address: "ที่อยู่",
  phone: "เบอร์โทร",
};
const FIELDS = Object.keys(FIELD_LABELS) as (keyof Customer)[];

export const CHECKOUT_REPLY = {
  emptyCart:
    'ตอนนี้ยังไม่มีรายการสินค้าในตะกร้าค่ะ รบกวนแจ้งสินค้าและจำนวนที่ต้องการก่อน เช่น "L 1/2 10 เส้น" นะคะ',
  askInfo:
    "รบกวนแจ้งข้อมูลสำหรับออกใบเสนอราคาค่ะ\n1. ชื่อบริษัท (ระบุสำนักงานใหญ่หรือสาขา)\n2. ที่อยู่\n3. เบอร์โทร",
  askEdit:
    "รบกวนพิมพ์ข้อมูลที่ต้องการแก้ไขได้เลยค่ะ (ส่งเฉพาะข้อที่แก้ก็ได้)\n1. ชื่อบริษัท (ระบุสำนักงานใหญ่หรือสาขา)\n2. ที่อยู่\n3. เบอร์โทร",
  useExistingQuestion: "ใช้ข้อมูลนี้ออกใบเสนอราคาไหมคะ (ใช่ / แก้ไข)",
  confirmQuestion: 'ถ้าข้อมูลถูกต้อง พิมพ์ "ยืนยัน" หรือพิมพ์ "แก้ไข" เพื่อแก้ข้อมูลนะคะ',
  requested: "รับคำขอใบเสนอราคาเรียบร้อยค่ะ แอดมินจะตรวจสอบราคาและส่งใบเสนอราคาให้โดยเร็วที่สุดนะคะ 🙏",
  customerSaved: "บันทึกข้อมูลบริษัทเรียบร้อยแล้วค่ะ",
  cancelled: "ยกเลิกการออกใบเสนอราคาแล้วค่ะ รายการในตะกร้ายังอยู่ครบนะคะ",
} as const;

// ---- Keyword detection ----

const POLITE = String.raw`\s*(?:ค่ะ|คะ|ครับ|นะคะ|นะครับ|จ้า|จ้ะ|ด้วย(?:ค่ะ|ครับ)?)?\s*[.!]*\s*$`;
/** Only the bare request: "ขอใบเสนอราคา L 1/2 10 เส้น" is an order, not a checkout. */
const QUOTE_TRIGGER_RE = new RegExp(String.raw`^\s*(?:ขอใบเสนอราคา|ออกใบเสนอราคา|ยืนยัน(?:การสั่งซื้อ|การสั่ง|รายการ|ใบเสนอราคา)?)` + POLITE);
const EDIT_CUSTOMER_RE = /^\s*แก้(?:ไข)?\s*ข้อมูล\s*(?:บริษัท|ลูกค้า|ที่อยู่)/;
const YES_RE = new RegExp(String.raw`^\s*(?:ใช่|ยืนยัน|ตกลง|ถูกต้อง|ok|okay|โอเค|ได้|yes|y)` + POLITE, "i");
const EDIT_RE = new RegExp(String.raw`^\s*(?:แก้ไข|แก้|เปลี่ยน|edit)` + POLITE, "i");
const CANCEL_RE = new RegExp(String.raw`^\s*(?:ยกเลิก|cancel)` + POLITE, "i");

export const isQuoteTrigger = (text: string) => QUOTE_TRIGGER_RE.test(text);
export const isEditCustomer = (text: string) => EDIT_CUSTOMER_RE.test(text);

// ---- Customer info ----

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export function missingFields(d: CustomerDraft): (keyof Customer)[] {
  return FIELDS.filter((f) => !clean(d[f]));
}

/** Non-empty values in `update` replace the draft's. */
export function mergeDraft(draft: CustomerDraft, update: CustomerDraft): CustomerDraft {
  const out: CustomerDraft = { ...draft };
  for (const f of FIELDS) {
    const v = clean(update[f]);
    if (v) out[f] = v;
  }
  return out;
}

export function hasAnyField(d: CustomerDraft): boolean {
  return FIELDS.some((f) => clean(d[f]));
}

export function formatCustomer(d: CustomerDraft): string {
  const company = [clean(d.companyName), clean(d.branch) ? `(${clean(d.branch)})` : ""].filter(Boolean).join(" ");
  return [`ชื่อบริษัท: ${company || "-"}`, `ที่อยู่: ${clean(d.address) || "-"}`, `เบอร์โทร: ${clean(d.phone) || "-"}`].join("\n");
}

const PHONE_RE = /(?:\+66[\s-]?|0)\d(?:[\s-]?\d){7,8}(?!\d)/;
const COMPANY_HINT_RE = /บริษัท|บจก|หจก|ห้างหุ้นส่วน|ร้าน|co\.|ltd|limited|company|corporation/i;
const ADDRESS_HINT_RE = /\d{5}|ถนน|ถ\.|ซอย|ซ\.|แขวง|เขต|ตำบล|ต\.|อำเภอ|อ\.|จังหวัด|จ\.|หมู่|เลขที่|กรุงเทพ/;
const QUESTION_RE = /ไหม|มั้ย|กี่|อะไร|เท่าไหร่|เท่าไร|ยังไง|อย่างไร|หรือเปล่า|รึเปล่า|[?？]/;
const LABEL_RE =/^(?:ชื่อบริษัท|ชื่อ|บริษัท(?=\s*[:：])|ที่อยู่|เบอร์โทร(?:ศัพท์)?|เบอร์|โทร(?:ศัพท์)?|สาขา(?=\s*[:：]))\s*[:：]?\s*/;

/** "บริษัท ก จำกัด (สำนักงานใหญ่)" -> { name: "บริษัท ก จำกัด", branch: "สำนักงานใหญ่" } */
function splitBranch(text: string): { name: string; branch?: string } {
  const hq = /\(?\s*(?:สำนักงานใหญ่|สนญ\.?|head\s*office)\s*\)?/i;
  if (hq.test(text)) return { name: clean(text.replace(hq, " ")), branch: "สำนักงานใหญ่" };
  const br = /\(?\s*สาขา(?:ที่)?\s*([^\s,)]+(?:\s*[^\s,)]+)?)\s*\)?/;
  const m = br.exec(text);
  if (m) return { name: clean(text.replace(m[0], " ")), branch: `สาขา ${clean(m[1])}` };
  return { name: clean(text) };
}

/**
 * Rule-based extraction (no AI), used when Gemini is unavailable. Understands the numbered
 * template ("1. ชื่อบริษัท ... 2. ที่อยู่ ... 3. เบอร์โทร") and loose lines with hints.
 */
export function extractCustomerRules(text: string): CustomerDraft {
  const out: CustomerDraft = {};
  const phone = PHONE_RE.exec(text);
  if (phone) out.phone = phone[0].trim();

  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const numbered: Record<string, string> = {};
  const loose: string[] = [];
  for (const line of lines) {
    const m = /^([1-4])\s*[.)]\s*(.+)$/.exec(line);
    const body = clean((m ? m[2] : line).replace(LABEL_RE, ""));
    if (!body) continue;
    if (m) numbered[m[1]] = body;
    else if (!QUESTION_RE.test(body)) loose.push(body); // "ร้านเปิดกี่โมง" is a question, not a name
  }

  const isPhoneOnly = (s: string) => PHONE_RE.test(s) && s.replace(PHONE_RE, "").replace(/[\s:：,-]/g, "").length <= 6;
  const companyText = numbered["1"] ?? loose.find((l) => COMPANY_HINT_RE.test(l) && !isPhoneOnly(l));
  // A loose line is an address only with a postcode or 2+ address words ("ส่งต่างจังหวัดได้ไหม" is not).
  const looksLikeAddress = (l: string) =>
    /\d{5}/.test(l) || (l.match(new RegExp(ADDRESS_HINT_RE.source, "g")) ?? []).length >= 2;
  const addressText = numbered["2"] ?? loose.find((l) => l !== companyText && looksLikeAddress(l) && !isPhoneOnly(l));

  if (companyText) {
    const { name, branch } = splitBranch(companyText);
    if (name) out.companyName = name;
    if (branch) out.branch = branch;
  } else {
    // A reply with only the branch, e.g. "สำนักงานใหญ่ค่ะ" / "สาขา 00001".
    const { branch } = splitBranch(text);
    if (branch && clean(text).length <= 40) out.branch = branch;
  }
  if (addressText) out.address = clean(addressText);
  return out;
}

// ---- Messages ----

function askMissing(d: CustomerDraft): string {
  const missing = missingFields(d).map((f) => FIELD_LABELS[f]);
  return `ขอข้อมูลเพิ่มอีกนิดนะคะ รบกวนแจ้ง${missing.join(" และ ")}ค่ะ`;
}

function confirmMessages(d: CustomerDraft, cart: Cart, purpose: CheckoutState["purpose"]): string[] {
  if (purpose === "edit") {
    return [`รบกวนตรวจสอบข้อมูลบริษัทค่ะ\n${formatCustomer(d)}\n\n${CHECKOUT_REPLY.confirmQuestion}`];
  }
  return [
    `รบกวนตรวจสอบข้อมูลก่อนส่งคำขอใบเสนอราคาค่ะ\n${formatCustomer(d)}`,
    `${formatSummary(cart)}\n\n${CHECKOUT_REPLY.confirmQuestion}`,
  ];
}

function newRequestId(now: Date, random: () => number): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(random() * 32)]).join("");
  return `QR-${ymd}-${suffix}`;
}

export function buildQuoteRequest(
  userId: string,
  customer: Customer,
  cart: Cart,
  now = new Date(),
  random: () => number = Math.random,
): QuoteRequest {
  const q = calcQuote(cart.lines.map((l) => ({ unitPrice: l.price, quantity: l.quantity })));
  return {
    requestId: newRequestId(now, random),
    status: "pending",
    userId,
    customer,
    items: cart.lines.map((l) => ({ code: l.code, name: l.name, unit: l.unit, quantity: l.quantity, unitPrice: l.price })),
    subtotal: q.subtotal / 100,
    vat: q.vat / 100,
    total: q.total / 100,
    createdAt: now.toISOString(),
  };
}

// ---- Steps ----

/** "ขอใบเสนอราคา" / "ยืนยัน" / "ออกใบเสนอราคา" with no checkout in progress. */
export function startCheckout(cart: Cart, customer: Customer | null): CheckoutStep {
  if (cart.lines.length === 0) return { passThrough: false, messages: [CHECKOUT_REPLY.emptyCart], state: null };
  if (customer) {
    return {
      passThrough: false,
      messages: [formatSummary(cart), `ข้อมูลสำหรับออกใบเสนอราคาค่ะ\n${formatCustomer(customer)}\n\n${CHECKOUT_REPLY.useExistingQuestion}`],
      state: { stage: "useExisting", purpose: "quote", draft: { ...customer } },
    };
  }
  return { passThrough: false, messages: [CHECKOUT_REPLY.askInfo], state: { stage: "collecting", purpose: "quote", draft: {} } };
}

/** "แก้ข้อมูลบริษัท" at any time. */
export function startEditCustomer(customer: Customer | null): CheckoutStep {
  return {
    passThrough: false,
    messages: [customer ? `ข้อมูลปัจจุบันค่ะ\n${formatCustomer(customer)}\n\n${CHECKOUT_REPLY.askEdit}` : CHECKOUT_REPLY.askInfo],
    state: { stage: "collecting", purpose: "edit", draft: customer ? { ...customer } : {} },
  };
}

/** Whether this message needs customer-info extraction (Gemini) before calling continueCheckout. */
export function needsExtraction(state: CheckoutState, text: string): boolean {
  if (CANCEL_RE.test(text)) return false;
  if (state.stage === "collecting") return true;
  if (state.stage === "confirm") return !YES_RE.test(text) && !EDIT_RE.test(text);
  return false; // useExisting: only ใช่ / แก้ไข
}

/**
 * One message while a checkout is in progress. `extracted` = customer fields found in the
 * message (Gemini or rules); empty when the message is about something else.
 */
export function continueCheckout(
  state: CheckoutState,
  text: string,
  extracted: CustomerDraft,
  ctx: { cart: Cart; customer: Customer | null; userId: string; now?: Date; random?: () => number },
): CheckoutStep {
  if (CANCEL_RE.test(text)) return { passThrough: false, messages: [CHECKOUT_REPLY.cancelled], state: null };

  const finish = (draft: CustomerDraft): CheckoutStep => {
    const customer = draft as Customer;
    const saveCustomer = { customer, isNew: ctx.customer === null };
    if (state.purpose === "edit") {
      const hint = ctx.cart.lines.length > 0 ? ' พิมพ์ "ขอใบเสนอราคา" เพื่อส่งคำขอได้เลยนะคะ' : "";
      return { passThrough: false, messages: [CHECKOUT_REPLY.customerSaved + hint], state: null, saveCustomer };
    }
    if (ctx.cart.lines.length === 0) return { passThrough: false, messages: [CHECKOUT_REPLY.emptyCart], state: null, saveCustomer };
    return {
      passThrough: false,
      messages: [CHECKOUT_REPLY.requested],
      state: null,
      saveCustomer,
      quote: buildQuoteRequest(ctx.userId, customer, ctx.cart, ctx.now, ctx.random),
      clearCart: true,
    };
  };

  const collect = (draft: CustomerDraft): CheckoutStep =>
    missingFields(draft).length > 0
      ? { passThrough: false, messages: [askMissing(draft)], state: { ...state, stage: "collecting", draft } }
      : { passThrough: false, messages: confirmMessages(draft, ctx.cart, state.purpose), state: { ...state, stage: "confirm", draft } };

  switch (state.stage) {
    case "useExisting":
      if (YES_RE.test(text) && missingFields(state.draft).length === 0) return finish(state.draft);
      if (EDIT_RE.test(text) || YES_RE.test(text)) {
        return { passThrough: false, messages: [CHECKOUT_REPLY.askEdit], state: { ...state, stage: "collecting" } };
      }
      return { passThrough: true, messages: [] };

    case "confirm":
      if (YES_RE.test(text)) return finish(state.draft);
      if (EDIT_RE.test(text)) {
        return { passThrough: false, messages: [CHECKOUT_REPLY.askEdit], state: { ...state, stage: "collecting" } };
      }
      // Corrections sent directly ("เบอร์ใหม่ 02-123-4567") are merged and re-confirmed.
      if (hasAnyField(extracted)) return collect(mergeDraft(state.draft, extracted));
      return { passThrough: true, messages: [] };

    case "collecting":
      if (!hasAnyField(extracted)) return { passThrough: true, messages: [] };
      return collect(mergeDraft(state.draft, extracted));
  }
}
