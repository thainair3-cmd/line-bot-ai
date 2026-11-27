// QR decoding with images generated here (no real slips).
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import QRCode from "qrcode";
import { decodeQr } from "../lib/qr.ts";

// Same shape as a Thai slip "mini QR" payload (made-up values).
const PAYLOAD = "0046000600000101030040220014242082547BPM049885102TH9104A1B2";

const qrPng = (text: string, width: number) => QRCode.toBuffer(text, { type: "png", width, margin: 2 });

/** A portrait "slip screenshot": white page, grey text bars, QR placed where given. */
async function fakeSlip(opts: { qrWidth: number; left: number; top: number; format: "png" | "jpeg"; quality?: number }) {
  const W = 1080;
  const H = 1920;
  const bars = Array.from({ length: 12 }, (_, i) => ({
    input: { create: { width: 700, height: 28, channels: 3 as const, background: "#999999" } },
    left: 120,
    top: 200 + i * 90,
  }));
  const img = sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } }).composite([
    ...bars,
    { input: await qrPng(PAYLOAD, opts.qrWidth), left: opts.left, top: opts.top },
  ]);
  return opts.format === "jpeg" ? img.jpeg({ quality: opts.quality ?? 80 }).toBuffer() : img.png().toBuffer();
}

test("อ่าน QR ตรง ๆ (PNG)", async () => {
  const r = await decodeQr(await qrPng(PAYLOAD, 300));
  assert.equal(r.payload, PAYLOAD);
  assert.equal(r.attempt, "fit1000");
});

test("อ่าน QR ในรูปสลิปขนาดใหญ่ (QR มุมขวาล่าง, JPEG)", async () => {
  const r = await decodeQr(await fakeSlip({ qrWidth: 260, left: 760, top: 1560, format: "jpeg" }));
  assert.equal(r.payload, PAYLOAD);
});

test("QR เล็กที่ย่อแล้วอ่านไม่ได้ ยังอ่านได้จากรูปเดิมหรือการตัดครึ่งล่างขวา", async () => {
  // 120px QR in a 1080x1920 image: too small once shrunk to 1000px, so a later variant must read it.
  const r = await decodeQr(await fakeSlip({ qrWidth: 120, left: 900, top: 1760, format: "png" }));
  assert.equal(r.payload, PAYLOAD);
  assert.ok(r.attempts >= 1);
});

test("QR สีกลับ (พื้นดำ QR ขาว)", async () => {
  const inverted = await sharp(await qrPng(PAYLOAD, 300)).negate({ alpha: false }).png().toBuffer();
  const r = await decodeQr(inverted);
  assert.equal(r.payload, PAYLOAD);
  assert.equal(r.attempt, "fit1000-inverted");
});

test("รูปไม่มี QR / ไม่ใช่รูป: ได้ null ไม่ throw", async () => {
  const blank = await sharp({ create: { width: 800, height: 1200, channels: 3, background: "#f0f0f0" } }).jpeg().toBuffer();
  const r = await decodeQr(blank);
  assert.equal(r.payload, null);
  assert.equal(r.attempts, 7);
  assert.equal((await decodeQr(Buffer.from("not an image"))).payload, null);
});
