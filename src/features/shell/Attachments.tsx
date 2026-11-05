import { ImagePlus, X } from "lucide-react";
import { useCallback, useState, type ClipboardEvent } from "react";
import { clipboardImages, MAX_IMAGES, toPastedImage, type PastedImage } from "../../lib/images";
import { cn, errMessage } from "../../lib/utils";

/** Paste-to-attach state for a composer: wire `onPaste` to the textarea and render <AttachmentStrip>. */
export function usePastedImages() {
  const [images, setImages] = useState<PastedImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const onPaste = useCallback((e: ClipboardEvent) => {
    const files = clipboardImages(e);
    if (!files.length) return; // plain text paste: leave it alone
    e.preventDefault();
    setError(null);
    void (async () => {
      for (const f of files) {
        try {
          const img = await toPastedImage(f);
          setImages((cur) => {
            if (cur.length >= MAX_IMAGES) {
              setError(`no máximo ${MAX_IMAGES} imagens por mensagem`);
              return cur;
            }
            return [...cur, img];
          });
        } catch (x) {
          setError(errMessage(x));
        }
      }
    })();
  }, []);
  const remove = (id: string) => setImages((cur) => cur.filter((i) => i.id !== id));
  const clear = () => { setImages([]); setError(null); };
  return {
    images,
    error,
    onPaste,
    remove,
    clear,
    /** Fields for api.sendMessage / NewSession. */
    payload: () => ({ images: images.map((i) => i.input), thumbs: images.map((i) => i.thumb) }),
  };
}

export function AttachmentStrip({ images, onRemove, error, className }: { images: PastedImage[]; onRemove: (id: string) => void; error?: string | null; className?: string }) {
  if (!images.length && !error) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {images.map((i) => (
        <div key={i.id} className="group relative size-14 overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--color-line-2)]">
          <img src={i.thumb} alt="imagem colada" className="size-full object-cover" />
          <button
            type="button"
            aria-label="Remover imagem"
            onClick={() => onRemove(i.id)}
            className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-fg/80 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      {error && <span className="text-[11.5px] text-red">{error}</span>}
    </div>
  );
}

/** Small hint shown under composers. */
export function PasteHint() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-dim">
      <ImagePlus className="size-3" /> Ctrl+V cola imagens
    </span>
  );
}
