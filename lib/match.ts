// Matches a customer's product description (from Gemini) against the product list.
// Pure code (type-only imports), so tests can load it directly.

export type Product = {
  code: string; // รหัสสินค้า
  name: string; // ชื่อสินค้า
  unit: string; // หน่วย
  price: number; // ราคาต่อหน่วย ก่อน VAT (baht)
};

export type MatchResult =
  | { kind: "one"; product: Product }
  | { kind: "many"; products: Product[] }
  | { kind: "none" };

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** หุน -> inch token: 4 -> "1/2", 8 -> "1", 12 -> "1+1/2" (1 หุน = 1/8 นิ้ว). */
function hunToInch(n: number): string {
  const whole = Math.floor(n / 8);
  const rem = n % 8;
  if (rem === 0) return String(whole);
  const g = gcd(rem, 8);
  const frac = `${rem / g}/${8 / g}`;
  return whole ? `${whole}+${frac}` : frac;
}

/**
 * Splits text into comparable tokens. Both product names and queries go through this, so
 * "ท่อ L 4 หุน", "Type L 1/2\"" and "L1/2นิ้ว" all yield the tokens "l" and "1/2".
 * Mixed fractions ("1 1/2", "1-1/2", "1.1/2") become one token "1+1/2" so they never match "1/2".
 */
export function tokenize(text: string): string[] {
  let t = text.normalize("NFKC").toLowerCase();
  t = t.replace(/[“”″]/g, '"').replace(/นิ้ว/g, '"');
  t = t.replace(/(\d+)\s*หุน/g, (_, n: string) => ` ${hunToInch(Number(n))} `);
  t = t.replace(/มม\.?/g, " mm ").replace(/ซม\.?/g, " cm ");
  t = t.replace(/(?<![\d/.])(\d+)\s*[-.\s]\s*(\d+\/\d+)/g, "$1+$2");
  // Separate digits from letters: "l1/2" -> "l 1/2", "19mm" -> "19 mm", "3/8x1/2" -> "3/8 x 1/2"
  t = t.replace(/(?<=[a-z฀-๿])(?=\d)|(?<=\d)(?=[a-z฀-๿])/g, " ");
  return t
    .split(/[\s,()[\]"'*×\-_:;|]+/)
    .map((tok) => tok.replace(/^[./]+|[./]+$/g, ""))
    .filter((tok) => tok !== "" && tok !== "x");
}

/**
 * Hard tokens must match exactly: anything with a digit (size, thickness, code part) and
 * 1–2 letter latin tokens (Type L / M / K). Other words (ท่อ, ทองแดง, aeroflex) are soft:
 * they only rank candidates.
 */
function isHard(tok: string): boolean {
  return /\d/.test(tok) || /^[a-z]{1,2}$/.test(tok);
}

const compact = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\-_./]/g, "");

type Indexed = { product: Product; tokens: Set<string>; text: string; code: string };

const indexCache = new WeakMap<Product[], Indexed[]>();
function indexOf(products: Product[]): Indexed[] {
  let idx = indexCache.get(products);
  if (!idx) {
    idx = products.map((p) => {
      const tokens = tokenize(`${p.code} ${p.name}`);
      return { product: p, tokens: new Set(tokens), text: tokens.join(" "), code: compact(p.code) };
    });
    indexCache.set(products, idx);
  }
  return idx;
}

export function matchProducts(query: string, products: Product[]): MatchResult {
  const index = indexOf(products);

  // Exact product code (e.g. an AEROFLEX code) wins outright.
  const q = compact(query);
  if (q) {
    const byCode = index.filter((i) => i.code && i.code === q);
    if (byCode.length === 1) return { kind: "one", product: byCode[0].product };
  }

  const tokens = tokenize(query);
  if (tokens.length === 0) return { kind: "none" };
  const hard = tokens.filter(isHard);
  const soft = tokens.filter((t) => !isHard(t));

  const scored = index
    .filter((i) => hard.every((h) => i.tokens.has(h) || (h.length >= 4 && /[a-z]/.test(h) && i.code.includes(h))))
    .map((i) => ({ i, score: soft.filter((s) => i.text.includes(s)).length }))
    .filter((s) => hard.length > 0 || s.score > 0);

  if (scored.length === 0) return { kind: "none" };
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best).map((s) => s.i.product);
  return top.length === 1 ? { kind: "one", product: top[0] } : { kind: "many", products: top };
}
