import type { StyleBeat, StyleReelStyle } from "./style-reel";

export type DirectionNote = {
  code: string;
  from: number;
  to: number;
  message: string;
};

/** Editorial prompts, never a quality score or an automatic rewrite of a plan. */
export function reviewStyleBeats(
  beats: StyleBeat[],
  style: StyleReelStyle,
): DirectionNote[] {
  const notes: DirectionNote[] = [];
  const signature = (beat: StyleBeat) => {
    const visual = beat.visual;
    const layout =
      beat.layout ??
      (visual ? (style === "cards" ? "full" : "split") : "speaker");
    return `${layout}:${visual?.kind ?? "speaker"}:${beat.entrance ?? "legacy"}`;
  };
  let run = 0;
  for (let index = 0; index <= beats.length; index++) {
    if (
      index > 0 &&
      index < beats.length &&
      signature(beats[index]) === signature(beats[run]) &&
      beats[index].from <= beats[index - 1].to + 0.1
    )
      continue;
    if (index - run >= 4 && style !== "locked-split")
      notes.push({
        code: "repeated_composition",
        from: beats[run].from,
        to: beats[index - 1].to,
        message:
          "Four or more consecutive beats use the same layout, visual kind and entrance. Review the visible action and shot scale. Keep a continuous demonstration when it develops; change the composition when the idea changes. Recoloring the backdrop alone does not resolve repetition.",
      });
    run = index;
  }
  const visual = (beat: StyleBeat) =>
    beat.visual?.kind === "asset"
      ? `${beat.visual.assetId}:${beat.sourceIn ?? 0}`
      : undefined;
  for (let i = 1; i < beats.length; i++)
    if (visual(beats[i]) && visual(beats[i]) === visual(beats[i - 1]))
      notes.push({
        code: "repeated_source",
        from: beats[i - 1].from,
        to: beats[i].to,
        message:
          "Adjacent beats restart the same asset passage. Continue the action with sourceIn or choose a meaningful detail; retain the repetition only when it is intentional.",
      });
  return notes.slice(0, 20);
}
