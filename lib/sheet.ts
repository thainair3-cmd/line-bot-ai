import { SHEET_CACHE_TTL_MS, SHEET_FETCH_TIMEOUT_MS } from "./constants";

type FaqCache = { text: string; fetchedAt: number };

// Module-level cache: survives between requests while the serverless instance stays warm.
let cache: FaqCache | null = null;

/**
 * Minimal RFC 4180 CSV parser: handles quoted fields containing commas,
 * newlines and escaped quotes (""), plus CRLF line endings.
 */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Turns CSV rows into "[หมวด] คำถาม: ... | คำตอบ: ..." lines (one FAQ per line). */
export function formatFaq(rows: string[][]): string {
  const cleaned = rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ""));
  if (cleaned.length === 0) return "";

  const header = cleaned[0].map((h) => h.toLowerCase());
  const col = (name: string, fallback: number) => {
    const idx = header.indexOf(name);
    return idx >= 0 ? idx : fallback;
  };
  const iCategory = col("category", 0);
  const iQuestion = col("question", 1);
  const iAnswer = col("answer", 2);

  return cleaned
    .slice(1)
    .map((r) => ({
      category: r[iCategory] ?? "",
      question: r[iQuestion] ?? "",
      answer: r[iAnswer] ?? "",
    }))
    .filter((f) => f.question !== "" || f.answer !== "")
    .map((f) => {
      // Keep each FAQ on a single line.
      const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, " ");
      return `[${oneLine(f.category)}] คำถาม: ${oneLine(f.question)} | คำตอบ: ${oneLine(f.answer)}`;
    })
    .join("\n");
}

async function fetchFaq(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEET_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const looksLikeHtml = contentType.includes("text/html") || /^\s*</.test(body);

    if (!res.ok || looksLikeHtml) {
      console.error("SHEET_ERROR", {
        status: res.status,
        contentType,
        bodyStart: body.slice(0, 100),
        hint: looksLikeHtml ? "Got HTML instead of CSV; SHEET_CSV_URL should end with /pub?output=csv" : undefined,
      });
      throw new Error(`Sheet fetch failed (status ${res.status})`);
    }

    const faq = formatFaq(parseCsv(body));
    if (!faq) throw new Error("Sheet has no FAQ rows");
    return faq;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the FAQ text, using a 60s in-memory cache.
 * On fetch failure falls back to a stale cache; returns null if there is nothing at all.
 */
export async function getFaq(): Promise<string | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < SHEET_CACHE_TTL_MS) return cache.text;

  const url = process.env.SHEET_CSV_URL;
  if (!url) {
    console.error("SHEET_ERROR", { status: null, bodyStart: "SHEET_CSV_URL is not set" });
    return cache?.text ?? null;
  }

  try {
    const text = await fetchFaq(url);
    cache = { text, fetchedAt: now };
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("SHEET_ERROR", { message, usingStaleCache: Boolean(cache) });
    return cache?.text ?? null;
  }
}
