// Scene 3: "Every artifact gets a link." Copy-link click in the real UI → the URL pill flies out and lands in three
// places: another agent's chat, your phone (real mobile capture), and a teammate's message.
import React from "react";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import { C, FONT, MONO, BEAT, DEMO_HOST } from "../theme";
import { BrowserFrame, Clip, Headline, Stage, TitleAt, Zoom, CLAMP, useEnter, BAR_H } from "../components/ui";

const B = (n: number) => Math.round(n * BEAT);
const URL = `${DEMO_HOST}/p/qa-runs/a/art_7Kq2Lm9x`;
const SPLIT = B(5);          // browser exits, pill goes centre
const CARDS = [B(6), B(7), B(8)];
const SAME = B(9);           // all three copies of the link light up together: it's the same link

/** Destination card width: 500 in 16:9, 470 in 9:16 (two side by side in 1080 px). */
const useCardW = () => { const { width, height } = useVideoConfig(); return width > height * 1.2 ? 500 : 470; };

const LinkPill: React.FC<{ scale?: number; style?: React.CSSProperties }> = ({ scale = 1, style }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: 10 * scale, fontFamily: MONO, fontSize: 22 * scale, color: C.accent,
    background: "rgba(96,165,250,0.12)", border: `1.5px solid ${C.accentLine}`, borderRadius: 999, padding: `${8 * scale}px ${18 * scale}px`, whiteSpace: "nowrap", ...style }}>
    <svg width={20 * scale} height={20 * scale} viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth={2.2} strokeLinecap="round">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
    {URL}
  </div>
);

const Card: React.FC<{ at: number; x: number; y?: number; label: string; children: React.ReactNode; w?: number }> = ({ at, x, y = 400, label, children, w = 500 }) => {
  const e = useEnter(at, { damping: 15, stiffness: 150 });
  return (
    <div style={{ position: "absolute", left: x - w / 2, top: y, width: w, display: "flex", flexDirection: "column", alignItems: "center", gap: 22,
      opacity: e, transform: `translateY(${(1 - e) * 60}px) scale(${0.92 + 0.08 * e})` }}>
      {children}
      <div style={{ fontFamily: FONT, fontWeight: 700, fontSize: 34, color: C.fg, letterSpacing: "-0.02em" }}>{label}</div>
    </div>
  );
};

/** Types `text` out from frame `at`, ~1.6 chars/frame. */
const Typed: React.FC<{ text: string; at: number; cps?: number }> = ({ text, at, cps = 1.6 }) => {
  const f = useCurrentFrame();
  const n = Math.max(0, Math.min(text.length, Math.floor((f - at) * cps)));
  return <>{text.slice(0, n)}{n > 0 && n < text.length && <span style={{ color: C.accent }}>▍</span>}</>;
};

// The agent card cycles through several agents (same link in each) to show the link isn't tied to one of them.
const CHAT_AGENTS: [string, string][] = [["Claude Duet", "#7c5cff"], ["ChatGPT", "#10a37f"], ["Grok Bot", "#3f3f46"], ["Codex", "#0f766e"]];
/** Pulse 0..1 when the three cards "agree" (same link highlighted everywhere). */
const useSame = () => {
  const f = useCurrentFrame();
  return interpolate(f, [SAME, SAME + 8, SAME + 40], [0, 1, 0.5], CLAMP);
};
const SamePill: React.FC<{ scale: number }> = ({ scale }) => {
  const s = useSame();
  return <LinkPill scale={scale} style={{ boxShadow: `0 0 0 ${4 * s}px rgba(96,165,250,${0.45 * s}), 0 0 ${30 * s}px rgba(96,165,250,${0.6 * s})` }} />;
};

const AgentChat: React.FC<{ at: number }> = ({ at }) => {
  const f = useCurrentFrame();
  // The reply types out under one agent; only when all three cards agree (SAME) do other agents cycle through,
  // each showing the same link.
  const i = Math.max(0, Math.min(CHAT_AGENTS.length - 1, Math.floor((f - SAME) / (BEAT / 2)) + 1));
  const [name, color] = f < SAME ? CHAT_AGENTS[0] : CHAT_AGENTS[i];
  return (
  <div style={{ width: useCardW(), height: 520, borderRadius: 22, background: C.card, border: `1px solid ${C.line2}`, padding: 26, display: "flex", flexDirection: "column", gap: 18,
    boxShadow: "0 30px 80px rgba(0,0,0,.55)", fontFamily: FONT }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12, fontWeight: 700, fontSize: 24, color: C.fg }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: color, display: "grid", placeItems: "center", fontSize: 18 }}>{name[0]}</div>
      {name}
    </div>
    <div style={{ alignSelf: "flex-end", background: C.sunk, borderRadius: 18, padding: "14px 16px", maxWidth: 440, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 22, color: C.fg }}>Can you check this QA run?</div>
      <SamePill scale={0.62} />
    </div>
    <div style={{ fontSize: 23, lineHeight: 1.45, color: C.muted, maxWidth: 440 }}>
      <Typed at={at + 22} text="Read it. 2 of 3 devices pass; step 2 clips on the iPhone 13 mini. Want me to draft the fix?" />
    </div>
  </div>
  );
};

const Phone: React.FC<{ at: number }> = ({ at }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
  <SamePill scale={0.5} />
  <div style={{ width: 230, height: 476, borderRadius: 40, background: "#000", border: `7px solid #26262c`, boxShadow: "0 30px 80px rgba(0,0,0,.6)", overflow: "hidden", position: "relative" }}>
    <Sequence from={at} layout="none">
      <div style={{ position: "absolute", inset: 0 }}><Clip name="mobile-open-link-dark-mobile" trimBefore={78} /></div>
    </Sequence>
    <div style={{ position: "absolute", top: 9, left: "50%", transform: "translateX(-50%)", width: 78, height: 22, borderRadius: 12, background: "#000" }} />
  </div>
  </div>
);

const TeamMessage: React.FC = () => (
  <div style={{ width: useCardW(), height: 520, borderRadius: 22, background: C.card, border: `1px solid ${C.line2}`, padding: 26, display: "flex", flexDirection: "column", gap: 16,
    boxShadow: "0 30px 80px rgba(0,0,0,.55)", fontFamily: FONT }}>
    <div style={{ fontWeight: 700, fontSize: 22, color: C.faint }}># tidepool-launch</div>
    <div style={{ display: "flex", gap: 14 }}>
      <div style={{ width: 44, height: 44, borderRadius: 12, background: "#0ea5e9", flex: "none", display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontSize: 20 }}>M</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 22, color: C.fg }}><b>Maya Chen</b> <span style={{ color: C.faint, fontSize: 18 }}>9:41 AM</span></div>
        <div style={{ fontSize: 22, color: C.fg, lineHeight: 1.4 }}>Pi's QA run is up. One fix before launch:</div>
        {/* Just the link: links are private (sign-in), so chat apps can't unfurl a preview. */}
        <SamePill scale={0.56} />
        <div style={{ display: "flex", gap: 8 }}>
          {["+1  3", "on it  1"].map((t) => <div key={t} style={{ fontSize: 16, color: C.muted, border: `1px solid ${C.line2}`, borderRadius: 999, padding: "4px 12px" }}>{t}</div>)}
        </div>
      </div>
    </div>
  </div>
);

/**
 * Where things go. 16:9: three cards in a row. 9:16: pill on top, agent + teammate side by side, phone below.
 * 1:1: the three cards in a row at 0.6 scale (`cardScale`), pill and lock line above.
 */
const layoutFor = (FW: number, FH: number) => {
  if (FW > FH * 1.2) return { W: 1280, X0: (FW - 1280) / 2, Y0: 210, pill: [FW / 2, 300], lock: { left: FW / 2 + 470, top: 300, center: false }, from: [FW / 2, 330],
    cards: [{ x: 420, y: 400 }, { x: 960, y: 400 }, { x: 1500, y: 400 }], cardScale: 1, pillScale: 1 };
  if (FH > FW * 1.2) return { W: 1000, X0: (FW - 1000) / 2, Y0: 520, pill: [FW / 2, 520], lock: { left: 0, top: 580, center: true }, from: [FW / 2, 610],
    cards: [{ x: 278, y: 660 }, { x: FW / 2, y: 1290 }, { x: 802, y: 660 }], cardScale: 1, pillScale: 1 };
  return { W: 960, X0: (FW - 960) / 2, Y0: 250, pill: [FW / 2, 300], lock: { left: 0, top: 350, center: true }, from: [FW / 2, 380],
    cards: [{ x: 190, y: 430 }, { x: 540, y: 430 }, { x: 890, y: 430 }], cardScale: 0.62, pillScale: 0.82 };
};

export const Links: React.FC = () => <LinksBoard />;

const LinksTitles: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  // Narrow frames wrap this line; break before "one link." so the blue phrase stays together on line two.
  const brk = width > height * 1.2 ? [] : ["\n"];
  return (
    <>
      <TitleAt y={70}>
        {frame < SAME - 1 && <Headline parts={["Every artifact gets ", ...brk, ["one link."]]} at={4} until={SAME - 1} size={92} />}
      </TitleAt>
      <TitleAt y={70}>
        {frame >= SAME - 2 && <Headline parts={["Same link. ", ["Every agent, device and teammate."]]} at={SAME - 2} size={72} />}
      </TitleAt>
    </>
  );
};

const LinksBoard: React.FC = () => {
  const frame = useCurrentFrame();
  const { width: FW, height: FH } = useVideoConfig();
  const L = layoutFor(FW, FH);
  // Phase A: browser + copy-link click (clip check-mark at ~1.3 s ≈ frame 80).
  const exit = interpolate(frame, [SPLIT - 10, SPLIT + 12], [0, 1], { ...CLAMP, easing: Easing.in(Easing.cubic) });
  const enter = useEnter(0, { damping: 18 });
  // Pill: born at the link icon (~frame 82), flies to just under the headline at SPLIT.
  const born = useEnter(82, { damping: 14, stiffness: 160 });
  const fly = interpolate(frame, [SPLIT - 6, SPLIT + 18], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const { W, X0, Y0 } = L;
  // Link icon (~0.79, 0.11 of the content) in frame space at zoom 1.45 about focus (0.62, 0.11); the focus moved
  // left so the doc title ("QA report: onboarding on iPhone") stays in frame.
  const iconX = X0 + W * (0.62 + (0.79 - 0.62) * 1.45), iconY = Y0 + BAR_H + W * 0.625 * 0.11;
  const pillX = interpolate(fly, [0, 1], [iconX - 170, L.pill[0]]), pillY = interpolate(fly, [0, 1], [iconY + 70, L.pill[1]]);
  const split = interpolate(frame, [CARDS[0] - 4, CARDS[2] + 10], [0, 1], CLAMP);

  return (
    <Stage>
      {/* Quick swap: the first headline is out by SAME-1, the second springs in from SAME-2 (no readable overlap). */}
      <LinksTitles />
      {/* Links are private: a lock line beside (16:9) or under (9:16) the central pill while the cards are on screen. */}
      {frame >= SPLIT + 12 && (
        <div style={{ position: "absolute", left: L.lock.left, right: L.lock.center ? 0 : undefined, top: L.lock.top, transform: "translateY(-50%)", pointerEvents: "none", display: "flex",
          justifyContent: L.lock.center ? "center" : undefined, alignItems: "center", gap: 8,
          fontFamily: FONT, fontWeight: 650, fontSize: 22, color: C.muted, whiteSpace: "nowrap", opacity: interpolate(frame, [SPLIT + 12, SPLIT + 26], [0, 1], CLAMP) }}>
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth={2.2} strokeLinecap="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          Private. Sign-in required.
        </div>
      )}
      {exit < 1 && (
        <div style={{ position: "absolute", left: X0, top: Y0, opacity: (1 - exit) * enter, transform: `translateY(${(1 - enter) * 40 + exit * 80}px) scale(${1 - 0.1 * exit})` }}>
          <BrowserFrame width={W}>
            <Zoom keys={[[0, 1, 0.5, 0.3], [30, 1, 0.5, 0.3], [64, 1.45, 0.62, 0.11], [SPLIT, 1.45, 0.62, 0.11]]}>
              <Clip name="copy-link-dark-desktop" />
            </Zoom>
          </BrowserFrame>
        </div>
      )}
      {frame >= 82 && (
        <div style={{ position: "absolute", left: pillX, top: pillY, transform: `translate(-50%,-50%) scale(${(0.6 + 0.4 * born) * (1 + 0.35 * fly)})`, opacity: born }}>
          <LinkPill scale={L.pillScale} />
          {/* "Link copied" chip */}
          <div style={{ position: "absolute", left: "50%", top: -46, transform: "translateX(-50%)", fontFamily: FONT, fontWeight: 700, fontSize: 18, color: C.ok,
            opacity: interpolate(frame, [86, 96, SPLIT - 10, SPLIT], [0, 1, 1, 0], CLAMP), whiteSpace: "nowrap" }}>✓ Link copied</div>
        </div>
      )}
      {/* Connector lines from the pill to each destination */}
      {frame >= SPLIT && (
        <svg width={FW} height={FH} style={{ position: "absolute", inset: 0 }}>
          {L.cards.map(({ x, y }, i) => {
            const [fx, fy] = L.from;
            // In 9:16 the phone sits below the other two cards: route its line down the centre gap.
            const d = y > 1000 ? `M ${fx} ${fy} L ${fx} ${y + 30}` : `M ${fx} ${fy} C ${fx} ${fy + 40}, ${x} ${y - 30}, ${x} ${y + 30}`;
            return <path key={i} d={d} fill="none" stroke={C.accentLine} strokeWidth={2.5} strokeDasharray="6 8"
              opacity={interpolate(frame, [CARDS[i] - 6, CARDS[i]], [0, 1], CLAMP) * (0.4 + 0.6 * split)} />;
          })}
        </svg>
      )}
      <AbsoluteFill style={{ top: 30 }}>
        {[
          <Card key="a" at={CARDS[0]} x={0} y={0} w={useCardW()} label="Another agent"><AgentChat at={CARDS[0]} /></Card>,
          <Card key="p" at={CARDS[1]} x={0} y={0} label="Your phone" w={300}><Phone at={CARDS[1] - 6} /></Card>,
          <Card key="t" at={CARDS[2]} x={0} y={0} w={useCardW()} label="A teammate"><TeamMessage /></Card>,
        ].map((card, i) => (
          // Each card is positioned by a wrapper so it can be scaled about its top centre (1:1 uses 0.62).
          <div key={i} style={{ position: "absolute", left: L.cards[i].x, top: L.cards[i].y, transform: `scale(${L.cardScale})`, transformOrigin: "0 0" }}>{card}</div>
        ))}
      </AbsoluteFill>
    </Stage>
  );
};
