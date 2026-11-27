import { test } from "node:test";
import assert from "node:assert/strict";
import { matchProducts, tokenize, type Product } from "../lib/match.ts";
import {
  addItems,
  choosePending,
  emptyCart,
  formatSummary,
  parseChoice,
  parseRemoveLines,
  removeItems,
  setItems,
  QUOTE_DISCLAIMER,
} from "../lib/cart-ops.ts";

const P: Product[] = [
  { code: "CL-04", name: "ท่อทองแดง Type L 1/2\"", unit: "เส้น", price: 710 },
  { code: "CL-12", name: "ท่อทองแดง Type L 1-1/2\"", unit: "เส้น", price: 2625 },
  { code: "CM-06", name: "ท่อทองแดง Type M 3/4\"", unit: "เส้น", price: 825 },
  { code: "AF-0608", name: "AEROFLEX 3/4\" x 3/8\"", unit: "เส้น", price: 120 },
  { code: "AF-0612", name: "AEROFLEX 3/4\" x 1/2\"", unit: "เส้น", price: 150 },
];

test("tokenize: หุน / นิ้ว / ติดกัน", () => {
  assert.deepEqual(tokenize("ท่อ L 4 หุน"), ["ท่อ", "l", "1/2"]);
  assert.deepEqual(tokenize("L1/2นิ้ว"), ["l", "1/2"]);
  assert.deepEqual(tokenize("1 1/2\""), ["1+1/2"]);
});

test("match: Type + ขนาด, ไม่สับสน 1/2 กับ 1-1/2", () => {
  const one = (q: string) => {
    const m = matchProducts(q, P);
    return m.kind === "one" ? m.product.code : m.kind;
  };
  assert.equal(one("ท่อ L 1/2"), "CL-04");
  assert.equal(one("L 4 หุน"), "CL-04");
  assert.equal(one("L 1 1/2"), "CL-12");
  assert.equal(one("M 6 หุน"), "CM-06");
  assert.equal(one("af-0612"), "AF-0612");
  assert.equal(one("aeroflex 3/4 x 1/2"), "AF-0612");
  assert.equal(one("aeroflex 3/4"), "many");
  assert.equal(one("Type K 1/2"), "none");
});

test("cart: add, ambiguous choice, set, remove, summary", () => {
  let r = addItems(emptyCart(), [{ query: "L 1/2", quantity: 583 }, { query: "aeroflex 3/4", quantity: 10 }, { query: "วาล์ว", quantity: 1 }], P);
  assert.equal(r.cart.lines.length, 1);
  assert.equal(r.cart.pending.length, 1);
  assert.match(r.notes.join(), /ไม่พบสินค้า “วาล์ว”/);

  r = choosePending(r.cart, 2);
  assert.deepEqual(r.cart.lines.map((l) => [l.code, l.quantity]), [["CL-04", 583], ["AF-0612", 10]]);
  assert.equal(r.cart.pending.length, 0);

  r = setItems(r.cart, [{ query: "L 1/2", quantity: 20 }], P);
  assert.equal(r.cart.lines[0].quantity, 20);
  r = setItems(r.cart, [{ query: "", quantity: 5, line: 2 }], P);
  assert.equal(r.cart.lines[1].quantity, 5);

  const summary = formatSummary(r.cart);
  assert.match(summary, /20 เส้น × 710\.00 = 14,200\.00/);
  assert.match(summary, /รวมเป็นเงิน 14,950\.00 บาท/);
  assert.match(summary, /VAT 7% 1,046\.50 บาท/);
  assert.match(summary, /รวมทั้งสิ้น 15,996\.50 บาท/);
  assert.ok(summary.endsWith(QUOTE_DISCLAIMER));

  r = removeItems(r.cart, [2], []);
  assert.deepEqual(r.cart.lines.map((l) => l.code), ["CL-04"]);
});

test("shortcuts: ลบรายการ / เลือกหมายเลข", () => {
  assert.deepEqual(parseRemoveLines("ลบรายการ 2"), [2]);
  assert.deepEqual(parseRemoveLines("ลบรายการที่ 1, 3"), [1, 3]);
  assert.equal(parseRemoveLines("ลบ L 1/2"), null);
  assert.equal(parseChoice("2"), 2);
  assert.equal(parseChoice("ข้อ 1 ค่ะ"), 1);
  assert.equal(parseChoice("L 1/2 10 เส้น"), null);
});
