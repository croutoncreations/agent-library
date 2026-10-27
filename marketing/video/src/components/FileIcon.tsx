// A document-style file icon: folded corner, type glyph, coloured extension badge. Pure SVG.
import React from "react";
import { C, MONO } from "../theme";

export type FileKind = "md" | "html" | "pdf" | "png" | "mp4" | "json" | "csv";
export const KIND_COLOR: Record<FileKind, string> = {
  md: C.heading, html: C.attr, pdf: C.code, png: C.tag, mp4: C.number, json: C.string, csv: C.ok,
};

const Glyph: React.FC<{ kind: FileKind; color: string }> = ({ kind, color }) => {
  const line = (y: number, w: number) => <rect key={y} x={14} y={y} width={w} height={4} rx={2} fill={color} opacity={0.55} />;
  switch (kind) {
    case "png":
      return (<g><circle cx={42} cy={30} r={5} fill={color} opacity={0.8} /><path d="M12 50 L26 33 L36 44 L42 38 L52 50 Z" fill={color} opacity={0.75} /></g>);
    case "mp4":
      return (<g><circle cx={32} cy={38} r={14} fill="none" stroke={color} strokeWidth={3} opacity={0.8} /><path d="M28 31 L39 38 L28 45 Z" fill={color} /></g>);
    case "html":
      return <text x={32} y={44} textAnchor="middle" fontFamily={MONO} fontWeight={700} fontSize={17} fill={color}>{"</>"}</text>;
    case "json":
      return <text x={32} y={45} textAnchor="middle" fontFamily={MONO} fontWeight={700} fontSize={20} fill={color}>{"{ }"}</text>;
    case "csv":
      return (<g opacity={0.75}>{[0, 1, 2].map((r) => [0, 1, 2].map((c) => <rect key={`${r}${c}`} x={14 + c * 13} y={24 + r * 9} width={11} height={7} rx={1.5} fill={color} opacity={r === 0 ? 1 : 0.6} />))}</g>);
    default: // md, pdf
      return <g>{line(24, 36)}{line(32, 28)}{line(40, 34)}{line(48, 20)}</g>;
  }
};

export const FileIcon: React.FC<{ kind: FileKind; size?: number; lit?: number; style?: React.CSSProperties }> = ({ kind, size = 72, lit = 0, style }) => {
  const color = KIND_COLOR[kind];
  return (
    <svg width={size} height={size * 1.25} viewBox="0 0 64 80" style={{ overflow: "visible", ...style }}>
      <defs>
        <filter id={`glow-${kind}`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" /></filter>
      </defs>
      {lit > 0 && <path d="M6 2 H42 L60 20 V74 Q60 78 56 78 H6 Q2 78 2 74 V6 Q2 2 6 2 Z" fill={color} opacity={0.35 * lit} filter={`url(#glow-${kind})`} />}
      <path d="M6 2 H42 L60 20 V74 Q60 78 56 78 H6 Q2 78 2 74 V6 Q2 2 6 2 Z" fill={C.sunk} stroke={lit > 0 ? color : C.line2} strokeWidth={2} />
      <path d="M42 2 V16 Q42 20 46 20 H60" fill={C.line2} stroke={lit > 0 ? color : C.line2} strokeWidth={2} strokeLinejoin="round" />
      <Glyph kind={kind} color={color} />
      <rect x={8} y={58} width={48} height={14} rx={4} fill={color} />
      <text x={32} y={68.5} textAnchor="middle" fontFamily={MONO} fontWeight={800} fontSize={10} fill={C.bg} letterSpacing={0.5}>{kind.toUpperCase()}</text>
    </svg>
  );
};
