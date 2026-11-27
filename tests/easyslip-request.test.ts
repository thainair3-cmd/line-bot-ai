// Checks that the EasySlip v2 requests really carry a payload or an image file.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { EASYSLIP_VERIFY_URL, buildImageRequest, buildPayloadRequest, sniffImageType } from "../lib/easyslip-request.ts";

const KEY = "test-key";
const PAYLOAD = "0046000600000101030040220014242082547BPM049885102TH9104A1B2";

/** What fetch would put on the wire for this request. */
function toRequest(r: { headers: Record<string, string>; body: string | FormData }) {
  return new Request(EASYSLIP_VERIFY_URL, { method: "POST", headers: r.headers, body: r.body });
}

test("แบบ QR: JSON มี payload (trim แล้ว) + checkDuplicate และ Content-Type application/json", async () => {
  const r = buildPayloadRequest(`  ${PAYLOAD}\n`, KEY);
  assert.ok(r);
  assert.equal(r.headers["Content-Type"], "application/json");
  assert.equal(r.headers.Authorization, `Bearer ${KEY}`);
  const req = toRequest(r);
  assert.equal(req.headers.get("content-type"), "application/json");
  assert.deepEqual(await req.json(), { payload: PAYLOAD, checkDuplicate: true });
});

test("แบบ QR: payload ว่าง / ช่องว่าง / null -> ไม่สร้างคำขอ (ต้องส่งรูปแทน)", () => {
  assert.equal(buildPayloadRequest("", KEY), null);
  assert.equal(buildPayloadRequest("   \n", KEY), null);
  assert.equal(buildPayloadRequest(null, KEY), null);
  assert.equal(buildPayloadRequest(undefined, KEY), null);
});

test("แบบรูป: multipart มีไฟล์ image ชื่อ slip.jpg, type ถูก, ไบต์ตรงต้นฉบับ + checkDuplicate=true", async () => {
  const jpeg = await sharp({ create: { width: 400, height: 700, channels: 3, background: "#ddd" } }).jpeg().toBuffer();
  // A Buffer that is a view into a bigger pool, like the chunks read from LINE.
  const pooled = Buffer.concat([Buffer.alloc(13, 1), jpeg]).subarray(13);

  const r = buildImageRequest(pooled, KEY);
  assert.equal(r.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(Object.keys(r.headers).some((h) => h.toLowerCase() === "content-type"), false, "fetch must set the boundary");
  assert.ok(r.body instanceof FormData);

  const req = toRequest(r);
  assert.match(req.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);
  const raw = Buffer.from(await req.clone().arrayBuffer()).toString("latin1");
  assert.match(raw, /Content-Disposition: form-data; name="image"; filename="slip\.jpg"\r\nContent-Type: image\/jpeg/);
  assert.match(raw, /name="checkDuplicate"\r\n\r\ntrue/);

  const form = await req.formData();
  const file = form.get("image");
  assert.ok(file instanceof File);
  assert.equal(file.name, "slip.jpg");
  assert.equal(file.type, "image/jpeg");
  assert.equal(file.size, jpeg.length);
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(jpeg), "sends the original bytes");
  assert.equal(form.get("checkDuplicate"), "true");
});

test("แบบรูป: PNG ได้ slip.png / image/png", async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
  assert.deepEqual(sniffImageType(png), { mime: "image/png", ext: "png" });
  const file = (await toRequest(buildImageRequest(png, KEY)).formData()).get("image") as File;
  assert.equal(file.name, "slip.png");
  assert.equal(file.type, "image/png");
});
