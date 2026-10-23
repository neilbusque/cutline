import { applyCommands, type Command } from "./commands";
import {
  ClipSchema,
  MotionLayerSchema,
  MotionSchema,
  makeClip,
  uid,
  validateProject,
  type MotionLayer,
  type Project,
} from "./model";
import {
  createMotionScene,
  signaturePalette,
  signatureSceneIds,
} from "./motion-presets";
import { upsertMotionKey } from "./motion-edit";

export type MotionSequenceOptions = {
  brand: string;
  headline: string;
  detail: string;
  closing: string;
  seconds: 12 | 18 | 24;
  paper: string;
  ink: string;
  accent: string;
  assetId?: string;
};

export const defaultMotionSequence: MotionSequenceOptions = {
  brand: "CUTLINE",
  headline: "MAKE IT\nMOVE.",
  detail: "From the first idea to the final frame.",
  closing: "MAKE\nYOUR MARK.",
  seconds: 18,
  paper: "#EEE9DF",
  ink: "#242522",
  accent: "#B36A48",
};

export const motionSequencePaces = [
  { seconds: 12, label: "Punchy", description: "4 seconds per act" },
  { seconds: 18, label: "Balanced", description: "6 seconds per act" },
  { seconds: 24, label: "Measured", description: "8 seconds per act" },
] as const;

/** Keep authored line breaks and wrap words before sizing the native text layer. */
function fittedText(
  layer: MotionLayer,
  text: string,
  maxLine: number,
): MotionLayer {
  const lines = text
    .trim()
    .split("\n")
    .flatMap((paragraph) => {
      const result: string[] = [];
      for (const word of paragraph.trim().split(/\s+/)) {
        if (
          !result.length ||
          result[result.length - 1].length + word.length + 1 > maxLine
        )
          result.push(word);
        else result[result.length - 1] += ` ${word}`;
      }
      return result;
    });
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const fontSize = Math.max(
    8,
    Math.min(
      layer.fontSize,
      layer.width / (longest * 0.64),
      layer.height / (lines.length * layer.lineHeight * 1.18),
    ),
  );
  return {
    ...layer,
    text: lines.join("\n"),
    fontSize,
    letterSpacing:
      layer.letterSpacing < 0 ? -fontSize * 0.032 : layer.letterSpacing,
  };
}

/**
 * A three-act composition on dedicated tracks. The mark's endpoint poses are
 * inherited from Signature, while every text, curve and optional screen stays
 * native and editable. Calling code submits these commands as one undo step.
 */
export function createMotionSequence(
  p: Project,
  start: number,
  options: MotionSequenceOptions,
) {
  if (!Number.isInteger(start) || start < 0)
    throw Error("Choose a whole-frame start on the timeline.");
  if (![12, 18, 24].includes(options.seconds))
    throw Error("Choose a 12, 18 or 24 second sequence.");
  for (const [label, value, limit] of [
    ["Brand", options.brand, 28],
    ["Opening headline", options.headline, 60],
    ["Detail", options.detail, 100],
    ["Closing headline", options.closing, 60],
  ] as const) {
    if (!value.trim() || value.trim().length > limit)
      throw Error(`${label} needs 1–${limit} characters.`);
  }
  for (const color of [options.paper, options.ink, options.accent])
    if (!/^#[0-9a-f]{6}$/i.test(color))
      throw Error("Use six-digit hex colors for the sequence palette.");
  const asset = options.assetId
    ? p.assets.find((item) => item.id === options.assetId)
    : undefined;
  if (options.assetId && (!asset || !["image", "video"].includes(asset.kind)))
    throw Error("Choose an imported image or video for the screen demo.");
  if (asset?.kind === "video" && asset.duration < 1)
    throw Error("Choose a screen recording at least one second long.");
  const frames = Math.round((options.seconds * p.fps) / 3);
  const track = {
    id: uid(),
    name: `${options.brand.trim()} · sequence`,
    kind: "text" as const,
    muted: false,
    hidden: false,
  };
  const commands: Command[] = [{ type: "track.add", track }];
  // A full-frame scene must stay below subtitles, including generated caption
  // tracks with custom IDs. Move only the new tracks; keep existing layer order.
  const captionTrackIds = new Set([
    "captions",
    ...p.clips
      .filter((clip) => clip.kind === "caption")
      .map((clip) => clip.trackId),
  ]);
  const scenePosition = p.tracks.reduce(
    (position, item, index) =>
      captionTrackIds.has(item.id) ? index + 1 : position,
    0,
  );
  for (let index = 0; index < scenePosition; index++)
    commands.push({ type: "track.move", id: track.id, direction: "down" });
  const tracksWithScene = [...p.tracks];
  tracksWithScene.splice(scenePosition, 0, track);
  const clips: ReturnType<typeof makeClip>[] = [];
  const motions: ReturnType<typeof MotionSchema.parse>[] = [];
  const palette: Record<string, string> = {
    [signaturePalette.ivory]: options.paper,
    [signaturePalette.charcoal]: options.ink,
    [signaturePalette.copper]: options.accent,
    [signaturePalette.stone]: options.paper,
  };
  const portrait = p.height >= p.width;
  const mediaPad = Math.round(p.fps * 0.55);
  const mediaDuration = Math.min(
    frames - mediaPad * 2,
    asset?.kind === "video" ? Math.floor(asset.duration * p.fps) : frames,
  );
  const mediaStart = Math.floor((frames - mediaDuration) / 2);
  const mediaFade = Math.min(
    Math.round(p.fps * 0.35),
    Math.floor(mediaDuration / 3),
  );
  const mediaBox = {
    x: p.width * 0.08,
    y: p.height * (portrait ? 0.36 : 0.32),
    width: p.width * 0.84,
    height: p.height * (portrait ? 0.44 : 0.51),
  };
  for (const [index, id] of signatureSceneIds.entries()) {
    const created = createMotionScene(p, start + index * frames, id, {
      durationFrames: frames,
    });
    let layers = created.motion.layers
      .filter(
        (layer) =>
          layer.name !== "Accent · underline" &&
          layer.name !== "Frame · top rule",
      )
      .map((layer) => {
        let next = { ...layer };
        for (const key of [
          "background",
          "color",
          "stroke",
          "gradientColor",
        ] as const)
          if (palette[next[key]]) next[key] = palette[next[key]];
        if (next.name === "Brand · signature")
          next = fittedText(next, options.brand.trim(), 28);
        if (next.name === "Headline · masked reveal")
          next = fittedText(
            next,
            index === 0
              ? options.headline
              : index === 1
                ? asset
                  ? "SEE IT\nIN MOTION."
                  : "BUILT\nWITH INTENT."
                : options.closing,
            portrait ? 16 : 20,
          );
        if (next.name === "Support · statement")
          next = fittedText(
            { ...next, height: p.height * 0.1 },
            options.detail,
            portrait ? 45 : 42,
          );
        if (next.name === "Footer · editorial note")
          next = {
            ...next,
            text:
              index === 0
                ? "IDEA / DIRECTION"
                : index === 1
                  ? "FORM / RHYTHM"
                  : "MOTION / RESOLVE",
          };
        return next;
      });
    if (asset && index === 1) {
      layers = layers.filter(
        (layer) =>
          layer.name !== "Support · statement" &&
          !layer.name?.startsWith("Structure ·"),
      );
      // The screen takes focus during the read. Retire the whole mark, rather
      // than leaving a clipped arc behind the panel, then restore its cut pose.
      layers = layers.map((layer) => {
        if (!layer.name?.startsWith("Orbit ·")) return layer;
        let next = layer;
        for (const [frame, opacity, easing] of [
          [0, layer.opacity, "hold"],
          [mediaStart, layer.opacity, "ease-out"],
          [mediaStart + mediaFade, 0, "hold"],
          [mediaStart + mediaDuration - mediaFade - 1, 0, "ease-in"],
          [mediaStart + mediaDuration - 1, layer.opacity, "hold"],
        ] as const) {
          const updated = upsertMotionKey(
            next,
            "opacity",
            frame,
            opacity,
            easing,
          );
          if (!updated)
            throw Error("This sequence has too many animation keys.");
          next = { ...next, keyframes: updated };
        }
        return next;
      });
      layers = layers.map((layer) =>
        layer.name === "Headline · masked reveal"
          ? fittedText(
              {
                ...layer,
                x: p.width * 0.08,
                y: p.height * 0.17,
                width: p.width * 0.84,
                height: p.height * 0.1,
                fontSize: Math.min(p.width, p.height) * 0.07,
                textRevealStart: 0,
              },
              "SEE IT IN MOTION.",
              28,
            )
          : layer,
      );
      layers.push(
        MotionLayerSchema.parse({
          name: "Screen · matte",
          type: "rectangle",
          ...mediaBox,
          background: options.ink,
          radius: Math.min(p.width, p.height) * 0.015,
          keyframes: [
            { frame: 0, opacity: 0, easing: "hold" },
            { frame: mediaStart, opacity: 0, easing: "ease-out" },
            { frame: mediaStart + mediaFade, opacity: 1 },
            {
              frame: mediaStart + mediaDuration - mediaFade - 1,
              opacity: 1,
              easing: "ease-in",
            },
            { frame: mediaStart + mediaDuration - 1, opacity: 0 },
          ],
        }),
      );
    }
    const names = [
      "01 · Opening",
      asset ? "02 · Screen demo" : "02 · Development",
      "03 · Closing",
    ];
    const motion = MotionSchema.parse({
      ...created.motion,
      name: `${options.brand.trim()} / ${names[index]}`,
      layers,
    });
    const clip = ClipSchema.parse({
      ...created.clip,
      trackId: track.id,
      text: names[index],
    });
    commands.push({ type: "motion.put", motion }, { type: "clip.add", clip });
    motions.push(motion);
    clips.push(clip);
  }
  if (asset) {
    const mediaTrack = {
      id: uid(),
      name: `${options.brand.trim()} · screen`,
      kind: "video" as const,
      muted: false,
      hidden: false,
    };
    commands.push({ type: "track.add", track: mediaTrack });
    // The screen sits directly above its scene and below every subtitle track.
    // A user may have reordered video above captions, so handle both directions.
    const position = tracksWithScene.findIndex((item) => item.kind === "video");
    const addedPosition = position < 0 ? tracksWithScene.length : position;
    const steps = Math.abs(addedPosition - scenePosition);
    for (let index = 0; index < steps; index++)
      commands.push({
        type: "track.move",
        id: mediaTrack.id,
        direction: addedPosition > scenePosition ? "up" : "down",
      });
    const clip = ClipSchema.parse({
      ...makeClip(
        p,
        asset.kind as "video" | "image",
        mediaTrack.id,
        start + frames + mediaStart,
        asset,
      ),
      ...mediaBox,
      duration: mediaDuration,
      fit: "contain",
      volume: 0,
      mask: "rounded",
      cornerRadius: Math.min(p.width, p.height) * 0.015,
      fadeIn: mediaFade,
      fadeOut: mediaFade,
      shadowBlur: 24,
      shadowY: 12,
      keyframes: [
        {
          frame: 0,
          property: "scale",
          value: 0.94,
          easing: "cubic-bezier",
          bezier: [0.16, 1, 0.3, 1],
        },
        {
          frame: Math.min(mediaDuration - 1, Math.round(p.fps * 0.7)),
          property: "scale",
          value: 1,
          easing: "linear",
        },
      ],
    });
    commands.push({ type: "clip.add", clip });
    clips.push(clip);
  }
  // Catch project/track/key/source bounds before an edit ever reaches the store.
  validateProject(
    applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Build motion sequence",
      commands,
    }),
  );
  return {
    commands,
    clips,
    motions,
    durationFrames: frames * 3,
    firstClipId: clips[0].id,
  };
}
