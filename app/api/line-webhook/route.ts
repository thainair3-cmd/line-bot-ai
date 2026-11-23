import { HTTPFetchError, messagingApi, validateSignature, type WebhookEvent } from "@line/bot-sdk";
import { askGemini } from "@/lib/gemini";
import { getFaq } from "@/lib/sheet";
import { DEFAULT_REPLY, NON_TEXT_REPLY } from "@/lib/constants";

export const runtime = "nodejs";
export const maxDuration = 10;

let lineClient: messagingApi.MessagingApiClient | null = null;
function getLineClient(): messagingApi.MessagingApiClient {
  if (!lineClient) {
    lineClient = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
    });
  }
  return lineClient;
}

async function reply(replyToken: string, text: string): Promise<void> {
  try {
    await getLineClient().replyMessage({
      replyToken,
      messages: [{ type: "text", text }],
    });
  } catch (err) {
    if (err instanceof HTTPFetchError) {
      console.error("LINE_REPLY_ERROR", { status: err.status, body: err.body });
    } else {
      console.error("LINE_REPLY_ERROR", { status: null, body: err instanceof Error ? err.message : String(err) });
    }
  }
}

async function handleEvent(event: WebhookEvent): Promise<void> {
  if (event.deliveryContext?.isRedelivery) return;
  if (event.type !== "message") return;

  if (event.message.type !== "text") {
    await reply(event.replyToken, NON_TEXT_REPLY);
    return;
  }

  const faq = await getFaq();
  const answer = faq ? await askGemini(faq, event.message.text) : DEFAULT_REPLY;
  await reply(event.replyToken, answer);
}

export async function POST(req: Request): Promise<Response> {
  try {
    // Raw body first: signature validation needs the exact bytes LINE sent.
    const body = await req.text();
    const signature = req.headers.get("x-line-signature") ?? "";
    const secret = process.env.LINE_CHANNEL_SECRET ?? "";

    if (!signature || !secret || !validateSignature(body, secret, signature)) {
      return new Response("Invalid signature", { status: 401 });
    }

    const { events } = JSON.parse(body) as { events?: WebhookEvent[] };
    // Empty events = the "Verify" button in LINE Developers Console.
    if (!events || events.length === 0) return new Response("OK", { status: 200 });

    // Finish all work before responding: Vercel may freeze the function after the response.
    const results = await Promise.allSettled(events.map(handleEvent));
    for (const r of results) {
      if (r.status === "rejected") console.error("EVENT_ERROR", r.reason);
    }
  } catch (err) {
    console.error("WEBHOOK_ERROR", err instanceof Error ? err.message : String(err));
  }

  // Always 200 so LINE does not redeliver.
  return new Response("OK", { status: 200 });
}
