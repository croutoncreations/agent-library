// Shared building blocks: headlines with accent words, a minimal browser frame, keyframed zoom, framed clips.
import React from "react";
import { AbsoluteFill, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { Video } from "@remotion/media";
import { C, FONT, MONO, DEMO_HOST } from "../theme";

export const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Spring 0→1 starting at frame `at`. */
export const useEnter = (at: number, cfg: { damping?: number; stiffness?: number; mass?: number } = {}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - at, fps, config: { damping: 16, stiffness: 140, ...cfg } });
};

/** Text parts: plain strings are foreground, [string] tuples are accent-coloured. */
export type Parts = (string | [string])[];
export const Rich: React.FC<{ parts: Parts; accent?: string }> = ({ parts, accent = C.accent }) => (
  <>{parts.map((p, i) => (p === "\n" ? <br key={i} /> : typeof p === "string" ? <span key={i}>{p}</span> : <span key={i} style={{ color: accent }}>{p[0]}</span>))}</>
);

/** A headline that springs in at `at` and (optionally) fades out ending at `until`. */
export const Headline: React.FC<{
  parts: Parts; at?: number; until?: number; size?: number; weight?: number; color?: string;
  align?: "left" | "center"; style?: React.CSSProperties;
}> = ({ parts, at = 0, until, size: base = 84, weight = 850, color = C.fg, align = "center", style }) => {
  const frame = useCurrentFrame();
  const size = base * useFit();
  const e = useEnter(at);
  const out = until === undefined ? 1 : interpolate(frame, [until - 8, until], [1, 0], CLAMP);
  if (frame < at - 1 || (until !== undefined && frame > until)) return null;
  return (
    <div style={{ fontFamily: FONT, fontWeight: weight, fontSize: size, letterSpacing: size > 60 ? "-0.035em" : "-0.015em", lineHeight: 1.08,
      color, textAlign: align, opacity: e * out, transform: `translateY(${(1 - e) * 26}px)`, ...style }}>
      <Rich parts={parts} />
    </div>
  );
};

/** Type scale for narrow frames (1 at ≥1200 px wide; 0.9 for 1080-wide vertical/square cuts). */
export const useFit = () => Math.min(1, useVideoConfig().width / 1200);
/** Layout helpers shared by the 16:9, 9:16 and 1:1 cuts. */
export const useFrame = () => {
  const { width: W, height: H } = useVideoConfig();
  return { W, H, tall: H > W * 1.2, square: Math.abs(H - W) < 10, wide: W > H * 1.2 };
};

/** Centred title band at a fixed y (px from top). In a tall frame, the y given for 16:9 moves down into the safe area. */
export const TitleAt: React.FC<{ y: number; children: React.ReactNode }> = ({ y, children }) => {
  const { tall } = useFrame();
  return <div style={{ position: "absolute", left: 50, right: 50, top: tall ? y + 170 : y, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>{children}</div>;
};

export const BAR_H = 40;
/** Minimal dark browser chrome. Content area is 16:10 (matches the 2880×1800 captures). */
// `height` (optional) makes a taller window for narrow frames: the 16:10 recording inside is then scaled up to fill the
// height and cropped at the sides (see FitClip), so text stays large in 9:16 and 1:1.
export const BrowserFrame: React.FC<{ width: number; height?: number; url?: string; children: React.ReactNode; style?: React.CSSProperties }> = ({ width, height, url = DEMO_HOST, children, style }) => {
  const h = height ?? Math.round(width * 0.625);
  return (
    <div style={{ width, height: h + BAR_H, borderRadius: 16, overflow: "hidden", background: C.card, border: `1px solid ${C.line2}`,
      boxShadow: "0 40px 120px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.02)", ...style }}>
      <div style={{ height: BAR_H, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", background: C.side, borderBottom: `1px solid ${C.line}` }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => <div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c, opacity: 0.85 }} />)}
        <div style={{ marginLeft: 18, flex: 1, display: "flex", justifyContent: "center" }}>
          <div style={{ fontFamily: MONO, fontSize: 14, color: C.faint, background: C.sunk, borderRadius: 7, padding: "4px 18px", minWidth: 320, textAlign: "center" }}>{url}</div>
        </div>
        <div style={{ width: 60 }} />
      </div>
      <div style={{ position: "relative", width, height: h, overflow: "hidden" }}>{children}</div>
    </div>
  );
};

/** Keyframed zoom: [frame, scale, focusX, focusY] (focus in 0..1 of the content). Eased between keys. */
export type ZoomKey = [number, number, number, number];
export const Zoom: React.FC<{ keys: ZoomKey[]; children: React.ReactNode }> = ({ keys, children }) => {
  const frame = useCurrentFrame();
  const fs = keys.map((k) => k[0]);
  const opt = { ...CLAMP, easing: Easing.inOut(Easing.cubic) };
  const s = interpolate(frame, fs, keys.map((k) => k[1]), opt);
  const x = interpolate(frame, fs, keys.map((k) => k[2]), opt);
  const y = interpolate(frame, fs, keys.map((k) => k[3]), opt);
  return <AbsoluteFill style={{ transform: `scale(${s})`, transformOrigin: `${x * 100}% ${y * 100}%` }}>{children}</AbsoluteFill>;
};

/**
 * A 16:10 UI clip laid out at its native aspect inside a window of any shape: `focusX` (0..1) picks which part of the
 * width stays visible when the window is narrower than 16:10. Zoom keys inside keep working in clip coordinates.
 */
export const FitClip: React.FC<{ w: number; h: number; focusX?: number; children: React.ReactNode }> = ({ w, h, focusX = 0.5, children }) => {
  const cw = Math.max(w, h / 0.625), ch = cw * 0.625;
  return (
    <div style={{ position: "absolute", width: cw, height: ch, left: (w - cw) * focusX, top: (h - ch) / 2 }}>
      <AbsoluteFill>{children}</AbsoluteFill>
    </div>
  );
};

/** A muted UI clip filling its parent. */
export const Clip: React.FC<{ name: string; trimBefore?: number; rate?: number }> = ({ name, trimBefore = 0, rate = 1 }) => (
  <Video src={staticFile(`clips/${name}.mp4`)} muted trimBefore={trimBefore || undefined} playbackRate={rate} objectFit="cover"
    style={{ width: "100%", height: "100%" }} />
);

/** Soft blue stage glow used behind most scenes. */
export const Stage: React.FC<{ children?: React.ReactNode; glow?: number }> = ({ children, glow = 1 }) => (
  <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
    <AbsoluteFill style={{ background: `radial-gradient(60% 55% at 50% 55%, rgba(37,99,235,${0.16 * glow}), transparent 70%)` }} />
    {children}
  </AbsoluteFill>
);
