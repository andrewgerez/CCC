import { isMock } from "./ipc";

/** Native folder picker (multi-select). Paths are validated again by the backend. */
export async function pickDirectories(defaultPath?: string): Promise<string[]> {
  if (isMock()) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: true, defaultPath, title: "Selecionar pastas do projeto" });
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}
