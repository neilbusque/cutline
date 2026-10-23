import type { Clip, Project, Rhythm } from "./model";
import { applyCommands, type Command } from "./commands";
import { compatibleTrack, playsForward, trimClip } from "./timeline";

export type MusicRhythm = Rhythm;
export type BeatSubdivision = "beat" | "bar";
export type MusicSyncOptions = {
  musicClipId: string;
  clipIds: string[];
  mode: "cuts" | "starts";
  subdivision?: BeatSubdivision;
  maxShiftFrames?: number;
  allowAudibleVideo?: boolean;
};
export type MusicSyncPlan = {
  projectId: string;
  revision: number;
  label: string;
  commands: Command[];
  summary: {
    musicClipId: string;
    mode: "cuts" | "starts";
    changedClips: number;
    snappedBoundaries: number;
    largestShiftFrames: number;
  };
  warnings: string[];
};

function musicSource(p: Project, id: string) {
  const clip = p.clips.find((item) => item.id === id);
  if (!clip || clip.kind !== "audio")
    throw Error(
      "Choose an audio clip in the open project as the music source.",
    );
  const asset = p.assets.find((item) => item.id === clip.assetId);
  if (!asset || asset.kind === "image")
    throw Error("The selected music clip has no local audio source.");
  return { clip, asset };
}

/** Source beat times remain anchored to the source, even when music is trimmed or sped up. */
export function beatFrames(
  p: Project,
  musicClipId: string,
  subdivision: BeatSubdivision = "beat",
): number[] {
  if (!["beat", "bar"].includes(subdivision))
    throw Error("Choose beat or bar snapping.");
  const { clip, asset } = musicSource(p, musicClipId);
  const rhythm = asset.rhythm;
  // Beats are measured on the music played forward.
  if (!rhythm || !playsForward(clip)) return [];
  const sourceEnd = Math.min(
    asset.duration,
    clip.sourceIn + (clip.duration * clip.speed) / p.fps,
  );
  const ordered = rhythm.beats
    .filter((beat) => Number.isFinite(beat.time) && beat.time >= 0)
    .sort((a, b) => a.time - b.time);
  const selected =
    subdivision === "bar"
      ? ordered.filter((_, index) => index % 4 === 0)
      : ordered;
  const frames = selected
    .filter(
      (beat) =>
        beat.time >= clip.sourceIn - 1e-8 && beat.time < sourceEnd - 1e-8,
    )
    .map((beat) =>
      Math.round(
        clip.start + ((beat.time - clip.sourceIn) * p.fps) / clip.speed,
      ),
    )
    .filter(
      (frame) => frame >= clip.start && frame < clip.start + clip.duration,
    );
  return [...new Set(frames)];
}

/** Returns undefined when no beat is close enough; an earlier beat wins an exact tie. */
export function nearestBeatFrame(
  frames: readonly number[],
  target: number,
  maxShiftFrames = Infinity,
): number | undefined {
  if (
    !Number.isFinite(target) ||
    maxShiftFrames < 0 ||
    Number.isNaN(maxShiftFrames)
  )
    return undefined;
  let nearest: number | undefined,
    distance = Infinity;
  for (const frame of frames) {
    if (!Number.isFinite(frame)) continue;
    const delta = Math.abs(frame - target);
    if (
      delta <= maxShiftFrames &&
      (delta < distance ||
        (delta === distance && (nearest === undefined || frame < nearest)))
    ) {
      nearest = frame;
      distance = delta;
    }
  }
  return nearest;
}

/** A user-supplied source grid, with no fabricated audio envelope or detection confidence. */
export function manualBeatGrid({
  bpm,
  offsetSeconds = 0,
  duration,
}: {
  bpm: number;
  offsetSeconds?: number;
  duration: number;
}): MusicRhythm {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)
    throw Error("Use a tempo between 20 and 300 BPM.");
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1200)
    throw Error(
      "Manual beat grids support audio up to 20 minutes. Choose a positive, shorter music source.",
    );
  if (
    !Number.isFinite(offsetSeconds) ||
    offsetSeconds < 0 ||
    offsetSeconds >= duration
  )
    throw Error("Place the first beat inside the source audio.");
  const interval = 60 / bpm;
  const count = Math.floor((duration - offsetSeconds) / interval + 1e-9) + 1;
  if (count > 10_000)
    throw Error("This beat grid is too large. Choose a shorter audio source.");
  return {
    version: 1,
    source: "manual",
    bpm,
    confidence: 1,
    duration,
    beats: Array.from({ length: count }, (_, index) => ({
      time: Math.min(
        duration,
        Number((offsetSeconds + index * interval).toFixed(7)),
      ),
      strength: index % 4 === 0 ? 1 : 0.72,
    })),
    envelope: { step: 0.05, values: [] },
  };
}

const end = (clip: Pick<Clip, "start" | "duration">) =>
  clip.start + clip.duration;
const overlap = (
  a: Pick<Clip, "start" | "duration">,
  b: Pick<Clip, "start" | "duration">,
) => a.start < end(b) && end(a) > b.start;

function sourceFrames(p: Project, clip: Clip) {
  if (clip.kind === "text" || clip.kind === "image" || clip.freeze)
    return Infinity;
  const asset = p.assets.find((item) => item.id === clip.assetId);
  if (!asset) throw Error("A selected clip is missing its source media.");
  return Math.max(
    0,
    Math.floor(((asset.duration - clip.sourceIn) * p.fps) / clip.speed + 1e-7),
  );
}

function lowerBound(values: readonly number[], target: number) {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function candidates(
  frames: readonly number[],
  target: number,
  maxShift: number,
) {
  const lo = lowerBound(frames, target - maxShift),
    hi = lowerBound(frames, target + maxShift + 1);
  return [...new Set([...frames.slice(lo, hi), target])].sort((a, b) => a - b);
}
type State = {
  frame: number;
  aligned: number;
  distance: number;
  previous?: State;
};
function better(next: State, previous: State | undefined) {
  return (
    !previous ||
    next.aligned > previous.aligned ||
    (next.aligned === previous.aligned &&
      (next.distance < previous.distance ||
        (next.distance === previous.distance && next.frame < previous.frame)))
  );
}
function statePath(state: State) {
  const values: number[] = [];
  for (let cursor: State | undefined = state; cursor; cursor = cursor.previous)
    values.push(cursor.frame);
  return values.reverse();
}

/** Sorted candidates advance a score window once, avoiding pairwise beat comparisons. */
function predecessorWindow(
  states: State[],
  minimumLength: number,
  capacity: number,
) {
  const queue: number[] = [];
  let added = 0,
    head = 0;
  return (frame: number): State | undefined => {
    while (
      added < states.length &&
      states[added].frame <= frame - minimumLength
    ) {
      while (
        queue.length > head &&
        better(states[added], states[queue[queue.length - 1]])
      )
        queue.pop();
      queue.push(added++);
    }
    while (head < queue.length && states[queue[head]].frame < frame - capacity)
      head++;
    return head < queue.length ? states[queue[head]] : undefined;
  };
}

/** Dynamic programming keeps all cut points ordered and source-bound, including nearby short shots. */
function cutPositions(
  p: Project,
  clips: Clip[],
  frames: number[],
  maxShift: number,
) {
  const grid = new Set(frames);
  let states: State[] = [{ frame: clips[0].start, aligned: 0, distance: 0 }];
  for (let i = 1; i <= clips.length; i++) {
    const last = i === clips.length,
      target = last ? end(clips[i - 1]) : clips[i].start;
    const choices = last ? [target] : candidates(frames, target, maxShift);
    const capacity = sourceFrames(p, clips[i - 1]);
    const next: State[] = [];
    const predecessor = predecessorWindow(states, 1, capacity);
    for (const frame of choices) {
      const previous = predecessor(frame);
      if (previous) {
        next.push({
          frame,
          aligned: previous.aligned + (!last && grid.has(frame) ? 1 : 0),
          distance: previous.distance + Math.abs(frame - target),
          previous,
        });
      }
    }
    states = next;
    if (!states.length)
      throw Error(
        "These edit points cannot be synced without exceeding source media. Trim the selected clips first.",
      );
  }
  return statePath(states[0]);
}

function startPositions(
  p: Project,
  clips: Clip[],
  frames: number[],
  maxShift: number,
  selected: Set<string>,
) {
  const grid = new Set(frames);
  let states: State[] = [{ frame: -1, aligned: 0, distance: 0 }];
  const obstacles = p.clips
    .filter(
      (other) => other.trackId === clips[0].trackId && !selected.has(other.id),
    )
    .sort((a, b) => a.start - b.start);
  const obstacleStarts = obstacles.map((clip) => clip.start);
  const obstacleEnds: number[] = [];
  for (const obstacle of obstacles)
    obstacleEnds.push(Math.max(end(obstacle), obstacleEnds.at(-1) ?? -1));
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const choices = candidates(frames, clip.start, maxShift).filter((frame) => {
      const index = lowerBound(obstacleStarts, frame + clip.duration);
      return frame >= 0 && (!index || obstacleEnds[index - 1] <= frame);
    });
    const next: State[] = [];
    const predecessor = predecessorWindow(
      states,
      i ? clips[i - 1].duration : 0,
      Infinity,
    );
    for (const frame of choices) {
      const previous = predecessor(frame);
      if (previous) {
        next.push({
          frame,
          aligned: previous.aligned + (grid.has(frame) ? 1 : 0),
          distance: previous.distance + Math.abs(frame - clip.start),
          previous,
        });
      }
    }
    states = next;
    if (!states.length)
      throw Error(
        "Snapping would overlap another clip on this track. Choose clips with space around them.",
      );
  }
  let best: State | undefined;
  for (const state of states) if (better(state, best)) best = state;
  return statePath(best!).slice(1);
}

function patchCommand(previous: Clip, next: Clip): Command {
  return {
    type: "clip.update",
    id: previous.id,
    patch: {
      start: next.start,
      duration: next.duration,
      sourceIn: next.sourceIn,
      animationOffset: next.animationOffset,
      words: next.words,
      ...(next.kind === "caption" ? { text: next.text } : {}),
    },
  };
}

/** Plans an undoable transaction. The caller must commit against this project ID and revision. */
export function syncClipTiming(
  p: Project,
  options: MusicSyncOptions,
): MusicSyncPlan {
  if (!["cuts", "starts"].includes(options.mode))
    throw Error("Choose cut or start snapping.");
  if (
    !options.clipIds.length ||
    options.clipIds.length > 1000 ||
    new Set(options.clipIds).size !== options.clipIds.length
  )
    throw Error("Select between one and 1,000 unique visual clips.");
  const maxShift = options.maxShiftFrames ?? Math.round(p.fps * 0.4);
  if (!Number.isInteger(maxShift) || maxShift < 0 || maxShift > p.fps * 5)
    throw Error("Use a maximum timing shift between zero and five seconds.");
  const { clip: music, asset } = musicSource(p, options.musicClipId);
  const frames = beatFrames(p, options.musicClipId, options.subdivision);
  if (!frames.length)
    throw Error("Analyze the music or set its BPM grid before syncing clips.");
  const chosen = new Set(options.clipIds);
  const clips = options.clipIds
    .map((id) => {
      const clip = p.clips.find((item) => item.id === id);
      if (!clip)
        throw Error("A selected clip no longer exists. Refresh the project.");
      if (!["video", "image", "text"].includes(clip.kind))
        throw Error(
          "Choose video, image or text clips. Music and captions keep their own timing.",
        );
      const track = p.tracks.find((item) => item.id === clip.trackId);
      if (!track || !compatibleTrack(clip, track))
        throw Error("A selected clip is on an incompatible track.");
      if (
        clip.transition ||
        p.clips.some((other) => other.transition?.fromId === clip.id)
      )
        throw Error(
          "Remove transitions from the selected sequence before syncing its timing.",
        );
      const media = p.assets.find((item) => item.id === clip.assetId);
      const speech =
        clip.kind === "video" &&
        clip.volume > 0 &&
        !track.muted &&
        (media?.hasAudio ||
          !!media?.words?.length ||
          !!clip.words.length ||
          p.clips.some((other) => other.captionSourceId === clip.id));
      if (speech && !options.allowAudibleVideo)
        throw Error(
          "Audible video is protected. Mute its source audio or explicitly allow dialogue retiming.",
        );
      if (sourceFrames(p, clip) < clip.duration)
        throw Error(
          "A selected clip exceeds its available source frames. Trim it before syncing.",
        );
      return clip;
    })
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const result: MusicSyncPlan = {
    projectId: p.id,
    revision: p.revision,
    label:
      options.mode === "cuts"
        ? "Sync cuts to music"
        : "Sync clip starts to music",
    commands: [],
    summary: {
      musicClipId: music.id,
      mode: options.mode,
      changedClips: 0,
      snappedBoundaries: 0,
      largestShiftFrames: 0,
    },
    warnings: [],
  };
  const changed = new Map<string, Clip>();
  const grid = new Set(frames);
  if (options.mode === "cuts") {
    if (
      clips.length < 2 ||
      clips.some((clip) => clip.trackId !== clips[0].trackId)
    )
      throw Error(
        "Choose at least two consecutive visual clips on one track to sync cuts.",
      );
    if (
      clips.some(
        (clip, index) => index > 0 && clip.start !== end(clips[index - 1]),
      )
    )
      throw Error(
        "Cut syncing needs a contiguous sequence with no gaps or overlaps.",
      );
    const block = {
      start: clips[0].start,
      duration: end(clips.at(-1)!) - clips[0].start,
    };
    if (
      p.clips.some(
        (clip) =>
          clip.trackId === clips[0].trackId &&
          !chosen.has(clip.id) &&
          overlap(clip, block),
      )
    )
      throw Error(
        "Select the complete sequence on this track; another clip overlaps this range.",
      );
    const positions = cutPositions(p, clips, frames, maxShift);
    for (const [index, clip] of clips.entries()) {
      const next = trimClip(
        p,
        { ...clip, start: positions[index] },
        "right",
        positions[index + 1],
      );
      if (next.start !== clip.start || next.duration !== clip.duration)
        changed.set(clip.id, next);
      if (index > 0) {
        const shift = Math.abs(positions[index] - clip.start);
        result.summary.largestShiftFrames = Math.max(
          result.summary.largestShiftFrames,
          shift,
        );
        if (shift && grid.has(positions[index]))
          result.summary.snappedBoundaries++;
      }
    }
    const missed = positions
      .slice(1, -1)
      .filter((frame) => !grid.has(frame)).length;
    if (missed)
      result.warnings.push(
        `${missed} cut${missed === 1 ? "" : "s"} kept their timing because no nearby beat fits the source bounds.`,
      );
  } else {
    const tracks = [...new Set(clips.map((clip) => clip.trackId))];
    for (const track of tracks) {
      const group = clips.filter((clip) => clip.trackId === track);
      const positions = startPositions(p, group, frames, maxShift, chosen);
      for (const [index, clip] of group.entries()) {
        const start = positions[index],
          shift = Math.abs(start - clip.start);
        if (shift) changed.set(clip.id, { ...clip, start });
        result.summary.largestShiftFrames = Math.max(
          result.summary.largestShiftFrames,
          shift,
        );
        if (shift && grid.has(start)) result.summary.snappedBoundaries++;
      }
      const missed = positions.filter((frame) => !grid.has(frame)).length;
      if (missed)
        result.warnings.push(
          `${missed} clip start${missed === 1 ? "" : "s"} kept their timing because no nearby beat has enough room.`,
        );
    }
  }
  result.summary.changedClips = changed.size;
  for (const previous of clips) {
    const next = changed.get(previous.id);
    if (!next) continue;
    result.commands.push(patchCommand(previous, next));
    const delta = next.start - previous.start;
    for (const caption of p.clips.filter(
      (clip) => clip.kind === "caption" && clip.captionSourceId === previous.id,
    )) {
      let updated = { ...caption, start: caption.start + delta };
      if (end(updated) <= next.start || updated.start >= end(next)) {
        result.commands.push({
          type: "clip.delete",
          id: caption.id,
          ripple: false,
        });
        continue;
      }
      if (updated.start < next.start)
        updated = trimClip(p, updated, "left", next.start);
      if (end(updated) > end(next))
        updated = trimClip(p, updated, "right", end(next));
      if (caption.words.length && !updated.words.length)
        result.commands.push({
          type: "clip.delete",
          id: caption.id,
          ripple: false,
        });
      else {
        changed.set(caption.id, updated);
        result.commands.push(patchCommand(caption, updated));
      }
    }
  }
  // Caption ownership follows the source; unrelated text/captions still keep their own timing.
  const deleted = new Set(
    result.commands
      .filter((command) => command.type === "clip.delete")
      .map((command) => command.id),
  );
  for (const clip of changed.values()) {
    if (clip.kind !== "caption") continue;
    if (
      p.clips.some(
        (other) =>
          other.id !== clip.id &&
          other.trackId === clip.trackId &&
          !deleted.has(other.id) &&
          overlap(clip, changed.get(other.id) ?? other) &&
          !overlap(
            p.clips.find((item) => item.id === clip.id)!,
            other,
          ),
      )
    )
      throw Error(
        "Moving these clips would overlap independent captions. Move the captions to separate tracks first.",
      );
  }
  if (result.commands.length > 2000)
    throw Error(
      "This edit includes too many linked captions for one transaction. Select a shorter sequence.",
    );
  if (result.commands.length) applyCommands(p, result);
  if (asset.rhythm?.source === "detected" && asset.rhythm.confidence < 0.3)
    result.warnings.push(
      "Beat detection is uncertain. Preview the timing or set a manual BPM grid.",
    );
  if (options.subdivision === "bar")
    result.warnings.push(
      "Four-beat snapping groups every fourth marker, anchored to the first source beat. Audio analysis does not detect time signatures or downbeats.",
    );
  return result;
}
