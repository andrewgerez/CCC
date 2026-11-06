import { useEffect } from "react";
import { Dialog, DialogContent } from "../../components/ui/dialog";
import { Kbd } from "../../components/ui/input";
import { useUi } from "../../store/ui";
import { setZoom, stepZoom, storedZoom } from "../../lib/zoom";

const LIST: [string[], string][] = [
  [["Ctrl", "K"], "Buscar projetos e sessões"],
  [["Tab"], "Alternar Trabalho / Pessoal"],
  [["1"], "Conta Trabalho"],
  [["2"], "Conta Pessoal"],
  [["G"], "Voltar ao quadro"],
  [["N"], "Nova tarefa"],
  [["Esc"], "Fechar painel"],
  [["Ctrl", "+"], "Aumentar zoom"],
  [["Ctrl", "−"], "Diminuir zoom"],
  [["Ctrl", "0"], "Zoom 100%"],
  [["?"], "Mostrar atalhos"],
];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

export function useShortcuts() {
  useEffect(() => {
    const z = storedZoom();
    if (z !== 1) void setZoom(z, false);
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && ["=", "+", "-", "_", "0"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "0") void setZoom(1);
        else void stepZoom(e.key === "-" || e.key === "_" ? -1 : 1);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.setPalette(!ui.paletteOpen);
        return;
      }
      if (e.key === "Escape") {
        if (!ui.paletteOpen && !ui.helpOpen && !ui.composer.open && !ui.loginAccount && !document.querySelector("[role=dialog]")) ui.closePanel();
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector("[role=dialog]")) return;
      switch (e.key) {
        case "Tab": {
          // Only hijack Tab on the board itself; keep normal focus navigation in panels.
          const f = document.activeElement;
          if (e.shiftKey || ui.view !== "canvas" || (f && f !== document.body && !f.closest(".canvas-root"))) return;
          e.preventDefault();
          ui.setScope(ui.scope === "personal" ? "work" : "personal");
          break;
        }
        case "1": ui.setScope("work"); break;
        case "2": ui.setScope("personal"); break;
        case "g": case "G": ui.setView("canvas"); break;
        case "n": case "N": e.preventDefault(); ui.openComposer(ui.scope === "global" ? null : ui.scope); break;
        case "?": ui.setHelp(true); break;
        default: return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function ShortcutsHelp() {
  const open = useUi((s) => s.helpOpen);
  const setOpen = useUi((s) => s.setHelp);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Atalhos de teclado" className="w-[min(420px,92vw)]">
        <div className="divide-y divide-line">
          {LIST.map(([keys, label]) => (
            <div key={label} className="flex items-center justify-between py-2 text-[13px]">
              <span className="text-fg-2">{label}</span>
              <span className="flex gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
