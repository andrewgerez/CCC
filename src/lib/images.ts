import type { ImageInput } from "./contract";

export const MAX_IMAGES = 6;
/** Longest side Claude makes use of; bigger images are downscaled before sending. */
const MAX_SIDE = 1568;
const MAX_BYTES = 4.5 * 1024 * 1024;
const THUMB_SIDE = 240;
const THUMB_MAX_LEN = 60 * 1024;
const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface PastedImage {
  id: string;
  input: ImageInput;
  /** Small data URL kept in the chat history. */
  thumb: string;
}

const readDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("imagem ilegível"));
    img.src = src;
  });

function draw(img: HTMLImageElement, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; // JPEG has no alpha
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function thumbOf(img: HTMLImageElement): string {
  const c = draw(img, THUMB_SIDE);
  for (const q of [0.75, 0.6, 0.45, 0.3]) {
    const url = c.toDataURL("image/jpeg", q);
    if (url.length <= THUMB_MAX_LEN) return url;
  }
  return draw(img, 120).toDataURL("image/jpeg", 0.5);
}

const splitDataUrl = (url: string): ImageInput => {
  const [head, data] = url.split(",", 2);
  return { mediaType: head.slice(5, head.indexOf(";")), data };
};

/** Turns a pasted file into what the backend expects: base64 within Claude's limits plus a thumbnail. */
export async function toPastedImage(file: Blob): Promise<PastedImage> {
  if (!file.type.startsWith("image/")) throw new Error("não é uma imagem");
  const original = await readDataUrl(file);
  const img = await loadImage(original);
  const tooBig = Math.max(img.naturalWidth, img.naturalHeight) > MAX_SIDE || file.size > MAX_BYTES;
  let input: ImageInput;
  if (ACCEPTED.includes(file.type) && !tooBig) {
    input = splitDataUrl(original);
  } else {
    const c = draw(img, MAX_SIDE);
    const png = c.toDataURL("image/png");
    input = splitDataUrl(png.length * 0.75 <= MAX_BYTES ? png : c.toDataURL("image/jpeg", 0.88));
  }
  return { id: crypto.randomUUID(), input, thumb: thumbOf(img) };
}

/** Images on the clipboard of a paste event (screenshots, copied images, copied image files). */
export function clipboardImages(e: ClipboardEvent | React.ClipboardEvent): File[] {
  const items = Array.from(e.clipboardData?.items ?? []);
  return items.filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => !!f);
}
