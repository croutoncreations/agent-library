// Scene 4: the variety of things agents make. Words land one per beat ("Docs. Pages. PDFs. Screenshots. Video."),
// each bringing in its tiles (isolated renders of real artifacts in the seeded library). Then the wall collapses
// into the library itself (home-scroll clip): "All in one place."
import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, Easing, spring, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { C, FONT, BEAT } from "../theme";
import { BrowserFrame, Clip, CLAMP, Stage, TitleAt, Headline } from "../components/ui";
import { FileIcon, FileKind } from "../components/FileIcon";

const B = (n: number) => Math.round(n * BEAT);
// r = height/width of the tile image; g = which word (0..4) brings it in. One tile per distinct artifact: the
// onboarding "When?" screen appears once (as the playing QA video), not as report + screenshot + video.
type Tile = { f: string; r: number; g: number; k: FileKind; video?: string };
const TILES: Tile[] = [
  { f: "md-launch-plan", r: 3358 / 1904, g: 0, k: "md" },
  { f: "html-landing", r: 1080 / 1904, g: 1, k: "html" },
  { f: "img-chart", r: 978 / 1904, g: 3, k: "png" },
  { f: "md-research-brief", r: 1162 / 1904, g: 0, k: "md" },
  { f: "video-qa-run", r: 1.25, g: 4, k: "mp4", video: "clips/qa-run-tile.mp4" },
  { f: "pdf-card", r: 0.62, g: 2, k: "pdf" },
  { f: "md-trip", r: 1958 / 1904, g: 0, k: "md" },
  { f: "img-app-screens", r: 1060 / 1904, g: 3, k: "png" },
  { f: "html-perf-audit", r: 1080 / 1904, g: 1, k: "html" },
  { f: "md-refactor-plan", r: 1400 / 1904, g: 0, k: "md" },
  { f: "img-photo", r: 1192 / 1904, g: 3, k: "png" },
  { f: "md-release-notes", r: 750 / 1904, g: 0, k: "md" },
  { f: "md-interviews", r: 946 / 1904, g: 0, k: "md" },
  { f: "md-press-kit", r: 744 / 1904, g: 0, k: "md" },
];

/** A PDF as a page thumbnail (the pdf tile is only the file card, too thin to read as a document). */
const PdfPage: React.FC = () => (
  <div style={{ position: "absolute", inset: 0, background: "#f4f4f5", display: "grid", placeItems: "center" }}>
    <div style={{ width: "78%", height: "86%", background: "#fff", boxShadow: "0 6px 18px rgba(0,0,0,.25)", padding: "18px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 17, color: "#18181b" }}>Tidepool architecture</div>
      <div style={{ fontFamily: FONT, fontSize: 11, color: "#71717a" }}>Sync engine · v1.0 · 4 pages</div>
      {[92, 80, 88, 60, 0, 85, 90, 70].map((w, i) => w ? <div key={i} style={{ height: 6, width: `${w}%`, background: "#e4e4e7", borderRadius: 3 }} /> : <div key={i} style={{ height: 34, display: "flex", gap: 6 }}>{[0, 1, 2].map((j) => <div key={j} style={{ flex: 1, border: "1.5px solid #c7d2fe", borderRadius: 4, background: "#eef2ff" }} />)}</div>)}
    </div>
  </div>
);

/** VIDEO badge + progress bar so a playing clip reads as a video, not a screenshot. */
const VideoChrome: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  const p = ((frame - at) / 300) % 1;
  return (
    <>
      <div style={{ position: "absolute", right: 10, top: 10, display: "flex", alignItems: "center", gap: 6, background: "rgba(10,10,13,.78)", color: "#fff",
        borderRadius: 8, padding: "5px 10px", fontFamily: FONT, fontWeight: 800, fontSize: 14, letterSpacing: "0.06em" }}>
        <div style={{ width: 0, height: 0, borderLeft: "9px solid #fff", borderTop: "6px solid transparent", borderBottom: "6px solid transparent" }} /> VIDEO
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 34, background: "linear-gradient(transparent, rgba(0,0,0,.75))" }}>
        <div style={{ position: "absolute", left: 12, right: 12, bottom: 10, height: 4, borderRadius: 2, background: "rgba(255,255,255,.3)" }}>
          <div style={{ width: `${Math.max(0, p) * 100}%`, height: "100%", borderRadius: 2, background: C.accent }} />
        </div>
      </div>
    </>
  );
};
const WORDS = ["Docs.", "Pages.", "PDFs.", "Screenshots.", "Video."];
const COLW = 330, GAP = 22, MAXH = 400;

// Deterministic masonry for a frame width: each tile goes into the currently shortest column.
const layoutFor = (W: number, top: number) => {
  const cols = W >= 1800 ? 5 : 3;
  const left = (W - (cols * COLW + (cols - 1) * GAP)) / 2;
  const hs = Array(cols).fill(0);
  return TILES.map((t) => {
    const h = Math.min(MAXH, Math.max(110, Math.round(COLW * t.r)));
    const c = hs.indexOf(Math.min(...hs));
    const pos = { x: left + c * (COLW + GAP), y: top + hs[c], h };
    hs[c] += h + GAP;
    return pos;
  });
};

const COLLAPSE = B(5);

export const Collage: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const wide = W > H * 1.2, tall = H > W * 1.2;
  const fit = Math.min(1, W / 1200);
  // Words wrap in narrow frames, so the wall starts lower.
  const top = wide ? 230 : tall ? 560 : 330;
  const LAYOUT = layoutFor(W, top);
  const collapse = interpolate(frame, [COLLAPSE - 4, COLLAPSE + 20], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const lib = spring({ frame: frame - COLLAPSE - 6, fps, config: { damping: 18, stiffness: 120 } });
  const wordsOut = interpolate(frame, [COLLAPSE - 6, COLLAPSE + 2], [1, 0], CLAMP);

  return (
    <Stage>
      {/* The wall of artifacts */}
      <AbsoluteFill style={{ transform: `scale(${1 - 0.62 * collapse}) translateY(${collapse * 120}px)`, transformOrigin: "50% 60%", opacity: 1 - collapse }}>
        {TILES.map((t, i) => {
          const at = B(t.g) + (i % 4) * 3;
          const e = spring({ frame: frame - at, fps, config: { damping: 14, stiffness: 150 } });
          const { x, y, h } = LAYOUT[i];
          const rot = ((i * 37) % 7 - 3) * (1 - e) * 2.5;
          const tall = COLW * t.r > MAXH;
          return (
            <div key={t.f} style={{ position: "absolute", left: x, top: y, width: COLW, height: h, borderRadius: 14, overflow: "hidden",
              background: C.card, border: `1px solid ${C.line2}`, boxShadow: "0 20px 50px rgba(0,0,0,.5)",
              opacity: e, transform: `translateY(${(1 - e) * 80}px) rotate(${rot}deg) scale(${0.9 + 0.1 * e})` }}>
              {t.video ? (
                <Video src={staticFile(t.video)} muted loop objectFit="cover" style={{ width: "100%", height: "100%" }} />
              ) : t.k === "pdf" ? <PdfPage /> : (
                <Img src={staticFile(`tiles/${t.f}.png`)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top",
                  transform: tall ? `translateY(${-interpolate(frame, [at, at + B(6)], [0, Math.min(140, h * 0.3)], CLAMP)}px)` : undefined }} />
              )}
              {t.video && <VideoChrome at={at} />}
              <div style={{ position: "absolute", left: 10, top: 10 }}><FileIcon kind={t.k} size={28} lit={1} /></div>
            </div>
          );
        })}
        {/* fade the bottom edge into the stage */}
        <AbsoluteFill style={{ background: `linear-gradient(to bottom, transparent 78%, ${C.bg} 98%)` }} />
      </AbsoluteFill>

      {/* Words, one per beat */}
      <TitleAt y={70}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", columnGap: 26 * fit, rowGap: 0, maxWidth: W - 80, fontFamily: FONT, fontWeight: 850,
          fontSize: 88 * fit, lineHeight: 1.1, letterSpacing: "-0.035em", opacity: wordsOut }}>
          {WORDS.map((w, i) => {
            const e = spring({ frame: frame - B(i), fps, config: { damping: 14, stiffness: 170 } });
            const isNew = frame >= B(i) && frame < B(i + 1);
            return <span key={w} style={{ opacity: e, transform: `translateY(${(1 - e) * 30}px)`, color: isNew ? C.accent : C.fg, display: "inline-block" }}>{w}</span>;
          })}
        </div>
      </TitleAt>

      {/* …all in one place: the library itself */}
      {frame >= COLLAPSE && (
        <>
          <TitleAt y={70}><Headline parts={["All in ", ["one place."]]} at={COLLAPSE + 2} size={92} /></TitleAt>
          {wide ? (
            <div style={{ position: "absolute", left: (W - 1280) / 2, top: 210, opacity: lib, transform: `scale(${1.25 - 0.25 * lib})`, transformOrigin: "50% 40%" }}>
              <BrowserFrame width={1280}><Clip name="home-scroll-dark-desktop" trimBefore={20} /></BrowserFrame>
            </div>
          ) : (
            // Narrow frames: the library on a phone (the real mobile capture, starting on Home).
            <div style={{ position: "absolute", left: W / 2 - (tall ? 270 : 200), top: tall ? 520 : 250, width: tall ? 540 : 400, height: tall ? 1100 : 780, borderRadius: 64,
              background: "#000", border: "10px solid #26262c", overflow: "hidden", boxShadow: "0 40px 120px rgba(0,0,0,.65)",
              opacity: lib, transform: `scale(${1.15 - 0.15 * lib})` }}>
              {/* The real mobile Home screen (the clip opens a document, so a still reads better as "the library"). */}
              <Img src={staticFile("stills/01-home-mobile-dark.png")} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
            </div>
          )}
        </>
      )}
    </Stage>
  );
};
