import { describe, expect, it } from "vitest";
import {
  makeClip,
  newProject,
  validateProject,
  type Asset,
  type Project,
} from "../src/shared/model";
import { evaluatedClip } from "../src/shared/animation";
import { evaluatedMotionLayer } from "../src/shared/motion";
import { filterFor, lookStrength, videoLooks } from "../src/shared/effects";
import {
  buildStyleReel,
  STYLE_TRACKS,
  type StyleBeat,
  type StyleEntrance,
} from "../src/shared/style-reel";

function fixture(): Project {
  const project = { ...newProject(), width: 1080, height: 1920 };
  const speaker: Asset = {
    id: "speaker",
    name: "Continuous original voice",
    kind: "video",
    path: "/tmp/speaker.mp4",
    duration: 12,
    width: 1080,
    height: 1920,
    hasAudio: true,
  };
  const image: Asset = {
    id: "screen",
    name: "Screen evidence",
    kind: "image",
    path: "/tmp/screen.png",
    duration: 0,
    width: 1920,
    height: 1080,
    hasAudio: false,
  };
  const proof: Asset = {
    id: "proof",
    name: "Moving proof",
    kind: "video",
    path: "/tmp/proof.mp4",
    duration: 5,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
  project.assets = [speaker, image, proof];
  project.clips = [
    {
      ...makeClip(
        project,
        "video",
        project.tracks.find((track) => track.kind === "video")!.id,
        0,
        speaker,
      ),
      duration: 360,
    },
  ];
  return project;
}
const assetBeat = (entrance: StyleEntrance): StyleBeat => ({
  from: 0,
  to: 2,
  layout: "full",
  entrance,
  backdrop: "plain",
  background: "#102030",
  visual: { kind: "asset", assetId: "screen" },
});

function assertVoiceContinuity(project: Project) {
  for (let frame = 0; frame < 360; frame++) {
    const audible = project.clips.filter(
      (clip) =>
        clip.assetId === "speaker" &&
        clip.volume > 0 &&
        !project.tracks.find((track) => track.id === clip.trackId)?.muted &&
        clip.start <= frame &&
        clip.start + clip.duration > frame,
    );
    expect(audible, `one original voice at frame ${frame}`).toHaveLength(1);
    const clip = audible[0];
    expect(
      clip.sourceIn + ((frame - clip.start) / project.fps) * clip.speed,
    ).toBeCloseTo(frame / project.fps, 8);
  }
  expect(
    project.clips
      .filter((clip) => clip.assetId === "proof")
      .every((clip) => clip.volume === 0),
  ).toBe(true);
}

describe("authored motion direction", () => {
  it("an explicit cut remains present from frame zero without implicit ripple or still drift", () => {
    for (const style of ["split", "cards"] as const) {
      const { project } = buildStyleReel(fixture(), {
        style,
        beats: [assetBeat("cut")],
      });
      const screen = project.clips.find((clip) => clip.assetId === "screen")!;
      expect(screen.keyframes).toEqual([]);
      expect(evaluatedClip(screen, 0).opacity).toBe(1);
      expect(
        project.motions.some((motion) => motion.name === "Ring ripple"),
      ).toBe(false);
    }
  });

  it.each(["fade", "rise", "slide-left", "pop"] as const)(
    "%s yields native editable clip keys and settles inside the beat",
    (entrance) => {
      const { project } = buildStyleReel(fixture(), {
        style: "cards",
        beats: [assetBeat(entrance)],
      });
      const screen = project.clips.find((clip) => clip.assetId === "screen")!;
      expect(evaluatedClip(screen, 0).opacity).toBe(0);
      expect(evaluatedClip(screen, screen.duration - 1)).toMatchObject({
        opacity: 1,
        scale: 1,
      });
      expect(
        screen.keyframes.every(
          (key) => key.frame >= 0 && key.frame < screen.duration,
        ),
      ).toBe(true);
      if (entrance === "rise")
        expect(evaluatedClip(screen, 0).y).toBeGreaterThan(screen.y);
      if (entrance === "slide-left")
        expect(evaluatedClip(screen, 0).x).toBeGreaterThan(screen.x);
      if (entrance === "pop")
        expect(
          screen.keyframes.some(
            (key) => key.property === "scale" && key.value > 1,
          ),
        ).toBe(true);
    },
  );

  it("authors text movement as native motion layers and honors an intentional ripple", () => {
    const { project } = buildStyleReel(fixture(), {
      style: "split",
      beats: [
        {
          from: 0,
          to: 2,
          entrance: "rise",
          emphasis: "ripple",
          visual: { kind: "text", text: "Show the result" },
        },
      ],
    });
    const line = project.motions
      .find((motion) => motion.name === "Beat line")!
      .layers.find((layer) => layer.type === "text")!;
    expect(evaluatedMotionLayer(line, 0).y).toBeGreaterThan(line.y);
    expect(evaluatedMotionLayer(line, 59)).toMatchObject({
      x: line.x,
      y: line.y,
      opacity: 1,
      scale: 1,
    });
    expect(
      project.motions.filter((motion) => motion.name === "Ring ripple"),
    ).toHaveLength(1);
  });

  it("retains legacy pop, sunburst and ripple when authoring options are omitted", () => {
    const { project } = buildStyleReel(fixture(), {
      style: "split",
      beats: [{ from: 0, to: 2, visual: { kind: "asset", assetId: "screen" } }],
    });
    expect(
      project.motions.some((motion) => motion.name === "Ring ripple"),
    ).toBe(true);
    expect(
      project.motions.some((motion) =>
        motion.layers.some((layer) => layer.name === "Sunburst"),
      ),
    ).toBe(true);
    expect(
      project.clips
        .find((clip) => clip.assetId === "screen")!
        .keyframes.some(
          (key) => key.property === "scale" && key.value === 0.85,
        ),
    ).toBe(true);
  });

  it("keeps changes of backdrop treatment and color at their authored boundaries", () => {
    const beats: StyleBeat[] = [
      {
        ...assetBeat("cut"),
        from: 0,
        to: 2,
        background: "#102030",
        backdrop: "plain",
      },
      {
        ...assetBeat("cut"),
        from: 2,
        to: 4,
        background: "#102030",
        backdrop: "grid",
      },
      {
        ...assetBeat("cut"),
        from: 4,
        to: 6,
        background: "#EEDDBB",
        backdrop: "grid",
      },
    ];
    const { project, summary } = buildStyleReel(fixture(), {
      style: "split",
      beats,
    });
    expect(summary.graphicWindows).toBe(3);
    const track = project.tracks.find(
      (item) => item.name === STYLE_TRACKS.backdrop,
    )!;
    const backdrops = project.clips
      .filter((clip) => clip.trackId === track.id)
      .sort((a, b) => a.start - b.start);
    expect(backdrops.map((clip) => [clip.start, clip.duration])).toEqual([
      [0, 60],
      [60, 60],
      [120, 60],
    ]);
    const motions = backdrops.map((clip) =>
      project.motions.find((motion) => motion.id === clip.motionId)!,
    );
    expect(
      motions.map(
        (motion) =>
          motion.layers.find((layer) => layer.name === "Backdrop")!.background,
      ),
    ).toEqual(["#102030", "#102030", "#EEDDBB"]);
    expect(motions[0].layers).toHaveLength(1);
    expect(motions[1].layers.some((layer) => layer.name === "Grid")).toBe(true);
  });

  it("preserves one continuous original voice across varied layouts and mutes proof sound", () => {
    const { project } = buildStyleReel(fixture(), {
      style: "split",
      beats: [
        { ...assetBeat("cut"), from: 0, to: 2, layout: "split" },
        {
          from: 2,
          to: 4,
          layout: "full",
          entrance: "fade",
          sourceIn: 1,
          visual: { kind: "asset", assetId: "proof" },
        },
        { from: 4, to: 5, layout: "face" },
        {
          from: 5,
          to: 8,
          layout: "full",
          entrance: "rise",
          visual: { kind: "text", text: "A visible payoff" },
        },
        { from: 8, to: 12, layout: "speaker" },
      ],
    });
    assertVoiceContinuity(project);
    expect(() => validateProject(project)).not.toThrow();
  });

  it("continues a selected proof passage and trims at the source end", () => {
    const { project, warnings } = buildStyleReel(fixture(), {
      style: "split",
      beats: [
        {
          from: 1,
          to: 5,
          entrance: "cut",
          framing: "contain",
          sourceIn: 3,
          visual: { kind: "asset", assetId: "proof" },
        },
      ],
    });
    expect(
      project.clips.find((clip) => clip.assetId === "proof"),
    ).toMatchObject({
      sourceIn: 3,
      start: 30,
      duration: 60,
      fit: "contain",
      mask: "none",
      volume: 0,
    });
    expect(
      warnings.some((warning) => /ends before the beat/u.test(warning)),
    ).toBe(true);
    assertVoiceContinuity(project);
  });

  it("skips a source passage beyond the proof instead of writing an invalid clip", () => {
    const { project, warnings } = buildStyleReel(fixture(), {
      style: "split",
      beats: [
        {
          from: 0,
          to: 2,
          sourceIn: 5,
          visual: { kind: "asset", assetId: "proof" },
        },
      ],
    });
    expect(project.clips.some((clip) => clip.assetId === "proof")).toBe(false);
    expect(
      warnings.some((warning) => /sourceIn is past its end/u.test(warning)),
    ).toBe(true);
  });

  it("flags four repeated compositions even when only the backdrop color changes", () => {
    const beats: StyleBeat[] = ["#112233", "#223344", "#334455", "#445566"].map(
      (background, index) => ({
        ...assetBeat("cut"),
        from: index * 2,
        to: (index + 1) * 2,
        background,
      }),
    );
    const { summary } = buildStyleReel(fixture(), { style: "split", beats });
    expect(summary.directionReview).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "repeated_composition",
          from: 0,
          to: 8,
        }),
      ]),
    );
    const locked = buildStyleReel(fixture(), { style: "locked-split", beats })
      .summary.directionReview;
    expect(locked.some((note) => note.code === "repeated_composition")).toBe(
      false,
    );
  });

  it("distinguishes a repeated source restart from a continuing source passage", () => {
    const beat: StyleBeat = {
      from: 0,
      to: 2,
      sourceIn: 0,
      visual: { kind: "asset", assetId: "proof" },
    };
    const restart = buildStyleReel(fixture(), {
      style: "split",
      beats: [beat, { ...beat, from: 2, to: 4 }],
    });
    expect(
      restart.summary.directionReview.some(
        (note) => note.code === "repeated_source",
      ),
    ).toBe(true);
    const continued = buildStyleReel(fixture(), {
      style: "split",
      beats: [beat, { ...beat, from: 2, to: 4, sourceIn: 2 }],
    });
    expect(
      continued.summary.directionReview.some(
        (note) => note.code === "repeated_source",
      ),
    ).toBe(false);
  });

  it.each(["studio", "soft-film", "crisp-mono"] as const)(
    "%s survives project validation and its strength remains adjustable to original",
    (look) => {
      const project = fixture();
      project.clips[0].look = look;
      project.clips[0].effectAmount = lookStrength(look);
      const clip = validateProject(project).clips[0];
      expect(videoLooks).toContain(look);
      expect(filterFor(clip)).not.toBe("none");
      expect(filterFor({ ...clip, effectAmount: 0 })).toBe("none");
    },
  );
});
