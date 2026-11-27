// 1:1 chat: conversation memory + order cart. Group chats do not use this module.
import { askGeminiChat, type ChatAction } from "./gemini";
import { ruleBasedAction } from "./order-parse";
import { getFaq } from "./sheet";
import { getProducts } from "./products";
import { appendHistory, formatHistory, loadCart, loadHistory, saveCart } from "./memory";
import {
  CLEAR_RE,
  addItems,
  cartSubtotalSatang,
  choosePending,
  emptyCart,
  formatPendingQuestion,
  formatPriceReply,
  formatSummary,
  parseChoice,
  parseRemoveLines,
  removeItems,
  setItems,
  type Cart,
  type CartResult,
} from "./cart-ops";
import { formatQuantity } from "./pricing";
import { CHAT_GEMINI_DEADLINE_MS, DEFAULT_REPLY, LINE_TEXT_MAX_LENGTH } from "./constants";

const PRODUCTS_UNAVAILABLE =
  "ขออภัยค่ะ ตอนนี้ระบบรายการสินค้าขัดข้องชั่วคราว เดี๋ยวแอดมินช่วยทำใบเสนอราคาให้นะคะ 🙏";

const formatCartForPrompt = (cart: Cart) =>
  cart.lines.map((l, i) => `${i + 1}. ${l.name} × ${formatQuantity(l.quantity)}${l.unit ? ` ${l.unit}` : ""}`).join("\n");

/** Summary (if anything is in the cart), then notes and the "which one?" question. */
function cartReply(r: CartResult, alwaysShowSummary: boolean): string[] {
  const messages: string[] = [];
  if (alwaysShowSummary || (r.changed && r.cart.lines.length > 0)) messages.push(formatSummary(r.cart));
  const extra = [...r.notes, formatPendingQuestion(r.cart)].filter((s): s is string => Boolean(s));
  if (extra.length) messages.push(extra.join("\n\n"));
  if (messages.length === 0) messages.push(formatSummary(r.cart));
  return messages.map((m) => m.slice(0, LINE_TEXT_MAX_LENGTH));
}

/**
 * Handles one 1:1 text message and returns the reply messages (1–2 texts).
 * Redis failures are logged as MEMORY_ERROR and the bot continues without memory/cart.
 */
export async function handleChat(userId: string, text: string): Promise<{ messages: string[]; save: () => Promise<void> }> {
  const startedAt = Date.now();
  // Start the product fetch now so it runs alongside Gemini; it is only awaited for orders.
  const productsPromise = getProducts();
  const [faq, history, storedCart] = await Promise.all([getFaq(), loadHistory(userId), loadCart(userId)]);
  const cart = storedCart ?? emptyCart();

  let result: CartResult | null = null;
  let messages: string[] = [];
  let alwaysShowSummary = false;

  const choice = cart.pending.length > 0 ? parseChoice(text) : null;
  const removeLines = parseRemoveLines(text);

  if (choice !== null) {
    result = choosePending(cart, choice);
  } else if (CLEAR_RE.test(text)) {
    result = { cart: emptyCart(), notes: ["ล้างตะกร้าเรียบร้อยแล้วค่ะ"], changed: cart.lines.length > 0 || cart.pending.length > 0 };
  } else if (removeLines) {
    result = removeItems(cart, removeLines, []);
    alwaysShowSummary = true;
  } else {
    const budgetMs = CHAT_GEMINI_DEADLINE_MS - (Date.now() - startedAt);
    let action: ChatAction | null = await askGeminiChat(
      faq ?? "(ไม่มีข้อมูล)",
      formatHistory(history),
      formatCartForPrompt(cart),
      text,
      budgetMs,
    );

    // Gemini failed, returned unparseable output, or handed over to staff: if the message names
    // products we can match (with quantities, or a price question), handle it without AI.
    if (!action || (action.action === "answer" && action.reply === DEFAULT_REPLY)) {
      const products = await productsPromise;
      const rule = products ? ruleBasedAction(text, products) : null;
      if (rule) {
        console.log("INTENT", { source: "rules", action: rule.action, itemCount: rule.items.length, parseOk: true });
        action = rule;
      }
    }
    action ??= { action: "answer", reply: DEFAULT_REPLY };

    if (action.action === "answer") {
      messages = [action.reply];
    } else if (action.action === "clear") {
      result = { cart: emptyCart(), notes: ["ล้างตะกร้าเรียบร้อยแล้วค่ะ"], changed: cart.lines.length > 0 || cart.pending.length > 0 };
    } else if (action.action === "view") {
      result = { cart, notes: [], changed: false };
      alwaysShowSummary = true;
    } else if (action.action === "remove") {
      result = removeItems(
        cart,
        action.items.flatMap((i) => (i.line ? [i.line] : [])),
        action.items.flatMap((i) => (!i.line && i.query ? [i.query] : [])),
      );
      alwaysShowSummary = true;
    } else if (action.action === "price") {
      // Unit price only; nothing is added to the cart.
      const { items } = action;
      const products = await productsPromise;
      messages = [products ? formatPriceReply(items, products).slice(0, LINE_TEXT_MAX_LENGTH) : PRODUCTS_UNAVAILABLE];
    } else if (action.action === "add" || action.action === "set") {
      const { action: mode, items } = action;
      const products = await productsPromise;
      if (!products) {
        messages = [PRODUCTS_UNAVAILABLE];
      } else {
        result = mode === "add" ? addItems(cart, items, products) : setItems(cart, items, products);
      }
    }
  }

  if (result) messages = cartReply(result, alwaysShowSummary);
  const finalMessages = messages;

  const cartToSave = result && (result.changed || JSON.stringify(result.cart.pending) !== JSON.stringify(cart.pending)) ? result.cart : null;

  // Saving happens after the reply is sent (the caller awaits it before returning 200).
  const save = async () => {
    const tasks: Promise<unknown>[] = [
      appendHistory(userId, [
        { role: "user", text },
        { role: "bot", text: finalMessages.join("\n") },
      ]),
    ];
    if (cartToSave) {
      tasks.push(
        saveCart(userId, cartToSave).then((ok) => {
          if (ok) {
            console.log("CART_UPDATED", {
              itemCount: cartToSave.lines.length,
              subtotal: cartSubtotalSatang(cartToSave) / 100,
            });
          }
        }),
      );
    }
    await Promise.all(tasks);
  };

  return { messages: finalMessages, save };
}
