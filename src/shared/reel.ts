import { z } from "zod";
import {
  makeClip,
  ClipSchema,
  MotionSchema,
  uid,
  type Asset,
  type Clip,
  type Project,
  type Track,
  type MotionLayer,
  type Word,
} from "./model";
import { applyCommands, type Command } from "./commands";
import { buildCaptionClips } from "./caption-grouping";
import {
  creatorBrollPlacement,
  creatorBrollWindow,
  creatorCaptionClips,
  creatorEducationColors,
  creatorSpeakerPlacement,
  creatorTeachingLayers,
  creatorTitlePlacement,
} from "./creator-education";
import {
  creatorShortCaptionClips,
  creatorShortColors,
  creatorShortEmphasisLayers,
  creatorShortPunchIns,
  creatorProofPlacement,
  creatorProofSpeakerPlacement,
  creatorProofCaptionPlacement,
  isCreatorShortFormat,
  type CreatorProofWindow,
} from "./creator-shorts";
import {
  ReelBeatSchema,
  ReelProofBeatSchema,
  ReelFormatSchema,
  reelFormats,
  type ReelBeat,
  type ReelProofBeat,
  type ReelFormat,
} from "./reel-formats";

export const reelStyles = [
  {
    id: "clean",
    label: "Clean",
    description: "Natural color, smooth motion and clear captions.",
  },
  {
    id: "bold",
    label: "Bold",
    description: "Vivid color, punchy titles and short caption groups.",
  },
  {
    id: "cinematic",
    label: "Cinematic",
    description: "Soft fades, gentle camera movement and a film look.",
  },
] as const;
export type ReelStyle = (typeof reelStyles)[number]["id"];
export const ReelSourceSchema = z
  .object({
    assetId: z.string().min(1),
    sourceIn: z.number().finite().min(0).optional(),
    sourceOut: z.number().finite().min(0).optional(),
    speed: z.number().finite().min(0.1).max(8).optional(),
  })
  .strict();
export const ReelOptionsSchema = z
  .object({
    sources: z.array(ReelSourceSchema).min(1).max(1000),
    format: ReelFormatSchema.optional(),
    captionStyle: ClipSchema.shape.captionStyle.removeDefault().optional(),
    beats: z.array(ReelBeatSchema).max(24).optional(),
    proofBeats: z.array(ReelProofBeatSchema).max(24).optional(),
    targetSeconds: z.union([
      z.literal(15),
      z.literal(30),
      z.literal(60),
      z.literal(90),
    ]),
    mode: z.enum(["replace", "append"]).optional(),
    style: z.enum(["clean", "bold", "cinematic"]).optional(),
    captions: z.boolean().optional(),
    hook: z.string().max(120).optional(),
    cta: z.string().max(120).optional(),
    brollAssetIds: z.array(z.string().min(1)).max(1000).optional(),
    musicAssetId: z.string().min(1).optional(),
    musicVolume: z.number().finite().min(0).max(1).optional(),
  })
  .strict();
export type ReelSource = z.infer<typeof ReelSourceSchema>;
export type ReelOptions = z.infer<typeof ReelOptionsSchema>;
export type ReelPlan = {
  commands: Command[];
  label: string;
  startFrame: number;
  durationFrames: number;
  targetFrames: number;
  footageCount: number;
  captionCount: number;
  brollCount: number;
  beatCount: number;
  proofCount: number;
  missingTranscriptAssetIds: string[];
  warnings: string[];
};

type PreparedSource = {
  sourceIndex: number;
  asset: Asset;
  sourceIn: number;
  speed: number;
  capacity: number;
};
type Roles =
  | "titles"
  | "beats"
  | "captions"
  | "proofs"
  | "proof-speaker"
  | "proof-backdrop"
  | "broll"
  | "footage"
  | "backdrop"
  | "music";
const roleDetails: Record<Roles, { kind: Track["kind"]; name: string }> = {
  titles: { kind: "text", name: "Reel · titles" },
  beats: { kind: "text", name: "Reel · animations" },
  captions: { kind: "text", name: "Reel · captions" },
  proofs: { kind: "video", name: "Reel · proof screens" },
  "proof-speaker": { kind: "video", name: "Reel · proof speaker" },
  "proof-backdrop": { kind: "text", name: "Reel · proof canvas" },
  broll: { kind: "video", name: "Reel · B-roll" },
  footage: { kind: "video", name: "Reel · footage" },
  backdrop: { kind: "text", name: "Reel · canvas" },
  music: { kind: "audio", name: "Reel · music" },
};
const treatments: Record<
  ReelStyle,
  {
    look: Clip["look"];
    camera: Clip["cameraMotion"];
    title: Clip["preset"];
    accent: string;
    words: number;
    brollSeconds: number;
  }
> = {
  clean: {
    look: "none",
    camera: "zoom-in",
    title: "rise",
    accent: "#c6f16d",
    words: 4,
    brollSeconds: 3,
  },
  bold: {
    look: "vivid",
    camera: "zoom-in",
    title: "spring",
    accent: "#c6f16d",
    words: 3,
    brollSeconds: 2.3,
  },
  cinematic: {
    look: "cinematic",
    camera: "pan-left",
    title: "fade",
    accent: "#ffd59e",
    words: 5,
    brollSeconds: 3.5,
  },
};

function finite(value: number, name: string, min: number, max: number) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw Error(`${name} must be between ${min} and ${max}.`);
  return value;
}

/** Fairly share the requested duration, redistributing time from shorter sources. */
export function allocateReelFrames(
  capacities: number[],
  requested: number,
): number[] {
  const result = capacities.map(() => 0);
  let remaining = Math.min(
    requested,
    capacities.reduce((total, value) => total + value, 0),
  );
  let active = capacities.map((_, index) => index);
  while (remaining > 0 && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const index of active) {
      const frames = Math.min(
        share,
        capacities[index] - result[index],
        remaining,
      );
      result[index] += frames;
      remaining -= frames;
    }
    active = active.filter((index) => result[index] < capacities[index]);
  }
  return result;
}

/** Source timestamps become clip-local seconds, including both trim and speed. */
export function reelWordsForClip(
  asset: Asset,
  clip: Pick<Clip, "sourceIn" | "speed" | "duration">,
  fps: number,
): Word[] {
  const seconds = clip.duration / fps;
  return (asset.words ?? [])
    .filter(
      (word) =>
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.end > word.start &&
        word.text.trim(),
    )
    .map((word) => ({
      text: word.text.trim(),
      start: Math.max(0, (word.start - clip.sourceIn) / clip.speed),
      end: Math.min(seconds, (word.end - clip.sourceIn) / clip.speed),
    }))
    .filter((word) => word.end > word.start && word.start < seconds)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Captions remain within their source clip, and word highlighting keeps source timing. */
export function reelCaptionClips(
  p: Project,
  asset: Asset,
  footage: Clip,
  trackId: string,
  style: ReelStyle = "clean",
  captionStyle?: Clip["captionStyle"],
): Clip[] {
  return buildCaptionClips(p, reelWordsForClip(asset, footage, p.fps), {
    trackId,
    startFrame: footage.start,
    maxDurationFrames: footage.duration,
    sourceId: footage.id,
    style:
      captionStyle ??
      (style === "bold" ? "pop" : style === "cinematic" ? "box" : "standard"),
  });
}

function addReelTracks(
  p: Project,
  roles: Roles[],
  mode: "replace" | "append",
  commands: Command[],
): Record<Roles, string> {
  const chosen = new Set<string>(),
    tracks = p.tracks.map((track) => ({ ...track }));
  const ids = {} as Record<Roles, string>;
  for (const role of roles) {
    const details = roleDetails[role];
    // Replacing may reuse existing tracks. Appending only reuses genuinely
    // empty tracks, preserving every existing clip's layer order and settings.
    const candidates = tracks.filter(
      (track) =>
        !chosen.has(track.id) &&
        (mode === "replace" ||
          !p.clips.some((clip) => clip.trackId === track.id)),
    );
    let track =
      candidates.find(
        (track) => track.name === details.name && track.kind === details.kind,
      ) ??
      candidates.find((track) => track.kind === details.kind) ??
      (mode === "replace" ? candidates[0] : undefined);
    if (track) {
      const patch = {
        ...details,
        muted: ["broll", "proofs", "proof-speaker"].includes(role),
        hidden: false,
      };
      commands.push({ type: "track.update", id: track.id, patch });
      Object.assign(track, patch);
    } else {
      if (tracks.length >= 64)
        throw Error(
          "There is no room for Reel layers. Build a new Reel or remove unused layers first.",
        );
      track = {
        id: uid(),
        ...details,
        muted: ["broll", "proofs", "proof-speaker"].includes(role),
        hidden: false,
      };
      commands.push({ type: "track.add", track });
      // Mirror command insertion before emitting explicit layer moves below.
      if (track.kind === "text") tracks.unshift(track);
      else if (track.kind === "audio") tracks.push(track);
      else {
        const firstVideo = tracks.findIndex((item) => item.kind === "video");
        tracks.splice(firstVideo < 0 ? tracks.length : firstVideo, 0, track);
      }
    }
    chosen.add(track.id);
    ids[role] = track.id;
  }
  // Topmost first: titles, captions, B-roll, source footage, music.
  for (let target = 0; target < roles.length; target++) {
    const id = ids[roles[target]];
    let current = tracks.findIndex((track) => track.id === id);
    while (current > target) {
      commands.push({ type: "track.move", id, direction: "up" });
      [tracks[current - 1], tracks[current]] = [
        tracks[current],
        tracks[current - 1],
      ];
      current--;
    }
  }
  return ids;
}

function titleClip(
  p: Project,
  trackId: string,
  text: string,
  start: number,
  frames: number,
  style: ReelStyle,
  ending: boolean,
  format: ReelFormat = "montage",
): Clip {
  const clip = makeClip(p, "text", trackId, start);
  const width = Math.round(p.width * 0.78),
    height = Math.round(p.height * 0.17);
  const longest = Math.max(...text.split(/\s+/).map((word) => word.length));
  const fontSize = Math.max(
    8,
    Math.floor(
      Math.min(
        p.width * 0.074,
        (width - 24) / Math.max(1, longest) / 0.62,
        Math.sqrt(
          ((width - 24) * (height - 24)) / Math.max(1, text.length) / 1.1,
        ),
      ),
    ),
  );
  return {
    ...clip,
    duration: frames,
    text,
    x: Math.round(p.width * 0.08),
    y: Math.round(p.height * (ending ? 0.49 : 0.18)),
    width,
    height,
    fontSize,
    background: "#101112cc",
    accent: treatments[style].accent,
    preset: treatments[style].title,
    animationFrames: Math.max(
      1,
      Math.min(Math.round(p.fps * 0.35), Math.floor(frames / 3)),
    ),
    exitAnimation: "fade",
    ...(format === "creator-education" ? creatorTitlePlacement(p, text) : {}),
    ...(isCreatorShortFormat(format)
      ? {
          background: "transparent",
          y: Math.round(p.height * 0.17),
          color: creatorShortColors.ink,
          accent: creatorShortColors.accent,
          preset: "rise" as const,
        }
      : {}),
  };
}

/** Sentence starts use real source alignment, including imported phrase cues. */
function sentenceStarts(asset: Asset, clip: Clip, fps: number) {
  const words = reelWordsForClip(asset, clip, fps);
  return words.flatMap((word, index) => {
    const previous = words[index - 1];
    if (
      index &&
      previous &&
      !/[.,;:!?。，；：！？]["'”’)]?$/u.test(previous.text) &&
      word.start - previous.end < 0.55
    )
      return [];
    const phrase: string[] = [];
    for (let at = index; at < words.length && phrase.length < 7; at++) {
      const text = words[at].text;
      phrase.push(text);
      if (/[.,;:!?。，；：！？]["'”’)]?$/u.test(text)) break;
    }
    const text = phrase.join(" ").replace(/\s+/gu, " ").slice(0, 80).trim();
    return [{ frame: Math.round(word.start * fps), text }];
  });
}

function punchIns(
  clip: Clip,
  starts: ReturnType<typeof sentenceStarts>,
  fps: number,
) {
  if (clip.kind !== "video") return;
  const keys: Clip["keyframes"] = [
    { property: "scale", frame: 0, value: 1, easing: "hold" },
  ];
  let previousEnd = 0;
  for (const start of starts) {
    const at = start.frame;
    const holdEnd = at + Math.round(fps * 1.7),
      end = holdEnd + Math.max(1, Math.round(fps * 0.3));
    if (at < Math.max(fps * 3, previousEnd + fps * 3) || end >= clip.duration)
      continue;
    keys.push(
      { property: "scale", frame: at - 1, value: 1, easing: "ease-out" },
      {
        property: "scale",
        frame: at + Math.max(1, Math.round(fps * 0.2)),
        value: 1.06,
        easing: "hold",
      },
      { property: "scale", frame: holdEnd, value: 1.06, easing: "ease-in-out" },
      { property: "scale", frame: end, value: 1, easing: "hold" },
    );
    previousEnd = end;
  }
  if (keys.length > 1) clip.keyframes = keys;
}

/** Native graphics stay editable, separate from the speaker and captions. */
function addFormatBeats(
  p: Project,
  format: ReelFormat,
  prepared: PreparedSource[],
  footage: Clip[],
  requested: ReelBeat[] | undefined,
  trackId: string,
  hook: string,
  cta: string,
  commands: Command[],
  warnings: string[],
  proofWindows: Pick<Clip, "start" | "duration">[] = [],
): Clip[] {
  const contexts = footage.map((clip, index) => ({
    clip,
    source: prepared[index],
  }));
  const startFrame = footage[0].start;
  const endFrame = footage.at(-1)!.start + footage.at(-1)!.duration;
  const titleFrames = Math.min(
    Math.round(p.fps * 3),
    hook && cta
      ? Math.floor((endFrame - startFrame) / 2)
      : endFrame - startFrame,
  );
  const titleWindows = [
    ...(hook ? [{ start: startFrame, duration: titleFrames }] : []),
    ...(cta ? [{ start: endFrame - titleFrames, duration: titleFrames }] : []),
  ].filter(
    (title) => !proofWindows.some((proof) => intervalsOverlap(title, proof)),
  );
  const derived: Array<ReelBeat & { start: number }> = [];
  for (const { clip, source } of contexts) {
    const starts = sentenceStarts(source.asset, clip, p.fps);
    if (isCreatorShortFormat(format) && requested?.length !== 0)
      creatorShortPunchIns(clip, starts, p.fps);
    if (
      (format === "talking-head" || format === "creator-education") &&
      requested?.length !== 0
    )
      punchIns(clip, starts, p.fps);
    if (
      requested !== undefined ||
      format === "montage" ||
      derived.length >=
        (format === "talking-head" || isCreatorShortFormat(format) ? 3 : 5)
    )
      continue;
    let previous = isCreatorShortFormat(format)
      ? (derived.at(-1)?.start ?? -Infinity)
      : -Infinity;
    for (const sentence of starts) {
      const start = clip.start + sentence.frame;
      if (
        start <
          startFrame + (hook ? titleFrames + Math.round(p.fps * 0.2) : 0) ||
        start - previous <
          p.fps *
            (isCreatorShortFormat(format)
              ? 8
              : format === "talking-head"
                ? 7
                : 5)
      )
        continue;
      if (
        endFrame - start < p.fps * 2 ||
        (cta && start + p.fps * 2 > endFrame - titleFrames)
      )
        continue;
      derived.push({
        sourceIndex: source.sourceIndex,
        sourceSeconds:
          source.sourceIn + (sentence.frame / p.fps) * source.speed,
        text: isCreatorShortFormat(format)
          ? sentence.text.split(/\s+/u).slice(0, 4).join(" ")
          : sentence.text,
        kind:
          format === "creator-education"
            ? (["callout", "step", "takeaway"] as const)[derived.length % 3]
            : format === "listicle"
              ? "step"
              : format === "explainer"
                ? "takeaway"
                : "callout",
        start,
      });
      previous = start;
      if (
        derived.length >=
        (format === "talking-head" || isCreatorShortFormat(format) ? 3 : 5)
      )
        break;
    }
  }
  const beats =
    requested === undefined
      ? derived
      : requested.map((beat) => {
          const context = contexts.find(
            ({ source }) => source.sourceIndex === beat.sourceIndex,
          );
          if (!context)
            throw Error(
              "An animation refers to footage that is missing or outside the Reel duration.",
            );
          const { clip, source } = context;
          const local =
            source.asset.kind === "image"
              ? beat.sourceSeconds
              : (beat.sourceSeconds - source.sourceIn) / source.speed;
          const frame = Math.round(local * p.fps);
          if (
            local < 0 ||
            frame < 0 ||
            frame >= clip.duration ||
            (source.asset.kind === "image" && beat.sourceSeconds !== 0)
          )
            throw Error(
              "Place each animation inside the source range used in the Reel.",
            );
          return { ...beat, start: clip.start + frame };
        });
  beats.sort((a, b) => a.start - b.start);
  if (!beats.length && format !== "montage" && requested === undefined)
    warnings.push(
      "No timed animations were added. Transcribe the selected footage or add timed animations to the Reel.",
    );
  const clips: Clip[] = [];
  let stepIndex = 0;
  for (const [index, beat] of beats.entries()) {
    if (isCreatorShortFormat(format)) {
      const duration = Math.min(
        Math.round(
          p.fps * Math.max(1.8, beat.text.split(/\s+/u).length * 0.24),
        ),
        endFrame - beat.start,
        (beats[index + 1]?.start ?? endFrame) - beat.start,
      );
      if (duration < Math.ceil(p.fps * 1.2)) {
        if (requested !== undefined)
          throw Error(
            "Leave at least 1.2 seconds between short emphasis beats and before the Reel ends.",
          );
        continue;
      }
      if (
        proofWindows.some((proof) =>
          intervalsOverlap(proof, { start: beat.start, duration }),
        )
      ) {
        if (requested !== undefined)
          warnings.push(
            "A text emphasis was omitted while its proof screen is visible.",
          );
        continue;
      }
      if (
        titleWindows.some((title) =>
          intervalsOverlap(title, { start: beat.start, duration }),
        )
      ) {
        if (requested !== undefined)
          warnings.push(
            "A text emphasis was omitted while an opening or closing title is visible.",
          );
        continue;
      }
      const motion = MotionSchema.parse({
        id: uid(),
        name: `Spoken emphasis · ${beat.text}`.slice(0, 100),
        source: `reel:${format}`,
        layers: creatorShortEmphasisLayers(p, beat.text, duration, p.fps),
      });
      commands.push({ type: "motion.put", motion });
      clips.push({
        ...makeClip(p, "text", trackId, beat.start),
        duration,
        text: beat.text,
        preset: "custom",
        motionId: motion.id,
        x: 0,
        y: 0,
        width: p.width,
        height: p.height,
      });
      continue;
    }
    const enter = Math.max(1, Math.round(p.fps * 0.3)),
      exit = Math.max(1, Math.round(p.fps * 0.23));
    const revealFrames = Math.max(1, Math.round(p.fps * 0.22));
    const textSettled =
      beat.kind === "takeaway"
        ? Math.max(1, Math.round(p.fps * 0.4)) +
          Math.max(0, beat.text.trim().split(/\s+/u).length - 1) * 2
        : revealFrames;
    const minimumDuration =
      Math.max(enter, textSettled) + Math.ceil(p.fps * 1.5) + exit + 1;
    const duration = Math.min(
      Math.max(Math.round(p.fps * 3.3), minimumDuration),
      endFrame - beat.start,
      (beats[index + 1]?.start ?? endFrame) - beat.start,
    );
    if (duration < minimumDuration) {
      if (requested !== undefined)
        throw Error(
          "Leave time for 1.5 seconds of settled text plus its entrance and exit between animations and before the Reel ends.",
        );
      continue;
    }
    if (
      proofWindows.some((proof) =>
        intervalsOverlap(proof, { start: beat.start, duration }),
      )
    ) {
      if (requested !== undefined)
        warnings.push(
          "A text card was omitted while its proof screen is visible.",
        );
      continue;
    }
    if (beat.kind === "step") stepIndex++;
    const w = p.width,
      h = p.height,
      portrait = h > w;
    const underHook = Boolean(hook && beat.start < startFrame + titleFrames);
    // An opening title occupies 18–35% and a CTA 49–66% of the canvas.
    // This smaller middle card remains clear even in a very short Reel.
    const width = Math.round(w * 0.78),
      height = Math.round(h * (underHook ? 0.115 : portrait ? 0.18 : 0.22));
    const x = Math.round((w - width) / 2);
    const y = Math.round(h * (underHook ? 0.36 : portrait ? 0.11 : 0.08));
    const inset = Math.round(Math.min(w, h) * 0.035);
    const numberWidth =
      beat.kind === "step" ? Math.round(Math.min(w, h) * 0.085) : 0;
    const textWidth = width - inset * 2 - numberWidth;
    const longest = Math.max(
      1,
      ...beat.text.split(/\s+/u).map((word) => word.length),
    );
    const fontSize = Math.max(
      8,
      Math.floor(
        Math.min(
          Math.min(w, h) * 0.059,
          textWidth / longest / 0.66,
          Math.sqrt(
            (textWidth * (height - inset * 2)) /
              Math.max(1, beat.text.length) /
              1.4,
          ),
        ),
      ),
    );
    const keys: MotionLayer["keyframes"] = [
      {
        frame: 0,
        opacity: 0,
        y: Math.round(h * 0.013),
        easing: "cubic-bezier",
        bezier: [0.22, 1, 0.36, 1],
      },
      { frame: enter, opacity: 1, y: 0, easing: "hold" },
      { frame: duration - exit - 1, opacity: 1, y: 0, easing: "ease-in" },
      {
        frame: duration - 1,
        opacity: 0,
        y: -Math.round(h * 0.008),
        easing: "linear",
      },
    ];
    const creatorLayers =
      format === "creator-education"
        ? creatorTeachingLayers(
            p,
            beat.text,
            beat.kind,
            stepIndex,
            Boolean(hook || cta),
            keys,
            revealFrames,
          )
        : undefined;
    const motion = MotionSchema.parse({
      id: uid(),
      name: `Reel ${beat.kind} · ${beat.text}`.slice(0, 100),
      source: `reel:${format}`,
      layers: creatorLayers ?? [
        {
          name: "Card",
          type: "rectangle",
          x,
          y,
          width,
          height,
          background: "#101318ed",
          color: "#101318ed",
          radius: Math.round(inset * 0.5),
          keyframes: keys,
        },
        ...(beat.kind === "step"
          ? [
              {
                name: "Step number",
                type: "text",
                text: String(stepIndex).padStart(2, "0"),
                x: x + inset,
                y: y + inset,
                width: numberWidth - inset / 2,
                height: height - inset * 2,
                color: "#d9f99d",
                fontSize: Math.round(fontSize * 0.85),
                fontWeight: 600,
                align: "left",
                keyframes: keys,
              },
            ]
          : []),
        {
          name:
            beat.kind === "takeaway"
              ? "Takeaway"
              : beat.kind === "step"
                ? "Step title"
                : "Callout",
          type: "text",
          text: beat.text,
          x: x + inset + numberWidth,
          y: y + inset,
          width: textWidth,
          height: height - inset * 2,
          color: "#ffffff",
          fontSize,
          fontWeight: 600,
          align: "left",
          textAnimation: beat.kind === "takeaway" ? "word-rise" : "line-reveal",
          textRevealFrames: revealFrames,
          staggerFrames: 2,
          keyframes: keys,
        },
      ],
    });
    commands.push({ type: "motion.put", motion });
    clips.push({
      ...makeClip(p, "text", trackId, beat.start),
      duration,
      preset: "custom",
      motionId: motion.id,
      text: beat.text,
      x: 0,
      y: 0,
      width: w,
      height: h,
      fontFamily: "Helvetica",
      align: "left",
      animationFrames: enter,
    });
  }
  if (
    beats.length &&
    !clips.length &&
    !proofWindows.length &&
    requested === undefined &&
    format !== "montage"
  )
    warnings.push(
      "The remaining speech was too short for an animation with a readable hold.",
    );
  return clips;
}

function intervalsOverlap(
  a: Pick<Clip, "start" | "duration">,
  b: Pick<Clip, "start" | "duration">,
) {
  return a.start < b.start + b.duration && b.start < a.start + a.duration;
}

/** Explicit imported evidence only. The audible source and its captions remain intact. */
function addProofBeats(
  p: Project,
  requested: ReelProofBeat[],
  prepared: PreparedSource[],
  footage: Clip[],
  tracks: Record<Roles, string>,
  commands: Command[],
): { clips: Clip[]; windows: CreatorProofWindow[] } {
  if (!requested.length) return { clips: [], windows: [] };
  const resolved = requested
    .map((proof) => {
      const index = prepared.findIndex(
        (source) => source.sourceIndex === proof.sourceIndex,
      );
      if (index < 0)
        throw Error(
          "A proof screen refers to footage that is missing or outside the Reel duration.",
        );
      const source = prepared[index],
        speaker = footage[index];
      const local =
        source.asset.kind === "image"
          ? proof.sourceSeconds
          : (proof.sourceSeconds - source.sourceIn) / source.speed;
      const frame = Math.round(local * p.fps);
      const duration = Math.floor(proof.durationSeconds * p.fps + 1e-7);
      if (
        local < 0 ||
        local + proof.durationSeconds > speaker.duration / p.fps + 1e-7 ||
        frame + duration > speaker.duration ||
        (source.asset.kind === "image" && proof.sourceSeconds !== 0)
      )
        throw Error(
          "Place the whole proof screen inside the source range used in the Reel, including its playback speed.",
        );
      const asset = p.assets.find((item) => item.id === proof.assetId);
      if (!asset || asset.kind === "audio")
        throw Error("Choose an imported video or image for each proof screen.");
      const sourceIn = proof.sourceIn ?? 0;
      if (
        (asset.kind === "image" && sourceIn !== 0) ||
        (asset.kind === "video" &&
          sourceIn + proof.durationSeconds > asset.duration + 1e-7)
      )
        throw Error(
          "Keep the whole proof screen within its imported media range; images start at zero.",
        );
      return {
        proof,
        speaker,
        asset,
        sourceIn,
        start: speaker.start + frame,
        duration,
      };
    })
    .sort((a, b) => a.start - b.start);
  for (let index = 1; index < resolved.length; index++)
    if (intervalsOverlap(resolved[index - 1], resolved[index]))
      throw Error(
        "Proof screens cannot overlap. Move or shorten one of the proof beats.",
      );
  const motion = MotionSchema.parse({
    id: uid(),
    name: "Proof screen canvas",
    source: "reel:proof-backdrop",
    layers: [
      {
        name: "Opaque proof canvas",
        type: "rectangle",
        x: 0,
        y: 0,
        width: p.width,
        height: p.height,
        background: creatorShortColors.canvas,
      },
    ],
  });
  commands.push({ type: "motion.put", motion });
  const clips = resolved.flatMap(
    ({ proof, speaker, asset, sourceIn, start, duration }) => {
      const backdrop: Clip = {
        ...makeClip(p, "text", tracks["proof-backdrop"], start),
        duration,
        text: `Proof ${proof.layout} canvas`,
        preset: "custom",
        motionId: motion.id,
        x: 0,
        y: 0,
        width: p.width,
        height: p.height,
      };
      const screen: Clip = {
        ...makeClip(
          p,
          asset.kind as "video" | "image",
          tracks.proofs,
          start,
          asset,
        ),
        ...creatorProofPlacement(p, proof.layout),
        duration,
        sourceIn,
        speed: 1,
      };
      const inset: Clip[] =
        proof.layout === "split"
          ? [
              {
                ...speaker,
                ...creatorProofSpeakerPlacement(p),
                id: uid(),
                trackId: tracks["proof-speaker"],
                start,
                duration,
                sourceIn:
                  speaker.kind === "image"
                    ? 0
                    : speaker.sourceIn +
                      ((start - speaker.start) / p.fps) * speaker.speed,
                keyframes: [],
                cameraMotion: "none",
                volume: 0,
                fadeIn: 0,
                fadeOut: 0,
              },
            ]
          : [];
      return [backdrop, screen, ...inset];
    },
  );
  return {
    clips,
    windows: resolved.map(({ start, duration, proof }) => ({
      start,
      duration,
      layout: proof.layout,
    })),
  };
}

/**
 * Pure, revision-safe plan. Apply `commands` in ONE transaction for one Undo.
 * `replace` is explicit; the default append mode preserves the current edit.
 * Existing assets, custom motions, frame rate and project identity are retained.
 */
export function createReelPlan(
  project: Project,
  options: ReelOptions,
): ReelPlan {
  if (![15, 30, 60, 90].includes(options.targetSeconds))
    throw Error("Choose a Reel duration of 15, 30, 60 or 90 seconds.");
  if (!options.sources.length)
    throw Error("Choose at least one video or photo for your Reel.");
  const mode = options.mode ?? "append",
    style = options.style ?? "clean";
  if (
    !["append", "replace"].includes(mode) ||
    !reelStyles.some((item) => item.id === style)
  )
    throw Error("Choose a supported Reel mode and style.");
  const format = ReelFormatSchema.parse(options.format ?? "montage");
  const captionStyle =
    options.captionStyle === undefined
      ? format === "montage"
        ? undefined
        : reelFormats.find((item) => item.id === format)!.captionStyle
      : ClipSchema.shape.captionStyle.parse(options.captionStyle);
  const requestedBeats =
    options.beats === undefined
      ? undefined
      : z.array(ReelBeatSchema).max(24).parse(options.beats);
  const requestedProofs = z
    .array(ReelProofBeatSchema)
    .max(24)
    .parse(options.proofBeats ?? []);
  const hook = (options.hook ?? "").trim(),
    cta = (options.cta ?? "").trim();
  if (hook.length > 120 || cta.length > 120)
    throw Error(
      "Keep the hook and closing title to 120 characters or fewer each.",
    );
  const warnings: string[] = [],
    fps = project.fps,
    targetFrames = options.targetSeconds * fps;
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const prepared: PreparedSource[] = [];
  for (const [sourceIndex, source] of options.sources.entries()) {
    const asset = assets.get(source.assetId);
    if (!asset || !["video", "image"].includes(asset.kind))
      throw Error("A selected source is missing or is not a video or photo.");
    const speed = finite(source.speed ?? 1, "Playback speed", 0.1, 8);
    const sourceIn = finite(
      source.sourceIn ?? 0,
      "Source start",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const sourceOut =
      source.sourceOut === undefined
        ? asset.duration
        : finite(source.sourceOut, "Source end", 0, Number.MAX_SAFE_INTEGER);
    if (asset.kind === "image")
      prepared.push({
        sourceIndex,
        asset,
        sourceIn: 0,
        speed: 1,
        capacity: targetFrames,
      });
    else {
      const capacity = Math.min(
        targetFrames,
        Math.max(
          0,
          Math.floor(
            ((Math.min(sourceOut, asset.duration) - sourceIn) / speed) * fps +
              1e-7,
          ),
        ),
      );
      if (sourceOut > asset.duration)
        warnings.push(
          `${asset.name}: the out point was limited to the end of the source.`,
        );
      if (capacity > 0)
        prepared.push({ sourceIndex, asset, sourceIn, speed, capacity });
      else
        warnings.push(`${asset.name}: no usable frames remain in this range.`);
    }
  }
  if (!prepared.length)
    throw Error(
      "The selected sources contain no usable video frames. Choose a longer range or add a photo.",
    );
  const allocations = allocateReelFrames(
    prepared.map((source) => source.capacity),
    targetFrames,
  );
  const durationFrames = allocations.reduce((sum, value) => sum + value, 0);
  const omitted = allocations.filter((value) => value === 0).length;
  if (omitted)
    warnings.push(
      `${omitted} source${omitted === 1 ? "" : "s"} did not fit the target duration. Choose fewer sources or a longer Reel.`,
    );
  if (durationFrames < targetFrames)
    warnings.push(
      `The selected footage makes ${(durationFrames / fps).toFixed(1)} seconds of the ${options.targetSeconds}-second target. Add more media to reach the target.`,
    );
  const startFrame =
    mode === "replace"
      ? 0
      : Math.max(0, ...project.clips.map((clip) => clip.start + clip.duration));
  const p: Project = {
    ...project,
    ...(mode === "replace" || !project.clips.length
      ? { width: 1080, height: 1920 }
      : {}),
  };
  if (
    mode === "append" &&
    project.clips.length &&
    (p.width !== 1080 || p.height !== 1920)
  )
    warnings.push(
      "The appended Reel keeps the current canvas. Choose Build a new Reel for 1080 × 1920.",
    );
  const mainIds = new Set(prepared.map((source) => source.asset.id));
  const broll = [...new Set(options.brollAssetIds ?? [])].flatMap((id) => {
    const asset = assets.get(id);
    if (!asset || asset.kind === "audio")
      throw Error(
        "A selected B-roll asset is missing or is not a video or photo.",
      );
    if (mainIds.has(id)) {
      warnings.push(
        `${asset.name}: already used as main footage, so it was not repeated as B-roll.`,
      );
      return [];
    }
    if (asset.kind === "video" && Math.floor(asset.duration * fps + 1e-7) < 1)
      return [];
    return [asset];
  });
  const music = options.musicAssetId
    ? assets.get(options.musicAssetId)
    : undefined;
  if (options.musicAssetId && (!music || music.kind !== "audio"))
    throw Error("Choose an imported audio file for the music bed.");
  const musicVolume = finite(options.musicVolume ?? 0.16, "Music volume", 0, 1);
  const commands: Command[] = [];
  if (mode === "replace")
    for (const clip of project.clips)
      commands.push({ type: "clip.delete", id: clip.id, ripple: false });
  if (p.width !== project.width || p.height !== project.height)
    commands.push({
      type: "project.update",
      patch: { width: p.width, height: p.height },
    });
  if (
    format === "creator-education" &&
    (mode === "replace" || !project.clips.length)
  ) {
    p.background = creatorEducationColors.canvas;
    commands.push({
      type: "project.update",
      patch: { background: p.background },
    });
  }
  const roles: Roles[] = [
    ...(hook || cta ? ["titles" as const] : []),
    // beats [] turns animations off: no empty animations track.
    ...((requestedBeats ? requestedBeats.length : format !== "montage")
      ? ["beats" as const]
      : []),
    ...(options.captions !== false ? ["captions" as const] : []),
    ...(requestedProofs.length
      ? ["proofs" as const, "proof-speaker" as const, "proof-backdrop" as const]
      : []),
    ...(broll.length ? ["broll" as const] : []),
    "footage",
    ...(format === "creator-education" ? ["backdrop" as const] : []),
    ...(music ? ["music" as const] : []),
  ];
  const tracks = addReelTracks(project, roles, mode, commands);
  if (format === "creator-education") {
    const motion = MotionSchema.parse({
      id: uid(),
      name: "Creator canvas",
      source: "reel:creator-education-background",
      layers: [
        {
          name: "Canvas",
          type: "rectangle",
          x: 0,
          y: 0,
          width: p.width,
          height: p.height,
          background: creatorEducationColors.canvas,
        },
      ],
    });
    commands.push(
      { type: "motion.put", motion },
      {
        type: "clip.add",
        clip: {
          ...makeClip(p, "text", tracks.backdrop, startFrame),
          preset: "custom",
          motionId: motion.id,
          text: "Creator canvas",
          x: 0,
          y: 0,
          width: p.width,
          height: p.height,
          duration: durationFrames,
        },
      },
    );
  }
  const footage: Clip[] = [],
    captions: Clip[] = [],
    overlays: Clip[] = [];
  const missingTranscriptAssetIds = new Set<string>();
  let cursor = startFrame;
  for (let index = 0; index < prepared.length; index++) {
    const source = prepared[index],
      frames = allocations[index];
    if (!frames) continue;
    const clip: Clip = {
      ...makeClip(
        p,
        source.asset.kind as "video" | "image",
        tracks.footage,
        cursor,
        source.asset,
      ),
      duration: frames,
      sourceIn: source.sourceIn,
      speed: source.speed,
      volume: 1,
      ...(format === "product-demo" ? { fit: "contain" as const } : {}),
      look: treatments[style].look,
      effectAmount: style === "bold" ? 0.6 : 0.7,
      vignette: style === "cinematic" ? 0.16 : 0,
      cameraMotion:
        format === "product-demo"
          ? "none"
          : source.asset.kind === "image"
            ? index % 2
              ? "zoom-out"
              : treatments[style].camera
            : "none",
      ...(format === "creator-education"
        ? {
            ...creatorSpeakerPlacement(p),
            cameraMotion: "none" as const,
          }
        : {}),
    };
    footage.push(clip);
    if (
      options.captions !== false &&
      source.asset.kind === "video" &&
      source.asset.hasAudio
    ) {
      const sourceCaptions = isCreatorShortFormat(format)
        ? creatorShortCaptionClips(
            p,
            reelWordsForClip(source.asset, clip, p.fps),
            clip,
            tracks.captions,
            captionStyle,
          )
        : format === "creator-education"
          ? creatorCaptionClips(
              p,
              reelWordsForClip(source.asset, clip, p.fps),
              clip,
              tracks.captions,
              captionStyle,
            )
          : reelCaptionClips(
              p,
              source.asset,
              clip,
              tracks.captions,
              style,
              captionStyle,
            );
      captions.push(...sourceCaptions);
    }
    const needsSpeech =
      options.captions !== false ||
      (format !== "montage" && requestedBeats === undefined);
    if (
      needsSpeech &&
      source.asset.kind === "video" &&
      source.asset.hasAudio &&
      !source.asset.words?.length
    )
      missingTranscriptAssetIds.add(source.asset.id);
    cursor += frames;
  }
  const { clips: proofClips, windows: proofWindows } = addProofBeats(
    p,
    requestedProofs,
    prepared.filter((_, index) => allocations[index] > 0),
    footage,
    tracks,
    commands,
  );
  for (const caption of captions)
    if (proofWindows.some((proof) => intervalsOverlap(caption, proof)))
      Object.assign(
        caption,
        creatorProofCaptionPlacement(p, caption, proofWindows),
      );
  const beatClips = addFormatBeats(
    p,
    format,
    prepared.filter((_, index) => allocations[index] > 0),
    footage,
    requestedBeats,
    tracks.beats,
    hook,
    cta,
    commands,
    warnings,
    proofWindows,
  );
  if (missingTranscriptAssetIds.size)
    warnings.push(
      `${missingTranscriptAssetIds.size} source${missingTranscriptAssetIds.size === 1 ? "" : "s"} need transcription for speech-timed captions or animations.`,
    );
  // Preserve the opening hook and closing CTA. Prefer sentence/gap boundaries
  // near a regular pacing interval; the original voice continues underneath.
  const margin = Math.min(Math.round(fps * 3), Math.floor(durationFrames / 4));
  const closingMargin =
    format === "talking-head" && cta
      ? Math.min(
          Math.round(fps * 3),
          hook && cta ? Math.floor(durationFrames / 2) : durationFrames,
        )
      : margin;
  const interval = Math.round(fps * (style === "bold" ? 5 : 7));
  const speechBoundaries = footage.flatMap((clip) => {
    const asset = assets.get(clip.assetId!)!;
    const words = reelWordsForClip(asset, clip, fps);
    return words
      .filter(
        (word, index) =>
          /[.!?]$/.test(word.text) ||
          (index + 1 < words.length && words[index + 1].start - word.end > 0.3),
      )
      .map((word) => clip.start + Math.round(word.end * fps));
  });
  let next = startFrame + margin,
    previousEnd = next;
  for (
    let index = 0;
    broll.length && next < startFrame + durationFrames - margin;
    index++, next += interval
  ) {
    const asset = broll[index % broll.length];
    const boundary = speechBoundaries
      .filter((frame) => frame >= previousEnd && Math.abs(frame - next) <= fps)
      .sort((a, b) => Math.abs(a - next) - Math.abs(b - next))[0];
    let start = Math.max(previousEnd, startFrame + margin, boundary ?? next);
    // Cards displaced below an opening title share the inset footage band.
    // Let the card finish before showing B-roll so neither covers the other.
    if (format === "talking-head" && hook) {
      const hookFrames = Math.min(
        Math.round(fps * 3),
        hook && cta ? Math.floor(durationFrames / 2) : durationFrames,
      );
      for (const beat of beatClips) {
        if (beat.start >= startFrame + hookFrames) continue;
        if (
          start < beat.start + beat.duration &&
          start + Math.round(treatments[style].brollSeconds * fps) > beat.start
        )
          start = beat.start + beat.duration;
      }
    }
    let frames = Math.min(
      Math.round(treatments[style].brollSeconds * fps),
      startFrame + durationFrames - closingMargin - start,
      asset.kind === "image"
        ? targetFrames
        : Math.floor(asset.duration * fps + 1e-7),
    );
    if (format === "creator-education") {
      const window = creatorBrollWindow(start, frames, beatClips);
      start = window.start;
      frames = window.frames;
    }
    if (proofWindows.length) {
      const window = creatorBrollWindow(start, frames, proofWindows);
      start = window.start;
      frames = window.frames;
    }
    if (frames < Math.min(fps / 2, durationFrames / 4)) continue;
    const overlay: Clip = {
      ...makeClip(
        p,
        asset.kind as "video" | "image",
        tracks.broll,
        start,
        asset,
      ),
      duration: frames,
      volume: 0,
      ...(format === "talking-head"
        ? {
            x: Math.round(p.width * 0.56),
            y: Math.round(p.height * 0.43),
            width: Math.round(p.width * 0.33),
            height: Math.round(p.height * 0.21),
            mask: "rounded" as const,
            cornerRadius: Math.round(Math.min(p.width, p.height) * 0.02),
          }
        : {}),
      look: treatments[style].look,
      effectAmount: 0.65,
      cameraMotion: index % 2 ? "zoom-out" : treatments[style].camera,
      ...(format === "creator-education" ? creatorBrollPlacement(p) : {}),
      fadeIn:
        style === "bold"
          ? 0
          : Math.min(Math.round(fps * 0.18), Math.floor(frames / 3)),
      fadeOut:
        style === "bold"
          ? 0
          : Math.min(Math.round(fps * 0.18), Math.floor(frames / 3)),
    };
    overlays.push(overlay);
    previousEnd = start + frames + Math.round(fps * 1.25);
  }
  const titles: Clip[] = [];
  const titleFrames = Math.min(
    Math.round(fps * 3),
    hook && cta ? Math.floor(durationFrames / 2) : durationFrames,
  );
  if (hook && titleFrames > 0)
    titles.push(
      titleClip(
        p,
        tracks.titles,
        hook,
        startFrame,
        titleFrames,
        style,
        false,
        format,
      ),
    );
  if (cta && titleFrames > 0)
    titles.push(
      titleClip(
        p,
        tracks.titles,
        cta,
        startFrame + durationFrames - titleFrames,
        titleFrames,
        style,
        true,
        format,
      ),
    );
  for (let index = titles.length - 1; index >= 0; index--)
    if (proofWindows.some((proof) => intervalsOverlap(titles[index], proof))) {
      titles.splice(index, 1);
      warnings.push(
        "An opening or closing title was omitted while its proof screen is visible.",
      );
    }
  const audio: Clip[] = [];
  if (music) {
    const frames = Math.min(
      durationFrames,
      Math.floor(music.duration * fps + 1e-7),
    );
    if (frames > 0)
      audio.push({
        ...makeClip(p, "audio", tracks.music, startFrame, music),
        duration: frames,
        volume: musicVolume,
        fadeIn: Math.min(fps, Math.floor(frames / 3)),
        fadeOut: Math.min(fps * 2, Math.floor(frames / 3)),
      });
    if (frames < durationFrames)
      warnings.push(
        "The music ends before the Reel. It fades out at its source end.",
      );
  }
  if (music?.rhythm && audio[0])
    for (const title of titles)
      title.musicReactive = {
        musicClipId: audio[0].id,
        mode: "beat",
        style: "both",
        amount: style === "bold" ? 0.3 : 0.15,
        releaseFrames: Math.max(1, Math.round(fps * 0.2)),
      };
  for (const clip of [
    ...footage,
    ...proofClips,
    ...overlays,
    ...captions,
    ...beatClips,
    ...titles,
    ...audio,
  ])
    commands.push({ type: "clip.add", clip });
  if (commands.length > 2000)
    throw Error(
      "This Reel exceeds the edit transaction limit. Save this project and create the Reel in a new project.",
    );
  const label = `${mode === "replace" ? "Build" : "Append"} ${options.targetSeconds}s Reel`;
  // Validate the whole plan before the caller applies anything. This also
  // catches frame limits, source overruns and incompatible model changes.
  applyCommands(project, {
    projectId: project.id,
    revision: project.revision,
    label,
    commands,
  });
  return {
    commands,
    label,
    startFrame,
    durationFrames,
    targetFrames,
    footageCount: footage.length,
    captionCount: captions.length,
    brollCount: overlays.length,
    beatCount: beatClips.length,
    proofCount: requestedProofs.length,
    missingTranscriptAssetIds: [...missingTranscriptAssetIds],
    warnings,
  };
}
