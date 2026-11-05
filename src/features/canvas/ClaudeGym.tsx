import { memo } from "react";
import { GYM_FRAMES, GYM_PALETTE, GYM_SEQUENCE, gymDelay } from "./gymFrames";

/** One CSS animation per frame: visible exactly during the steps where the sequence shows it. */
function buildCss(): string {
  const starts: number[] = [];
  let t = 0;
  GYM_SEQUENCE.forEach((f, i) => {
    starts.push(t);
    t += gymDelay(i, f);
  });
  const total = t;
  const pct = (x: number) => `${((x / total) * 100).toFixed(3)}%`;
  const rules = GYM_FRAMES.map((_, f) => {
    const stops = ["0% { visibility: hidden; }"];
    GYM_SEQUENCE.forEach((sf, i) => {
      if (sf !== f) return;
      stops.push(`${pct(starts[i])} { visibility: visible; }`);
      stops.push(`${pct(starts[i] + gymDelay(i, sf))} { visibility: hidden; }`);
    });
    stops.push("100% { visibility: hidden; }");
    return `@keyframes cg-f${f} { ${stops.join(" ")} }\n.cg-f${f} { animation: cg-f${f} ${total.toFixed(3)}s step-end infinite; }`;
  });
  return [
    ".cg-frame { visibility: hidden; }",
    ...rules,
    "@media (prefers-reduced-motion: reduce) { .cg-frame[data-still] { visibility: visible; } }",
  ].join("\n");
}

const CSS = buildCss();

function Frame({ data }: { data: string }) {
  return (
    <>
      {data.split(";").map((r, i) => {
        const [geom, transform] = r.split("|");
        const [x, y, w, h] = geom.slice(0, -1).split(",").map(Number);
        return <rect key={i} x={x} y={y} width={w} height={h} fill={GYM_PALETTE[geom.slice(-1)]} transform={transform} />;
      })}
    </>
  );
}

/** Pixel Claude lifting a dumbbell: the "nobody is working here" idle scene. Pure SVG + CSS, no JS timers. */
export const ClaudeGym = memo(function ClaudeGym({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 158 128" shapeRendering="crispEdges" className={className} role="img" aria-label="Claude treinando">
      <style>{CSS}</style>
      {GYM_FRAMES.map(([tx, ty, data], f) => (
        <g key={f} transform={`translate(${tx}, ${ty})`} className={`cg-frame cg-f${f}`} data-still={f === 0 ? "" : undefined}>
          <Frame data={data} />
        </g>
      ))}
    </svg>
  );
});
