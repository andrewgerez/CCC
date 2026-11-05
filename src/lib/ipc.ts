import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { EVENTS_CHANNEL, type UiEvent } from "./contract";

/** Subscribes to batched backend events. Works against the real Tauri runtime and the
 *  browser mock alike (the mock implements `plugin:event|listen` on __TAURI_INTERNALS__). */
export function listenEvents(handler: (batch: UiEvent[]) => void): Promise<UnlistenFn> {
  return listen<UiEvent[] | UiEvent>(EVENTS_CHANNEL, (e) => {
    const p = e.payload;
    handler(Array.isArray(p) ? p : [p]);
  });
}

export const isMock = () => Boolean((window as unknown as { __CCC_MOCK__?: boolean }).__CCC_MOCK__);
