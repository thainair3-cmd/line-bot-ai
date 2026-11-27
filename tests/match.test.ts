// Product names copied from the real "สินค้า" sheet (PRODUCTS_CSV_URL sample).
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchProducts, tokenize, type Product } from "../lib/match.ts";
import { parseCsv } from "../lib/csv.ts";
import { parsePrice } from "../lib/pricing.ts";

const CSV = `รหัสสินค้า,ชื่อสินค้า,หน่วย,ราคาต่อหน่วย
ST-001,ท่อทองแดง K 3/8 x 0.89mm x 6M,เส้น,940
ST-013,ท่อทองแดง L 1/2 x 0.89mm x 6m,เส้น,1130
ST-024,ท่อทองแดง M 1/2 x 0.51mm x 6m,เส้น,645
FT-001,"ข้องอ 90° ทองแดง ขนาด 1/4""",ตัว,35
FT-027,"ข้องอ 45° ทองแดง ขนาด 3-1/8""",ตัว,990
FT-087,"ข้อต่อเกลียวใน ทองแดง ขนาด 3/8"" x 1/4""",ตัว,100
FT-167,"ข้อโค้ง 180° ทองแดง ขนาด 1/2""",ตัว,45
CO-003,ท่อม้วนทองแดง เบอร์18 ขนาด 3/8 ความหนา 1.2mm ความยาว 15m,ม้วน,2519.3
CO-020,ท่อม้วนทองแดง เบอร์22 ขนาด 5/16 ความหนา 0.7mm ความยาว 15m,ม้วน,1236.25
AF-1414,"AEROFLEX:ฉนวนยางท่อ 1414 (หนา 1/4"" ท่อ 1/4"" ยาว 1.83ม.)",เส้น,36
AF-12138,"AEROFLEX:ฉนวนยางท่อ 12138 (หนา 1/2"" ท่อ 1-3/8"" ยาว 1.83ม.)",เส้น,120
AF-11434,"AEROFLEX:ฉนวนยางท่อ 11434 (หนา 1-1/4"" ท่อ 3/4"" ยาว 1.83ม.)",เส้น,260
AF-P123200,"AEROFLEX:ฉนวนยางแผ่นตัดสำเร็จ P123200 (หนา 1/2"" สำหรับ 32""IPS (104""x48""))",แผ่น,1440
AF-S1243A,"AEROFLEX:ฉนวนยางแผ่นเคลือบกาว S1243A (3x4 ฟุต หนา 1/2"")",แผ่น,660
AF-AFSR12APP,"AEROFLEX:ฉนวนยางม้วนเอ็กซ์ตร้าเคลือบกาว AFSR12APP (กว้าง 4 ฟุต หนา 1/2"")",ม้วน,10140`;

const P: Product[] = parseCsv(CSV)
  .slice(1)
  .map(([code, name, unit, price]) => ({ code, name, unit, price: parsePrice(price)! }));
// Not in the sample: added to check that 1/2 and 1-1/2 are never confused.
P.push({ code: "ST-TEST", name: "ท่อทองแดง L 1-1/2 x 1.27mm x 6m", unit: "เส้น", price: 4000 });

function match(q: string): string {
  const m = matchProducts(q, P);
  if (m.kind === "one") return m.product.code;
  if (m.kind === "many") return `many:${m.products.map((p) => p.code).join(",")}`;
  return "none";
}

test("ท่อเส้นตรง: K/L/M + ขนาด (ไม่มีคำว่า Type)", () => {
  assert.equal(match("ท่อ L 1/2"), "ST-013");
  assert.equal(match("ท่อทองแดง M 1/2"), "ST-024");
  assert.equal(match("K 3/8"), "ST-001");
  assert.equal(match("Type L 1/2\""), "ST-013");
  assert.equal(match("K 1/2"), "none");
});

test("6m / 6M (ความยาว) ไม่ถูกอ่านเป็น Type M", () => {
  assert.ok(!tokenize("ท่อทองแดง K 3/8 x 0.89mm x 6M").includes("m"));
  assert.equal(match("M 3/8"), "none");
});

test("ภาษาไทย เค/แอล/เอ็ม และ หุน", () => {
  assert.equal(match("ท่อแอล 4 หุน"), "ST-013");
  assert.equal(match("เอ็ม 4 หุน"), "ST-024");
  assert.equal(match("ท่อทองแดง เค 3 หุน"), "ST-001");
  assert.equal(match("ท่อ L 1/2 หนา 0.89"), "ST-013");
});

test("1/2 กับ 1-1/2 ห้ามสับสน (รวม 1.1/2 และ 1 1/2)", () => {
  assert.equal(match("L 1/2"), "ST-013");
  assert.equal(match("L 1-1/2"), "ST-TEST");
  assert.equal(match("L 1.1/2"), "ST-TEST");
  assert.equal(match("แอล 1 1/2"), "ST-TEST");
  assert.equal(match("L 12 หุน"), "ST-TEST");
});

test("ข้อต่อ: ประเภท + องศา + ขนาด", () => {
  assert.equal(match("ข้องอ 90 1/4"), "FT-001");
  assert.equal(match("ข้องอ 90° 2 หุน"), "FT-001");
  assert.equal(match("ข้องอ 45 องศา 3.1/8"), "FT-027");
  assert.equal(match("ข้องอ 45 3 1/8\""), "FT-027");
  assert.equal(match("ข้องอ 45 1/8"), "none");
  assert.equal(match("ข้อต่อเกลียวใน 3/8 x 1/4"), "FT-087");
  assert.equal(match("ข้อโค้ง 4 หุน"), "FT-167");
});

test("ท่อม้วน: เบอร์ หรือ ความหนา", () => {
  assert.equal(match("ท่อม้วน 3/8 เบอร์18"), "CO-003");
  assert.equal(match("ท่อม้วน 3/8 1.2"), "CO-003");
  assert.equal(match("ท่อม้วน 5/16 เบอร์ 22"), "CO-020");
  assert.equal(match("ท่อม้วน 5/16 0.7"), "CO-020");
  assert.equal(match("ท่อม้วน 5/16 0.7 มม."), "CO-020");
  assert.equal(match("ท่อม้วน 3/8 เบอร์22"), "none");
});

test("AEROFLEX: รหัส และ ยาง X ท่อ Y", () => {
  assert.equal(match("1414"), "AF-1414");
  assert.equal(match("AF-12138"), "AF-12138");
  assert.equal(match("aeroflex 11434"), "AF-11434");
  assert.equal(match("ยาง 1/2 ท่อ 1-3/8"), "AF-12138");
  assert.equal(match("ยาง 2 หุน ท่อ 2 หุน"), "AF-1414");
  assert.equal(match("ฉนวน 1.1/4 ท่อ 6 หุน"), "AF-11434");
  assert.equal(match("ท่อ 3/4 หนา 1-1/4"), "AF-11434");
  // Reversed sizes is a different code (3/4 thick on 1-1/4 pipe), not in the sample.
  assert.equal(match("ยาง 3/4 ท่อ 1-1/4"), "none");
  assert.equal(match("1413"), "none");
});

test("AEROFLEX แผ่น/ม้วน: รหัสในวงเล็บตรงทุกตัว", () => {
  assert.equal(match("P123200"), "AF-P123200");
  assert.equal(match("S1243A"), "AF-S1243A");
  assert.equal(match("afsr12app"), "AF-AFSR12APP");
  assert.equal(match("P12320"), "none");
});

test("คำกว้างได้หลายตัวให้ถามเลือก", () => {
  assert.equal(match("ทองแดง 1/2"), "many:ST-013,ST-024,FT-167");
});

test("ราคาจาก CSV", () => {
  assert.equal(P.find((p) => p.code === "CO-003")!.price, 2519.3);
  assert.equal(P.find((p) => p.code === "AF-AFSR12APP")!.price, 10140);
});

// Cases that failed when testing all 636 real products (fixed): a few names copied from the sheet.
const R: Product[] = [
  ["FT-006", 'ข้องอ 90° ทองแดง ขนาด 7/8"'],
  ["FT-106", 'ข้องอ 90° ทองแดง รัศมียาว ขนาด 7/8"'],
  ["FT-048", 'สามทาง ทองแดง ขนาด 1/2"'],
  ["FT-114", 'สามทางลด ทองแดง ขนาด 1/2" x 1/2" x 1/4"'],
  ["FT-115", 'สามทางลด ทองแดง ขนาด 1/2" x 1/2" x 3/8"'],
  ["FT-062", 'ข้อต่อเกลียวนอก ทองแดง ขนาด 3/8" x 1/2"'],
  ["FT-063", 'ข้อต่อเกลียวนอก ทองแดง ขนาด 1/2" x 3/8"'],
  ["FT-064", 'ข้อต่อเกลียวนอก ทองแดง ขนาด 1/2" x 1/2"'],
  ["AF-1410", 'AEROFLEX:ฉนวนยางท่อ 1410 (หนา 1/4" ท่อ 1" ยาว 1.83ม.)'],
  ["AF-1210", 'AEROFLEX:ฉนวนยางท่อ 1210 (หนา 1/2" ท่อ 1" ยาว 1.83ม.)'],
  ["AF-12200", 'AEROFLEX:ฉนวนยางท่อ 12200 (หนา 1/2" ท่อ 2" ยาว 1.83ม.)'],
  ["AF-2058", 'AEROFLEX:ฉนวนยางท่อ 2058 (หนา 2" ท่อ 5/8" ยาว 1.83ม.)'],
  ["AF-M63022PP", 'AEROFLEX:ฉนวนยางท่อ M63022PP (หนา 2-1/2" ท่อ 7/8" ยาว 2ม.)'],
].map(([code, name]) => ({ code, name, unit: "ตัว", price: 1 }));

function matchR(q: string): string {
  const m = matchProducts(q, R);
  if (m.kind === "one") return m.product.code;
  return m.kind === "many" ? `many:${m.products.map((p) => p.code).join(",")}` : "none";
}

test("ชื่อเต็มทุกตัวต้องได้ตัวเอง (ชุดที่เคยไม่ผ่าน)", () => {
  for (const p of R) assert.equal(matchR(p.name), p.code, p.name);
});

test("ข้อต่อ: เลือกตัวที่ไม่มีขนาดเกิน / ลำดับขนาดตรง / คำเกินน้อยสุด", () => {
  assert.equal(matchR("สามทาง 1/2"), "FT-048");
  assert.equal(matchR("สามทางลด 1/2 x 1/2 x 1/4"), "FT-114");
  assert.equal(matchR("สามทางลด 1/2"), "many:FT-114,FT-115");
  assert.equal(matchR("ข้องอ 90 7/8"), "FT-006");
  assert.equal(matchR("ข้องอ 7/8 รัศมียาว"), "FT-106");
  assert.equal(matchR("เกลียวนอก 3/8 x 1/2"), "FT-062");
  assert.equal(matchR("เกลียวนอก 1/2 x 3/8"), "FT-063");
  assert.equal(matchR("เกลียวนอก 4 หุน x 4 หุน"), "FT-064");
});

test("AEROFLEX ขนาดเต็มนิ้วและรหัสเมตริก: เทียบหนา/ท่อตามลำดับ", () => {
  assert.equal(matchR("ยาง 1/4 ท่อ 1 นิ้ว"), "AF-1410");
  assert.equal(matchR("ยาง 4 หุน ท่อ 1\""), "AF-1210");
  assert.equal(matchR("หนา 1/2 ท่อ 2"), "AF-12200");
  assert.equal(matchR("ยาง 2 นิ้ว ท่อ 5 หุน"), "AF-2058");
  assert.equal(matchR("ยาง 2-1/2 ท่อ 7/8"), "AF-M63022PP");
  assert.equal(matchR("ยาง 1 ท่อ 1/4"), "none"); // reversed AF-1410
  assert.equal(matchR("M63022PP"), "AF-M63022PP");
});
