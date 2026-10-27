// Scene: undo any agent's change. The launch plan's History: ChatGPT's v6 "condensed" Claude's plan down to a few
// lines (clearly destructive). Open v5 → "Compare with current" shows everything v6 removed (red) → "Restore this
// version" → v7 brings it all back (green), "Restored version 5 as version 7". Nothing is deleted.
// Clip timeline (history-restore, 7.8 s): list 0–1.3 · red diff 1.6–3.8 · back to list/Restore 4.0–5.4 ·
// green restored diff + toast 5.6–7.8.
import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, FONT, BEAT } from "../theme";
import { BrowserFrame, Clip, CLAMP, FitClip, Headline, Stage, TitleAt, Zoom, useEnter, useFit, useFrame } from "../components/ui";

const B = (n: number) => Math.round(n * BEAT);
const TRIM_S = 0.4, R = 1.15;
const at = (clipSec: number) => Math.round(((clipSec - TRIM_S) / R) * 60); // scene frame for a clip timestamp
const RESTORED = at(5.75);

const Callout: React.FC<{ from: number; to: number; border: string; children: React.ReactNode; top: number }> = ({ from, to, border, children, top }) => {
  const frame = useCurrentFrame();
  const e = useEnter(from, { damping: 12, stiffness: 170 });
  const fit = useFit();
  const out = interpolate(frame, [to - 8, to], [1, 0], CLAMP);
  if (frame > to) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top, display: "flex", justifyContent: "center", opacity: e * out, transform: `translateY(${(1 - e) * 24}px) scale(${0.92 + 0.08 * e})` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "18px 30px", borderRadius: 18, background: "rgba(10,10,13,.94)", border: `2px solid ${border}`,
        boxShadow: "0 20px 70px rgba(0,0,0,.7)", fontFamily: FONT, fontSize: 36 * fit, fontWeight: 800, color: C.fg, whiteSpace: "nowrap" }}>
        {children}
      </div>
    </div>
  );
};

export const Edits: React.FC = () => {
  const enter = useEnter(0, { damping: 18 });
  const { W, H, wide, tall } = useFrame();
  const bw = wide ? 1240 : tall ? 1000 : 960, bh = wide ? 775 : tall ? 1180 : 620;
  const top = wide ? 250 : tall ? 540 : 360;
  const k = wide ? 1 : 0.85; // the crop already enlarges the doc column in narrow windows
  const callTop = wide ? 850 : top + bh - 90;
  return (
    <Stage>
      <TitleAt y={60}>
        <Headline parts={["Undo ", ["any agent's"], " change."]} at={2} size={92} />
        <Headline parts={["Every version kept. Restore in one click."]} at={B(0.75)} size={38} weight={600} color={C.muted} />
      </TitleAt>
      <div style={{ position: "absolute", left: (W - bw) / 2, top: Math.min(top, H - bh - 40), opacity: enter, transform: `translateY(${(1 - enter) * 40}px)` }}>
        <BrowserFrame width={bw} height={bh}>
          <FitClip w={bw} h={bh} focusX={0.45}>
            <Zoom keys={[
              [0, 1.4 * k, 0.4, 0.12], [at(1.3), 1.4 * k, 0.4, 0.12],               // History: ChatGPT v6 "Condensed…" on top
              [at(1.7), 1.35 * k, 0.45, 0.62], [at(3.8), 1.35 * k, 0.45, 0.62],     // everything v6 removed, in red
              [at(4.3), 1.1 * k, 0.45, 0.4], [at(5.5), 1.1 * k, 0.45, 0.4],          // Restore
              [at(6.0), 1.35 * k, 0.45, 0.5], [at(7.8), 1.4 * k, 0.45, 0.5],        // v7: it's all back, in green
            ]}>
              <Clip name="history-restore-dark-desktop" trimBefore={Math.round(TRIM_S * 60)} rate={R} />
            </Zoom>
          </FitClip>
        </BrowserFrame>
      </div>
      <Callout from={at(1.8)} to={at(4.0)} border="rgba(248,113,113,.6)" top={callTop}>
        <span style={{ color: "#f87171" }}>✕</span> ChatGPT cut the plan to 4 lines.
      </Callout>
      <Callout from={RESTORED} to={B(30)} border="rgba(74,222,128,.55)" top={callTop}>
        <span style={{ color: C.ok }}>✓</span> Restored v5 as v7. <span style={{ color: C.muted, fontWeight: 600 }}>Nothing deleted.</span>
      </Callout>
    </Stage>
  );
};
