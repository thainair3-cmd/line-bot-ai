// Pure money math (no imports, so tests can load it directly). All totals are integers in satang
// (1 baht = 100 satang) so sums are exact; rounding matches Excel ROUND(x, 2) (half away from zero).

export const VAT_PERCENT = 7;

/**
 * Excel-style ROUND to an integer: half away from zero.
 * toPrecision(15) removes float noise first (e.g. 1.005 * 100 = 100.49999999999999 -> 100.5),
 * the same way Excel works with 15 significant digits.
 */
export function roundHalfAwayFromZero(x: number): number {
  const cleaned = Number(Math.abs(x).toPrecision(15));
  return Math.sign(x) * Math.round(cleaned);
}

/** "1,700.00" / "฿1,700" / " 1700 " -> 1700. Returns null if it is not a valid non-negative number. */
export function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[,\s฿]/g, "").replace(/บาท$/, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** ROUND(price * quantity, 2) in satang. */
export function lineTotalSatang(unitPrice: number, quantity: number): number {
  return roundHalfAwayFromZero(unitPrice * quantity * 100);
}

export type QuoteInput = { unitPrice: number; quantity: number };
export type Quote = {
  lineTotals: number[]; // satang, one per line
  subtotal: number; // รวมเป็นเงิน (satang)
  vat: number; // VAT 7% = ROUND(subtotal * 7%, 2) (satang)
  total: number; // รวมทั้งสิ้น (satang)
};

export function calcQuote(lines: QuoteInput[]): Quote {
  const lineTotals = lines.map((l) => lineTotalSatang(l.unitPrice, l.quantity));
  const subtotal = lineTotals.reduce((a, b) => a + b, 0);
  const vat = roundHalfAwayFromZero((subtotal * VAT_PERCENT) / 100);
  return { lineTotals, subtotal, vat, total: subtotal + vat };
}

/** 160893000 -> "1,608,930.00" */
export function formatSatang(satang: number): string {
  const sign = satang < 0 ? "-" : "";
  const abs = Math.abs(Math.round(satang));
  const baht = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${baht}.${String(abs % 100).padStart(2, "0")}`;
}

/** Baht amount (e.g. a unit price) -> "1,700.00" */
export function formatBaht(baht: number): string {
  return formatSatang(roundHalfAwayFromZero(baht * 100));
}

/** 20 -> "20", 2.5 -> "2.5", 1234 -> "1,234" */
export function formatQuantity(q: number): string {
  const [int, dec] = String(Math.round(q * 100) / 100).split(".");
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dec ? `.${dec}` : "");
}
