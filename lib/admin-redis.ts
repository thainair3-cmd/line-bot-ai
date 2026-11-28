// Redis-backed AdminStore and LINE push for the admin group (quote stage 3).
import { HTTPFetchError, messagingApi } from "@line/bot-sdk";
import type { Redis } from "@upstash/redis";
import { redisOp } from "./redis";
import type { AdminDeps, AdminStore, ApprovedQuote } from "./admin";
import type { QuoteRequest } from "./checkout";

// Keys (no expiry: quotes are business records).
const ADMIN_GROUP_KEY = "admin:groupId";
const SHORT_SEQ_KEY = "quote:shortSeq"; // INCR -> #1, #2, ...
const shortKey = (n: number) => `quote:short:${n}`; // -> requestId
const requestKey = (requestId: string) => `quote:request:${requestId}`;
const PENDING_LIST = "quote:pending"; // requestIds, newest first (LPUSH)
const quoteSeqKey = (yymm: string) => `quote:seq:${yymm}`; // INCR -> BQ{yymm}-nnnn, shared by both issuers
const approvedKey = (quoteNo: string) => `quote:approved:${quoteNo}`;

/** Redis call that must succeed (throws instead of returning null). Keys/values are never logged. */
async function must<T>(op: string, fn: (r: Redis) => Promise<T>): Promise<T> {
  const ok = await redisOp(op, async (r) => ({ value: await fn(r) }));
  if (!ok) throw new Error(`Redis unavailable (${op})`);
  return ok.value;
}

async function assignShortId(req: QuoteRequest): Promise<QuoteRequest> {
  const shortId = await must("nextShortId", (r) => r.incr(SHORT_SEQ_KEY));
  const withId = { ...req, shortId };
  await must("saveShortId", (r) =>
    r.multi().set(requestKey(req.requestId), withId).set(shortKey(shortId), req.requestId).exec(),
  );
  return withId;
}

export const redisAdminStore: AdminStore = {
  async getAdminGroup() {
    return (await redisOp("getAdminGroup", (r) => r.get<string>(ADMIN_GROUP_KEY))) ?? null;
  },
  async setAdminGroup(groupId) {
    await must("setAdminGroup", (r) => r.set(ADMIN_GROUP_KEY, groupId));
  },
  async listPending() {
    const ids = await must("listPending", (r) => r.lrange<string>(PENDING_LIST, 0, -1));
    if (ids.length === 0) return [];
    const reqs = await must("loadPending", (r) => r.mget<(QuoteRequest | null)[]>(...ids.map(requestKey)));
    return reqs.filter((q): q is QuoteRequest => Boolean(q)).reverse(); // oldest first
  },
  async getByShortId(shortId) {
    const requestId = await must("getShortId", (r) => r.get<string>(shortKey(shortId)));
    if (!requestId) return null;
    return must("getRequest", (r) => r.get<QuoteRequest>(requestKey(requestId)));
  },
  async ensureShortId(req) {
    return req.shortId ? req : assignShortId(req);
  },
  async saveRequest(req) {
    await must("saveRequest", (r) => r.set(requestKey(req.requestId), req));
  },
  async removePending(requestId) {
    await must("removePending", (r) => r.lrem(PENDING_LIST, 0, requestId));
  },
  async nextQuoteSeq(yymm) {
    return must("nextQuoteSeq", (r) => r.incr(quoteSeqKey(yymm)));
  },
  async saveApproved(q: ApprovedQuote) {
    await must("saveApproved", (r) => r.set(approvedKey(q.quoteNo), q));
  },
};

/**
 * Stores a new quote request with its short id (#n) and queues it as pending.
 * Returns the saved request, or null if Redis failed.
 */
export async function queueQuoteRequest(req: QuoteRequest): Promise<QuoteRequest | null> {
  try {
    const shortId = await must("nextShortId", (r) => r.incr(SHORT_SEQ_KEY));
    const saved = { ...req, shortId };
    await must("queueQuoteRequest", (r) =>
      r
        .multi()
        .set(requestKey(req.requestId), saved)
        .set(shortKey(shortId), req.requestId)
        .lpush(PENDING_LIST, req.requestId)
        .exec(),
    );
    return saved;
  } catch {
    return null; // MEMORY_ERROR already logged
  }
}

// ---- LINE push ----

let client: messagingApi.MessagingApiClient | null = null;
function lineClient(): messagingApi.MessagingApiClient {
  if (!client) {
    client = new messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "" });
  }
  return client;
}

/** Push text messages to a group or user. Logs LINE_PUSH_ERROR (status only, never the id). */
export async function linePush(to: string, messages: string[]): Promise<void> {
  if (messages.length === 0) return;
  try {
    await lineClient().pushMessage({ to, messages: messages.slice(0, 5).map((text) => ({ type: "text", text })) });
  } catch (err) {
    console.error("LINE_PUSH_ERROR", {
      status: err instanceof HTTPFetchError ? err.status : null,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function adminDeps(): AdminDeps {
  return { store: redisAdminStore, push: linePush, setupCode: process.env.ADMIN_SETUP_CODE };
}
