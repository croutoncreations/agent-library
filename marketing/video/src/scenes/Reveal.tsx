// Scene 2: everything collapses to a point; the Fold mark pops, "Agent Library" wipes in, then the tagline
// "One library. Every agent.", the supporting line, and an "Open source" pill, one per beat.
// Wide frames: mark beside the wordmark. Narrow (9:16, 1:1): mark above the wordmark, tagline on two lines.
import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { C, FONT, BEAT } from "../theme";

export const Reveal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const wide = W > H * 1.2;
  const at = (b: number) => Math.round(b * BEAT);
  const sp = (b: number, cfg = {}) => spring({ frame: frame - at(b), fps, config: { damping: 16, stiffness: 130, ...cfg } });
  const flash = interpolate(frame, [0, 3, 16], [0, 0.18, 0], { extrapolateRight: "clamp" });
  const ring = interpolate(frame, [0, 40], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const mark = spring({ frame: frame - 2, fps, config: { damping: 11, stiffness: 140, mass: 0.8 } });
  const word = sp(1);
  const tag = sp(2, { damping: 14, stiffness: 150 });
  const sub = sp(2.6);
  const pill = sp(3.3, { damping: 12, stiffness: 170 });
  const glow = 0.45 + 0.15 * Math.sin(frame / 14);
  // Vertical rhythm: in narrow frames the whole stack is centred around the middle of the frame.
  const cy = wide ? 330 : H / 2 - (H > W * 1.2 ? 260 : 220);
  const markSize = wide ? 200 : 180;
  // Wide lockup: 200px mark + 50px gap + ~640px wordmark, centred; the mark slides left as the wordmark arrives.
  const markX = wide ? interpolate(word, [0, 1], [0, -345]) : 0;
  const markY = wide ? 0 : interpolate(word, [0, 1], [70, -10]);
  const line = (y: number) => (wide ? y : y);
  return (
    <AbsoluteFill style={{ background: C.bg, alignItems: "center", overflow: "hidden" }}>
      <AbsoluteFill style={{ background: `radial-gradient(45% 45% at 50% ${(cy / H) * 100 + 4}%, rgba(37,99,235,${0.28 * glow + 0.08}), transparent 70%)` }} />
      <div style={{ position: "absolute", top: cy - 800 * ring, left: W / 2 - 800 * ring, width: 1600 * ring, height: 1600 * ring, borderRadius: "50%", border: `3px solid ${C.accent}`, opacity: (1 - ring) * 0.8 }} />
      <AbsoluteFill style={{ background: C.accent, opacity: flash }} />
      {wide ? (
        <div style={{ position: "absolute", top: 230, height: 200, width: 1200, left: W / 2 - 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Img src={staticFile("brand/app-icon-512.png")} style={{ position: "absolute", width: markSize, height: markSize,
            transform: `translateX(${markX}px) scale(${mark}) rotate(${(1 - mark) * -25}deg)`, filter: `drop-shadow(0 0 ${40 * glow}px rgba(96,165,250,.55))` }} />
          <div style={{ position: "absolute", left: 600 - 345 + 100 + 50, fontFamily: FONT, fontWeight: 850, fontSize: 112, letterSpacing: "-0.04em", color: C.fg,
            opacity: word, transform: `translateX(${(1 - word) * -60}px)`, clipPath: `inset(0 ${(1 - word) * 100}% 0 0)`, whiteSpace: "nowrap" }}>
            Agent Library
          </div>
        </div>
      ) : (
        <>
          <Img src={staticFile("brand/app-icon-512.png")} style={{ position: "absolute", top: cy - markSize / 2 + markY, left: W / 2 - markSize / 2, width: markSize, height: markSize,
            transform: `scale(${mark}) rotate(${(1 - mark) * -25}deg)`, filter: `drop-shadow(0 0 ${40 * glow}px rgba(96,165,250,.55))` }} />
          <div style={{ position: "absolute", top: cy + 110, fontFamily: FONT, fontWeight: 850, fontSize: 112, letterSpacing: "-0.04em", color: C.fg,
            opacity: word, transform: `translateY(${(1 - word) * 30}px)`, whiteSpace: "nowrap" }}>
            Agent Library
          </div>
        </>
      )}
      <div style={{ position: "absolute", top: wide ? line(520) : cy + 290, fontFamily: FONT, fontWeight: 850, fontSize: wide ? 96 : 88, letterSpacing: "-0.04em", color: C.fg,
        opacity: tag, transform: `translateY(${(1 - tag) * 28}px)`, textAlign: "center", lineHeight: 1.05 }}>
        One library.{wide ? " " : <br />}<span style={{ color: C.accent }}>Every agent.</span>
      </div>
      <div style={{ position: "absolute", top: wide ? 650 : cy + 500, left: 40, right: 40, textAlign: "center", fontFamily: FONT, fontWeight: 550, fontSize: wide ? 44 : 40,
        color: C.muted, letterSpacing: "-0.01em", opacity: sub, transform: `translateY(${(1 - sub) * 20}px)` }}>
        One home for everything your agents make.
      </div>
      <div style={{ position: "absolute", top: wide ? 760 : cy + 600, display: "flex", alignItems: "center", gap: 12, padding: "12px 26px", borderRadius: 999,
        background: "rgba(74,222,128,0.10)", border: `1.5px solid rgba(74,222,128,0.45)`, fontFamily: FONT, fontWeight: 750, fontSize: 32, color: C.ok,
        opacity: pill, transform: `scale(${0.8 + 0.2 * pill})` }}>
        <div style={{ width: 12, height: 12, borderRadius: 6, background: C.ok, boxShadow: `0 0 12px ${C.ok}` }} />
        Open source
      </div>
    </AbsoluteFill>
  );
};
