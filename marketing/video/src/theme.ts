// Visual system: the Agent Library app's dark theme (src/web/app.css, prefers-color-scheme: dark).
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

export const inter = loadInter("normal", { weights: ["400", "500", "600", "700", "800", "900"], subsets: ["latin"] });
export const mono = loadMono("normal", { weights: ["400", "500", "700"], subsets: ["latin"] });

export const C = {
  bg: "#0a0a0d",
  card: "#111114",
  sunk: "#18181b",
  side: "#0e0e11",
  line: "#1f1f25",
  line2: "#2e2e36",
  fg: "#ececef",
  muted: "#a1a1aa",
  faint: "#8b8b95",
  accent: "#60a5fa", // app accent (dark)
  accentSoft: "rgba(96,165,250,0.12)",
  accentLine: "rgba(96,165,250,0.38)",
  brand: "#2563eb", // Fold mark blue
  ok: "#4ade80",
  warn: "#f0b54a",
  // syntax colours from the editor theme, used for artifact-type accents
  heading: "#9ab8ff",
  string: "#a5d6ff",
  attr: "#d2a8ff",
  code: "#f0a0c0",
  number: "#ffb070",
  tag: "#7ee2a8",
};

export const FONT = `${inter.fontFamily}, -apple-system, system-ui, sans-serif`;
export const MONO = `${mono.fontFamily}, ui-monospace, Menlo, monospace`;

// Music: "Launch Day Loop" measured at ~95.1 BPM, first beat at 0.61 s, full drums from ~4.4 s.
// At 60 fps: beat = 37.8 frames, bar = 151.4 frames. beatFrame(n) gives the frame of beat n (0-based).
/** Hostname shown in browser chrome and links. A reserved example name (AGENTS.md: example.com/.test/.invalid only). */
export const DEMO_HOST = "library.example.com";

export const FPS = 60;
export const BPM = 95.14;
export const BEAT = (60 / BPM) * FPS;
export const BAR = BEAT * 4;
export const FIRST_BEAT = 0.612 * FPS;
export const beatFrame = (n: number) => Math.round(FIRST_BEAT + n * BEAT);
