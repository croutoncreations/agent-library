// Scene: "You decide who gets what." Copy plus the real consent screen, recorded at 3x with real clicks on the
// per-project toggles (consent-toggle clip; clicks are 630 ms apart ≈ one beat, so with a 1-frame trim they land
// on beats 1–5 of this scene). The crop starts below the "Name not verified" badge row.
// 16:9: copy left, consent right. 9:16: copy on top, consent below.
import React from "react";
import { useVideoConfig } from "remotion";
import { C, BEAT } from "../theme";
import { Clip, Headline, Stage, useEnter } from "../components/ui";

const B = (n: number) => Math.round(n * BEAT);
// Crop of the 560×900 CSS-px consent viewport (clip is 1680×2700): from the PROJECTS label to the footer.
const CROP = { x: 40, y: 300, w: 480, h: 500 };

export const Access: React.FC = () => {
  const { width: FW, height: FH } = useVideoConfig();
  const wide = FW > FH * 1.2, square = !wide && FH < FW * 1.2;
  const card = useEnter(0, { damping: 18 });
  const S = wide ? 1.85 : square ? 1.15 : 1.95; // output px per CSS px (source is 3 px per CSS px, so this stays sharp)
  const W = CROP.w * S, H = CROP.h * S;
  const copy = (
    <>
      <Headline parts={["You decide"]} at={2} size={square ? 76 : 104} align={wide || square ? "left" : "center"} />
      <Headline parts={[["who gets what."]]} at={B(0.5)} size={square ? 76 : 104} align={wide || square ? "left" : "center"} />
      <Headline parts={["Pick per agent, per project:", "\n", "off, read, or edit. Revoke any time."]} at={B(1.5)} size={square ? 34 : 40} weight={600} color={C.muted} align={wide || square ? "left" : "center"}
        style={{ whiteSpace: "pre-line", lineHeight: 1.35, marginTop: 10 }} />
    </>
  );
  return (
    <Stage>
      {wide || square ? (
        <div style={{ position: "absolute", left: wide ? 120 : 50, top: 0, bottom: 0, width: wide ? 760 : 440, display: "flex", flexDirection: "column", justifyContent: "center", gap: wide ? 28 : 14 }}>{copy}</div>
      ) : (
        <div style={{ position: "absolute", left: 40, right: 40, top: 260, display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>{copy}</div>
      )}
      <div style={{ position: "absolute", left: wide || square ? undefined : (FW - W) / 2, right: wide ? 90 : square ? 40 : undefined, top: wide || square ? (FH - H) / 2 : 760, width: W, height: H, borderRadius: 26,
        overflow: "hidden", background: C.card, border: `1px solid ${C.line2}`, boxShadow: "0 40px 120px rgba(0,0,0,.65)", opacity: card,
        transform: wide || square ? `translateX(${(1 - card) * 60}px)` : `translateY(${(1 - card) * 60}px)` }}>
        <div style={{ position: "absolute", left: -CROP.x * S, top: -CROP.y * S, width: 560 * S, height: 900 * S }}>
          <Clip name="consent-toggle-dark-consent" trimBefore={1} />
        </div>
      </div>
    </Stage>
  );
};
