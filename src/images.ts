import { PushPortError } from "./types.js";

export function imageLimit(value: unknown): number { return typeof value === "number" && Number.isInteger(value) && value >= 1048576 && value <= 20971520 ? value : 5242880; }
export async function downloadImage(value: unknown, limit: number, icon = false): Promise<{ url: string; size: number; duration: number; status: number }> {
  const started = Date.now();
  let url: URL;
  try { url = new URL(typeof value === "string" ? value : ""); } catch { throw new PushPortError("invalid_url", "Invalid image URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 1000 || (url.port && url.port !== "443") || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname)) throw new PushPortError("invalid_url", "Use a public HTTPS image URL");
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url.href, { signal: controller.signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store" });
    if (!response.ok) throw new PushPortError("http_error", "Image server rejected the download", response.status);
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!type || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)) throw new PushPortError("unsupported_content_type", "Unsupported image content");
    if (Number(response.headers.get("content-length") ?? 0) > limit) throw new PushPortError("too_large", "Image exceeds the configured limit");
    const reader = response.body?.getReader(); if (!reader) throw new PushPortError("decode_failed", "Empty image response");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) { await reader.cancel(); throw new PushPortError("too_large", "Image exceeds the configured limit"); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (!size) throw new PushPortError("decode_failed", "Empty image response");
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
    const signature = type === "image/png" ? bytes[0] === 137 && ascii(1, 4) === "PNG" : type === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : type === "image/gif" ? ["GIF87a", "GIF89a"].includes(ascii(0, 6)) : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    if (!signature) throw new PushPortError("decode_failed", "Invalid image bytes");
    let blob = new Blob([bytes], { type });
    if (typeof createImageBitmap !== "undefined") {
      const bitmap = await createImageBitmap(blob).catch(() => { throw new PushPortError("decode_failed", "Cannot decode image"); });
      try {
        if (!bitmap.width || !bitmap.height || bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 8000000) throw new PushPortError("pixel_limit", "Image resolution is too large");
        if (typeof OffscreenCanvas !== "undefined") {
          const scale = Math.min(1, (icon ? 256 : 2000) / Math.max(bitmap.width, bitmap.height));
          const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
          const context = canvas.getContext("2d"); if (context) { context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); blob = await canvas.convertToBlob({ type: "image/png" }); }
        }
      } finally { bitmap.close(); }
    }
    // Service workers cannot create object URLs. A data URL avoids a second unbounded browser download.
    const output = new Uint8Array(await blob.arrayBuffer()); let binary = "";
    for (let i = 0; i < output.length; i += 8192) binary += String.fromCharCode(...output.subarray(i, i + 8192));
    return { url: `data:${blob.type};base64,${btoa(binary)}`, size, duration: Math.min(10000, Date.now() - started), status: response.status };
  } catch (error) { if (error instanceof PushPortError) throw error; throw new PushPortError(controller.signal.aborted ? "timeout" : "network_error", "Image download failed"); }
  finally { clearTimeout(timeout); }
}
