import React from "react";
import { Composition, Folder } from "remotion";
import { Cut, Hero, SCENE_COMPONENTS } from "./Hero";
import { FPS } from "./theme";
import { HERO_FRAMES, HERO_PLAN, SQUARE_PLAN, TEASER_PLAN, VERTICAL_PLAN, planFrames } from "./timeline";

const Vertical: React.FC = () => <Cut plan={VERTICAL_PLAN} />;
const Square: React.FC = () => <Cut plan={SQUARE_PLAN} />;
const SquareTeaser: React.FC = () => <Cut plan={TEASER_PLAN} />;

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Hero" component={Hero} durationInFrames={HERO_FRAMES} fps={FPS} width={1920} height={1080} />
    <Composition id="Vertical" component={Vertical} durationInFrames={planFrames(VERTICAL_PLAN)} fps={FPS} width={1080} height={1920} />
    <Composition id="Square" component={Square} durationInFrames={planFrames(SQUARE_PLAN)} fps={FPS} width={1080} height={1080} />
    <Composition id="SquareTeaser" component={SquareTeaser} durationInFrames={planFrames(TEASER_PLAN)} fps={FPS} width={1080} height={1080} />
    <Folder name="Scenes">
      {HERO_PLAN.map(({ id, frames }, i) => (
        <Composition key={id} id={`S${i + 1}-${id}`} component={SCENE_COMPONENTS[id]} durationInFrames={frames} fps={FPS} width={1920} height={1080} />
      ))}
    </Folder>
    <Folder name="Vertical-scenes">
      {VERTICAL_PLAN.map(({ id, frames }, i) => (
        <Composition key={id} id={`V${i + 1}-${id}`} component={SCENE_COMPONENTS[id]} durationInFrames={frames} fps={FPS} width={1080} height={1920} />
      ))}
    </Folder>
  </>
);
