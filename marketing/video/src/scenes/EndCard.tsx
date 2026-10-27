// End card: logo lockup, "One library. Every agent.", the open-source/self-host line, the GitHub URL typed out,
// agent names orbiting faintly. Narrow frames stack the mark above the wordmark and wrap the support line.
import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, MONO, BEAT } from "../theme";
import { CLAMP, Stage, useEnter } from "../components/ui";
import { AGENTS } from "./Hook";

const B = (n: number) => Math.round(n * BEAT);
export const REPO = "github.com/croutoncreations/agent-library";

const GitHub: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={C.fg}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
);

export const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { width: W, height: H } = useVideoConfig();
  const wide = W > H * 1.2;
  const mark = useEnter(0, { damping: 13, stiffness: 150 });
  const line = useEnter(B(1));
  const sub = useEnter(B(1.6));
  const urlIn = useEnter(B(2.4));
  const typed = Math.max(0, Math.min(REPO.length, Math.floor((frame - B(2.4) - 4) * 1.6)));
  const orbit = interpolate(frame, [0, B(8)], [0, 0.35]);
  const urlSize = wide ? 36 : 30;
  return (
    <Stage glow={1.4}>
      {/* Faint orbit of agent names */}
      <AbsoluteFill>
        {AGENTS.map((a, i) => {
          const ang = (i / AGENTS.length) * Math.PI * 2 + orbit;
          const x = W / 2 + Math.cos(ang) * W * (wide ? 0.42 : 0.4), y = H * 0.46 + Math.sin(ang) * H * (wide ? 0.37 : 0.42);
          const o = interpolate(frame, [i * 2, i * 2 + 20], [0, 1], CLAMP) * (0.16 + 0.06 * Math.sin(frame / 20 + i));
          return <div key={a} style={{ position: "absolute", left: x, top: y, transform: "translate(-50%,-50%)", fontFamily: FONT, fontWeight: 700, fontSize: 28, color: C.fg, opacity: o, whiteSpace: "nowrap" }}>{a}</div>;
        })}
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 0, padding: "0 40px", textAlign: "center" }}>
        <div style={{ display: "flex", flexDirection: wide ? "row" : "column", alignItems: "center", gap: wide ? 40 : 18, transform: `scale(${0.85 + 0.15 * mark})`, opacity: mark, marginTop: -60 }}>
          <Img src={staticFile("brand/app-icon-512.png")} style={{ width: wide ? 170 : 150, height: wide ? 170 : 150, filter: "drop-shadow(0 0 30px rgba(96,165,250,.45))" }} />
          <div style={{ fontFamily: FONT, fontWeight: 850, fontSize: wide ? 112 : 104, letterSpacing: "-0.04em", color: C.fg, whiteSpace: "nowrap" }}>Agent Library</div>
        </div>
        <div style={{ marginTop: 40, fontFamily: FONT, fontWeight: 850, fontSize: wide ? 72 : 76, lineHeight: 1.05, letterSpacing: "-0.035em", color: C.fg, opacity: line, transform: `translateY(${(1 - line) * 20}px)` }}>
          One library.{wide ? " " : <br />}<span style={{ color: C.accent }}>Every agent.</span>
        </div>
        {/* "Free plan" is about Cloudflare's plans (Workers/D1/R2/KV + Zero Trust Free); a domain is still needed. */}
        <div style={{ marginTop: 22, fontFamily: FONT, fontWeight: 600, fontSize: wide ? 38 : 36, lineHeight: 1.4, color: C.muted, opacity: sub, transform: `translateY(${(1 - sub) * 16}px)` }}>
          {wide ? "Open source · Works with any agent · Self-host on Cloudflare's free plan"
            : <>Open source · Works with any agent<br />Self-host on Cloudflare&apos;s free plan</>}
        </div>
        <div style={{ marginTop: 40, display: "flex", alignItems: "center", gap: 14, padding: wide ? "16px 30px" : "14px 22px", borderRadius: 999, background: C.sunk, border: `1.5px solid ${C.line2}`,
          fontFamily: MONO, fontSize: urlSize, color: C.fg, opacity: urlIn, transform: `translateY(${(1 - urlIn) * 20}px)`, minWidth: wide ? 980 : undefined, justifyContent: "center", whiteSpace: "nowrap" }}>
          <GitHub size={urlSize - 2} />
          <span>{REPO.slice(0, typed)}<span style={{ opacity: typed < REPO.length || Math.floor(frame / 20) % 2 ? 1 : 0, color: C.accent }}>▍</span></span>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};
