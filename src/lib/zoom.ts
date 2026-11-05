import { isMock } from "./ipc";

const KEY = "ccc.zoom";
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.33, 1.5, 1.75, 2];
let current = 1;

export function storedZoom(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return v >= 0.5 && v <= 2 ? v : 1;
  } catch { return 1; }
}
export const currentZoom = () => current;

function cssZoom(z: number) {
  (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(z);
}

/** Native webview zoom (keeps pointer math correct); CSS zoom only in the browser mock. */
export async function setZoom(z: number, announce = true) {
  current = Math.min(2, Math.max(0.5, Math.round(z * 100) / 100));
  try { localStorage.setItem(KEY, String(current)); } catch { /* ignore */ }
  if (isMock()) cssZoom(current);
  else {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(current);
    } catch { cssZoom(current); }
  }
  if (announce) window.dispatchEvent(new CustomEvent<number>("ccc-zoom", { detail: current }));
}

export function stepZoom(dir: 1 | -1) {
  const next = dir > 0
    ? ZOOM_STEPS.find((s) => s > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
    : [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001) ?? ZOOM_STEPS[0];
  return setZoom(next);
}
