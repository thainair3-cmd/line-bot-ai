// Matches a customer's product description (from Gemini) against the product list.
// Pure code (type-only imports), so tests can load it directly.
//
// Sheet name formats this is tuned for (sheet "สินค้า"):
//   ท่อทองแดง L 1/2 x 0.89mm x 6m                         (straight pipe: Type K/L/M, size, thickness, length)
//   ท่อม้วนทองแดง เบอร์22 ขนาด 5/16 ความหนา 0.7mm ความยาว 15m  (coil: เบอร์ = thickness)
//   ข้องอ 45° ทองแดง ขนาด 3-1/8"  /  ข้อต่อเกลียวใน ทองแดง ขนาด 3/8" x 1/4"
//   AEROFLEX:ฉนวนยางท่อ 12138 (หนา 1/2" ท่อ 1-3/8" ยาว 1.83ม.)

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

const THAI = "\\u0E00-\\u0E7F";
const NOT_THAI_AFTER = `(?![${THAI}])`;

/**
 * Normalises sizes and units so customer text and sheet names compare equally:
 * - หุน -> inches (4 หุน = 1/2), นิ้ว -> "
 * - เค / แอล / เอ็ม -> k / l / m (copper pipe Type)
 * - mixed fractions "1-1/8", "1.1/8", "1 1/8" -> "1+1/8" (one token, so it never matches "1/8")
 * - units stay attached to their number: "0.89mm", "6m", "1.83m", "4ft", so the "m" of
 *   "6m" is never read as Type M; "0.7 มม." -> "0.7mm"
 * - "90°" / "90 องศา" -> "90"
 */
function normalizeText(text: string): string {
  let t = text.normalize("NFKC").toLowerCase();
  t = t.replace(/[“”″]/g, '"').replace(/นิ้ว/g, '"');
  t = t.replace(/°|องศา/g, " ");
  t = t.replace(/(\d+)\s*หุน/g, (_, n: string) => ` ${hunToInch(Number(n))} `);
  t = t
    .replace(new RegExp(`เค${NOT_THAI_AFTER}`, "g"), " k ")
    .replace(new RegExp(`แอล${NOT_THAI_AFTER}`, "g"), " l ")
    .replace(new RegExp(`เอ็ม${NOT_THAI_AFTER}`, "g"), " m ");
  t = t.replace(/(\d)\s*มม\.?/g, "$1mm").replace(/(\d)\s*ซม\.?/g, "$1cm");
  t = t.replace(/(\d)\s*(?:เมตร|ม\.)/g, "$1m").replace(/(\d)\s*ฟุต/g, "$1ft");
  t = t.replace(/(\d)\s+(mm|cm|ft)(?![a-z])/g, "$1$2");
  // Whole part is a single digit, so "เบอร์22 3/8" is not read as 22 3/8.
  t = t.replace(/(?<![\d/.])([1-9])\s*[-.\s]\s*(\d+\/\d+)/g, "$1+$2");
  // Separate digits from letters ("l1/2" -> "l 1/2", "เบอร์18" -> "เบอร์ 18", "3/8x1/2" -> "3/8 x 1/2"),
  // except a unit right after a number.
  t = t.replace(new RegExp(`(?<=[a-z${THAI}])(?=\\d)|(?<=\\d)(?=[a-z${THAI}])(?!(?:mm|cm|m|ft)(?![a-z]))`, "g"), " ");
  return t;
}

function splitTokens(t: string): string[] {
  return t
    .split(/[\s,()[\]"'*×\-_:;|]+/)
    .map((tok) => tok.replace(/^[./]+|[./]+$/g, ""))
    .filter((tok) => tok !== "" && tok !== "x");
}

/**
 * Splits text into comparable tokens. Both product names and queries go through this, so
 * "ท่อ แอล 4 หุน", "ท่อทองแดง L 1/2 x 0.89mm x 6m" and "L1/2นิ้ว" all contain "l" and "1/2".
 */
export function tokenize(text: string): string[] {
  return splitTokens(normalizeText(text));
}

// A size after normalizeText: "1+3/8", "3/8" or a whole inch "1".
const SIZE = String.raw`(\d\+\d+\/\d+|\d+\/\d+|\d)(?![\d/.])`;
const AF_THICK_RE = new RegExp(String.raw`(?:หนา|ยาง|ฉนวน)\s*` + SIZE);
const AF_PIPE_RE = new RegExp(String.raw`ท่อ\s*` + SIZE);

/**
 * AEROFLEX "ยาง/หนา X ท่อ Y" (either order) -> key "X|Y" (thickness|pipe).
 * The same key is read from each sheet name ("... (หนา 1/2" ท่อ 1-3/8" ยาว 1.83ม.)"), so the
 * order matters (หนา 3/4 ท่อ 1-1/4 is not หนา 1-1/4 ท่อ 3/4) and it works for every code style
 * (12138, 1410, M63022PP). Returns the key and the text with both sizes removed, or null.
 */
function aeroflexKey(t: string): { key: string; rest: string } | null {
  const thick = AF_THICK_RE.exec(t);
  const pipe = AF_PIPE_RE.exec(t);
  if (!thick || !pipe) return null;
  // Cut both matches out by position (a text replace could hit "ท่อ 1" inside "ท่อ 1410").
  let rest = t;
  for (const m of [thick, pipe].sort((a, b) => b.index - a.index)) {
    rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
  }
  return { key: `${thick[1]}|${pipe[1]}`, rest };
}

/**
 * Hard tokens must match exactly: anything with a digit (size, thickness, เบอร์, code) and
 * 1–2 letter latin tokens (Type K / L / M). Other words (ท่อ, ข้องอ, เกลียวใน, aeroflex) are soft:
 * they only rank candidates.
 */
function isHard(tok: string): boolean {
  return /\d/.test(tok) || /^[a-z]{1,2}$/.test(tok);
}

const compact = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\-_./:]/g, "");

type Indexed = {
  product: Product;
  tokens: Set<string>; // code + name tokens
  text: string;
  code: string;
  nameHard: string[]; // hard tokens of the name only, with repeats (1/2 x 1/2 x 1/4 -> three)
  nameSoft: string[];
  sizes: string[]; // inch sizes in name order ("3/8 x 1/2" -> ["3/8", "1/2"])
  afKey?: string; // AEROFLEX tube "thickness|pipe"
};

const isSize = (tok: string) => tok.includes("/") || /^\d\+/.test(tok);

const indexCache = new WeakMap<Product[], Indexed[]>();
function indexOf(products: Product[]): Indexed[] {
  let idx = indexCache.get(products);
  if (!idx) {
    idx = products.map((p) => {
      const tokens = tokenize(`${p.code} ${p.name}`);
      const name = tokenize(p.name);
      return {
        product: p,
        tokens: new Set(tokens),
        text: tokens.join(" "),
        code: compact(p.code),
        nameHard: name.filter(isHard),
        nameSoft: name.filter((t) => !isHard(t)),
        sizes: name.filter(isSize),
        afKey: aeroflexKey(normalizeText(p.name))?.key,
      };
    });
    indexCache.set(products, idx);
  }
  return idx;
}

/** Same token, or a bare decimal thickness ("0.7") against "0.7mm". */
function sameHard(query: string, product: string): boolean {
  return query === product || (/^\d+\.\d+$/.test(query) && product === `${query}mm`);
}

function hardTokenMatches(h: string, i: Indexed): boolean {
  return i.tokens.has(h) || (/^\d+\.\d+$/.test(h) && i.tokens.has(`${h}mm`));
}

/** Sizes/numbers in the product name that the customer did not type (counting repeats). */
function extraHard(hard: string[], i: Indexed): number {
  const left = [...hard];
  let extra = 0;
  for (const p of i.nameHard) {
    const k = left.findIndex((h) => sameHard(h, p));
    if (k >= 0) left.splice(k, 1);
    else extra++;
  }
  return extra;
}

/** Words in the product name not covered by the customer's words (e.g. "รัศมียาว"). */
function extraSoft(soft: string[], i: Indexed): number {
  return i.nameSoft.filter((p) => !soft.some((q) => p.includes(q) || q.includes(p))).length;
}

/** Keeps the items with the lowest value (all of them if they tie). */
function narrow<T>(items: T[], value: (t: T) => number): T[] {
  const min = Math.min(...items.map(value));
  return items.filter((t) => value(t) === min);
}

export function matchProducts(query: string, products: Product[]): MatchResult {
  const index = indexOf(products);

  // Exact product code (e.g. "AF-3438") wins outright.
  const q = compact(query);
  if (q) {
    const byCode = index.filter((i) => i.code && i.code === q);
    if (byCode.length === 1) return { kind: "one", product: byCode[0].product };
  }

  const normalized = normalizeText(query);
  // "ยาง X ท่อ Y": compare thickness and pipe size with each AEROFLEX name, in that order.
  const af = aeroflexKey(normalized);
  const tokens = splitTokens(af ? af.rest : normalized);
  if (tokens.length === 0 && !af) return { kind: "none" };
  const hard = tokens.filter(isHard);
  const soft = tokens.filter((t) => !isHard(t));
  const typedSizes = splitTokens(normalized).filter(isSize).join(" ");

  const scored = index
    .filter((i) => !af || i.afKey === af.key)
    .filter((i) => hard.every((h) => hardTokenMatches(h, i)))
    .map((i) => ({ i, score: soft.filter((s) => i.text.includes(s)).length }))
    .filter((s) => af || hard.length > 0 || s.score > 0);

  if (scored.length === 0) return { kind: "none" };
  const best = Math.max(...scored.map((s) => s.score));
  let top = scored.filter((s) => s.score === best).map((s) => s.i);

  // Tie-break: prefer products with no sizes beyond what was typed ("สามทาง 1/2" -> the plain tee,
  // not "สามทางลด 1/2 x 1/2 x 1/4"), then sizes in the typed order ("เกลียวนอก 3/8 x 1/2" is not
  // "1/2 x 3/8"), then the fewest extra words ("ข้องอ 90 7/8" -> the standard elbow, not
  // "รัศมียาว"). Only when some product has no extra sizes, so "ท่อ 1/2" still asks.
  if (top.length > 1) {
    const exact = top.filter((i) => extraHard(hard, i) === 0);
    if (exact.length > 0) {
      top = narrow(exact, (i) => (i.sizes.join(" ") === typedSizes ? 0 : 1));
      top = narrow(top, (i) => extraSoft(soft, i));
    }
  }
  return top.length === 1
    ? { kind: "one", product: top[0].product }
    : { kind: "many", products: top.map((i) => i.product) };
}
