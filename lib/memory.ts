import { redisOp } from "./redis";
import {
  CART_TTL_SECONDS,
  CHECKOUT_TTL_SECONDS,
  MEMORY_MAX_MESSAGES,
  MEMORY_MAX_TEXT_LENGTH,
  MEMORY_TTL_SECONDS,
} from "./constants";
import type { CheckoutState, Customer, QuoteRequest } from "./checkout";
import type { Cart } from "./cart-ops";

export type HistoryEntry = { role: "user" | "bot"; text: string };

const historyKey = (userId: string) => `chat:history:${userId}`;
const cartKey = (userId: string) => `chat:cart:${userId}`;

/** Last MEMORY_MAX_MESSAGES messages (oldest first). Empty if Redis is unavailable. */
export async function loadHistory(userId: string): Promise<HistoryEntry[]> {
  const items = await redisOp("loadHistory", (r) => r.lrange<HistoryEntry>(historyKey(userId), 0, -1));
  return (items ?? []).filter((e) => e && typeof e.text === "string" && (e.role === "user" || e.role === "bot"));
}

/** Appends the messages, keeps only the last MEMORY_MAX_MESSAGES and refreshes the 24h TTL. */
export async function appendHistory(userId: string, entries: HistoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const key = historyKey(userId);
  const trimmed = entries.map((e) => ({ role: e.role, text: e.text.slice(0, MEMORY_MAX_TEXT_LENGTH) }));
  await redisOp("appendHistory", (r) =>
    r
      .multi()
      .rpush(key, ...trimmed)
      .ltrim(key, -MEMORY_MAX_MESSAGES, -1)
      .expire(key, MEMORY_TTL_SECONDS)
      .exec(),
  );
}

export function formatHistory(history: HistoryEntry[]): string {
  return history.map((e) => `${e.role === "user" ? "ลูกค้า" : "น้องแอดมิน"}: ${e.text.replace(/\s+/g, " ")}`).join("\n");
}

/** Returns null if Redis failed (caller continues with an empty cart). */
export async function loadCart(userId: string): Promise<Cart | null> {
  const cart = await redisOp("loadCart", (r) => r.get<Cart>(cartKey(userId)));
  if (cart === null) return null;
  return {
    lines: Array.isArray(cart?.lines) ? cart.lines : [],
    pending: Array.isArray(cart?.pending) ? cart.pending : [],
  };
}

/** Saves the cart for 3 days (TTL is refreshed on every change); an empty cart deletes the key. */
export async function saveCart(userId: string, cart: Cart): Promise<boolean> {
  const key = cartKey(userId);
  const empty = cart.lines.length === 0 && cart.pending.length === 0;
  const ok = await redisOp("saveCart", async (r) => {
    if (empty) await r.del(key);
    else await r.set(key, cart, { ex: CART_TTL_SECONDS });
    return true;
  });
  return ok === true;
}


// ---- Customers, checkout and quote requests (1:1 chat) ----


const customerKey = (userId: string) => `customer:${userId}`; // no expiry: reused next time
const checkoutKey = (userId: string) => `chat:checkout:${userId}`;
const quoteRequestKey = (requestId: string) => `quote:request:${requestId}`; // no expiry
export const QUOTE_PENDING_LIST = "quote:pending"; // requestIds waiting for admin approval (stage 3)

export async function loadCustomer(userId: string): Promise<Customer | null> {
  return redisOp("loadCustomer", (r) => r.get<Customer>(customerKey(userId)));
}

export async function saveCustomer(userId: string, customer: Customer): Promise<boolean> {
  const ok = await redisOp("saveCustomer", async (r) => {
    await r.set(customerKey(userId), customer);
    return true;
  });
  return ok === true;
}

export async function loadCheckout(userId: string): Promise<CheckoutState | null> {
  return redisOp("loadCheckout", (r) => r.get<CheckoutState>(checkoutKey(userId)));
}

/** null clears the checkout. Expires like the cart if the customer never finishes. */
export async function saveCheckout(userId: string, state: CheckoutState | null): Promise<boolean> {
  const key = checkoutKey(userId);
  const ok = await redisOp("saveCheckout", async (r) => {
    if (state) await r.set(key, state, { ex: CHECKOUT_TTL_SECONDS });
    else await r.del(key);
    return true;
  });
  return ok === true;
}

/** Stores the pending quote request and queues it for the admin. Returns false if Redis failed. */
export async function saveQuoteRequest(req: QuoteRequest): Promise<boolean> {
  const ok = await redisOp("saveQuoteRequest", async (r) => {
    await r.multi().set(quoteRequestKey(req.requestId), req).lpush(QUOTE_PENDING_LIST, req.requestId).exec();
    return true;
  });
  return ok === true;
}
