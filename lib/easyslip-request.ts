// Builds the EasySlip v2 verify requests (POST https://api.easyslip.com/v2/verify/bank).
// No imports, so tests can check exactly what is sent.

export const EASYSLIP_VERIFY_URL = "https://api.easyslip.com/v2/verify/bank";

export type EasySlipRequest = { headers: Record<string, string>; body: string | FormData };

/** Image type from the file's first bytes (LINE images are normally JPEG). */
export function sniffImageType(buf: Uint8Array): { mime: string; ext: string } {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { mime: "image/gif", ext: "gif" };
  if (String.fromCharCode(...buf.subarray(8, 12)) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return { mime: "image/jpeg", ext: "jpg" };
}

/**
 * QR text -> JSON request {"payload": "...", "checkDuplicate": true}.
 * Returns null for a missing/blank payload: the caller must send the image instead.
 */
export function buildPayloadRequest(payload: string | null | undefined, apiKey: string): EasySlipRequest | null {
  const p = typeof payload === "string" ? payload.trim() : "";
  if (!p) return null;
  return {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: p, checkDuplicate: true }),
  };
}

/**
 * Original LINE image bytes -> multipart form with an "image" file (named slip.<ext>, correct
 * content type) and checkDuplicate=true. Content-Type is NOT set here: fetch adds the
 * multipart boundary itself.
 */
export function buildImageRequest(image: Uint8Array, apiKey: string): EasySlipRequest {
  const { mime, ext } = sniffImageType(image);
  const form = new FormData();
  // Copy into a fresh ArrayBuffer so the file holds exactly these bytes (Buffers can be views
  // into a larger shared pool).
  const bytes = new Uint8Array(image.byteLength);
  bytes.set(image);
  form.append("image", new File([bytes], `slip.${ext}`, { type: mime }));
  form.append("checkDuplicate", "true");
  return { headers: { Authorization: `Bearer ${apiKey}` }, body: form };
}
