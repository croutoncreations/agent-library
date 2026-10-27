// Copy generated marketing assets into public/ (git-ignored). Run after scripts/marketing/{capture,clips}.mjs.
// Sources (repo root): tmp/marketing (stills + tiles), tmp/marketing/clips (60 fps clips; clips.mjs default --out),
// tmp/media/qa.mp4 (the synthetic QA-run video, written by seed.mjs), src/web/brand (logo),
// and a music track from MUSIC=/path/to/track.mp3 (not included in the repository).
import { cpSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
const root = join(here, "..", "..", "..");
const copyDir = (from, to, filter = () => true) => {
  if (!existsSync(from)) { console.warn("missing", from); return 0; }
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of readdirSync(from)) if (filter(f)) { cpSync(join(from, f), join(to, f)); n++; }
  return n;
};
console.log("stills", copyDir(join(root, "tmp/marketing"), join(pub, "stills"), (f) => f.endsWith(".png")));
console.log("tiles", copyDir(join(root, "tmp/marketing/tiles"), join(pub, "tiles"), (f) => f.endsWith(".png")));
// Same default as scripts/marketing/clips.mjs --out; override with CLIPS=<dir> if you recorded elsewhere.
const clips = process.env.CLIPS ? join(root, process.env.CLIPS) : join(root, "tmp/marketing/clips");
console.log("clips", copyDir(clips, join(pub, "clips"), (f) => f.endsWith(".mp4")));
console.log("brand", copyDir(join(root, "src/web/brand"), join(pub, "brand"), (f) => f.endsWith(".png")));
// The synthetic QA-run video itself (made by demo-images.mjs, saved by seed.mjs) plays inside the collage tile.
const qa = join(root, "tmp/media/qa.mp4");
if (existsSync(qa)) { cpSync(qa, join(pub, "clips", "qa-run-tile.mp4")); console.log("qa tile video ok"); } else console.warn("missing", qa);
const music = process.env.MUSIC ?? join(pub, "audio", "launch-day-loop.mp3");
mkdirSync(join(pub, "audio"), { recursive: true });
const dest = join(pub, "audio", "launch-day-loop.mp3");
if (existsSync(music)) { if (resolve(music) !== dest) cpSync(music, dest); console.log("music ok"); } else console.warn("music missing: set MUSIC=/path/to/track.mp3");
