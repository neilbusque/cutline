import { applyCommands } from "./commands";
import { captionStylePatch } from "./caption-styles";
import { regroupCaptionCommands } from "./caption-grouping";
import {
  MotionLayerSchema,
  MotionSchema,
  makeClip,
  uid,
  validateProject,
  type Clip,
  type Motion,
  type Project,
  type Track,
} from "./model";
import { parseEditableSvg } from "./vector-path";
import { createVectorScene } from "./vector-scenes";
import { checkFrames } from "./check-frames";

/**
 * Creator-style Shorts laid out from a beat plan: the speaker's framing
 * changes on hard cuts, a styled graphic area shows the real logo, page or
 * line each beat names, and captions take the matching look. An assistant
 * plans the beats from the transcript; this lays them out natively and
 * editably. Looks follow measured references, not copies of anyone's art.
 */
export const styleReelStyles = [
  {
    id: "split",
    name: "Split explainer",
    inspiredBy: "Jack Roberts",
    description:
      "Graphic on top, speaker below, full-screen graphics and face punch-ins on hard cuts; pastel sunburst, pop-ins with a ring ripple, grey pill captions on the seam.",
  },
  {
    id: "cards",
    name: "Card canvas",
    inspiredBy: "sebintel",
    description:
      "Speaker for the hook and close, the middle on a warm grid canvas with soft white cards that drift in; clean bold captions, dark on the canvas.",
  },
  {
    id: "locked-split",
    name: "Locked split",
    inspiredBy: "Matthew Berman",
    description:
      "Real screens and recordings fill the top half for the whole video, speaker below; heavy outlined captions on the seam.",
  },
] as const;
export type StyleReelStyle = (typeof styleReelStyles)[number]["id"];
export type StyleLayout = "split" | "full" | "face" | "speaker";

export type StyleVisual =
  | {
      kind: "asset";
      assetId: string;
      logo?: boolean;
      /** A cut-out picture made for an idea: placed like a drawing, unframed. */
      drawing?: boolean;
    }
  | {
      kind: "svg";
      svg: string;
      color?: string;
      title: string;
      /** An illustration fills more of the panel than a logo does. */
      drawing?: boolean;
    }
  | { kind: "text"; text: string };
export type StyleBeat = {
  /** Timeline seconds. */
  from: number;
  to: number;
  layout?: StyleLayout;
  visual?: StyleVisual;
};

export const STYLE_TRACKS = {
  backdrop: "Style backdrop",
  media: "Style media",
  graphics: "Style graphics",
} as const;
const pastels = ["#f7cfe0", "#cdeee0", "#ffe2cc", "#ddd7fb", "#d3e5fb"];
const canvas = "#efedea";
type Rect = { x: number; y: number; width: number; height: number };

/** Default layout for a beat: what the reference does with a beat like it. */
function layoutFor(
  style: StyleReelStyle,
  beat: StyleBeat | undefined,
): StyleLayout {
  if (style === "locked-split") return "split";
  if (!beat) return "speaker";
  const wanted =
    beat.layout ??
    (beat.visual ? (style === "cards" ? "full" : "split") : "speaker");
  // The split explainer never floats a graphic over bare footage, and an
  // empty panel would only show the backdrop: both become the nearest
  // layout the reference actually uses.
  if (
    beat.visual &&
    style === "split" &&
    (wanted === "speaker" || wanted === "face")
  )
    return "split";
  if (!beat.visual && (wanted === "split" || wanted === "full"))
    return "speaker";
  return wanted;
}

function panelFor(
  style: StyleReelStyle,
  layout: StyleLayout,
  W: number,
  H: number,
): Rect | undefined {
  if (layout === "full") return { x: 0, y: 0, width: W, height: H };
  if (layout === "split")
    return style === "cards"
      ? { x: 0, y: 0, width: W, height: Math.round(H * 0.55) }
      : { x: 0, y: 0, width: W, height: Math.round(H / 2) };
  return undefined;
}

/** Where the speaker sits for a layout. Full graphics keep the voice, hidden. */
function speakerPlacement(
  style: StyleReelStyle,
  layout: StyleLayout,
  W: number,
  H: number,
): Partial<Clip> {
  const base = {
    x: 0,
    y: 0,
    width: W,
    height: H,
    fit: "cover" as const,
    opacity: 1,
    mask: "none" as const,
    shadowBlur: 0,
  };
  if (layout === "split")
    return style === "cards"
      ? {
          ...base,
          x: Math.round(W * 0.04),
          y: Math.round(H * 0.57),
          width: Math.round(W * 0.92),
          height: Math.round(H * 0.4),
          mask: "rounded",
          cornerRadius: Math.round(W * 0.037),
        }
      : { ...base, y: Math.round(H / 2), height: H - Math.round(H / 2) };
  if (layout === "full") return { ...base, opacity: 0 };
  return base;
}

function clipEnd(c: Pick<Clip, "start" | "duration">) {
  return c.start + c.duration;
}

/**
 * Re-cut one speaker clip at the beat edges exactly as a split does, so its
 * fades stay on the outer ends, the footage carries on (reversed too), its
 * keys keep their phase, a crossfade out of it still works and each caption
 * belongs to the piece it plays over. Then frame each piece for its layout.
 */
function reframeSpeaker(
  p: Project,
  clip: Clip,
  edges: number[],
  layoutAt: (frame: number) => StyleLayout,
  style: StyleReelStyle,
  warnings: string[],
  keepCaptions = false,
): Clip[] {
  const ids = [clip.id];
  // captions: "keep" leaves every caption whole: they sit out the cuts and
  // then belong to the piece that plays under their middle.
  const kept = new Set(
    keepCaptions
      ? p.clips
          .filter((c) => c.kind === "caption" && c.captionSourceId === clip.id)
          .map((c) => c.id)
      : [],
  );
  for (const c of p.clips) if (kept.has(c.id)) c.captionSourceId = undefined;
  for (const frame of edges) {
    const last = p.clips.find((c) => c.id === ids.at(-1))!;
    if (frame <= last.start || frame >= clipEnd(last)) continue;
    const before = new Set(p.clips.map((c) => c.id));
    try {
      applyCommands(
        p,
        {
          projectId: p.id,
          revision: p.revision,
          label: "Reframe speaker",
          commands: [{ type: "clip.split", id: last.id, frame }],
        },
        { clone: false, validate: false },
      );
    } catch (error) {
      if (!/inside a transition/u.test((error as Error).message)) throw error;
      const warning = `The speaker is not cut at ${(frame / p.fps).toFixed(1)}s, which is inside a crossfade.`;
      if (!warnings.includes(warning)) warnings.push(warning);
      continue;
    }
    ids.push(
      p.clips.find((c) => !before.has(c.id) && c.kind === clip.kind)!.id,
    );
  }
  for (const caption of p.clips.filter((c) => kept.has(c.id))) {
    const middle = caption.start + caption.duration / 2;
    const owner =
      ids
        .map((id) => p.clips.find((c) => c.id === id)!)
        .find((piece) => middle >= piece.start && middle < clipEnd(piece)) ??
      p.clips.find((c) => c.id === ids[0])!;
    caption.captionSourceId = owner.id;
  }
  return ids.map((id) => {
    const piece = p.clips.find((c) => c.id === id)!;
    const layout = layoutAt(piece.start);
    // The layout sets the framing. A face punch-in zooms where the head sits,
    // about a third down a vertical shot, rather than on the chest.
    const keyframes = piece.keyframes.filter(
      (key) => !["x", "y", "scale"].includes(key.property),
    );
    if (layout === "face")
      keyframes.push(
        {
          property: "scale",
          frame: piece.animationOffset,
          value: 1.45,
          easing: "hold",
        },
        {
          property: "y",
          frame: piece.animationOffset,
          value: Math.round(p.height * 0.13),
          easing: "hold",
        },
      );
    Object.assign(piece, speakerPlacement(style, layout, p.width, p.height), {
      keyframes: keyframes.sort((a, b) => a.frame - b.frame),
    });
    return piece;
  });
}

/** Sutherland-Hodgman: a convex polygon cut to a rectangle. */
function clipToRect(points: [number, number][], r: Rect): [number, number][] {
  const edges: [
    (p: [number, number]) => boolean,
    (a: [number, number], b: [number, number]) => [number, number],
  ][] = [
    [
      (p) => p[0] >= r.x,
      (a, b) => [r.x, a[1] + ((b[1] - a[1]) * (r.x - a[0])) / (b[0] - a[0])],
    ],
    [
      (p) => p[0] <= r.x + r.width,
      (a, b) => [
        r.x + r.width,
        a[1] + ((b[1] - a[1]) * (r.x + r.width - a[0])) / (b[0] - a[0]),
      ],
    ],
    [
      (p) => p[1] >= r.y,
      (a, b) => [a[0] + ((b[0] - a[0]) * (r.y - a[1])) / (b[1] - a[1]), r.y],
    ],
    [
      (p) => p[1] <= r.y + r.height,
      (a, b) => [
        a[0] + ((b[0] - a[0]) * (r.y + r.height - a[1])) / (b[1] - a[1]),
        r.y + r.height,
      ],
    ],
  ];
  let poly = points;
  for (const [inside, cross] of edges) {
    const next: [number, number][] = [];
    poly.forEach((current, i) => {
      const previous = poly[(i + poly.length - 1) % poly.length];
      if (inside(current)) {
        if (!inside(previous)) next.push(cross(previous, current));
        next.push(current);
      } else if (inside(previous)) next.push(cross(previous, current));
    });
    poly = next;
    if (!poly.length) break;
  }
  return poly;
}

function luminance(hex: string) {
  const n = hex.replace("#", "").slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** A one-color brand mark recolored only when it would vanish on the panel. */
function readableOn(color: string | undefined, backdrop: string) {
  if (!color || !/^#[0-9a-f]{6}/iu.test(color)) return color;
  const [hi, lo] = [luminance(color), luminance(backdrop)].sort(
    (a, b) => b - a,
  );
  if ((hi + 0.05) / (lo + 0.05) >= 2.2) return color;
  return luminance(backdrop) > 0.4 ? "#141418" : "#ffffff";
}
const backdropColor = (style: StyleReelStyle) =>
  style === "split" ? "#f4d9e6" : style === "cards" ? canvas : "#0f0f12";

function rectFit(aspect: number, area: Rect, share: number): Rect {
  const width = Math.min(area.width * share, area.height * share * aspect);
  const height = width / aspect;
  return {
    x: area.x + (area.width - width) / 2,
    y: area.y + (area.height - height) / 2,
    width,
    height,
  };
}

/** The style's backdrop for one graphic window, as one editable motion. */
function backdropMotion(
  style: StyleReelStyle,
  area: Rect,
  index: number,
  frames: number,
  fps: number,
): Motion {
  const base = {
    name: "Backdrop",
    type: "rectangle" as const,
    ...area,
    background:
      style === "split"
        ? pastels[index % pastels.length]
        : style === "cards"
          ? canvas
          : "#0f0f12",
  };
  const layers: unknown[] = [base];
  const cx = area.x + area.width / 2,
    cy = area.y + area.height / 2;
  if (style === "split") {
    // A soft sunburst: 14 thin wedges from the centre, barely lighter,
    // clipped to the panel so no ray crosses into the speaker's half.
    const r = Math.hypot(area.width, area.height);
    let d = "";
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2,
        b = a + Math.PI / 28;
      const wedge = clipToRect(
        [
          [cx, cy],
          [cx + r * Math.cos(a), cy + r * Math.sin(a)],
          [cx + r * Math.cos(b), cy + r * Math.sin(b)],
        ],
        area,
      );
      if (wedge.length >= 3)
        d += `M${wedge.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}Z`;
    }
    layers.push({
      name: "Sunburst",
      type: "path",
      vectorPath: d,
      vectorViewBox: [area.x, area.y, area.width, area.height],
      vectorAspectRatio: "none",
      ...area,
      background: "#ffffff",
      fillOpacity: 0.28,
      stroke: "transparent",
      strokeWidth: 0,
    });
    // Drifting confetti, the reference's ambient layer.
    const colors = ["#7c6cf2", "#ff8a5b", "#30c48d", "#f5c518", "#4aa3ff"];
    for (let i = 0; i < 8; i++) {
      const size = Math.round(Math.min(area.width, area.height) * 0.018);
      const x = area.x + ((i * 0.618 + 0.11) % 1) * area.width;
      // Confetti drifts down a little but always stays inside the panel.
      const y = area.y + (0.06 + ((i * 0.37 + 0.2) % 1) * 0.7) * area.height;
      layers.push({
        name: `Confetti ${i + 1}`,
        type: i % 3 === 0 ? "ellipse" : i % 3 === 1 ? "triangle" : "rectangle",
        x,
        y,
        width: size,
        height: i % 3 === 2 ? size * 0.45 : size,
        radius: size,
        background: colors[i % colors.length],
        opacity: 0.85,
        rotate: i * 37,
        keyframes: [
          { frame: 0, y, rotate: i * 37, easing: "linear" },
          {
            frame: Math.max(1, frames - 1),
            y: Math.min(
              area.y + area.height - size * 2,
              y + (frames / fps) * Math.min(area.width, area.height) * 0.02,
            ),
            rotate: i * 37 + 40,
            easing: "linear",
          },
        ],
      });
    }
  } else if (style === "cards") {
    const step = Math.round(area.width / 12);
    let d = "";
    for (let x = area.x + step; x < area.x + area.width; x += step)
      d += `M${x} ${area.y}V${area.y + area.height}`;
    for (let y = area.y + step; y < area.y + area.height; y += step)
      d += `M${area.x} ${y}H${area.x + area.width}`;
    layers.push({
      name: "Grid",
      type: "path",
      vectorPath: d,
      vectorViewBox: [area.x, area.y, area.width, area.height],
      vectorAspectRatio: "none",
      ...area,
      background: "transparent",
      stroke: "#0000000d",
      strokeWidth: 1.5,
    });
  }
  return MotionSchema.parse({
    id: uid(),
    name: "Style backdrop",
    source: `style-reel:${style}:backdrop`,
    layers: layers.map((layer) => MotionLayerSchema.parse(layer)),
  });
}

/** Entrance for a graphic, in the style's own rhythm. */
function entrance(style: StyleReelStyle, fps: number) {
  const f = (seconds: number) => Math.max(1, Math.round(seconds * fps));
  if (style === "split")
    return [
      { frame: 0, scale: 0.85, opacity: 0, easing: "ease-out" as const },
      { frame: f(0.1), scale: 1.04, opacity: 1, easing: "ease-out" as const },
      { frame: f(0.2), scale: 1, opacity: 1, easing: "hold" as const },
    ];
  if (style === "cards")
    return [
      { frame: 0, scale: 0.97, opacity: 0, easing: "ease-out" as const },
      { frame: f(0.3), scale: 1, opacity: 1, easing: "ease-out" as const },
    ];
  return [];
}

function ripple(area: Rect, start: number, track: string, p: Project) {
  const size = Math.min(area.width, area.height) * 0.7;
  const layer = MotionLayerSchema.parse({
    name: "Ring ripple",
    type: "ellipse",
    x: area.x + area.width / 2 - size / 2,
    y: area.y + area.height / 2 - size / 2,
    width: size,
    height: size,
    background: "transparent",
    stroke: "#ffffff",
    strokeWidth: Math.max(2, Math.round(p.width * 0.005)),
    keyframes: [
      { frame: 0, scale: 0.6, opacity: 0.8, easing: "ease-out" },
      {
        frame: Math.round(p.fps * 0.33),
        scale: 1.25,
        opacity: 0,
        easing: "linear",
      },
    ],
  });
  const motion = MotionSchema.parse({
    id: uid(),
    name: "Ring ripple",
    source: "style-reel:split:ripple",
    layers: [layer],
  });
  const clip: Clip = {
    ...makeClip(p, "text", track, start),
    text: "Ring ripple",
    preset: "custom",
    motionId: motion.id,
    x: 0,
    y: 0,
    width: p.width,
    height: p.height,
    duration: Math.max(2, Math.round(p.fps * 0.4)),
  };
  return { motion, clip };
}

export type StyleReelInput = {
  style: StyleReelStyle;
  beats: StyleBeat[];
  /** Video track holding the speaker; defaults to the busiest video track. */
  speakerTrackId?: string;
  /** Caption look; keep leaves captions as they are. */
  captions?: "auto" | "keep";
};

/** Lays out a creator-style Short on the project; returns the new project. */
export function buildStyleReel(project: Project, input: StyleReelInput) {
  const p = structuredClone(project);
  const { fps, width: W, height: H } = p;
  const warnings: string[] = [];
  const style = input.style;
  if (H <= W)
    warnings.push(
      "These styles are made for vertical 9:16 video; the canvas is not vertical.",
    );

  // Clear a previous pass: its tracks, their clips and motions.
  const ownTracks = new Set(
    p.tracks
      .filter((t) => (Object.values(STYLE_TRACKS) as string[]).includes(t.name))
      .map((t) => t.id),
  );
  const ownMotions = new Set(
    p.clips
      .filter((c) => ownTracks.has(c.trackId) && c.motionId)
      .map((c) => c.motionId!),
  );
  p.clips = p.clips.filter((c) => !ownTracks.has(c.trackId));
  p.tracks = p.tracks.filter((t) => !ownTracks.has(t.id));
  p.motions = p.motions.filter(
    (m) => !ownMotions.has(m.id) || p.clips.some((c) => c.motionId === m.id),
  );

  const videoTracks = p.tracks.filter((t) => t.kind === "video");
  const busiest = videoTracks
    .map((t) => ({
      t,
      frames: p.clips
        .filter((c) => c.trackId === t.id && c.kind === "video")
        .reduce((sum, c) => sum + c.duration, 0),
    }))
    .sort((a, b) => b.frames - a.frames)[0]?.t;
  const speakerTrack = input.speakerTrackId
    ? p.tracks.find((t) => t.id === input.speakerTrackId)
    : busiest;
  if (!speakerTrack || speakerTrack.kind !== "video")
    throw Error("Add the speaker's video to the timeline first.");
  const speaker = p.clips
    .filter((c) => c.trackId === speakerTrack.id && c.kind === "video")
    .sort((a, b) => a.start - b.start);
  if (!speaker.length) throw Error("The speaker track has no video clips.");
  const reelStart = speaker[0].start,
    reelEnd = Math.max(...speaker.map(clipEnd));

  // Beats in frames, ordered, clipped to the speaker and never overlapping.
  const beats = input.beats
    .map((beat) => ({
      ...beat,
      start: Math.max(reelStart, Math.round(beat.from * fps)),
      end: Math.min(reelEnd, Math.round(beat.to * fps)),
    }))
    .filter((beat) => {
      const ok = beat.end - beat.start >= Math.round(fps * 0.3);
      if (!ok)
        warnings.push(
          `A beat at ${beat.from.toFixed(1)}s is shorter than 0.3 s or outside the speaker's video, so it was skipped.`,
        );
      return ok;
    })
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < beats.length; i++)
    if (beats[i].start < beats[i - 1].end) beats[i - 1].end = beats[i].start;
  // A locked split holds each visual until the next one replaces it.
  if (style === "locked-split")
    beats.forEach((beat, i) => {
      if (beat.visual) beat.end = beats[i + 1]?.start ?? reelEnd;
    });
  const beatAt = (frame: number) =>
    beats.find((beat) => frame >= beat.start && frame < beat.end);
  const layoutAt = (frame: number) => layoutFor(style, beatAt(frame));
  const edges = [...new Set(beats.flatMap((b) => [b.start, b.end]))].sort(
    (a, b) => a - b,
  );

  // Speaker framing on hard cuts.
  const reframed = speaker.flatMap((clip) =>
    clip.freeze
      ? [clip]
      : reframeSpeaker(
          p,
          clip,
          edges,
          layoutAt,
          style,
          warnings,
          input.captions === "keep",
        ),
  );

  // Style layers sit directly above the speaker, under captions and titles.
  const make = (name: string, kind: Track["kind"]): Track => ({
    id: uid(),
    name,
    kind,
    muted: kind === "video",
    hidden: false,
  });
  const graphics = make(STYLE_TRACKS.graphics, "text"),
    media = make(STYLE_TRACKS.media, "video"),
    backdrop = make(STYLE_TRACKS.backdrop, "text");
  const at = p.tracks.findIndex((t) => t.id === speakerTrack.id);
  p.tracks.splice(at, 0, graphics, media, backdrop);

  const assets = new Map(p.assets.map((a) => [a.id, a]));
  const add = (clip: Clip, motion?: Motion) => {
    if (motion) p.motions.push(motion);
    p.clips.push(clip);
  };
  let windowIndex = 0;
  // Backdrops cover each run of one layout, so cuts between two visuals on
  // the same layout keep one continuous background, as the references do.
  const windows: { start: number; end: number; layout: StyleLayout }[] = [];
  for (const beat of beats) {
    const layout = layoutFor(style, beat);
    if (!panelFor(style, layout, W, H)) continue;
    const last = windows.at(-1);
    if (last && last.layout === layout && last.end === beat.start)
      last.end = beat.end;
    else windows.push({ start: beat.start, end: beat.end, layout });
  }
  for (const w of windows) {
    const area = panelFor(style, w.layout, W, H)!;
    const motion = backdropMotion(
      style,
      area,
      windowIndex++,
      w.end - w.start,
      fps,
    );
    add(
      {
        ...makeClip(p, "text", backdrop.id, w.start),
        text: "Style backdrop",
        preset: "custom",
        motionId: motion.id,
        x: 0,
        y: 0,
        width: W,
        height: H,
        duration: w.end - w.start,
      },
      motion,
    );
  }

  for (const beat of beats) {
    const visual = beat.visual;
    if (!visual) continue;
    const layout = layoutFor(style, beat);
    // On the card canvas, a visual over the speaker sits on a white card
    // across the upper part of the frame, as the reference does.
    const fullPanel = panelFor(style, layout, W, H);
    // On a full-screen beat the visual sits in the upper part so the
    // captions below never cover it.
    const panel =
      fullPanel && layout === "full"
        ? { ...fullPanel, height: Math.round(H * 0.6) }
        : fullPanel;
    const floating = !panel;
    const area = panel ?? {
      x: Math.round(W * 0.06),
      y: Math.round(H * 0.07),
      width: Math.round(W * 0.88),
      height: Math.round(H * 0.22),
    };
    const frames = beat.end - beat.start;
    if (visual.kind === "asset") {
      const asset = assets.get(visual.assetId);
      if (!asset || asset.kind === "audio") {
        warnings.push(
          `Beat at ${beat.from.toFixed(1)}s: that media is not in the project.`,
        );
        continue;
      }
      const aspect = (asset.width ?? 16) / (asset.height ?? 9);
      const fill = style === "locked-split" && !visual.logo && !visual.drawing;
      const box = fill
        ? area
        : rectFit(
            aspect,
            area,
            visual.logo
              ? 0.4
              : visual.drawing
                ? 0.72
                : style === "cards"
                  ? 0.84
                  : 0.82,
          );
      const clip: Clip = {
        ...makeClip(
          p,
          asset.kind === "image" ? "image" : "video",
          media.id,
          beat.start,
          asset,
        ),
        duration:
          asset.kind === "video"
            ? Math.min(frames, Math.max(1, Math.floor(asset.duration * fps)))
            : frames,
        volume: 0,
        ...box,
        fit: "cover",
        cameraMotion: "none",
        ...(fill || visual.drawing
          ? {}
          : {
              mask: "rounded" as const,
              cornerRadius: Math.round(
                visual.logo
                  ? box.width * 0.22
                  : W * (style === "cards" ? 0.02 : 0.025),
              ),
              shadowBlur: visual.logo ? 0 : style === "cards" ? 30 : 50,
              shadowY: style === "cards" ? 10 : 20,
              shadowColor: style === "cards" ? "#0000001f" : "#00000033",
            }),
        keyframes: [
          ...entrance(style, fps).flatMap((key) => [
            {
              property: "scale" as const,
              frame: key.frame,
              value: key.scale,
              easing: key.easing,
            },
            {
              property: "opacity" as const,
              frame: key.frame,
              value: key.opacity,
              easing: key.easing,
            },
          ]),
          // The card canvas keeps every still drifting slowly closer.
          ...(style === "cards" && frames > fps
            ? [
                {
                  property: "scale" as const,
                  frame: Math.round(fps * 0.3) + 1,
                  value: 1,
                  easing: "linear" as const,
                },
                {
                  property: "scale" as const,
                  frame: frames - 1,
                  value: 1.06,
                  easing: "linear" as const,
                },
              ]
            : []),
        ],
      };
      add(clip);
    } else {
      const layers =
        visual.kind === "svg"
          ? (() => {
              const color = readableOn(visual.color, backdropColor(style));
              const parsed = parseEditableSvg(
                color && !/\bfill=/u.test(visual.svg)
                  ? visual.svg.replace(/<svg\b/u, `<svg fill="${color}"`)
                  : visual.svg,
              );
              const side =
                Math.min(area.width, area.height) *
                (visual.drawing ? 0.72 : 0.42);
              const aspect = parsed.width / parsed.height;
              const scene = createVectorScene(p, beat.start, parsed, {
                name: visual.title,
                ...(aspect >= 1 ? { width: side } : { height: side }),
              });
              return scene.motion.layers.map((layer) => ({
                ...layer,
                x: area.x + (area.width - layer.width) / 2,
                y: area.y + (area.height - layer.height) / 2,
              }));
            })()
          : [
              MotionLayerSchema.parse({
                name: "Line",
                type: "text",
                text: visual.text,
                x: area.x + area.width * 0.08,
                y: area.y + area.height * 0.3,
                width: area.width * 0.84,
                height: area.height * 0.4,
                fontSize: Math.round(
                  W * (visual.text.length > 24 ? 0.07 : 0.09),
                ),
                fontWeight: 800,
                align: "center",
                color: style === "locked-split" ? "#ffffff" : "#141418",
              }),
            ];
      if (floating)
        layers.unshift(
          MotionLayerSchema.parse({
            name: "Card",
            type: "rectangle",
            ...area,
            background: "#ffffff",
            radius: Math.round(W * 0.035),
          }),
        );
      const keys = entrance(style, fps);
      // A drawing builds in part by part, back to front, all of it landed
      // within half a second; logos, lines and the card arrive at once.
      const parts =
        visual.kind === "svg" && visual.drawing
          ? layers.filter((layer) => layer.name !== "Card").length
          : 0;
      const step =
        parts > 1 ? Math.min(Math.round(fps * 0.07), Math.floor((fps * 0.5) / (parts - 1))) : 0;
      let part = 0;
      const delay = (layer: (typeof layers)[number]) =>
        step && layer.name !== "Card" ? step * part++ : 0;
      const motion = MotionSchema.parse({
        id: uid(),
        name:
          visual.kind === "svg"
            ? visual.drawing
              ? visual.title
              : `${visual.title} logo`
            : "Beat line",
        source: `style-reel:${style}:${visual.kind}`,
        layers: layers.map((layer) => {
          const offset = delay(layer);
          return MotionLayerSchema.parse({
            ...layer,
            keyframes: keys.map((key) => ({
              frame: key.frame + offset,
              scale: key.scale,
              opacity: key.opacity,
              easing: key.easing,
            })),
          });
        }),
      });
      add(
        {
          ...makeClip(p, "text", graphics.id, beat.start),
          text: motion.name,
          preset: "custom",
          motionId: motion.id,
          x: 0,
          y: 0,
          width: W,
          height: H,
          duration: frames,
        },
        motion,
      );
    }
    if (style === "split") {
      const r = ripple(area, beat.start, graphics.id, p);
      add({ ...r.clip, duration: Math.min(r.clip.duration, frames) }, r.motion);
    }
  }

  // Captions: the style's look in short chunks, placed by each caption's
  // layout. On the light card canvas they turn dark to stay readable.
  if (input.captions !== "keep") {
    const look =
      style === "split" ? "pill" : style === "cards" ? "clean" : "heavy";
    const inRange = p.clips.filter(
      (c) =>
        c.kind === "caption" && c.start < reelEnd && clipEnd(c) > reelStart,
    );
    if (!inRange.length)
      warnings.push(
        "No captions yet: transcribe the speaker, then run this again to style them.",
      );
    else {
      const regrouped = applyCommands(p, {
        projectId: p.id,
        revision: p.revision,
        label: "Style captions",
        commands: [
          ...inRange.map((c) => ({
            type: "clip.update" as const,
            id: c.id,
            patch: captionStylePatch(look, p),
          })),
        ],
      });
      const short = regroupCaptionCommands(
        regrouped,
        regrouped.clips.filter((c) => inRange.some((r) => r.id === c.id)),
        "short",
      );
      const next = applyCommands(regrouped, {
        projectId: regrouped.id,
        revision: regrouped.revision,
        label: "Short captions",
        commands: short.commands,
      });
      p.clips = next.clips;
      for (const caption of p.clips) {
        if (
          caption.kind !== "caption" ||
          caption.start >= reelEnd ||
          clipEnd(caption) <= reelStart
        )
          continue;
        const middle = caption.start + caption.duration / 2;
        const layout = layoutAt(middle);
        const centre =
          layout === "split"
            ? style === "cards"
              ? H * 0.52
              : H / 2
            : layout === "full"
              ? style === "cards"
                ? H * 0.82
                : H * 0.65
              : layout === "face"
                ? H * 0.7
                : H * 0.68;
        caption.y = Math.round(centre - caption.height / 2);
        if (style === "cards") {
          // Full beats and the split's caption band both sit on the canvas.
          const light = layout === "full" || layout === "split";
          caption.color = light ? "#141418" : "#ffffff";
        }
      }
    }
  }

  const result = validateProject({ ...p, revision: project.revision });
  return {
    project: result,
    warnings,
    summary: {
      beats: beats.length,
      speakerPieces: reframed.length,
      graphicWindows: windows.length,
      // Every beat that changes the picture, once its entrance has landed.
      checkFrames: checkFrames(
        fps,
        reelStart,
        reelEnd,
        beats
          .filter((beat) => beat.visual || layoutFor(style, beat) !== "speaker")
          .map((beat) => ({
            start: beat.start,
            duration: beat.end - beat.start,
          })),
      ),
    },
  };
}
