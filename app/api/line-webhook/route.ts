import { HTTPFetchError, messagingApi, validateSignature, type WebhookEvent } from "@line/bot-sdk";
import { askGemini } from "@/lib/gemini";
import { getFaq } from "@/lib/sheet";
import { checkSlip, type SlipReply } from "@/lib/slip";
import { DEFAULT_REPLY, UNSUPPORTED_MESSAGE_REPLY } from "@/lib/constants";

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

function logReplyError(tag: string, err: unknown): void {
  if (err instanceof HTTPFetchError) {
    console.error(tag, { status: err.status, body: err.body });
  } else {
    console.error(tag, { status: null, body: err instanceof Error ? err.message : String(err) });
  }
}

async function replyMessages(replyToken: string, messages: messagingApi.Message[]): Promise<void> {
  try {
    await getLineClient().replyMessage({ replyToken, messages });
  } catch (err) {
    logReplyError("LINE_REPLY_ERROR", err);
  }
}

async function reply(replyToken: string, text: string): Promise<void> {
  await replyMessages(replyToken, [{ type: "text", text }]);
}

/**
 * Sends the slip result (Flex card + text). If LINE rejects it with 400 (e.g. invalid Flex),
 * logs FLEX_ERROR and sends the plain-text version instead; a rejected request does not use up the replyToken.
 */
async function replySlip(replyToken: string, slip: SlipReply): Promise<void> {
  try {
    await getLineClient().replyMessage({ replyToken, messages: slip.messages });
  } catch (err) {
    if (err instanceof HTTPFetchError && err.status === 400 && slip.fallbackText) {
      // LINE's 400 body names the invalid property path, not the message values.
      logReplyError("FLEX_ERROR", err);
      await reply(replyToken, slip.fallbackText);
    } else {
      logReplyError("LINE_REPLY_ERROR", err);
    }
  }
}

async function handleEvent(event: WebhookEvent): Promise<void> {
  if (event.deliveryContext?.isRedelivery) return;
  if (event.type !== "message") return;

  // Images are checked as transfer slips via EasySlip (never sent to Gemini).
  if (event.message.type === "image") {
    const slip = await checkSlip(event.message.id, event.message.contentProvider.type);
    await replySlip(event.replyToken, slip);
    return;
  }

  if (event.message.type !== "text") {
    await reply(event.replyToken, UNSUPPORTED_MESSAGE_REPLY);
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
