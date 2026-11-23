# line-bot-ai

LINE bot "น้องแอดมิน" ของ ไทยแน่ (Thainair) ตอบลูกค้าด้วย Gemini โดยใช้ FAQ จาก Google Sheet
Next.js 14 (App Router) + TypeScript, deploy บน Vercel

## โครงสร้าง

```
app/page.tsx                   หน้าเช็กสถานะ "Thainair LINE bot is running"
app/api/line-webhook/route.ts  Webhook: ตรวจ signature, ดึง FAQ, ถาม Gemini, ตอบกลับ
lib/sheet.ts                   ดึง FAQ (CSV) จาก Google Sheet + cache 60 วินาที
lib/gemini.ts                  System prompt + เรียก Gemini + ทำความสะอาดคำตอบ
lib/constants.ts               DEFAULT_REPLY และค่าคงที่
vercel.json                    { "framework": "nextjs" } กัน Vercel มองเป็น Other แล้ว 404
```

## Google Sheet

แถวแรกเป็นหัวคอลัมน์: `category | question | answer`
เผยแพร่ด้วย File > Share > Publish to web > CSV แล้วเอาลิงก์ที่ลงท้าย `/pub?output=csv` ไปใส่ `SHEET_CSV_URL`

## Env vars

`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `GEMINI_API_KEY`, `SHEET_CSV_URL`
ทดสอบในเครื่องใส่ใน `.env.local` (ไม่ถูก commit)

## รัน

```bash
npm install
npm run build
npm run dev
```

Webhook URL ใน LINE Developers Console: `https://<vercel-domain>/api/line-webhook`
