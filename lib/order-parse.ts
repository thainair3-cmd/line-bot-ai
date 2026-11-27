// Rule-based order reader (no AI). Used when Gemini's answer is missing, not valid JSON, or the
// default "hand over to staff" reply even though the message names products we can match.
// Imports use .ts extensions so `node --test` can load this file without a bundler.
import { matchProducts, type Product } from "./match.ts";
import type { OrderItem } from "./cart-ops.ts";

const UNITS = "เส้น|ม้วน|ตัว|แผ่น|อัน|ชิ้น";
// A quantity followed by a unit: "10 เส้น", "1,000 เส้น", "2.5 ม้วน". Not the "2" of "1/2 เส้น".
const QTY_UNIT_RE = new RegExp(String.raw`(?<![\d/.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:${UNITS})`, "g");
// Item separators: กับ, และ, new line, comma (but not the thousands comma in "1,000").
const SEPARATOR_RE = /\s*(?:กับ|และ|\n|,(?!\d{3}(?!\d)))\s*/;
// Request words and polite particles that are not part of the product description.
const FILLER_RE =
  /ขอใบเสนอราคา|ใบเสนอราคา|ขอราคา|ราคาเท่าไหร่|ราคาเท่าไร|ราคา|เท่าไหร่|เท่าไร|ต้องการ|ขอ|สั่งซื้อ|สั่ง|เอา|ซื้อ|หน่อย|ด้วย|ครับ|ค่ะ|คะ|นะ|จ้า|บาท|ทั้งหมด|ได้ไหม|ไหม|มั้ย/g;
const PRICE_QUESTION_RE = /ราคา|เท่าไหร่|เท่าไร/;

function cleanQuery(s: string): string {
  return s.replace(FILLER_RE, " ").replace(/\s+/g, " ").trim();
}

/** "ขอราคา L 1/2 10 เส้น กับยาง 3438 100 เส้น" -> [{L 1/2, 10}, {ยาง 3438, 100}] */
export function parseOrderText(text: string): OrderItem[] {
  const items: OrderItem[] = [];
  for (const segment of text.split(SEPARATOR_RE)) {
    let prevEnd = 0;
    const matches = [...segment.matchAll(QTY_UNIT_RE)];
    matches.forEach((m, k) => {
      const quantity = Number(m[1].replace(/,/g, ""));
      let query = cleanQuery(segment.slice(prevEnd, m.index));
      // Quantity written first ("เอา 10 เส้น L 1/2"): take the text up to the next quantity.
      if (!query) {
        const nextStart = matches[k + 1]?.index ?? segment.length;
        query = cleanQuery(segment.slice(m.index + m[0].length, nextStart));
      }
      prevEnd = m.index + m[0].length;
      if (query && quantity > 0) items.push({ query, quantity });
    });
  }
  return items;
}

/** "L 1/2 ราคาเท่าไหร่" -> "L 1/2"; null if the message is not a price question. */
export function parsePriceQuestion(text: string): string | null {
  if (!PRICE_QUESTION_RE.test(text)) return null;
  const query = cleanQuery(text.replace(/[?？]/g, " "));
  return query || null;
}

export type RuleAction = { action: "add" | "price"; items: OrderItem[] };

/**
 * Orders (product + quantity + unit) -> add; price question without quantity -> price.
 * Returns null unless at least one product can actually be matched.
 */
export function ruleBasedAction(text: string, products: Product[]): RuleAction | null {
  const found = (q: string) => matchProducts(q, products).kind !== "none";
  const items = parseOrderText(text);
  if (items.length > 0 && items.some((i) => found(i.query))) return { action: "add", items };
  const priceQuery = parsePriceQuestion(text);
  if (priceQuery && found(priceQuery)) return { action: "price", items: [{ query: priceQuery }] };
  return null;
}
