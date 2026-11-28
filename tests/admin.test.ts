import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleGroupText,
  quoteYYMM,
  sendDraftToAdminGroup,
  type AdminDeps,
  type AdminStore,
  type ApprovedQuote,
} from "../lib/admin.ts";
import type { QuoteRequest } from "../lib/checkout.ts";

const ADMIN = "Cadmin-group";
const OTHER = "Cother-group";
const CODE = "s3cret-42";
const NOW = new Date("2026-11-28T05:00:00Z"); // 28 พ.ย. 2569 (Bangkok)

function makeRequest(n: number): QuoteRequest {
  return {
    requestId: `QR-20261128-REQ${n}`,
    status: "pending",
    userId: `Ucustomer${n}`,
    customer: { companyName: "บริษัท ทดสอบ จำกัด", branch: "สำนักงานใหญ่", address: "1 ถ.สุขุมวิท กรุงเทพฯ 10110", phone: "02-111-2222" },
    items: [
      { code: "ST-013", name: "ท่อทองแดง L 1/2 x 0.89mm x 6m", unit: "เส้น", quantity: 10, unitPrice: 1130 },
      { code: "ST-024", name: "ท่อทองแดง M 1/2 x 0.51mm x 6m", unit: "เส้น", quantity: 20, unitPrice: 645 },
      { code: "AF-3438", name: "AEROFLEX:ฉนวนยางท่อ 3438 (หนา 3/4 ท่อ 3/8 ยาว 1.83ม.)", unit: "เส้น", quantity: 100, unitPrice: 120 },
    ],
    subtotal: 0,
    vat: 0,
    total: 0,
    createdAt: NOW.toISOString(),
  };
}

/** In-memory version of the Redis store. */
function memoryStore(initial: QuoteRequest[] = []) {
  let group: string | null = null;
  let shortSeq = 0;
  const requests = new Map<string, QuoteRequest>();
  const pending: string[] = [];
  const seqs = new Map<string, number>();
  const approved: ApprovedQuote[] = [];
  for (const r of initial) {
    requests.set(r.requestId, r);
    pending.push(r.requestId);
  }
  const store: AdminStore = {
    getAdminGroup: async () => group,
    setAdminGroup: async (id) => void (group = id),
    listPending: async () => pending.map((id) => requests.get(id)!),
    getByShortId: async (n) => [...requests.values()].find((r) => r.shortId === n) ?? null,
    ensureShortId: async (r) => {
      if (r.shortId) return r;
      const next = { ...r, shortId: ++shortSeq };
      requests.set(r.requestId, next);
      return next;
    },
    saveRequest: async (r) => void requests.set(r.requestId, r),
    removePending: async (id) => void pending.splice(pending.indexOf(id), 1),
    nextQuoteSeq: async (yymm) => {
      seqs.set(yymm, (seqs.get(yymm) ?? 0) + 1);
      return seqs.get(yymm)!;
    },
    saveApproved: async (q) => void approved.push(q),
  };
  return { store, requests, pending, approved, group: () => group };
}

function setup(initial: QuoteRequest[] = [], opts: { setupCode?: string } = { setupCode: CODE }) {
  const { setupCode } = opts;
  const mem = memoryStore(initial);
  const pushes: { to: string; messages: string[] }[] = [];
  const deps: AdminDeps = {
    store: mem.store,
    push: async (to, messages) => void pushes.push({ to, messages }),
    setupCode,
    now: () => NOW,
  };
  const say = (text: string, groupId = ADMIN) => handleGroupText(text, groupId, deps);
  return { mem, pushes, deps, say };
}

const customerPushes = (pushes: { to: string }[]) => pushes.filter((p) => p.to.startsWith("U"));

test("ตั้งกลุ่ม: รหัสผิด / ไม่มี env -> เงียบ, รหัสถูก -> ตั้งและส่งคำขอที่ค้างเข้ากลุ่ม", async () => {
  const noEnv = setup([], {}); // ADMIN_SETUP_CODE not set
  assert.deepEqual(await noEnv.say(`ตั้งเป็นกลุ่มแอดมิน ${CODE}`), { handled: true, messages: [] });
  assert.equal(noEnv.mem.group(), null);

  const t = setup([makeRequest(1), makeRequest(2)]);
  assert.deepEqual(await t.say("ตั้งเป็นกลุ่มแอดมิน wrong"), { handled: true, messages: [] });
  assert.equal(t.mem.group(), null);
  assert.equal(t.pushes.length, 0);

  assert.deepEqual(await t.say(`ตั้งเป็นกลุ่มแอดมิน${CODE}`), { handled: true, messages: ["ตั้งเป็นกลุ่มแอดมินเรียบร้อยค่ะ"] });
  assert.equal(t.mem.group(), ADMIN);
  assert.deepEqual(
    t.pushes.map((p) => p.to),
    [ADMIN, ADMIN],
  );
  const first = t.pushes[0].messages.join("\n");
  assert.match(first, /^📋 คำขอใบเสนอราคา #1\nลูกค้า: บริษัท ทดสอบ จำกัด \(สำนักงานใหญ่\)/);
  assert.match(first, /โทร: 02-111-2222/);
  assert.match(first, /1\. ท่อทองแดง L 1\/2 x 0\.89mm x 6m\n   10 เส้น × 1,130\.00 = 11,300\.00/);
  // 11,300 + 12,900 + 12,000 = 36,200 ; VAT 2,534 ; 38,734
  assert.match(first, /รวมเป็นเงิน 36,200\.00 บาท\nVAT 7% 2,534\.00 บาท\nรวมทั้งสิ้น 38,734\.00 บาท/);
  assert.match(first, /คำสั่ง: ส่วนลด #1/);
  assert.match(t.pushes[1].messages[0], /#2/);

  // Setting it again from another group replaces the old one.
  await t.say(`ตั้งเป็นกลุ่มแอดมิน ${CODE}`, OTHER);
  assert.equal(t.mem.group(), OTHER);
});

test("ในกลุ่มแอดมิน ข้อความอื่นเงียบ, กลุ่มอื่นไม่ใช่ของแอดมิน, คำสั่งผิดรูปแบบตอบตัวอย่าง", async () => {
  const t = setup([makeRequest(1)]);
  await t.say(`ตั้งเป็นกลุ่มแอดมิน ${CODE}`);
  assert.deepEqual(await t.say("สวัสดีค่ะ"), { handled: true, messages: [] });
  assert.deepEqual(await t.say("น้องแอดมิน ราคาท่อ"), { handled: true, messages: [] });
  assert.deepEqual(await t.say("ดู #1", OTHER), { handled: false, messages: [] });
  assert.match((await t.say("ส่วนลด #1 abc")).messages[0], /ตัวอย่าง: ส่วนลด #1 1-2=23% 3=43%/);
  assert.match((await t.say("ส่วนลด #1 5=10%")).messages[0], /ตัวอย่าง/); // only 3 lines
  assert.match((await t.say("อนุมัติ")).messages[0], /^คำสั่งกลุ่มแอดมิน:/);
  assert.deepEqual((await t.say("ดู #99")).messages, ["ไม่พบคำขอ #99 ค่ะ"]);
  assert.equal(
    (await t.say("รายการรอ")).messages[0],
    "คำขอที่รออนุมัติ 1 รายการ\n#1 บริษัท ทดสอบ จำกัด (สำนักงานใหญ่) · 3 รายการ · 38,734.00 บาท · ยังไม่เลือกบริษัท",
  );
  assert.match((await t.say("ดู#๑")).messages[0], /^📋 คำขอใบเสนอราคา #1/);
});

test("ส่วนลดหลายช่วง + ทั้งหมด (เลขไทย/ไม่มีเว้นวรรค)", async () => {
  const t = setup([makeRequest(1)]);
  await t.say(`ตั้งเป็นกลุ่มแอดมิน ${CODE}`);

  const draft = (await t.say("ส่วนลด #1 1-2=23% 3=43%")).messages.join("\n");
  // 10 × 1130 × 0.77 = 8,701.00 ; 20 × 645 × 0.77 = 9,933.00 ; 100 × 120 × 0.57 = 6,840.00
  assert.match(draft, /10 เส้น × 1,130\.00 ลด 23% = 8,701\.00/);
  assert.match(draft, /20 เส้น × 645\.00 ลด 23% = 9,933\.00/);
  assert.match(draft, /100 เส้น × 120\.00 ลด 43% = 6,840\.00/);
  assert.match(draft, /รวมเป็นเงิน 25,474\.00 บาท\nVAT 7% 1,783\.18 บาท\nรวมทั้งสิ้น 27,257\.18 บาท/);
  const saved = t.mem.requests.get("QR-20261128-REQ1")!;
  assert.deepEqual(
    saved.items.map((i) => i.discountPercent),
    [23, 23, 43],
  );
  assert.equal(saved.total, 27257.18);

  const all = (await t.say("ส่วนลด#๑ ทั้งหมด=๒๐%")).messages.join("\n");
  assert.match(all, /รวมเป็นเงิน 28,960\.00 บาท/); // 36,200 × 0.8
  assert.deepEqual(
    t.mem.requests.get("QR-20261128-REQ1")!.items.map((i) => i.discountPercent),
    [20, 20, 20],
  );
});

test("แก้ราคาต่อหน่วย", async () => {
  const t = setup([makeRequest(1)]);
  await t.say(`ตั้งเป็นกลุ่มแอดมิน ${CODE}`);
  const draft = (await t.say("ราคา #1 3=1,200")).messages.join("\n");
  assert.match(draft, /100 เส้น × 1,200\.00 \(เดิม 120\.00\) = 120,000\.00/);
  const item = t.mem.requests.get("QR-20261128-REQ1")!.items[2];
  assert.equal(item.unitPrice, 1200);
  assert.equal(item.listPrice, 120);
  assert.match((await t.say("ราคา #1 3=10%")).messages[0], /ตัวอย่าง: ราคา #1 3=1200/);
});

test("อนุมัติโดยยังไม่เลือกบริษัท -> เตือน ยังไม่ออกเลข", async () => {
  const t = setup([makeRequest(1)]);
  await t.say(`ตั้งเป็นกลุ่มแอดมิน ${CODE}`);
  const r = await t.say("อนุมัติ #1");
  assert.match(r.messages[0], /ยังไม่ได้เลือกบริษัทผู้ออกใบ/);
  assert.equal(t.mem.requests.get("QR-20261128-REQ1")!.status, "pending");
  assert.equal(t.mem.approved.length, 0);
  assert.equal(customerPushes(t.pushes).length, 0);
});

test("อนุมัติครบ -> BQ6911-0001 แจ้งลูกค้า, ใบต่อไป BQ6911-0002 (นับร่วมกันทั้ง 2 บริษัท)", async () => {
  assert.equal(quoteYYMM(NOW), "6911");
  const t = setup([makeRequest(1), makeRequest(2)]);
  await t.say(`ตั้งเป็นกลุ่มแอดมิน ${CODE}`);

  await t.say("ส่วนลด #1 ทั้งหมด=10%");
  assert.match((await t.say("บริษัท #1 วู่จิน")).messages.join("\n"), /บริษัทผู้ออกใบ: วู่จิน/);
  await t.say("อ้างอิง #1 PO-7788");
  assert.deepEqual((await t.say("อนุมัติ #1")).messages, ["อนุมัติ BQ6911-0001 แล้วค่ะ"]);

  const q = t.mem.approved[0];
  assert.equal(q.quoteNo, "BQ6911-0001");
  assert.equal(q.issuer, "wujin");
  assert.deepEqual(q.issuerCompany, {
    name: "บริษัท ไทยแน่ วู่จิน จำกัด",
    address: "224/50-52 ถนนหลานหลวง แขวงคลองมหานาค เขตป้อมปราบศัตรูพ่าย กรุงเทพฯ 10100",
    phone: "T:(092)514-1030 (02)-121-4505",
  });
  assert.equal(q.reference, "PO-7788");
  assert.equal(q.validityDays, 3);
  assert.equal(q.payment, "เงินสด");
  assert.equal(q.quoteDate, "2026-11-28");
  assert.equal(q.subtotal, 32580); // 36,200 × 0.9
  assert.equal(q.vat, 2280.6);
  assert.equal(q.total, 34860.6);
  assert.deepEqual(
    q.items.map((i) => i.lineTotal),
    [10170, 11610, 10800],
  );
  assert.equal(t.mem.requests.get("QR-20261128-REQ1")!.status, "approved");
  assert.deepEqual(t.mem.pending, ["QR-20261128-REQ2"]);

  const msg = t.pushes.find((p) => p.to === "Ucustomer1")!.messages.join("\n");
  assert.match(msg, /^ใบเสนอราคาเลขที่ BQ6911-0001 ค่ะ/);
  assert.match(msg, /ลด 10% = 10,170\.00/);
  assert.match(msg, /รวมทั้งสิ้น 34,860\.60 บาท/);
  assert.match(msg, /ไฟล์ใบเสนอราคาจะส่งตามมาค่ะ$/);

  assert.match((await t.say("อนุมัติ #1")).messages[0], /อนุมัติแล้ว \(BQ6911-0001\)/);

  await t.say("บริษัท #2 เครื่องเย็น");
  assert.deepEqual((await t.say("อนุมัติ #2")).messages, ["อนุมัติ BQ6911-0002 แล้วค่ะ"]);
  assert.equal(t.mem.approved[1].issuer, "kreungyen");
});

test("ยกเลิก -> rejected ออกจากคิว ไม่แจ้งลูกค้า", async () => {
  const t = setup([makeRequest(1)]);
  await t.say(`ตั้งเป็นกลุ่มแอดมิน ${CODE}`);
  assert.deepEqual((await t.say("ยกเลิก #1")).messages, ["ยกเลิกคำขอ #1 แล้วค่ะ"]);
  assert.equal(t.mem.requests.get("QR-20261128-REQ1")!.status, "rejected");
  assert.deepEqual(t.mem.pending, []);
  assert.equal(customerPushes(t.pushes).length, 0);
  assert.deepEqual((await t.say("รายการรอ")).messages, ["ไม่มีคำขอที่รออนุมัติค่ะ"]);
});

test("คำขอใหม่: ส่งร่างเข้ากลุ่มเมื่อมีกลุ่ม, ไม่มีกลุ่ม = เก็บในคิวเฉย ๆ", async () => {
  const t = setup();
  const req = await t.mem.store.ensureShortId(makeRequest(5));
  assert.equal(await sendDraftToAdminGroup(req, t.deps), false);
  assert.equal(t.pushes.length, 0);
  await t.say(`ตั้งเป็นกลุ่มแอดมิน ${CODE}`);
  assert.equal(await sendDraftToAdminGroup(req, t.deps), true);
  assert.equal(t.pushes.at(-1)!.to, ADMIN);
  assert.match(t.pushes.at(-1)!.messages[0], /#1/);
});
