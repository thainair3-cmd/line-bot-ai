// Server-side QR decoding for transfer slips (sharp -> raw RGBA pixels -> jsQR).
// No project imports, so `node --test` can load it directly. Images stay in memory only.
import sharp from "sharp";
import jsQRModule from "jsqr";

type SharpImage = ReturnType<typeof sharp>;
type JsQR = typeof jsQRModule;
// jsqr is a UMD bundle: the function may sit on `.default` depending on how it is loaded.
const jsQR: JsQR = ((jsQRModule as unknown as { default?: JsQR }).default ?? jsQRModule) as JsQR;

export type QrResult = {
  payload: string | null;
  attempt: string | null; // which variant decoded it (for logs), null if none did
  attempts: number;
  ms: number;
};

type Variant = {
  name: string;
  /** Builds the variant from a fresh sharp pipeline of the (EXIF-rotated) image. */
  build: (img: SharpImage, w: number, h: number) => SharpImage;
};

const fit = (max: number) => (img: SharpImage, w: number, h: number) =>
  Math.max(w, h) > max ? img.resize({ width: w >= h ? max : undefined, height: h > w ? max : undefined }) : img;

/**
 * Tried in order until one decodes (cheapest / most likely first). Thai bank slips are usually
 * portrait screenshots with the QR in the lower part, often bottom-right.
 */
const VARIANTS: Variant[] = [
  { name: "fit1000", build: (img, w, h) => fit(1000)(img, w, h) },
  { name: "original", build: (img, w, h) => fit(2000)(img, w, h) },
  { name: "gray-contrast", build: (img, w, h) => fit(1000)(img, w, h).grayscale().normalise() },
  {
    name: "bottom-right",
    build: (img, w, h) =>
      img.extract({ left: Math.floor(w / 2), top: Math.floor(h / 2), width: w - Math.floor(w / 2), height: h - Math.floor(h / 2) }),
  },
  {
    name: "bottom-half",
    build: (img, w, h) => img.extract({ left: 0, top: Math.floor(h / 2), width: w, height: h - Math.floor(h / 2) }),
  },
  { name: "fit600-sharpen", build: (img, w, h) => fit(600)(img, w, h).grayscale().normalise().sharpen() },
  // Light QR on a dark background. Inverted with sharp: jsQR's own "onlyInvert" mode crashes (jsqr 1.4).
  { name: "fit1000-inverted", build: (img, w, h) => fit(1000)(img, w, h).negate({ alpha: false }) },
];

async function tryVariant(rotated: Buffer, w: number, h: number, v: Variant): Promise<string | null> {
  const { data, info } = await v
    .build(sharp(rotated), w, h)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const code = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height, {
    inversionAttempts: "dontInvert",
  });
  return code?.data ? code.data : null;
}

/**
 * Decodes the first QR code in the image, trying several variants until one works or
 * `budgetMs` runs out. Never throws: an unreadable or non-image buffer returns payload null.
 */
export async function decodeQr(image: Buffer, budgetMs = 1_500): Promise<QrResult> {
  const startedAt = Date.now();
  let attempts = 0;
  try {
    // Apply EXIF rotation once; every variant starts from this upright image.
    const rotated = await sharp(image).rotate().toBuffer();
    const meta = await sharp(rotated).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return { payload: null, attempt: null, attempts, ms: Date.now() - startedAt };

    for (const v of VARIANTS) {
      if (Date.now() - startedAt >= budgetMs) break;
      attempts++;
      try {
        const payload = await tryVariant(rotated, w, h, v);
        if (payload) return { payload, attempt: v.name, attempts, ms: Date.now() - startedAt };
      } catch {
        // A variant can fail on odd sizes (e.g. 1px crops); just try the next one.
      }
    }
  } catch {
    // Not an image sharp can read: fall through to "not decoded".
  }
  return { payload: null, attempt: null, attempts, ms: Date.now() - startedAt };
}
