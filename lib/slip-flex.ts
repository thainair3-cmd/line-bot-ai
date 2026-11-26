import type { messagingApi } from "@line/bot-sdk";

export type SlipStatus = "ok" | "duplicate" | "receiverMismatch";

/** Party as shown on the card. Account numbers are already masked by EasySlip; shown as-is. */
export type CardParty = { bankShort?: string; name?: string; account?: string };

export type SlipCard = {
  status: SlipStatus;
  amountText: string; // e.g. "22,090.64"
  dateText: string; // e.g. "25 พ.ย. 69 10:43"
  transRef: string;
  sender: CardParty;
  receiver: CardParty;
};

const THEME: Record<SlipStatus, { color: string; title: string }> = {
  ok: { color: "#06C755", title: "ตรวจสอบสลิปเรียบร้อย" },
  duplicate: { color: "#F59E0B", title: "สลิปนี้เคยส่งเข้ามาแล้ว" },
  receiverMismatch: { color: "#EF4444", title: "บัญชีผู้รับไม่ตรงกับร้าน" },
};

const LABEL_COLOR = "#8C8C8C";
const VALUE_COLOR = "#111111";

// Flex text must not be empty.
const orDash = (s: string | undefined) => (s && s.trim() ? s.trim() : "-");

function row(label: string, values: string[]): messagingApi.FlexBox {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "md",
    contents: [
      { type: "text", text: label, size: "sm", color: LABEL_COLOR, flex: 2 },
      {
        type: "box",
        layout: "vertical",
        flex: 5,
        contents: values.map(
          (v): messagingApi.FlexText => ({ type: "text", text: orDash(v), size: "sm", color: VALUE_COLOR, wrap: true }),
        ),
      },
    ],
  };
}

function partyLines(p: CardParty): string[] {
  const first = [p.bankShort, p.name].filter((s) => s && s.trim()).join(" ");
  return p.account ? [first, p.account] : [first];
}

export function buildSlipFlex(card: SlipCard): messagingApi.FlexMessage {
  const theme = THEME[card.status];

  const bubble: messagingApi.FlexBubble = {
    type: "bubble",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: theme.color,
      paddingAll: "lg",
      contents: [{ type: "text", text: theme.title, color: "#FFFFFF", weight: "bold", size: "md", wrap: true }],
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        {
          type: "text",
          text: `${card.amountText} ฿`,
          size: "xxl",
          weight: "bold",
          align: "center",
          color: VALUE_COLOR,
        },
        { type: "separator", margin: "lg" },
        {
          type: "box",
          layout: "vertical",
          spacing: "md",
          margin: "lg",
          contents: [
            row("จาก", partyLines(card.sender)),
            row("ผู้รับ", partyLines(card.receiver)),
            row("วันที่โอน", [card.dateText]),
            row("เลขอ้างอิง", [card.transRef]),
          ],
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      backgroundColor: theme.color,
      paddingAll: "md",
      contents: [{ type: "text", text: "ไทยแน่ (Thainair)", color: "#FFFFFF", size: "sm", align: "center" }],
    },
  };

  return {
    type: "flex",
    altText: `ผลตรวจสลิป ${card.amountText} บาท`,
    contents: bubble,
  };
}
