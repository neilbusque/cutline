import { FinishingOverlay } from "./FinishingOverlay";
import { RgbSplit } from "./RgbSplit";
import { MotionGraphicAtFrame } from "./MotionGraphic";
import { CaptionText } from "./CaptionText";
import { captionWordStyle } from "../shared/caption-styles";
import { evaluatedClip, animatedValue } from "../shared/animation";
import {
  animationSpans,
  presetEntranceOpacity,
  presetTiming,
  staggerLetter,
  typewriterSplit,
  wordRevealOpacity,
  wordRuns,
  type AnimationSpan,
  type PresetTiming,
} from "../shared/text-presets";
import {
  musicBindings,
  reactiveVisual,
  reactiveClipVisual,
  type MusicBinding,
} from "../shared/music-reactive";
import { activeTransition, clipFadeEnvelope } from "../shared/transitions";
import {
  blackDip,
  clipBoxStyle,
  clipWrapperStyle,
  mediaStyle,
  transitionGain,
  transitionGroups,
  type IncomingTransition,
  type OutgoingTransition,
} from "./compositing";
import React, { useMemo, useState } from "react";
import {
  AbsoluteFill,
  Sequence,
  Video,
  OffthreadVideo,
  Audio,
  Freeze,
  Img,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  duration,
  type Project,
  type Clip,
  type Motion,
  type Asset,
  type Track,
} from "../shared/model";
export type RenderProps = {
  project: Project;
  mediaBase: string;
  preview?: boolean;
};
export function assetUrl(base: string, a: Asset, preview = false) {
  return `${base}/media/${a.id}/${preview && a.proxy ? "proxy" : "original"}`;
}
/**
 * The file a media clip plays. A reversed clip plays the reversed copy made
 * on this Mac; until it exists the editor shows a waiting card, and export
 * makes it first.
 */
export function clipMedia(c: Clip, a: Asset, base: string, preview: boolean) {
  if (c.reverse)
    return { src: `${base}/media/${a.id}/reversed`, pending: !a.reversed };
  return { src: assetUrl(base, a, preview), pending: false };
}
export function opacityAt(c: Clip, f: number) {
  return c.opacity * clipFadeEnvelope(c, f);
}
/** Letters rise one by one; each word stays in one piece when lines wrap. */
function staggeredText(text: string, timing: PresetTiming) {
  const count = Array.from(text).length;
  return wordRuns(text).map((run) =>
    run.space ? (
      <React.Fragment key={run.start}>{run.text}</React.Fragment>
    ) : (
      <span key={run.start} style={{ display: "inline-block" }}>
        {Array.from(run.text).map((letter, i) => {
          const state = staggerLetter(run.start + i, count, timing);
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                whiteSpace: "pre",
                opacity: state.opacity,
                transform: `translateY(${state.rise * 30}px)`,
              }}
            >
              {letter}
            </span>
          );
        })}
      </span>
    ),
  );
}

/** Frame-driven title rendering shared by preview, export and tests. */
export function TextGraphicAtFrame({
  c,
  frame: f,
  fps,
  motion,
  accentPulse,
  span,
}: {
  c: Clip;
  frame: number;
  fps: number;
  motion?: Motion;
  accentPulse?: { scale: number; glow: number };
  span?: AnimationSpan;
}) {
  if (
    c.kind === "caption" &&
    c.captionLayout === "balanced" &&
    !(c.preset === "custom" && motion)
  )
    return <CaptionText clip={c} frame={f} fps={fps} span={span} />;
  const timing = presetTiming(c, f, span);
  // Loops continue across a split, like the entrance and exit.
  const loopSeconds = timing.at / fps;
  let text: React.ReactNode = c.text;
  if (c.kind === "caption" && c.words.length) {
    text = c.words.map((w, i) => {
      const state = captionWordStyle(c, i, f / fps);
      return (
        <React.Fragment key={i}>
          <span
            style={{
              display: "inline-block",
              color:
                c.highlight && state.active
                  ? state.filled
                    ? "#111813"
                    : c.accent
                  : c.color,
              background: state.filled ? c.accent : undefined,
              borderRadius: 7,
              padding: c.captionStyle === "karaoke" ? "2px 6px" : undefined,
              transform: `scale(${state.scale})`,
              opacity: state.visible ? 1 : 0,
              WebkitTextStroke:
                c.captionStyle === "outline" ? "2px #141816" : undefined,
              paintOrder: "stroke fill",
            }}
          >
            {w.text}
          </span>{" "}
        </React.Fragment>
      );
    });
  } else if (c.preset === "typewriter") {
    // Untyped letters keep their room, so the line never re-centers or rewraps.
    const { typed, hidden } = typewriterSplit(c.text, timing.progress);
    text = (
      <>
        {typed}
        {hidden && <span style={{ visibility: "hidden" }}>{hidden}</span>}
      </>
    );
  } else if (c.preset === "word-reveal") {
    const words = c.text.split(" ");
    text = words.map((w, i) => (
      <span
        key={i}
        style={{ opacity: wordRevealOpacity(i, words.length, timing) }}
      >
        {w}{" "}
      </span>
    ));
  }
  if (c.preset === "stagger") text = staggeredText(c.text, timing);
  const exiting = !!c.exitAnimation && c.exitAnimation !== "none";
  const { move, pop, exitEased } = timing;
  const entryTransform =
    c.preset === "spring"
      ? `scale(${0.86 + 0.14 * pop})`
      : c.preset === "slide" || c.preset === "lower-third"
        ? `translateY(${(1 - move) * 55}px)`
        : c.preset === "rise"
          ? `translateY(${(1 - move) * 36}px)`
          : c.preset === "callout"
            ? `scale(${0.85 + 0.15 * pop})`
            : c.preset === "flip"
              ? `perspective(900px) rotateX(${(1 - move) * 90}deg)`
              : c.preset === "pulse"
                ? `scale(${1 + 0.035 * Math.sin(loopSeconds * Math.PI * 3)})`
                : c.preset === "swing"
                  ? `rotate(${(1 - pop) * -18}deg)`
                  : "";
  const exitTransform =
    c.exitAnimation === "slide"
      ? ` translateY(${exitEased * 70}px)`
      : c.exitAnimation === "shrink"
        ? ` scale(${1 - exitEased * 0.3})`
        : "";
  if (c.preset === "custom" && motion)
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          opacity: exiting ? 1 - exitEased : 1,
          transform: exitTransform.trim() || "none",
        }}
      >
        <MotionGraphicAtFrame
          motion={motion}
          c={c}
          frame={f}
          fps={fps}
          accentPulse={accentPulse}
        />
      </div>
    );
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent:
          c.align === "left"
            ? "flex-start"
            : c.align === "right"
              ? "flex-end"
              : "center",
        textAlign: c.align,
        fontFamily: c.fontFamily,
        fontWeight: c.fontWeight,
        fontSize: c.fontSize,
        lineHeight: 1.18,
        color: c.color,
        background: c.background,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        padding: c.kind === "caption" ? "12px 24px" : 12,
        boxSizing: "border-box",
        borderRadius: c.kind === "caption" ? 18 : 0,
        opacity:
          presetEntranceOpacity(c.preset, timing) *
          (exiting ? 1 - exitEased : 1),
        transform: (entryTransform + exitTransform).trim() || "none",
        filter:
          c.preset === "blur-in" ? `blur(${(1 - move) * 18}px)` : undefined,
        clipPath:
          c.preset === "wipe" ? `inset(0 ${(1 - move) * 100}% 0 0)` : undefined,
        textShadow:
          c.preset === "glow"
            ? `0 0 ${12 + 8 * Math.sin(loopSeconds * 3)}px ${c.accent}, 0 0 35px ${c.accent}`
            : c.kind === "caption" && c.background === "transparent"
              ? "0 2px 7px #000, 0 0 2px #000"
              : undefined,
        borderLeft:
          c.preset === "lower-third" ? `8px solid ${c.accent}` : undefined,
        // Inside the box, so a crop or mask never hides the ring.
        boxShadow:
          c.preset === "callout" ? `inset 0 0 0 3px ${c.accent}` : undefined,
      }}
    >
      <div>{text}</div>
    </div>
  );
}
function TextGraphic(props: {
  c: Clip;
  motion?: Motion;
  accentPulse?: { scale: number; glow: number };
  span?: AnimationSpan;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <TextGraphicAtFrame {...props} frame={frame} fps={fps} />;
}
/** Editor-only stand-in for footage the preview cannot play yet. */
function MediaPending({
  ready,
  height,
  message = "Preparing preview…",
}: {
  ready: boolean;
  height: number;
  message?: string;
}) {
  return (
    <AbsoluteFill
      style={{
        background: "#16161a",
        color: "rgba(237, 238, 242, 0.72)",
        fontFamily: "-apple-system, system-ui, sans-serif",
        fontSize: Math.max(14, Math.round(height * 0.028)),
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
      }}
    >
      {ready ? "Preview unavailable" : message}
    </AbsoluteFill>
  );
}
function Layer({
  c: original,
  p,
  base,
  preview,
  a,
  track,
  motion,
  incoming,
  outgoing,
  musicBinding,
  span,
}: {
  c: Clip;
  incoming?: IncomingTransition;
  outgoing?: OutgoingTransition;
  a?: Asset;
  track: Track;
  motion?: Motion;
  p: Project;
  base: string;
  preview: boolean;
  musicBinding?: MusicBinding;
  span?: AnimationSpan;
}) {
  const f = useCurrentFrame();
  // Footage Chrome cannot play (ProRes, AVI) shows a quiet card in the
  // editor until its preview copy is ready, instead of throwing.
  const [failedMedia, setFailedMedia] = useState("");
  const c = evaluatedClip(original, f);
  const reactive = reactiveClipVisual(
    original,
    original.start + f,
    musicBinding,
  );
  const accentPulse =
    original.musicReactive?.scope === "accents"
      ? reactiveVisual(original, original.start + f, musicBinding)
      : undefined;

  const audioVolume = (at: number) =>
    animatedValue(original, "volume", at) *
    (track?.muted ? 0 : 1) *
    transitionGain(at, incoming, outgoing) *
    clipFadeEnvelope(c, at);
  const media = a ? clipMedia(c, a, base, preview) : undefined;
  const src = media?.src ?? "";
  const MediaVideo = preview ? Video : OffthreadVideo;
  if (c.kind === "audio")
    // A held frame is silent, and reversed sound waits for its copy.
    return a && !track.muted && !c.freeze && !media?.pending ? (
      <Audio
        src={src}
        startFrom={c.sourceIn * p.fps}
        playbackRate={c.speed}
        volume={audioVolume}
      />
    ) : null;
  const footage =
    c.kind === "video" && a ? (
      <MediaVideo
        src={src}
        startFrom={Math.round(c.sourceIn * p.fps)}
        playbackRate={c.speed}
        volume={c.freeze ? 0 : audioVolume}
        muted={c.freeze}
        style={{ width: "100%", height: "100%", objectFit: c.fit }}
        {...(preview
          ? { onError: () => setFailedMedia(`${src}\n${a.path}`) }
          : {})}
      />
    ) : null;
  if (track?.hidden) return null;
  const dip =
    incoming?.kind === "black" ? blackDip(f, incoming.frames).black : 0;
  return (
    <>
      <div
        style={clipWrapperStyle({
          c,
          frame: f,
          glow: reactive.glow,
          incoming,
          outgoing,
        })}
      >
        <div style={clipBoxStyle(c, opacityAt(c, f), reactive.scale)}>
          <RgbSplit amount={c.rgbSplit}>
            <div
              style={{
                width: "100%",
                height: "100%",
                overflow:
                  c.kind === "video" || c.kind === "image"
                    ? "hidden"
                    : "visible",
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  ...mediaStyle(c, f, p.fps, span),
                }}
              >
                {c.kind === "video" && a && media?.pending ? (
                  <MediaPending
                    ready={false}
                    height={p.height}
                    message="Preparing reversed copy…"
                  />
                ) : c.kind === "video" &&
                  a &&
                  failedMedia === `${src}\n${a.path}` ? (
                  <MediaPending ready={!!a.proxy} height={p.height} />
                ) : c.kind === "video" && a && c.freeze ? (
                  // The first frame of the clip holds for its whole duration.
                  <Freeze frame={0}>{footage}</Freeze>
                ) : c.kind === "video" && a ? (
                  footage
                ) : c.kind === "image" && a ? (
                  <Img
                    src={src}
                    style={{ width: "100%", height: "100%", objectFit: c.fit }}
                  />
                ) : (
                  <TextGraphic
                    c={c}
                    motion={motion}
                    accentPulse={accentPulse}
                    span={span}
                  />
                )}
              </div>
              {(c.kind === "video" || c.kind === "image") && (
                <FinishingOverlay clip={c} frame={f} />
              )}
              {(c.kind === "video" || c.kind === "image") && c.vignette > 0 && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                    background: `radial-gradient(ellipse, transparent 35%, rgba(0,0,0,${c.vignette}) 100%)`,
                  }}
                />
              )}
            </div>
          </RgbSplit>
        </div>
      </div>
      {dip > 0 && (
        <AbsoluteFill style={{ background: "black", opacity: dip }} />
      )}
    </>
  );
}
export const Film: React.FC<RenderProps> = ({
  project: p,
  mediaBase,
  preview = false,
}) => {
  const groups = useMemo(() => {
    const music = musicBindings(p);
    const spans = animationSpans(p);
    const assets = new Map(p.assets.map((a) => [a.id, a])),
      motions = new Map(p.motions.map((m) => [m.id, m]));
    const byTrack = new Map<string, Clip[]>();
    for (const c of p.clips) {
      const list = byTrack.get(c.trackId) ?? [];
      list.push(c);
      byTrack.set(c.trackId, list);
    }
    const transitions = new Map(
      p.clips.map((c) => [c.id, activeTransition(p, c)]),
    );
    const grouped = [...p.tracks]
      .reverse()
      .flatMap((track) =>
        transitionGroups(
          (byTrack.get(track.id) ?? [])
            .sort((a, b) => a.start - b.start)
            .map((c) => ({ c, track, incoming: transitions.get(c.id) })),
        ),
      );
    // A transition inside a group mixes only its own two shots.
    const isolated = new Set(
      grouped.flatMap((group) => group.slice(1).map((entry) => entry.c.id)),
    );
    const outgoing = new Map<string, OutgoingTransition>();
    for (const c of p.clips) {
      const t = transitions.get(c.id);
      if (t)
        outgoing.set(t.previous.id, {
          kind: t.kind,
          start: c.start - t.previous.start,
          frames: t.frames,
          isolated: isolated.has(c.id),
        });
    }
    return grouped.map((group) =>
      group.map(({ c, track, incoming }) => ({
        c,
        track,
        incoming: incoming && {
          kind: incoming.kind,
          frames: incoming.frames,
          isolated: isolated.has(c.id),
        },
        outgoing: outgoing.get(c.id),
        a: c.assetId ? assets.get(c.assetId) : undefined,
        motion: c.motionId ? motions.get(c.motionId) : undefined,
        musicBinding: c.musicReactive
          ? music.get(c.musicReactive.musicClipId)
          : undefined,
        span: spans.get(c.id),
      })),
    );
  }, [p]);
  const layer = ({
    c,
    track,
    a,
    motion,
    incoming,
    outgoing,
    musicBinding,
    span,
  }: (typeof groups)[number][number]) => (
    <Sequence
      key={c.id}
      from={c.start}
      durationInFrames={c.duration}
      layout="none"
    >
      <Layer
        c={c}
        incoming={incoming}
        outgoing={outgoing}
        musicBinding={musicBinding}
        span={span}
        p={p}
        a={a}
        track={track}
        motion={motion}
        base={mediaBase}
        preview={preview}
      />
    </Sequence>
  );
  return (
    <AbsoluteFill style={{ background: p.background, overflow: "hidden" }}>
      {groups.map((group) =>
        group.length > 1 ? (
          // Shots joined by transitions blend with each other, not the tracks below.
          <div
            key={`group:${group[0].c.id}`}
            style={{ position: "absolute", inset: 0, isolation: "isolate" }}
          >
            {group.map(layer)}
          </div>
        ) : (
          layer(group[0])
        ),
      )}
    </AbsoluteFill>
  );
};
