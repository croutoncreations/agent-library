import React from "react";
import { AbsoluteFill, Sequence, staticFile, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import { Hook } from "./scenes/Hook";
import { Reveal } from "./scenes/Reveal";
import { Links } from "./scenes/Links";
import { Collage } from "./scenes/Collage";
import { Access } from "./scenes/Access";
import { Edits } from "./scenes/Edits";
import { Markdown } from "./scenes/Markdown";
import { EndCard } from "./scenes/EndCard";
import { AnyAgent } from "./scenes/AnyAgent";
import { HERO_PLAN, HERO_FRAMES, Plan, SceneId } from "./timeline";
import { C, BAR } from "./theme";

export const SCENE_COMPONENTS: Record<SceneId, React.FC> = {
  hook: Hook, reveal: Reveal, collage: Collage, links: Links, anyagent: AnyAgent, access: Access, edits: Edits, markdown: Markdown, end: EndCard,
};

/** Cuts land on beats; a 6-frame dip from the stage colour softens each one without blurring the beat. */
const CutDip: React.FC = () => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ background: C.bg, opacity: interpolate(f, [0, 6], [1, 0], { extrapolateRight: "clamp" }), pointerEvents: "none" }} />;
};

/** One cut of the video: the scenes of `plan` back to back over the music, faded out over the last bar. */
export const Cut: React.FC<{ plan: Plan }> = ({ plan }) => {
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Audio src={staticFile("audio/launch-day-loop.mp3")}
        volume={(f) => interpolate(f, [0, 12, durationInFrames - BAR, durationInFrames], [0, 0.9, 0.9, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
      {plan.map(({ id, from, frames }) => {
        const Comp = SCENE_COMPONENTS[id];
        return (
          <Sequence key={id} name={id} from={from} durationInFrames={frames} premountFor={60}>
            <Comp />
            {id !== "hook" && id !== "reveal" && <CutDip />}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export const Hero: React.FC = () => <Cut plan={HERO_PLAN} />;
export { HERO_FRAMES };
