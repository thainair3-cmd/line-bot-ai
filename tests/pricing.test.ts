import { test } from "node:test";
import assert from "node:assert/strict";
import { calcQuote, formatSatang, lineTotalSatang, parsePrice, roundHalfAwayFromZero } from "../lib/pricing.ts";

test("583 เส้น × 710 = 413,930.00", () => {
  assert.equal(formatSatang(lineTotalSatang(710, 583)), "413,930.00");
});

test("ใบเสนอราคา 5 บรรทัด: รวม 1,608,930.00 VAT 112,625.10 รวมทั้งสิ้น 1,721,555.10", () => {
  const q = calcQuote([
    { unitPrice: 825, quantity: 530 },
    { unitPrice: 1295, quantity: 69 },
    { unitPrice: 1750, quantity: 528 },
    { unitPrice: 2200, quantity: 66 },
    { unitPrice: 2625, quantity: 5 },
  ]);
  assert.deepEqual(q.lineTotals.map(formatSatang), ["437,250.00", "89,355.00", "924,000.00", "145,200.00", "13,125.00"]);
  assert.equal(formatSatang(q.subtotal), "1,608,930.00");
  assert.equal(formatSatang(q.vat), "112,625.10");
  assert.equal(formatSatang(q.total), "1,721,555.10");
});

test("ราคาใน CSV มีจุลภาค", () => {
  assert.equal(parsePrice("1,700.00"), 1700);
  assert.equal(parsePrice(" 12,345.5 "), 12345.5);
  assert.equal(parsePrice("ไม่มีราคา"), null);
  assert.equal(parsePrice(""), null);
});

test("ปัดเศษแบบ Excel (ครึ่งขึ้น ไม่โดน float error)", () => {
  assert.equal(roundHalfAwayFromZero(1.005 * 100), 101); // Excel ROUND(1.005,2) = 1.01
  assert.equal(roundHalfAwayFromZero(0.125 * 100), 13); // ROUND(0.125,2) = 0.13
  assert.equal(formatSatang(lineTotalSatang(33.335, 1)), "33.34");
  assert.equal(formatSatang(lineTotalSatang(10.1, 3)), "30.30");
  // VAT on a subtotal ending in .5 satang rounds up: 0.07 * 7.50 = 0.525 -> 0.53
  assert.equal(formatSatang(calcQuote([{ unitPrice: 7.5, quantity: 1 }]).vat), "0.53");
});
