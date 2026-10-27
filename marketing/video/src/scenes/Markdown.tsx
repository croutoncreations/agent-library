// Scene: Markdown is first-class. The editor-typing clip, sped up and zoomed on the line being typed, then
// pulled back as it flips to the rendered preview. Narrow frames use a tall window cropped to the document column.
import React from "react";
import { BEAT } from "../theme";
import { C } from "../theme";
import { BrowserFrame, Clip, FitClip, Headline, Stage, TitleAt, Zoom, useEnter, useFrame } from "../components/ui";

const B = (n: number) => Math.round(n * BEAT);

export const Markdown: React.FC = () => {
  const enter = useEnter(0, { damping: 18 });
  const { W, H, wide, tall } = useFrame();
  // Window: 1280×800 (16:9); 1000×1240 (9:16); 960×700 (1:1).
  const bw = wide ? 1280 : tall ? 1000 : 960, bh = wide ? 800 : tall ? 1240 : 700;
  const top = wide ? 250 : tall ? 560 : 300;
  // In narrow windows the zoom eases less (the crop already enlarges the column).
  const z = wide ? [1.9, 1.15] : [1.5, 1.0];
  return (
    <Stage>
      <TitleAt y={70}>
        <Headline parts={["Markdown is ", ["first-class."]]} at={2} size={92} />
        <Headline parts={["Agents write it. You edit it. No conversion."]} at={B(1)} size={38} weight={600} color={C.muted} />
      </TitleAt>
      <div style={{ position: "absolute", left: (W - bw) / 2, top: wide ? top : Math.min(top, H - bh - 60), opacity: enter, transform: `translateY(${(1 - enter) * 40}px)` }}>
        <BrowserFrame width={bw} height={bh}>
          <FitClip w={bw} h={bh} focusX={0.42}>
            {/* rate 2.6: typing done ≈ 2.3 s, rendered Preview from ≈ 2.55 s, held for the last ~1.2 s (≈ 2 beats). */}
            <Zoom keys={[[0, z[0], 0.3, 0.24], [B(3.2), z[0], 0.36, 0.24], [B(3.9), z[1], 0.45, 0.3], [B(6), z[1], 0.45, 0.3]]}>
              <Clip name="editor-typing-dark-desktop" trimBefore={60} rate={2.6} />
            </Zoom>
          </FitClip>
        </BrowserFrame>
      </div>
    </Stage>
  );
};
