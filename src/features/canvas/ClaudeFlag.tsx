import { memo } from "react";
import { FLAG_BODY, FLAG_EYES, FLAG_FRAMES, FLAG_LEFT_HAND, FLAG_LEGS, FLAG_RIGHT_HAND, type Rect } from "./flagFrames";

/** Loop uses sprites 3..11 (the intro 0..2 only plays once in the original). */
const LOOP = [3, 4, 5, 6, 7, 8, 9, 10, 11];
const FILL: Record<string, string> = { b: "#141413", w: "#ffffff" };

const rect = ([x, y, width, height, fill]: Rect, key: number | string) => (
  <rect key={key} x={x} y={y} width={width} height={height} fill={fill === "black" ? "#141413" : fill} />
);

function Sprite({ data }: { data: string }) {
  return (
    <>
      {data.split(";").map((r, i) => {
        const [x, y, w, h] = r.slice(0, -1).split(",").map(Number);
        return <rect key={i} x={x} y={y} width={w} height={h} fill={FILL[r.slice(-1)]} />;
      })}
    </>
  );
}

/** Pixel Claude waving a checkered flag: the "finished" celebration. Pure SVG + CSS steps, no JS timers. */
export const ClaudeFlag = memo(function ClaudeFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="-4 -14 176 164" shapeRendering="crispEdges" className={className} role="img" aria-label="concluído">
      {FLAG_LEGS.map(rect)}
      <g className="cf-body">
        {FLAG_BODY.map(rect)}
        {FLAG_EYES.map(rect)}
        <g className="cf-left">{rect(FLAG_LEFT_HAND, "lh")}</g>
        <g className="cf-hand">
          {rect(FLAG_RIGHT_HAND, "rh")}
          {LOOP.map((f, k) => (
            <g key={f} transform={`translate(${FLAG_FRAMES[f][0]}, ${FLAG_FRAMES[f][1]})`}>
              <g className="cf-frame" style={{ animationDelay: `${(k * 0.07).toFixed(2)}s` }} data-still={k === 2 ? "" : undefined}>
                <Sprite data={FLAG_FRAMES[f][2]} />
              </g>
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
});
