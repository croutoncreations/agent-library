// Scene plans in frames, aligned to the music: every scene boundary falls on a beat (beatFrame()).
// Beat ≈ 0.63 s at 95.1 BPM. The hook includes the 0.6 s pickup before beat 0 and is 7 beats in every cut.
import { beatFrame } from "./theme";

export type SceneId = "hook" | "reveal" | "collage" | "links" | "anyagent" | "access" | "edits" | "markdown" | "end";
export type Plan = { id: SceneId; from: number; frames: number }[];

/** [id, end beat] pairs → scenes with start frame and length. */
const build = (ends: [SceneId, number][]): Plan => {
  let prev = 0;
  return ends.map(([id, endBeat]) => {
    const end = beatFrame(endBeat);
    const s = { id, from: prev, frames: end - prev };
    prev = end;
    return s;
  });
};
export const planFrames = (p: Plan) => p[p.length - 1].from + p[p.length - 1].frames;

// 16:9 hero, ~45 s.
export const HERO_PLAN = build([
  ["hook", 7],       // 0:00–0:05.1  "Which agent has the launch plan?" + spinning reel (fades before it wraps)
  ["reveal", 14],    // –0:09.4     Agent Library · One library. Every agent. · Open source
  ["collage", 21],   // –0:13.8     Docs. Pages. PDFs. Screenshots. Video. → All in one place.
  ["links", 32],     // –0:20.8     Every artifact gets one link. → same link: agents, phone, teammate
  ["anyagent", 39],  // –0:25.2     Any agent reads and writes over MCP (Claude saves → Codex reads)
  ["access", 47],    // –0:30.3     You decide who gets what (real consent toggles)
  ["edits", 57],     // –0:36.6     Undo any agent's change: ChatGPT wipes the plan (v6) → restore v5 as v7
  ["markdown", 63],  // –0:40.3     Markdown is first-class
  ["end", 71],       // –0:45.4     One library. Every agent. · Open source · any agent · CF free plan + GitHub URL
]);
// 9:16 vertical and 1:1 square: the same story and timing as the hero, laid out for the frame.
export const VERTICAL_PLAN = HERO_PLAN;
export const SQUARE_PLAN = HERO_PLAN;
// 1:1 teaser, ~25 s: the problem, the answer, the "aha" (one link everywhere), where to get it.
export const TEASER_PLAN = build([["hook", 7], ["reveal", 14], ["links", 25], ["end", 33]]);

export const sceneLen = (p: Plan, id: SceneId) => p.find((s) => s.id === id)!.frames;
// Back-compat for scenes that read their own length from the hero plan (the hook is identical in every cut).
export const SCENES = Object.fromEntries(HERO_PLAN.map((s) => [s.id, s.frames])) as Record<SceneId, number>;
export const HERO_FRAMES = planFrames(HERO_PLAN);
