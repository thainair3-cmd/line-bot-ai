import { HTTPFetchError, messagingApi, validateSignature, type WebhookEvent } from "@line/bot-sdk";
import { askGemini } from "@/lib/gemini";
import { getFaq } from "@/lib/sheet";
import { checkSlip, type SlipReply } from "@/lib/slip";
import { handleChat } from "@/lib/chat";
import { handleGroupText } from "@/lib/admin";
import { adminDeps } from "@/lib/admin-redis";
import { DEFAULT_REPLY, GROUP_JOIN_REPLY, GROUP_TRIGGER, UNSUPPORTED_MESSAGE_REPLY } from "@/lib/constants";

export const runtime = "nodejs";
export const maxDuration = 30;

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

/**
 * In a group, text is only for the bot when it starts with GROUP_TRIGGER (optionally "@น้องแอดมิน").
 * Returns the question with the trigger removed, or null if the message is not addressed to the bot.
 */
function groupQuestion(text: string): string | null {
  const t = text.trim().replace(/^@/, "");
  if (!t.startsWith(GROUP_TRIGGER)) return null;
  const rest = t.slice(GROUP_TRIGGER.length).replace(/^[\s,:：、]+/, "").trim();
  // Only the name was typed: let Gemini treat it as a greeting.
  return rest || GROUP_TRIGGER;
}

async function answerWithGemini(replyToken: string, question: string): Promise<void> {
  const faq = await getFaq();
  const answer = faq ? await askGemini(faq, question) : DEFAULT_REPLY;
  await reply(replyToken, answer);
}

async function handleEvent(event: WebhookEvent): Promise<void> {
  if (event.deliveryContext?.isRedelivery) return;

  const sourceType = event.source?.type ?? "unknown";
  const inGroup = sourceType === "group" || sourceType === "room";

  // Bot was invited into a group/room.
  if (event.type === "join") {
    console.log("EVENT", { type: "join", sourceType });
    await reply(event.replyToken, GROUP_JOIN_REPLY);
    return;
  }

  if (event.type !== "message") return;
  console.log("EVENT", { type: "message", messageType: event.message.type, sourceType });

  // Images are checked as transfer slips via EasySlip (never sent to Gemini).
  if (event.message.type === "image") {
    const slip = await checkSlip(event.message.id, event.message.contentProvider.type, { sourceType });
    if (slip) await replySlip(event.replyToken, slip); // null = stay silent (non-slip photo in a group)
    return;
  }

  if (inGroup) {
    // Groups: ignore stickers/video/audio/files and any text not addressed to "น้องแอดมิน".
    if (event.message.type !== "text") return;

    // "ตั้งเป็นกลุ่มแอดมิน <code>" in any group, and admin commands in the admin group.
    // In the admin group only commands get a reply (and slips, handled above).
    if (event.source.type === "group") {
      try {
        const admin = await handleGroupText(event.message.text, event.source.groupId, adminDeps());
        if (admin.handled) {
          if (admin.messages.length > 0) {
            await replyMessages(event.replyToken, admin.messages.map((text): messagingApi.Message => ({ type: "text", text })));
          }
          return;
        }
      } catch (err) {
        // e.g. Redis down mid-command; never log ids or the setup code.
        console.error("ADMIN_ERROR", { message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    const question = groupQuestion(event.message.text);
    if (question === null) return;
    await answerWithGemini(event.replyToken, question);
    return;
  }

  // 1:1 chat.
  if (event.message.type !== "text") {
    await reply(event.replyToken, UNSUPPORTED_MESSAGE_REPLY);
    return;
  }

  const userId = event.source.type === "user" ? event.source.userId : undefined;
  if (!userId) {
    await answerWithGemini(event.replyToken, event.message.text);
    return;
  }
  // Memory + order cart (Redis). Reply first, then save, all before the webhook returns 200.
  const chat = await handleChat(userId, event.message.text);
  await replyMessages(
    event.replyToken,
    chat.messages.map((text): messagingApi.Message => ({ type: "text", text })),
  );
  await chat.save();
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
