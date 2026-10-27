// Scene: "Any agent reads and writes over MCP." One concrete handoff: Claude saves the launch plan into the library,
// then Codex (a different agent, a different company) opens the very same plan. The library sits in the middle.
// Drawn: the two agent panels. The doc card mirrors the real seeded "Launch plan".
import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { C, FONT, MONO, BEAT } from "../theme";
import { CLAMP, Headline, Stage, TitleAt, useEnter } from "../components/ui";

const B = (n: number) => Math.round(n * BEAT);
const SAVE = B(1.5), ARRIVE = B(2.6), READ = B(3.6), GOT = B(4.6);

const Panel: React.FC<{ x: number; y?: number; w?: number; h?: number; at: number; name: string; color: string; children: React.ReactNode }> = ({ x, y = 330, w = 520, h = 520, at, name, color, children }) => {
  const e = useEnter(at, { damping: 15, stiffness: 140 });
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: 24, background: C.card, border: `1px solid ${C.line2}`,
      boxShadow: "0 30px 80px rgba(0,0,0,.55)", padding: 28, display: "flex", flexDirection: "column", gap: 18, fontFamily: FONT,
      opacity: e, transform: `translateY(${(1 - e) * 50}px)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, fontWeight: 800, fontSize: 30, color: C.fg }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: color, display: "grid", placeItems: "center", fontSize: 22, color: "#fff" }}>{name[0]}</div>
        {name}
      </div>
      {children}
    </div>
  );
};

const ToolCall: React.FC<{ at: number; tool: string; args: string; result: string; ok?: boolean }> = ({ at, tool, args, result }) => {
  const frame = useCurrentFrame();
  const e = useEnter(at, { damping: 16 });
  const done = interpolate(frame, [at + 18, at + 26], [0, 1], CLAMP);
  return (
    <div style={{ borderRadius: 14, background: C.sunk, border: `1px solid ${C.line2}`, padding: "16px 18px", fontFamily: MONO, fontSize: 21, color: C.muted,
      opacity: e, transform: `translateY(${(1 - e) * 16}px)`, display: "flex", flexDirection: "column", gap: 10 }}>
      <div><span style={{ color: C.faint }}>agent-library ›</span> <span style={{ color: C.accent, fontWeight: 700 }}>{tool}</span></div>
      <div style={{ color: C.fg, whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{args}</div>
      <div style={{ color: C.ok, opacity: done, fontWeight: 700 }}>✓ {result}</div>
    </div>
  );
};

// 16:9: Claude | library | Codex in a row. 9:16 and 1:1: Claude above, Codex below, library in between; the doc chip
// travels down instead of across.
const layoutFor = (W: number, H: number) => {
  if (W > H * 1.2) return { claude: { x: 190, y: 330, w: 520, h: 520 }, codex: { x: 1210, y: 330, w: 520, h: 520 }, lib: [W / 2, 590], size: 220, path: "x" as const, a: 450, b: 1470 };
  if (H > W * 1.2) return { claude: { x: 90, y: 560, w: 900, h: 320 }, codex: { x: 90, y: 1360, w: 900, h: 320 }, lib: [W / 2, 1120], size: 190, path: "y" as const, a: 880, b: 1360 };
  return { claude: { x: 60, y: 330, w: 460, h: 420 }, codex: { x: 560, y: 330, w: 460, h: 420 }, lib: [W / 2, 880], size: 140, path: "v" as const, a: 0, b: 0 };
};

export const AnyAgent: React.FC = () => {
  const frame = useCurrentFrame();
  const { width: W, height: H } = useVideoConfig();
  const Lo = layoutFor(W, H);
  const lib = useEnter(B(0.4), { damping: 13, stiffness: 150 });
  // The doc travels Claude → library → Codex.
  const toLib = interpolate(frame, [SAVE + 20, ARRIVE], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const toCodex = interpolate(frame, [READ + 20, GOT], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const [lx, ly] = Lo.lib;
  // Chip position: along x (16:9), along y (9:16), or down-then-up as a "V" between the side-by-side panels (1:1).
  const leg = frame < READ + 20;
  const t = leg ? toLib : toCodex;
  const docPos: [number, number] = Lo.path === "x" ? [leg ? interpolate(t, [0, 1], [Lo.a, lx]) : interpolate(t, [0, 1], [lx, Lo.b]), ly]
    : Lo.path === "y" ? [lx, leg ? interpolate(t, [0, 1], [Lo.a, ly]) : interpolate(t, [0, 1], [ly, Lo.b])]
    : leg ? [interpolate(t, [0, 1], [Lo.claude.x + Lo.claude.w / 2, lx]), interpolate(t, [0, 1], [Lo.claude.y + Lo.claude.h, ly])]
      : [interpolate(t, [0, 1], [lx, Lo.codex.x + Lo.codex.w / 2]), interpolate(t, [0, 1], [ly, Lo.codex.y + Lo.codex.h])];
  const docOn = frame >= SAVE + 20 && frame < GOT + 4;
  const pulse = interpolate(frame, [ARRIVE, ARRIVE + 8, ARRIVE + 40], [0, 1, 0], CLAMP);
  return (
    <Stage>
      <TitleAt y={70}>
        <Headline parts={["Any agent ", ["reads and writes"], " over MCP."]} at={2} size={88} />
        <Headline parts={["Claude saves it. Codex opens the same plan."]} at={B(1)} size={38} weight={600} color={C.muted} />
      </TitleAt>
      <Panel {...Lo.claude} at={B(0.6)} name="Claude" color="#7c5cff">
        <div style={{ fontSize: 24, color: C.fg, lineHeight: 1.4 }}>Saving the launch plan to your library.</div>
        <ToolCall at={SAVE} tool="save_markdown" args={'"Launch plan"\nchange_note: "Added launch-day runbook"'} result="rev 5 saved" />
      </Panel>
      <Panel {...Lo.codex} at={B(2.8)} name="Codex" color="#0f766e">
        <div style={{ fontSize: 24, color: C.fg, lineHeight: 1.4 }}>Building from the launch plan.</div>
        <ToolCall at={READ} tool="read_artifact" args={'"Launch plan"'} result="rev 5 · Claude · 2 min ago" />
      </Panel>
      {/* The library in the middle */}
      <div style={{ position: "absolute", left: lx - Lo.size / 2, top: ly - Lo.size / 2, width: Lo.size, height: Lo.size, borderRadius: Lo.size * 0.18, background: C.card, border: `1.5px solid ${C.accentLine}`,
        display: "grid", placeItems: "center", opacity: lib, transform: `scale(${(0.7 + 0.3 * lib) * (1 + 0.06 * pulse)})`,
        boxShadow: `0 0 ${60 + 60 * pulse}px rgba(37,99,235,${0.35 + 0.3 * pulse})` }}>
        <Img src={staticFile("brand/app-icon-512.png")} style={{ width: Lo.size * 0.6, height: Lo.size * 0.6 }} />
      </div>
      {/* Library label: below the icon (16:9, 1:1) or to its right (9:16, where the doc chip runs vertically through it). */}
      <div style={{ position: "absolute", left: Lo.path === "y" ? lx + Lo.size / 2 + 24 : lx - 160, top: Lo.path === "y" ? ly - 18 : ly + Lo.size / 2 + 16,
        width: 320, textAlign: Lo.path === "y" ? "left" : "center", fontFamily: FONT, fontWeight: 750, fontSize: 28, color: C.fg, opacity: lib }}>Agent Library</div>
      {/* Doc chip in flight */}
      {docOn && (
        <div style={{ position: "absolute", left: docPos[0], top: docPos[1], transform: "translate(-50%,-50%)", display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
          borderRadius: 12, background: C.sunk, border: `1.5px solid ${C.accentLine}`, fontFamily: FONT, fontWeight: 700, fontSize: 22, color: C.fg, boxShadow: "0 10px 30px rgba(0,0,0,.5)" }}>
          <span style={{ fontFamily: MONO, fontSize: 15, color: C.bg, background: C.heading, borderRadius: 5, padding: "2px 6px" }}>MD</span> Launch plan
        </div>
      )}
      <AbsoluteFill style={{ pointerEvents: "none" }} />
    </Stage>
  );
};
