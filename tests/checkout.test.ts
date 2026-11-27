import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKOUT_REPLY,
  continueCheckout,
  extractCustomerRules,
  isEditCustomer,
  isQuoteTrigger,
  needsExtraction,
  startCheckout,
  startEditCustomer,
  type CheckoutState,
  type Customer,
} from "../lib/checkout.ts";
import { emptyCart, type Cart } from "../lib/cart-ops.ts";

const CART: Cart = {
  lines: [
    { code: "ST-013", name: "ท่อทองแดง L 1/2 x 0.89mm x 6m", unit: "เส้น", price: 1130, quantity: 10 },
    { code: "AF-3438", name: 'AEROFLEX:ฉนวนยางท่อ 3438 (หนา 3/4" ท่อ 3/8" ยาว 1.83ม.)', unit: "เส้น", price: 120, quantity: 100 },
  ],
  pending: [],
};
const SAVED: Customer = {
  companyName: "บริษัท ไทยแน่ จำกัด",
  branch: "สำนักงานใหญ่",
  address: "99/1 ถ.พระราม 2 แขวงแสมดำ เขตบางขุนเทียน กรุงเทพฯ 10150",
  phone: "081-234-5678",
};
const ctx = (customer: Customer | null, cart = CART) => ({
  cart,
  customer,
  userId: "U-test",
  now: new Date("2026-11-27T03:00:00Z"),
  random: () => 0,
});

/** Runs one message through the checkout like chat.ts does, using the rule extractor. */
function send(state: CheckoutState, text: string, customer: Customer | null, cart = CART) {
  const extracted = needsExtraction(state, text) ? extractCustomerRules(text) : {};
  return continueCheckout(state, text, extracted, ctx(customer, cart));
}

test("คำสั่งเริ่ม: เฉพาะข้อความ ขอใบเสนอราคา / ยืนยัน / ออกใบเสนอราคา เปล่า ๆ", () => {
  for (const t of ["ขอใบเสนอราคา", "ขอใบเสนอราคาค่ะ", "ยืนยัน", "ออกใบเสนอราคาด้วยครับ"]) assert.ok(isQuoteTrigger(t), t);
  assert.equal(isQuoteTrigger("ขอใบเสนอราคา L 1/2 10 เส้น"), false); // that is an order
  assert.ok(isEditCustomer("แก้ข้อมูลบริษัท"));
  assert.ok(isEditCustomer("แก้ไขข้อมูลบริษัทค่ะ"));
});

test("ตะกร้าว่าง: บอกให้แจ้งรายการก่อน ไม่เริ่มขั้นตอน", () => {
  const r = startCheckout(emptyCart(), SAVED);
  assert.deepEqual(r.messages, [CHECKOUT_REPLY.emptyCart]);
  assert.equal(r.state, null);
});

test("ลูกค้าใหม่ ให้ข้อมูลครบในข้อความเดียว -> สรุปให้ยืนยัน -> ยืนยัน -> สร้างคำขอ pending + ล้างตะกร้า", () => {
  const start = startCheckout(CART, null);
  assert.deepEqual(start.messages, [CHECKOUT_REPLY.askInfo]);
  assert.equal(start.state?.stage, "collecting");

  const info = "1. บริษัท ไทยแน่ จำกัด (สำนักงานใหญ่)\n2. 99/1 ถ.พระราม 2 แขวงแสมดำ เขตบางขุนเทียน กรุงเทพฯ 10150\n3. 081-234-5678";
  const step = send(start.state!, info, null);
  assert.equal(step.passThrough, false);
  assert.equal(step.state?.stage, "confirm");
  assert.deepEqual(step.state?.draft, SAVED);
  const shown = step.messages.join("\n");
  assert.match(shown, /ชื่อบริษัท: บริษัท ไทยแน่ จำกัด \(สำนักงานใหญ่\)/);
  assert.match(shown, /เบอร์โทร: 081-234-5678/);
  assert.match(shown, /รวมเป็นเงิน 23,300\.00 บาท/);
  assert.match(shown, /รวมทั้งสิ้น 24,931\.00 บาท/);

  const done = send(step.state!, "ยืนยันค่ะ", null);
  assert.deepEqual(done.messages, [CHECKOUT_REPLY.requested]);
  assert.equal(done.state, null);
  assert.equal(done.clearCart, true);
  assert.deepEqual(done.saveCustomer, { customer: SAVED, isNew: true });
  assert.deepEqual(done.quote, {
    requestId: "QR-20261127-AAAAAA",
    status: "pending",
    userId: "U-test",
    customer: SAVED,
    items: [
      { code: "ST-013", name: "ท่อทองแดง L 1/2 x 0.89mm x 6m", unit: "เส้น", quantity: 10, unitPrice: 1130 },
      { code: "AF-3438", name: 'AEROFLEX:ฉนวนยางท่อ 3438 (หนา 3/4" ท่อ 3/8" ยาว 1.83ม.)', unit: "เส้น", quantity: 100, unitPrice: 120 },
    ],
    subtotal: 23300,
    vat: 1631,
    total: 24931,
    createdAt: "2026-11-27T03:00:00.000Z",
  });
  assert.equal(/BQ/.test(JSON.stringify(done.quote)), false); // no BQ number yet (stage 3)
});

test("ลูกค้าใหม่ ขาดเบอร์โทร -> ถามเฉพาะเบอร์โทร -> ส่งเบอร์ -> สรุปให้ยืนยัน", () => {
  const start = startCheckout(CART, null);
  const step = send(start.state!, "บริษัท ไทยแน่ จำกัด สาขา บางนา\n99/1 ถ.พระราม 2 แขวงแสมดำ เขตบางขุนเทียน กรุงเทพฯ 10150", null);
  assert.equal(step.state?.stage, "collecting");
  assert.deepEqual(step.messages, ["ขอข้อมูลเพิ่มอีกนิดนะคะ รบกวนแจ้งเบอร์โทรค่ะ"]);
  assert.equal(step.state?.draft.branch, "สาขา บางนา");

  const step2 = send(step.state!, "02-123-4567 ค่ะ", null);
  assert.equal(step2.state?.stage, "confirm");
  assert.equal(step2.state?.draft.phone, "02-123-4567");
  assert.equal(step2.state?.draft.companyName, "บริษัท ไทยแน่ จำกัด");
});

test("ลูกค้าเก่ากด ใช่ -> ใช้ข้อมูลเดิมสร้างคำขอทันที", () => {
  const start = startCheckout(CART, SAVED);
  assert.equal(start.state?.stage, "useExisting");
  assert.match(start.messages.join("\n"), /ชื่อบริษัท: บริษัท ไทยแน่ จำกัด \(สำนักงานใหญ่\)/);
  assert.match(start.messages.at(-1)!, /ใช้ข้อมูลนี้ออกใบเสนอราคาไหมคะ \(ใช่ \/ แก้ไข\)$/);

  const done = send(start.state!, "ใช่", SAVED);
  assert.deepEqual(done.messages, [CHECKOUT_REPLY.requested]);
  assert.deepEqual(done.saveCustomer, { customer: SAVED, isNew: false });
  assert.equal(done.quote?.customer.phone, "081-234-5678");
  assert.equal(done.clearCart, true);
});

test("ลูกค้าเก่ากด แก้ไข -> ส่งเฉพาะเบอร์ใหม่ -> ยืนยันด้วยข้อมูลที่รวมแล้ว", () => {
  const start = startCheckout(CART, SAVED);
  const edit = send(start.state!, "แก้ไข", SAVED);
  assert.equal(edit.state?.stage, "collecting");
  const step = send(edit.state!, "เบอร์โทร 02-999-8888", SAVED);
  assert.equal(step.state?.stage, "confirm");
  assert.deepEqual(step.state?.draft, { ...SAVED, phone: "02-999-8888" });
});

test("ระหว่างรอข้อมูล ถามเรื่องอื่น / สั่งเพิ่ม -> ส่งต่อให้แชทปกติ ขั้นตอนและตะกร้ายังอยู่", () => {
  const start = startCheckout(CART, null);
  for (const t of ["ส่งต่างจังหวัดได้ไหมคะ", "L 1/2 ราคาเท่าไหร่", "เพิ่ม M 1/2 5 เส้น"]) {
    const r = send(start.state!, t, null);
    assert.equal(r.passThrough, true, t);
    assert.equal(r.state, undefined, t); // unchanged
    assert.equal(r.clearCart, undefined, t);
  }
  const confirm = send(start.state!, "1. บริษัท ไทยแน่ จำกัด (สำนักงานใหญ่)\n2. 99/1 ถ.พระราม 2 กรุงเทพฯ 10150\n3. 0812345678", null);
  assert.equal(send(confirm.state!, "ร้านเปิดกี่โมง", null).passThrough, true);
});

test("แก้ข้อมูลบริษัท ได้ทุกเมื่อ: บันทึกข้อมูลอย่างเดียว ไม่สร้างคำขอ", () => {
  const start = startEditCustomer(SAVED);
  const step = send(start.state!, "ที่อยู่: 1 ถ.สุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพฯ 10110", SAVED);
  assert.equal(step.state?.stage, "confirm");
  const done = send(step.state!, "ยืนยัน", SAVED, emptyCart());
  assert.equal(done.quote, undefined);
  assert.equal(done.clearCart, undefined);
  assert.equal(done.saveCustomer?.customer.address, "1 ถ.สุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพฯ 10110");
  assert.equal(done.saveCustomer?.isNew, false);
});

test("ยกเลิก: ออกจากขั้นตอน ตะกร้าไม่ถูกล้าง", () => {
  const r = send(startCheckout(CART, null).state!, "ยกเลิก", null);
  assert.deepEqual(r.messages, [CHECKOUT_REPLY.cancelled]);
  assert.equal(r.state, null);
  assert.equal(r.clearCart, undefined);
});
