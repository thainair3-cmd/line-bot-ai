// Pure cart operations and the summary text. Money is always computed here, never by Gemini.
// Imports use .ts extensions so `node --test` can load this file without a bundler.
import { calcQuote, formatBaht, formatQuantity, formatSatang } from "./pricing.ts";
import { matchProducts, type Product } from "./match.ts";

export type CartLine = Product & { quantity: number };

/** An item that matched several products; the customer picks one by number. */
export type Pending = { query: string; quantity: number; mode: "add" | "set"; options: Product[] };

export type Cart = { lines: CartLine[]; pending: Pending[] };

/** One item read from the customer's message by Gemini. */
export type OrderItem = { query: string; quantity?: number | null; line?: number | null };

export type CartResult = { cart: Cart; notes: string[]; changed: boolean };

export const CART_MAX_LINES = 50;
export const MAX_OPTIONS_SHOWN = 5;
export const QUOTE_DISCLAIMER = "ยอดเบื้องต้น ยังไม่รวมส่วนลดและค่าจัดส่ง แอดมินจะยืนยันใบเสนอราคาอีกครั้งนะคะ";

export const emptyCart = (): Cart => ({ lines: [], pending: [] });

const clone = (c: Cart): Cart => ({ lines: c.lines.map((l) => ({ ...l })), pending: [...c.pending] });

function validQuantity(q: number | null | undefined): number | null {
  if (typeof q !== "number" || !Number.isFinite(q) || q < 0 || q > 1_000_000) return null;
  return Math.round(q * 100) / 100;
}

const notFound = (query: string) =>
  `ไม่พบสินค้า “${query}” ในรายการค่ะ เดี๋ยวแอดมินช่วยตรวจสอบให้นะคะ 🙏`;

/** Adds (mode "add") or sets (mode "set") the quantity of a product. Quantity 0 removes it. */
function upsert(cart: Cart, product: Product, quantity: number, mode: "add" | "set", notes: string[]): boolean {
  const existing = cart.lines.find((l) => l.code === product.code && l.name === product.name);
  if (existing) {
    existing.quantity = mode === "add" ? existing.quantity + quantity : quantity;
    if (existing.quantity <= 0) cart.lines.splice(cart.lines.indexOf(existing), 1);
    return true;
  }
  if (quantity <= 0) return false;
  if (cart.lines.length >= CART_MAX_LINES) {
    notes.push(`ตะกร้ามีครบ ${CART_MAX_LINES} รายการแล้วค่ะ รบกวนให้แอดมินช่วยต่อนะคะ 🙏`);
    return false;
  }
  cart.lines.push({ ...product, quantity });
  return true;
}

/** Matches against the product list and adds/sets; ambiguous items are queued in cart.pending. */
function applyFromProducts(
  cart: Cart,
  item: OrderItem,
  quantity: number,
  mode: "add" | "set",
  products: Product[],
  notes: string[],
): boolean {
  const m = matchProducts(item.query, products);
  if (m.kind === "one") return upsert(cart, m.product, quantity, mode, notes);
  if (m.kind === "many") {
    cart.pending.push({ query: item.query, quantity, mode, options: m.products.slice(0, MAX_OPTIONS_SHOWN) });
    return false;
  }
  notes.push(notFound(item.query));
  return false;
}

export function addItems(cart0: Cart, items: OrderItem[], products: Product[]): CartResult {
  const cart = clone(cart0);
  cart.pending = [];
  const notes: string[] = [];
  let changed = false;
  for (const item of items) {
    const quantity = validQuantity(item.quantity ?? 1);
    if (!item.query?.trim()) continue;
    if (!quantity) {
      notes.push(`รบกวนระบุจำนวนของ “${item.query}” อีกครั้งนะคะ`);
      continue;
    }
    changed = applyFromProducts(cart, item, quantity, "add", products, notes) || changed;
  }
  return { cart, notes, changed };
}

/** "เปลี่ยน L 1/2 เป็น 20 เส้น" / "รายการ 2 เอา 5 เส้น". Items not yet in the cart are added. */
export function setItems(cart0: Cart, items: OrderItem[], products: Product[]): CartResult {
  const cart = clone(cart0);
  cart.pending = [];
  const notes: string[] = [];
  let changed = false;
  for (const item of items) {
    const quantity = validQuantity(item.quantity);
    if (quantity === null) {
      notes.push(`รบกวนระบุจำนวนใหม่${item.query ? `ของ “${item.query}”` : ""}อีกครั้งนะคะ`);
      continue;
    }
    if (item.line) {
      const line = cart.lines[item.line - 1];
      if (!line) {
        notes.push(`ไม่มีรายการที่ ${item.line} ในตะกร้าค่ะ`);
        continue;
      }
      changed = upsert(cart, line, quantity, "set", notes) || changed;
      continue;
    }
    if (!item.query?.trim()) continue;
    const inCart = matchProducts(item.query, cart.lines);
    if (inCart.kind === "one") {
      changed = upsert(cart, inCart.product, quantity, "set", notes) || changed;
    } else if (inCart.kind === "many") {
      notes.push(`“${item.query}” ตรงกับหลายรายการในตะกร้าค่ะ รบกวนระบุเลขรายการ เช่น "รายการ 2 เป็น ${formatQuantity(quantity)}"`);
    } else {
      changed = applyFromProducts(cart, item, quantity, "set", products, notes) || changed;
    }
  }
  return { cart, notes, changed };
}

export function removeItems(cart0: Cart, lineNumbers: number[], queries: string[]): CartResult {
  const cart = clone(cart0);
  cart.pending = [];
  const notes: string[] = [];
  const toRemove = new Set<CartLine>();
  for (const n of lineNumbers) {
    const line = cart.lines[n - 1];
    if (line) toRemove.add(line);
    else notes.push(`ไม่มีรายการที่ ${n} ในตะกร้าค่ะ`);
  }
  for (const q of queries) {
    const m = matchProducts(q, cart.lines);
    if (m.kind === "one") toRemove.add(m.product as CartLine);
    else if (m.kind === "many") notes.push(`“${q}” ตรงกับหลายรายการในตะกร้าค่ะ รบกวนระบุเลขรายการ เช่น "ลบรายการ 2"`);
    else notes.push(`ไม่พบ “${q}” ในตะกร้าค่ะ`);
  }
  cart.lines = cart.lines.filter((l) => !toRemove.has(l));
  return { cart, notes, changed: toRemove.size > 0 };
}

/** Customer answered a "which one?" question with a number. */
export function choosePending(cart0: Cart, choice: number): CartResult {
  const cart = clone(cart0);
  const notes: string[] = [];
  const [first, ...rest] = cart.pending;
  if (!first) return { cart, notes, changed: false };
  const product = first.options[choice - 1];
  if (!product) {
    notes.push(`รบกวนเลือกหมายเลข 1-${first.options.length} นะคะ`);
    return { cart, notes, changed: false };
  }
  cart.pending = rest;
  const changed = upsert(cart, product, first.quantity, first.mode, notes);
  return { cart, notes, changed };
}

export function cartSubtotalSatang(cart: Cart): number {
  return calcQuote(cart.lines.map((l) => ({ unitPrice: l.price, quantity: l.quantity }))).subtotal;
}

/** Itemised summary with subtotal, VAT 7% and grand total, ending with the disclaimer. */
export function formatSummary(cart: Cart): string {
  if (cart.lines.length === 0) {
    return "ตะกร้ายังว่างอยู่ค่ะ พิมพ์สินค้าและจำนวนที่ต้องการได้เลย เช่น \"ท่อ L 1/2 10 เส้น\" นะคะ";
  }
  const q = calcQuote(cart.lines.map((l) => ({ unitPrice: l.price, quantity: l.quantity })));
  const rows = cart.lines.map((l, i) => {
    const unit = l.unit ? ` ${l.unit}` : "";
    return `${i + 1}. ${l.name}\n   ${formatQuantity(l.quantity)}${unit} × ${formatBaht(l.price)} = ${formatSatang(q.lineTotals[i])}`;
  });
  return [
    "สรุปรายการเบื้องต้นค่ะ",
    ...rows,
    "",
    `รวมเป็นเงิน ${formatSatang(q.subtotal)} บาท`,
    `VAT 7% ${formatSatang(q.vat)} บาท`,
    `รวมทั้งสิ้น ${formatSatang(q.total)} บาท`,
    "",
    QUOTE_DISCLAIMER,
  ].join("\n");
}

/** "Which one?" prompt for the first pending item, or null if nothing is pending. */
export function formatPendingQuestion(cart: Cart): string | null {
  const p = cart.pending[0];
  if (!p) return null;
  const options = p.options.map((o, i) => `${i + 1}) ${o.name} (${formatBaht(o.price)}${o.unit ? `/${o.unit}` : ""})`);
  return [`“${p.query}” มีหลายรายการค่ะ รบกวนพิมพ์หมายเลขที่ต้องการนะคะ`, ...options].join("\n");
}

/**
 * Unit prices from the product sheet for "how much is X?" (no quantity, nothing added to the cart).
 */
export function formatPriceReply(items: OrderItem[], products: Product[]): string {
  const parts = items
    .filter((i) => i.query?.trim())
    .map((i) => {
      const m = matchProducts(i.query, products);
      const price = (p: Product) => `${formatBaht(p.price)} บาท${p.unit ? `/${p.unit}` : ""}`;
      if (m.kind === "one") return `${m.product.name}\nราคา ${price(m.product)} (ยังไม่รวม VAT) ค่ะ`;
      if (m.kind === "many") {
        const shown = m.products.slice(0, MAX_OPTIONS_SHOWN).map((p, k) => `${k + 1}) ${p.name} ${price(p)}`);
        const more = m.products.length > MAX_OPTIONS_SHOWN ? [`และอีก ${m.products.length - MAX_OPTIONS_SHOWN} รายการ รบกวนระบุให้ชัดขึ้นนะคะ`] : [];
        return [`“${i.query}” มีหลายรายการค่ะ (ราคายังไม่รวม VAT)`, ...shown, ...more].join("\n");
      }
      return notFound(i.query);
    });
  if (parts.length === 0) return notFound("");
  return [...parts, "ถ้าต้องการใบเสนอราคา พิมพ์สินค้าพร้อมจำนวนได้เลย เช่น \"L 1/2 10 เส้น\" นะคะ"].join("\n\n");
}

/** Shortcuts handled without Gemini. */
export const CLEAR_RE = /^\s*(ล้างตะกร้า|ล้างรายการ|เคลียร์ตะกร้า|ยกเลิกทั้งหมด|ยกเลิกรายการทั้งหมด)/;
const REMOVE_RE = /^\s*ลบ\s*(?:รายการ)?\s*(?:ที่)?\s*((?:\d+\s*(?:,|และ|\s)\s*)*\d+)\s*(?:ค่ะ|คะ|ครับ|นะ)?\s*$/;
const CHOICE_RE = /^\s*(?:ข้อ|ตัวที่|อันที่|เลือก|เบอร์|หมายเลข|no\.?)?\s*(\d{1,2})\s*(?:ค่ะ|คะ|ครับ|นะ|นะคะ|ครับผม)?\s*$/i;

export function parseRemoveLines(text: string): number[] | null {
  const m = REMOVE_RE.exec(text);
  return m ? (m[1].match(/\d+/g) ?? []).map(Number) : null;
}

export function parseChoice(text: string): number | null {
  const m = CHOICE_RE.exec(text);
  return m ? Number(m[1]) : null;
}
