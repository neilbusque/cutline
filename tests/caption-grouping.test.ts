import { describe, expect, it } from "vitest";
import {
  buildCaptionClips,
  groupCaptionWords,
} from "../src/shared/caption-grouping";
import {
  captionPlacement,
  captionStylePatch,
  captionStyles,
} from "../src/shared/caption-styles";
import { captionLayout } from "../src/shared/caption-layout";
import {
  ClipSchema,
  makeClip,
  newProject,
  ProjectSchema,
  type Word,
} from "../src/shared/model";
import {
  captionClips,
  parseSrt,
  srtCaptionClips,
  toSrt,
} from "../src/shared/subtitles";
import { reelCaptionClips } from "../src/shared/reel";
import { applyAgentEdit } from "../src/shared/agent-edit";

const spoken = (text: string, step = 0.34): Word[] =>
  text.split(" ").map((text, index) => ({
    text,
    start: index * step,
    end: index * step + 0.24,
  }));

describe("Natural caption phrases", () => {
  it("uses complete sentence boundaries without creating a trailing orphan", () => {
    const groups = groupCaptionWords(
      spoken("Make this simple. Then share it."),
      30,
    );
    expect(
      groups.map((group) => group.map((word) => word.text).join(" ")),
    ).toEqual(["Make this simple.", "Then share it."]);
    const seven = groupCaptionWords(
      spoken("one two three four five six seven"),
      30,
    );
    expect(seven.length).toBe(2);
    expect(seven.every((group) => group.length >= 3)).toBe(true);
  });

  it("keeps an article with its noun where there is a readable alternative", () => {
    const groups = groupCaptionWords(
      spoken("Now you can create a beautiful story with captions"),
      30,
    );
    expect(groups.length).toBeGreaterThan(1);
    expect(
      groups
        .slice(0, -1)
        .every((group) => !["a", "with"].includes(group.at(-1)!.text)),
    ).toBe(true);
  });

  it("separates long pauses and retains phrase-level imported timing", () => {
    const words = [
      ...spoken("A clear message."),
      { text: "A whole subtitle\nwith authored lines.", start: 3, end: 5 },
      { text: "Done.", start: 6, end: 7 },
    ];
    const groups = groupCaptionWords(words, 30);
    expect(groups).toHaveLength(3);
    expect(groups[1]).toEqual([words[3]]);
    expect(groups[2]).toEqual([words[4]]);
  });

  it("preserves every original fractional timestamp at safe frame boundaries", () => {
    const p = newProject();
    const words = Array.from({ length: 25 }, (_, i) => ({
      text: `word${i}`,
      start: 0.011 + i * 0.123,
      end: 0.091 + i * 0.123,
    }));
    const before = structuredClone(words),
      clips = buildCaptionClips(p, words, {
        startFrame: 171,
        maxDurationFrames: 120,
      });
    expect(clips.length).toBeGreaterThan(1);
    const actual = clips.flatMap((clip) =>
      clip.words.map((word) => ({
        ...word,
        start: word.start + (clip.start - 171) / p.fps,
        end: word.end + (clip.start - 171) / p.fps,
      })),
    );
    expect(actual).toHaveLength(words.length);
    actual.forEach((word, i) => {
      expect(word.text).toBe(words[i].text);
      expect(word.start).toBeCloseTo(words[i].start, 12);
      expect(word.end).toBeCloseTo(words[i].end, 12);
    });
    clips.forEach((clip, i) => {
      expect(clip.start + clip.duration).toBeLessThanOrEqual(291);
      if (i + 1 < clips.length)
        expect(clip.start + clip.duration).toBeLessThanOrEqual(
          clips[i + 1].start,
        );
      clip.words.forEach((word) => {
        expect(word.start).toBeGreaterThanOrEqual(0);
        expect(word.end).toBeLessThanOrEqual(clip.duration / p.fps);
      });
    });
    expect(words).toEqual(before);
  });

  it.each([24, 25, 30, 60] as const)(
    "keeps actual contiguous Whisper speech readable at %s fps without losing words",
    (fps) => {
      const p = newProject();
      p.fps = fps;
      // Captured from the real local speech pipeline that previously collapsed
      // into a lone "A" cue and one 33-word cue because its timestamps touch.
      const text =
        "A better morning starts with freshly roasted coffee. Grind the beans just before brewing. Then take your cup outside and enjoy a quiet ocean view. Small routines can change the way your day feels.".split(
          " ",
        );
      const boundaries = [
        0, 0.3, 0.46, 0.93, 1.37, 1.61, 2.07, 2.54, 3.34, 3.74, 3.93, 4.29,
        4.63, 5.03, 5.64, 5.94, 6.12, 6.36, 6.54, 7.01, 7.27, 7.73, 7.81, 8.29,
        9.11, 9.42, 9.82, 10.49, 10.71, 11.19, 11.43, 11.67, 11.99, 12.63,
        12.92,
      ];
      const words = text.map((text, index) => ({
        text,
        start: boundaries[index],
        end: boundaries[index + 1],
      }));
      const before = structuredClone(words);
      const clips = buildCaptionClips(p, words, {
        maxDurationFrames: Math.ceil(13 * fps),
      });
      expect(clips.length).toBeGreaterThan(6);
      expect(
        clips.every((clip) => clip.words.length >= 2 && clip.words.length <= 7),
      ).toBe(true);
      expect(clips.every((clip) => clip.duration / fps < 3.5)).toBe(true);
      expect(
        clips.flatMap((clip) => clip.words.map((word) => word.text)),
      ).toEqual(text);
      const actual = clips.flatMap((clip) =>
        clip.words.map((word) => ({
          ...word,
          start: clip.start / fps + word.start,
          end: clip.start / fps + word.end,
        })),
      );
      actual.forEach((word, i) => {
        expect(Math.abs(word.start - words[i].start)).toBeLessThan(
          1 / fps + 1e-9,
        );
        expect(Math.abs(word.end - words[i].end)).toBeLessThan(1 / fps + 1e-9);
        expect(word.end).toBeGreaterThan(word.start);
      });
      clips.forEach((clip, index) => {
        expect(
          clip.words.every(
            (word) =>
              word.start >= 0 &&
              word.end <= clip.duration / fps &&
              word.end > word.start,
          ),
        ).toBe(true);
        if (index + 1 < clips.length)
          expect(clip.start + clip.duration).toBeLessThanOrEqual(
            clips[index + 1].start,
          );
      });
      expect(words).toEqual(before);
    },
  );

  it("keeps sub-frame words when no distinct caption boundary can display both sides", () => {
    const p = newProject();
    const words = Array.from({ length: 12 }, (_, index) => ({
      text: `word${index}`,
      start: 0.005 + index * 0.001,
      end: 0.006 + index * 0.001,
    }));
    const clips = buildCaptionClips(p, words);
    expect(
      clips.flatMap((clip) => clip.words.map((word) => word.text)),
    ).toEqual(words.map((word) => word.text));
    expect(
      clips.every((clip) => clip.words.every((word) => word.end > word.start)),
    ).toBe(true);
  });

  it("keeps overlapping words together instead of deleting their timing", () => {
    const words = [
      { text: "First", start: 0, end: 0.45 },
      { text: "second", start: 0.3, end: 0.7 },
      { text: "third", start: 0.5, end: 1.1 },
    ];
    const clips = captionClips(newProject(), words);
    expect(clips).toHaveLength(1);
    expect(clips[0].words).toEqual(words);
  });

  it("holds a short cue into available silence without extending its word highlight", () => {
    const p = newProject(),
      words = [
        { text: "Yes.", start: 0, end: 0.2 },
        { text: "Here we go.", start: 2, end: 3 },
      ];
    const clips = buildCaptionClips(p, words, { maxDurationFrames: 120 });
    expect(clips[0].duration).toBeGreaterThan(6);
    expect(clips[0].words).toEqual([words[0]]);
    expect(clips[0].duration).toBeLessThanOrEqual(clips[1].start);
    expect(captionClips(p, [words[0]])[0].duration).toBe(6);
    expect(captionClips(p, [words[0]], 0, 7)[0].duration).toBe(7);
  });

  it("drops unusable input and clips only at explicit media selection boundaries", () => {
    const p = newProject(),
      words = [
        { text: " ", start: 0, end: 0.3 },
        { text: "NaN", start: NaN, end: 1 },
        { text: "backward", start: 2, end: 1 },
        { text: "partial", start: -0.2, end: 0.2 },
        { text: "edge", start: 0.8, end: 1.5 },
        { text: "outside", start: 2, end: 3 },
      ];
    const clips = captionClips(p, words, 0, 30);
    expect(
      clips.flatMap((clip) => clip.words.map((word) => word.text)),
    ).toEqual(["partial", "edge"]);
    expect(clips.at(-1)!.start + clips.at(-1)!.duration).toBeLessThanOrEqual(
      30,
    );
    expect(captionClips(p, [])).toEqual([]);
    expect(captionClips(p, words, 0, 0)).toEqual([]);
  });

  it("uses the same phrases and source association in accelerated Reel captions", () => {
    const p = newProject();
    const words = spoken("Make this simple. Then share it.").map((word) => ({
      ...word,
      start: 4 + word.start * 2,
      end: 4 + word.end * 2,
    }));
    const asset = {
      id: "voice",
      name: "Voice",
      kind: "video" as const,
      path: "/local/voice.mp4",
      duration: 20,
      hasAudio: true,
      words,
    };
    const footage = {
      ...makeClip(p, "video", "video", 150, asset),
      sourceIn: 4,
      speed: 2,
      duration: 90,
    };
    const generated = reelCaptionClips(p, asset, footage, "captions", "bold");
    const direct = buildCaptionClips(
      p,
      spoken("Make this simple. Then share it."),
      { startFrame: 150, maxDurationFrames: 90 },
    );
    expect(generated.map((clip) => clip.text)).toEqual(
      direct.map((clip) => clip.text),
    );
    expect(
      generated.every(
        (clip) =>
          clip.captionSourceId === footage.id &&
          clip.captionStyle === "pop" &&
          clip.captionLayout === "balanced",
      ),
    ).toBe(true);
    expect(generated[0].text).toBe("Make this simple.");
    expect(generated[0].captionCase).toBe("upper");
  });
});

describe("Caption presets and compatible documents", () => {
  it("loads old captions without changing legacy appearance, text or geometry", () => {
    const p = newProject(),
      clip = {
        ...makeClip(p, "caption", "captions", 90),
        text: "Keep my\nline breaks",
        fontSize: 49,
        x: 41,
        y: 980,
      } as Record<string, unknown>;
    for (const field of [
      "captionLayout",
      "captionCase",
      "captionMaxLines",
      "captionStrokeWidth",
      "captionTracking",
      "captionSourceId",
    ])
      delete clip[field];
    const restored = ProjectSchema.parse({ ...p, clips: [clip] }).clips[0];
    expect(restored).toMatchObject({
      captionLayout: "legacy",
      captionCase: "original",
      captionMaxLines: 2,
      captionStrokeWidth: 2,
      captionTracking: 0,
      text: "Keep my\nline breaks",
      fontSize: 49,
      x: 41,
      y: 980,
    });
    expect(restored.captionSourceId).toBeUndefined();
    expect(parseSrt(toSrt([restored], 30))[0].text).toBe(
      "Keep my\nline breaks",
    );
  });

  it("scales all eleven complete presets while preserving a custom clip position and content", () => {
    const p = newProject(),
      c = {
        ...makeClip(p, "caption", "captions", 64),
        x: 73,
        y: 211,
        text: "My words",
        words: spoken("My words"),
      };
    expect(captionStyles).toHaveLength(11);
    expect(new Set(captionStyles.map((style) => style.id)).size).toBe(11);
    for (const style of captionStyles) {
      const full = captionStylePatch(style.id, { width: 1080, height: 1920 });
      const half = captionStylePatch(style.id, { width: 540, height: 960 });
      const patched = ClipSchema.parse({ ...c, ...half });
      expect(patched).toMatchObject({
        captionLayout: "balanced",
        captionStyle: style.id,
        x: 73,
        y: 211,
        start: 64,
        text: "My words",
        words: c.words,
      });
      expect(half.fontSize).toBe(Math.round(full.fontSize! / 2));
      expect(half.captionStrokeWidth).toBeCloseTo(full.captionStrokeWidth! / 2);
    }
    const placement = captionPlacement({ width: 1080, height: 1920 });
    expect(placement.x + placement.width / 2).toBe(1080 / 2);
    expect(placement.x).toBe(1080 - placement.x - placement.width);
    expect(placement.y + placement.height).toBeLessThan(1920 * 0.9);
  });

  it("validates editing bounds and rejects nonfinite stroke or spacing", () => {
    const c = makeClip(newProject(), "caption", "captions", 0);
    for (const patch of [
      { captionLayout: "unknown" },
      { captionCase: "title" },
      { captionMaxLines: 3 },
      { captionStrokeWidth: 13 },
      { captionStrokeWidth: NaN },
      { captionTracking: -6 },
      { captionTracking: Infinity },
    ])
      expect(ClipSchema.safeParse({ ...c, ...patch }).success).toBe(false);
  });
});

describe("Subtitle file import", () => {
  // Cues meet at 2.033 s and 3.517 s, which fall between frames at every rate.
  const srt = [
    "1\n00:00:01,000 --> 00:00:02,033\nThe first line\n",
    "2\n00:00:02,033 --> 00:00:03,517\nmeets the second\n",
    "3\n00:00:03,517 --> 00:00:05,250\nYes\n",
    "4\n00:00:05,250 --> 00:00:05,600\nno\n",
    "5\n00:00:07,000 --> 00:00:08,000\nDone\n",
  ].join("\n");

  it.each([24, 25, 30, 60] as const)(
    "keeps every cue as one caption with no frame showing two at %i fps",
    (fps) => {
      const p = { ...newProject(), fps };
      const clips = srtCaptionClips(p, srt);
      expect(clips.map((clip) => clip.text)).toEqual([
        "The first line",
        "meets the second",
        "Yes",
        "no",
        "Done",
      ]);
      // Back-to-back cues share one frame boundary.
      for (let i = 1; i < 4; i++)
        expect(clips[i].start).toBe(
          clips[i - 1].start + clips[i - 1].duration,
        );
      // A short cue before a gap ends where its author ended it.
      expect(clips[3].start + clips[3].duration).toBe(Math.ceil(5.6 * fps));
    },
  );

  it("times a file the same in the app and for an agent's caption.import", () => {
    const p = newProject();
    const imported = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Import subtitles",
      actions: [{ type: "caption.import", srt, at: { frame: 30 } }],
    }).project.clips;
    const app = srtCaptionClips(p, srt, 30);
    expect(imported.map(({ start, duration, text }) => [start, duration, text])).toEqual(
      app.map(({ start, duration, text }) => [start, duration, text]),
    );
    expect(app.map((clip) => [clip.start, clip.duration])).toEqual([
      [60, 31],
      [91, 45],
      [136, 52],
      [188, 10],
      [240, 30],
    ]);
  });
});

describe("Readable subtitle exchange", () => {
  it("preserves authored SRT lines, Unicode, BOMs and tag-free text", () => {
    const cue = parseSrt(
      "\uFEFF1\r\n00:00:01,020 --> 00:00:03,250\r\n<i>Café 世界</i>\r\nSecond line\r\n",
    )[0];
    expect(cue).toEqual({
      text: "Café 世界\nSecond line",
      start: 1.02,
      end: 3.25,
    });
    expect(
      parseSrt("1\n00:00:00,000 --> 00:00:01,000\nOne<br>two")[0].text,
    ).toBe("One\ntwo");
    expect(() => parseSrt("1\n00:61:00,000 --> 01:02:00,000\nInvalid")).toThrow(
      "timestamp",
    );
  });

  it("exports balanced case and line breaks exactly as rendered without changing spoken word text", () => {
    const p = newProject(),
      c = {
        ...captionClips(
          p,
          spoken("Read these beautiful words together now"),
        )[0],
        ...captionStylePatch("pop", p),
        width: 360,
      };
    const before = structuredClone(c.words),
      expected = captionLayout(c)
        .lines.map((line) => line.text)
        .join("\n");
    const parsed = parseSrt(toSrt([c], p.fps))[0];
    expect(parsed.text).toBe(expected);
    expect(parsed.text).toBe(parsed.text.toUpperCase());
    expect(parsed.text.split("\n")).toHaveLength(2);
    expect(c.words).toEqual(before);
    expect(parsed.start).toBe(c.start / p.fps);
    expect(parsed.end).toBeCloseTo((c.start + c.duration) / p.fps, 3);
  });

  it("retains full phrase text for Focus captions instead of exporting only the active word", () => {
    const p = newProject(),
      c = {
        ...captionClips(p, spoken("Every word belongs here"))[0],
        ...captionStylePatch("focus", p),
      };
    expect(parseSrt(toSrt([c], p.fps))[0].text.replace(/\n/g, " ")).toBe(
      "EVERY WORD BELONGS HERE",
    );
  });
});
