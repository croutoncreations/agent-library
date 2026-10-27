// Scene 1 (0:00–~0:05): "Which agent has the launch plan?" The question is fully on screen from frame 0
// (frame 0 doubles as the thumbnail). Below it a reel of agent names spins: Claude, ChatGPT, Codex on the beat,
// then faster and faster through the long tail (assistant bots included), never landing. The reel and the dim
// ring of file icons are pulled into the centre for the reveal.
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { C, FONT, BEAT, beatFrame } from "../theme";
import { FileIcon, FileKind } from "../components/FileIcon";
import { SCENES } from "../timeline";
import { useFit } from "../components/ui";

// Plain-text product names only (no logos). Big names first, then the long tail flies by. Order matters only
// for the first three (they get a full beat each); the rest blur past.
export const AGENTS = [
  "Claude", "ChatGPT", "Codex", "Cursor", "Grok Bot", "Gemini", "Claude Duet", "Muse", "Copilot", "ChatGPT Dot",
  "Hermes", "OpenClaw", "Pi", "Claude Code", "Perplexity", "Devin", "Windsurf", "Cline",
];
// "the launch plan" is the same document the rest of the video follows (Codex opens it, an agent's edit to it is
// undone), so the hook's question gets answered on screen.
export const LEAD = ["Which agent has", "the launch plan?"];

// Reel timeline (frame each name appears): Claude at 0, ChatGPT on beat 1, Codex on beat 2, then each hold is ~70%
// of the previous (floor 1/7 beat), looping the list if needed until the pull-in. It never settles.
const REEL: number[] = (() => {
  const out = [0, beatFrame(1), beatFrame(2)];
  let t = beatFrame(3), hold = BEAT * 0.7;
  while (t < SCENES.hook) { out.push(Math.round(t)); t += hold; hold = Math.max(BEAT / 7, hold * 0.7); }
  return out;
})();

const BASE = 104;
const KINDS: FileKind[] = ["md", "html", "png", "pdf", "mp4", "json", "csv", "md", "png", "html", "md", "mp4", "pdf", "csv"];
const rnd = (i: number, s = 0) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const { width: W, height: H } = useVideoConfig();
  const fit = useFit();
  const SIZE = BASE * fit, LINE = Math.round(SIZE * 1.2);
  const idx = Math.max(0, REEL.findLastIndex((f) => frame >= f));
  const since = frame - REEL[idx];
  const hold = (REEL[idx + 1] ?? SCENES.hook) - REEL[idx];
  // Each name rolls up into the window; fast names get a little motion blur.
  const roll = idx === 0 ? 1 : Easing.out(Easing.cubic)(Math.min(1, since / Math.max(3, Math.min(12, hold * 0.6))));
  // The reel fades out before it can wrap back to the start of the list (so no name is ever "last").
  const wrapAt = REEL[AGENTS.length] ?? SCENES.hook;
  const reelOut = interpolate(frame, [Math.min(wrapAt, SCENES.hook - 24) - 12, Math.min(wrapAt, SCENES.hook - 24)], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const blur = idx < 3 ? 0 : Math.min(3, (BEAT / Math.max(1, hold) - 1) * 0.6);
  const name = (i: number) => AGENTS[i % AGENTS.length];

  const end = SCENES.hook;
  const pull = interpolate(frame, [end - 24, end], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
  // Gentle settle-in of the whole question (it is already readable at frame 0).
  const drift = interpolate(frame, [0, 40], [8, 0], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });

  const N = KINDS.length;
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <AbsoluteFill style={{ background: `radial-gradient(55% 55% at 50% 50%, ${C.accentSoft}, transparent 72%)` }} />
      {KINDS.map((k, i) => {
        const a = (i / N) * Math.PI * 2 + rnd(i) * 0.25 - Math.PI / 2;
        // Wide: a loose ellipse. Narrow frames: pushed out toward the edges so icons never cover the question.
        const rx = W * (W > H ? 0.39 : 0.4) + W * rnd(i, 1) * 0.06, ry = H * (W > H ? 0.37 : 0.4) + H * rnd(i, 2) * 0.05;
        // The first three names each light "their" files (by index) for the length of their beat.
        const lit = idx < 3 && i % 3 === idx ? interpolate(since, [0, 6, 30], [0, 1, 0.55], { extrapolateRight: "clamp" }) : 0;
        const bob = Math.sin((frame + i * 23) / 40) * 6;
        const x = W / 2 + Math.cos(a) * rx, y = H / 2 + Math.sin(a) * ry + bob;
        const px = x + (W / 2 - x) * pull, py = y + (H / 2 - y) * pull;
        return (
          <div key={i} style={{ position: "absolute", left: px, top: py, opacity: (0.34 + 0.66 * lit) * (1 - pull * 0.6),
            transform: `translate(-50%,-50%) rotate(${(rnd(i, 3) - 0.5) * 16 * (1 - pull)}deg) scale(${(1 - 0.85 * pull) * (1 + 0.12 * lit)})` }}>
            <FileIcon kind={k} size={(60 + rnd(i, 4) * 24) * fit} lit={lit} />
          </div>
        );
      })}
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: 1 - pull, transform: `translateY(${drift}px) scale(${1 - 0.2 * pull})` }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", fontFamily: FONT, fontWeight: 850, fontSize: SIZE,
          letterSpacing: "-0.04em", lineHeight: 1.06, color: C.fg, textAlign: "center" }}>
          <div>{LEAD[0]}</div>
          <div>{LEAD[1]}</div>
          {/* The reel: one name at a time, rolling up; clipped vertically only. */}
          <div style={{ position: "relative", height: LINE, width: Math.min(1400, W - 60), marginTop: 26, overflow: "hidden", color: C.accent, opacity: reelOut }}>
            <div style={{ position: "absolute", left: 0, right: 0, top: 0, transform: `translateY(${(1 - roll) * LINE}px)`, filter: blur ? `blur(${blur}px)` : "none" }}>
              {name(idx)}?
            </div>
            {roll < 1 && (
              <div style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: 0.5, transform: `translateY(${-roll * LINE}px)`, filter: blur ? `blur(${blur}px)` : "none" }}>
                {name(idx - 1)}?
              </div>
            )}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
