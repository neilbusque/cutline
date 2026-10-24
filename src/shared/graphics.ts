import { z } from "zod";
import type { Command } from "./commands";
import { chooseBackdrop, hexRgb, type Backdrop } from "./cutout";
import { newTrack } from "./layers";
import { makeClip, type Asset, type Clip, type Project } from "./model";
import {
  extractSvg,
  generateVector,
  VectorGenerateSchema,
  vectorStyles,
  type VectorGenerateInput,
} from "./vector-generation";
import { parseEditableSvg, type ParsedEditableSvg } from "./vector-path";

/**
 * Graphics Cutline makes itself. Claude or ChatGPT draws an editable vector
 * first and checks its own render. Only a subject too detailed for a clean
 * vector becomes a picture from Higgsfield, lifted off its backdrop.
 */

export const GraphicGenerateSchema = VectorGenerateSchema.extend({
  /**
   * auto: a vector, or a Higgsfield picture when the subject is too detailed.
   * vector: always a vector. picture: straight to Higgsfield.
   */
  route: z.enum(["auto", "vector", "picture"]).default("auto"),
});
export type GraphicGenerateInput = z.infer<typeof GraphicGenerateSchema>;

export type GraphicResult =
  | {
      kind: "vector";
      /** The review's 1 to 5 score of the drawing, when it gave one. */
      score?: number;
      svg: string;
      warnings: string[];
      layers: number;
      /** Model calls it took, counting the review. */
      attempts: number;
      /** Set when the review redrew the vector. */
      revised?: boolean;
      /** A plain note to show with the result, such as why no picture was made. */
      note?: string;
    }
  | {
      kind: "picture";
      file: string;
      width: number;
      height: number;
      /** False when the backdrop could not be removed; the picture stays opaque. */
      cutout: boolean;
      /** Why a picture was made instead of a vector. */
      reason: "asked" | "too-detailed" | "lost-detail" | "unusable";
      /** Higgsfield's estimate for the request, in US dollars. */
      usd?: string;
      /** The drawing made before the picture, offered as the alternative. */
      drawing?: { svg: string; layers: number; warnings: string[] };
    };

export type PictureRequest = {
  prompt: string;
  style: GraphicGenerateInput["style"];
  aspect: GraphicGenerateInput["aspect"];
  palette?: string[];
  onto?: string;
};
export type PictureResult = Omit<
  Extract<GraphicResult, { kind: "picture" }>,
  "kind" | "reason"
>;

/** How a model is asked: an optional image is a render it should look at. */
export type Ask = (
  system: string,
  prompt: string,
  image?: Uint8Array,
) => Promise<string>;

const DECLINE = "<too-detailed/>";
const pictureStyles: Record<GraphicGenerateInput["style"], string> = {
  flat: "flat vector illustration, clean solid color shapes, crisp edges, subtle shading",
  line: "clean line art icon, one consistent stroke weight, rounded ends",
  glyph: "bold simple logo mark, strong silhouette, two or three colors",
  gradient: "glossy app icon style, smooth gradients and soft highlights",
  badge: "sticker badge with a bold symbol on a filled base shape",
};
const pictureAspect = { square: "1:1", wide: "16:9", tall: "9:16" } as const;

/**
 * The Recraft V4.1 request for a picture: one subject on a flat backdrop the
 * subject does not use, which Cutline removes after download.
 */
export function pictureRequest(input: PictureRequest, backdrop?: Backdrop) {
  const key = backdrop ?? chooseBackdrop(input.prompt, input.palette);
  const hex = `#${key.rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  return {
    endpoint: "recraft/v4.1/text-to-image",
    backdrop: key,
    body: {
      prompt: [
        input.prompt.trim().replace(/[.\s]+$/u, ""),
        `${pictureStyles[input.style]}${input.onto ? `, in colors that stand out on ${input.onto}` : ""}.`,
        "One subject, centered, entirely in frame with space around it.",
        `Isolated on a plain flat solid ${key.name} (${hex}) background: no shadow, no floor, no scenery, no border, no text or lettering.`,
      ].join(". "),
      resolution: "1k",
      aspect_ratio: pictureAspect[input.aspect],
      output_format: "png",
      background_color: { rgb: [...key.rgb] },
      ...(input.palette?.length
        ? { colors: input.palette.map((color) => ({ rgb: [...hexRgb(color)] })) }
        : {}),
    },
  };
}

/** The drawing brief plus, when a picture can take over, permission to decline. */
export function declineRule() {
  return `If the subject cannot become a clean, recognizable vector within 40 shapes (photo-real, a real person's likeness, a crowd, a detailed landscape, room or city full of objects, fur, hair or fabric texture), reply with exactly ${DECLINE} and nothing else. Simple and medium subjects (objects, icons, mascots, devices, symbols, simple characters) are always drawn.`;
}

export function reviewSystemPrompt() {
  return [
    "You are a demanding art director checking a vector illustration for a video. You see the drawing exactly as it renders, followed by its SVG source.",
    "Judge it at a glance, the way a viewer sees it for two seconds: does it clearly show the request and the action it names, are the proportions and placement right, do parts float loose or overlap wrongly, is anything cut off, too faint or too small to read, or missing?",
    "Start your reply with <score>N</score>: 5 when a viewer would recognize the request instantly, 3 when it takes a moment or something is off, 1 when it does not show the request.",
    "Then, if it is good, write exactly <ok/>.",
    "Otherwise write one corrected complete SVG fixing every problem you saw, following the same rules as the original (same elements allowed, at most 40 shapes, ids naming parts, back to front, no text, gradients on fills only).",
  ].join("\n");
}

/** The review's 1 to 5 score, or undefined when it gave none. */
export function reviewScore(reply: string) {
  const score = Number(/<score>\s*([1-5])\s*<\/score>/u.exec(reply)?.[1]);
  return score >= 1 ? score : undefined;
}

/**
 * Requests for scenes, realism or texture: a clean vector rarely does them
 * justice, so a middling drawing of one goes to Higgsfield when allowed.
 */
export const sceneRequest =
  /\b(photo\w*|realistic|realism|detailed|textur\w*|reflections?|skyline|cityscape|landscape|scenery|crowd\w*|portrait|cinematic|3d|lighting|interior)\b/iu;

/** Mostly straight-edged boxes and polygons in quantity: a blocky scene. */
export function blocky(parsed: ParsedEditableSvg) {
  const straight = parsed.layers.filter(
    (layer) => !/[CSQTAcsqta]/u.test(layer.vectorPath),
  ).length;
  return parsed.layers.length >= 32 && straight >= parsed.layers.length * 0.7;
}

export function reviewPrompt(input: VectorGenerateInput, svg: string, canDecline: boolean) {
  const style = vectorStyles.find((s) => s.id === input.style)!;
  return [
    `The request was: ${input.prompt}`,
    `Style: ${style.brief}`,
    input.fill
      ? "It is a whole video frame: its background must still cover the board edge to edge."
      : "",
    canDecline
      ? `If no vector within 40 shapes could show this well, reply with exactly ${DECLINE}.`
      : "",
    "SVG source:",
    svg.slice(0, 24000),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A made picture on the timeline: on a free Graphics video track above the
 * footage, centered (above the captions on tall frames), held four seconds,
 * fading in with a small settle and out again.
 */
export function placePicture(p: Project, start: number, asset: Asset) {
  const fps = p.fps,
    frames = fps * 4;
  const W = p.width,
    H = p.height,
    tall = H > W;
  const aspect = (asset.width ?? 1) / (asset.height ?? 1);
  const side = Math.min(W, H) * (tall ? 0.72 : 0.56);
  const width = Math.round(aspect >= 1 ? side : side * aspect),
    height = Math.round(width / aspect);
  const free = (trackId: string) =>
    !p.clips.some(
      (c) =>
        c.trackId === trackId &&
        c.start < start + frames &&
        c.start + c.duration > start,
    );
  const commands: Command[] = [];
  let track = p.tracks.find(
    (t) => t.kind === "video" && t.name === "Graphics" && !t.hidden && free(t.id),
  );
  if (!track) {
    if (p.tracks.length >= 64)
      throw Error("This project has 64 tracks, the most it can hold.");
    track = { ...newTrack(p, "video"), name: "Graphics" };
    commands.push({ type: "track.add", track });
  }
  const settle = Math.max(2, Math.round(fps * 0.35));
  const clip: Clip = {
    ...makeClip(p, "image", track.id, start, asset),
    duration: frames,
    x: Math.round((W - width) / 2),
    y: Math.round((tall ? H * 0.4 : H / 2) - height / 2),
    width,
    height,
    fit: "contain",
    cameraMotion: "none",
    fadeIn: Math.round(fps * 0.2),
    fadeOut: Math.round(fps * 0.2),
    keyframes: [
      { property: "scale", frame: 0, value: 0.94, easing: "ease-out" },
      { property: "scale", frame: settle, value: 1, easing: "hold" },
    ],
  };
  commands.push({ type: "clip.add", clip });
  return { clip, track, commands };
}

const lostDetail = (parsed: ParsedEditableSvg) =>
  (parsed.warnings ?? []).some((w) => /left out|combined/u.test(w));

/**
 * Makes a graphic: a vector from the signed-in assistant, reviewed once
 * against its own render when render is available, or a Higgsfield picture
 * when the vector route cannot show the subject and picture is available.
 */
export async function generateGraphic(
  raw: unknown,
  deps: {
    ask: Ask;
    /** The SVG as a PNG, for the assistant to look at. */
    render?: (svg: string) => Promise<Uint8Array>;
    /** Present only when Higgsfield is connected and allowed for graphics. */
    picture?: (request: PictureRequest) => Promise<PictureResult>;
    /** Why there is no picture route, shown with a detailed vector. */
    pictureUnavailable?: string;
    onStep?: (step: "drawing" | "reviewing" | "picture") => void;
  },
): Promise<GraphicResult> {
  const input = GraphicGenerateSchema.parse(raw ?? {});
  const { route, ...vectorInput } = input;
  const request: PictureRequest = {
    prompt: input.prompt,
    style: input.style,
    aspect: input.aspect,
    palette: input.palette,
    onto: input.onto,
  };
  const picture = async (
    reason: Extract<GraphicResult, { kind: "picture" }>["reason"],
    drawing?: { svg: string; parsed: ParsedEditableSvg },
  ) => {
    deps.onStep?.("picture");
    return {
      kind: "picture" as const,
      reason,
      ...(await deps.picture!(request)),
      ...(drawing
        ? {
            drawing: {
              svg: drawing.svg,
              layers: drawing.parsed.layers.length,
              warnings: drawing.parsed.warnings ?? [],
            },
          }
        : {}),
    };
  };
  if (route === "picture") {
    if (!deps.picture)
      throw Error(deps.pictureUnavailable ?? "Connect Higgsfield in Settings to make pictures.");
    return picture("asked");
  }
  const canDecline = route === "auto" && !!deps.picture;

  deps.onStep?.("drawing");
  let drawn: Awaited<ReturnType<typeof generateVector>>;
  try {
    drawn = await generateVector(vectorInput, deps.ask, {
      decline: canDecline ? declineRule() : undefined,
    });
  } catch (error) {
    if (canDecline && /too detailed/u.test((error as Error).message))
      return picture("too-detailed");
    if (canDecline && !/Cancelled/u.test((error as Error).message))
      return picture("unusable");
    throw error;
  }
  if (canDecline && lostDetail(drawn.parsed)) return picture("lost-detail", drawn);

  let { svg, parsed, attempts } = drawn;
  let revised = false;
  let score: number | undefined;
  if (deps.render) {
    deps.onStep?.("reviewing");
    try {
      const reply = await deps.ask(
        reviewSystemPrompt(),
        reviewPrompt(vectorInput, svg, canDecline),
        await deps.render(svg),
      );
      attempts++;
      score = reviewScore(reply);
      const scene = sceneRequest.test(input.prompt);
      // Claude rarely declines on its own, so its score decides: a weak
      // drawing, or a middling or blocky one of a scene, becomes a picture.
      if (
        canDecline &&
        (reply.includes(DECLINE) ||
          (score !== undefined && score <= 2) ||
          (scene && ((score !== undefined && score <= 3) || blocky(parsed))))
      )
        return picture("too-detailed", { svg, parsed });
      if (/<svg[\s>]/u.test(reply)) {
        const fixed = extractSvg(reply);
        const check = parseEditableSvg(fixed);
        // A review never trades a working drawing for one that loses detail.
        if (check.layers.length && !lostDetail(check)) {
          svg = fixed;
          parsed = check;
          revised = true;
        }
      }
    } catch (error) {
      if (/Cancelled/u.test((error as Error).message)) throw error;
      // The first drawing already passed the importer: keep it.
    }
  }
  const detailed =
    !deps.picture &&
    route === "auto" &&
    (lostDetail(parsed) ||
      (score !== undefined && score <= 2) ||
      (sceneRequest.test(input.prompt) && blocky(parsed)));
  return {
    kind: "vector",
    svg,
    warnings: parsed.warnings ?? [],
    layers: parsed.layers.length,
    attempts,
    ...(score !== undefined ? { score } : {}),
    ...(revised ? { revised } : {}),
    ...(detailed && deps.pictureUnavailable ? { note: deps.pictureUnavailable } : {}),
  };
}
