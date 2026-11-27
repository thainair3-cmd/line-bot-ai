import { test } from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../lib/match.ts";
import { parseOrderText, parsePriceQuestion, ruleBasedAction } from "../lib/order-parse.ts";
import { addItems, emptyCart, formatPriceReply, formatSummary } from "../lib/cart-ops.ts";

// Names and prices from the real "สินค้า" sheet.
const P: Product[] = [
  { code: "ST-002", name: "ท่อทองแดง K 1/2 x 1.24mm x 6m", unit: "เส้น", price: 1700 },
  { code: "ST-013", name: "ท่อทองแดง L 1/2 x 0.89mm x 6m", unit: "เส้น", price: 1130 },
  { code: "ST-024", name: "ท่อทองแดง M 1/2 x 0.51mm x 6m", unit: "เส้น", price: 645 },
  { code: "AF-1414", name: 'AEROFLEX:ฉนวนยางท่อ 1414 (หนา 1/4" ท่อ 1/4" ยาว 1.83ม.)', unit: "เส้น", price: 36 },
  { code: "AF-3438", name: 'AEROFLEX:ฉนวนยางท่อ 3438 (หนา 3/4" ท่อ 3/8" ยาว 1.83ม.)', unit: "เส้น", price: 120 },
  { code: "FT-048", name: 'สามทาง ทองแดง ขนาด 1/2"', unit: "ตัว", price: 60 },
];

const MESSAGE = "ขอราคา L 1/2 10 เส้น กับยาง 3438 100 เส้น";

test("แยกรายการโดยไม่ใช้ AI: ข้อความจริงที่เคยได้ DEFAULT_REPLY", () => {
  assert.deepEqual(parseOrderText(MESSAGE), [
    { query: "L 1/2", quantity: 10 },
    { query: "ยาง 3438", quantity: 100 },
  ]);
});

test("ข้อความนี้ต้องได้ ST-013 × 10 และ AF-3438 × 100, รวม 23,300.00 VAT 1,631.00 รวมทั้งสิ้น 24,931.00", () => {
  const action = ruleBasedAction(MESSAGE, P);
  assert.equal(action?.action, "add");
  const r = addItems(emptyCart(), action!.items, P);
  assert.deepEqual(r.cart.lines.map((l) => [l.code, l.quantity]), [["ST-013", 10], ["AF-3438", 100]]);
  assert.deepEqual(r.notes, []);
  const summary = formatSummary(r.cart);
  assert.match(summary, /10 เส้น × 1,130\.00 = 11,300\.00/);
  assert.match(summary, /100 เส้น × 120\.00 = 12,000\.00/);
  assert.match(summary, /รวมเป็นเงิน 23,300\.00 บาท/);
  assert.match(summary, /VAT 7% 1,631\.00 บาท/);
  assert.match(summary, /รวมทั้งสิ้น 24,931\.00 บาท/);
});

test("ตัวแยก: , / และ / ขึ้นบรรทัด / หน่วยต่าง ๆ / จำนวนมีจุลภาค / จำนวนมาก่อน", () => {
  assert.deepEqual(parseOrderText("สั่ง M 1/2 5 เส้น, สามทาง 4 หุน 20 ตัว และ ยาง 1414 1,000 เส้นค่ะ"), [
    { query: "M 1/2", quantity: 5 },
    { query: "สามทาง 4 หุน", quantity: 20 },
    { query: "ยาง 1414", quantity: 1000 },
  ]);
  assert.deepEqual(parseOrderText("เอา L 1/2 2 เส้น\nK 1/2 3 เส้น"), [
    { query: "L 1/2", quantity: 2 },
    { query: "K 1/2", quantity: 3 },
  ]);
  assert.deepEqual(parseOrderText("เอา 10 เส้น L 1/2"), [{ query: "L 1/2", quantity: 10 }]);
  assert.deepEqual(parseOrderText("ส่งกี่วันคะ"), []);
});

test("ถามราคาไม่มีจำนวน: ตอบราคาต่อหน่วย ไม่ใส่ตะกร้า", () => {
  assert.equal(parsePriceQuestion("L 1/2 ราคาเท่าไหร่"), "L 1/2");
  const action = ruleBasedAction("L 1/2 ราคาเท่าไหร่ครับ", P);
  assert.deepEqual(action, { action: "price", items: [{ query: "L 1/2" }] });
  const reply = formatPriceReply(action!.items, P);
  assert.match(reply, /ท่อทองแดง L 1\/2 x 0\.89mm x 6m\nราคา 1,130\.00 บาท\/เส้น \(ยังไม่รวม VAT\)/);
  assert.match(formatPriceReply([{ query: "ท่อ 1/2" }], P), /มีหลายรายการ/);
});

test("ไม่ใช่ออเดอร์หรือไม่เจอสินค้า: ไม่ใช้ตัวแยก (ให้ Gemini/แอดมินตอบตามเดิม)", () => {
  assert.equal(ruleBasedAction("ส่งต่างจังหวัดได้ไหม", P), null);
  assert.equal(ruleBasedAction("ขอราคา วาล์ว 10 ตัว", P), null);
  assert.equal(ruleBasedAction("ร้านเปิดกี่โมง ราคาส่งมีไหม", P), null);
});
