import { normalizeHeader, parseCsv } from "./csv";
import { parsePrice } from "./pricing";
import type { Product } from "./match";
import { PRODUCTS_CACHE_TTL_MS, PRODUCTS_FETCH_TIMEOUT_MS } from "./constants";

// Sheet "สินค้า": รหัสสินค้า, ชื่อสินค้า, หน่วย, ราคาต่อหน่วย (ก่อน VAT). Compared after normalizeHeader().
const HEADERS = {
  code: (h: string) => h === "รหัสสินค้า" || h === "รหัส" || h === "code",
  name: (h: string) => h === "ชื่อสินค้า" || h === "สินค้า" || h === "name",
  unit: (h: string) => h === "หน่วย" || h === "unit",
  price: (h: string) => h.startsWith("ราคา") || h.includes("price"),
};

export function parseProducts(rows: string[][]): Product[] {
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length < 2) return [];
  const header = nonEmpty[0].map(normalizeHeader);
  const find = (test: (h: string) => boolean, fallback: number) => {
    const i = header.findIndex(test);
    return i >= 0 ? i : fallback;
  };
  const iCode = find(HEADERS.code, 0);
  const iName = find(HEADERS.name, 1);
  const iUnit = find(HEADERS.unit, 2);
  const iPrice = find(HEADERS.price, 3);

  const products: Product[] = [];
  let skipped = 0;
  for (const r of nonEmpty.slice(1)) {
    const name = (r[iName] ?? "").trim();
    const price = parsePrice(r[iPrice] ?? "");
    if (!name || price === null) {
      skipped++;
      continue;
    }
    products.push({ code: (r[iCode] ?? "").trim(), name, unit: (r[iUnit] ?? "").trim(), price });
  }
  if (skipped) console.log("PRODUCTS_ROWS_SKIPPED", { skipped });
  return products;
}

let cache: { products: Product[]; fetchedAt: number } | null = null;

async function fetchProducts(url: string): Promise<Product[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRODUCTS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const looksLikeHtml = contentType.includes("text/html") || /^\s*</.test(body);
    if (!res.ok || looksLikeHtml) {
      throw new Error(
        `status ${res.status}${looksLikeHtml ? " (got HTML; PRODUCTS_CSV_URL should be a /pub?...output=csv link)" : ""}`,
      );
    }
    const products = parseProducts(parseCsv(body.replace(/^﻿/, "")));
    if (products.length === 0) throw new Error("no product rows");
    console.log("PRODUCTS_LOADED", { productCount: products.length });
    return products;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Product list with a 5-minute in-memory cache. On fetch failure or timeout (1500ms)
 * falls back to the stale cache; returns null if there is nothing at all.
 */
export async function getProducts(): Promise<Product[] | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < PRODUCTS_CACHE_TTL_MS) return cache.products;

  const url = process.env.PRODUCTS_CSV_URL;
  if (!url) {
    console.error("PRODUCTS_ERROR", { message: "PRODUCTS_CSV_URL is not set" });
    return cache?.products ?? null;
  }
  try {
    const products = await fetchProducts(url);
    cache = { products, fetchedAt: now };
    return products;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("PRODUCTS_ERROR", { message, usingStaleCache: Boolean(cache) });
    return cache?.products ?? null;
  }
}
