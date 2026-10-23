import { describe, it, expect } from "vitest";
import {
  newProject,
  makeClip,
  validateProject,
  ClipSchema,
} from "../src/shared/model";
import { applyCommands } from "../src/shared/commands";
import {
  filterFor,
  cameraTransform,
  textAnimations,
} from "../src/shared/effects";
import { stockUrl, plain } from "../src/main/stock";
const clip = () => makeClip(newProject(), "text", "titles");
describe("effects and project compatibility", () => {
  it("loads previous project clips with neutral effect defaults", () => {
    const c: any = clip();
    delete c.look;
    delete c.cameraMotion;
    delete c.animationFrames;
    expect(ClipSchema.parse(c)).toMatchObject({
      look: "none",
      cameraMotion: "none",
      animationFrames: 18,
    });
  });
  it("zero strength produces a neutral look", () => {
    const c = { ...clip(), look: "vintage" as const, effectAmount: 0 };
    expect(filterFor(c)).toBe(filterFor({ ...c, look: "none" }));
  });
  it("camera motion reaches deterministic endpoints and clamps out of range", () => {
    // Six seconds or more earn the full move.
    const c = { ...clip(), cameraMotion: "zoom-in" as const, duration: 181 };
    expect(cameraTransform(c, 0)).toBe("scale(1)");
    expect(cameraTransform(c, 180)).toBe("scale(1.18)");
    expect(cameraTransform(c, 300)).toBe("scale(1.18)");
    // A one-second shot drifts about 3% instead of lunging 18%.
    const short = { ...c, duration: 31 };
    expect(cameraTransform(short, 30)).toBe(`scale(${1 + 0.18 * (31 / 30 / 6)})`);
    expect(cameraTransform(short, 300)).toBe(cameraTransform(short, 30));
  });
  it("all exposed text presets validate", () => {
    for (const a of textAnimations)
      expect(() =>
        ClipSchema.parse({ ...clip(), preset: a.preset }),
      ).not.toThrow();
  });
  it("effect updates preserve geometry and other effect values", () => {
    const p = newProject();
    p.clips = [{ ...clip(), look: "warm", brightness: 1.2, x: 42 }];
    const next = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "effect",
      commands: [
        { type: "clip.update", id: p.clips[0].id, patch: { vignette: 0.4 } },
      ],
    });
    expect(next.clips[0]).toMatchObject({
      x: 42,
      look: "warm",
      brightness: 1.2,
      vignette: 0.4,
    });
  });
  it("places B-roll above video but below titles and captions", () => {
    const p = newProject();
    const next = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "broll",
      commands: [
        {
          type: "track.add",
          track: {
            id: "broll",
            name: "B-roll",
            kind: "video",
            muted: false,
            hidden: false,
          },
        },
      ],
    });
    expect(next.tracks.map((t) => t.id)).toEqual([
      "titles",
      "captions",
      "broll",
      "video",
      "audio",
    ]);
  });
  it("rejects unsupported effects and non-finite parameters", () => {
    expect(() =>
      validateProject({
        ...newProject(),
        clips: [{ ...clip(), blur: Infinity }],
      }),
    ).toThrow();
    expect(() => ClipSchema.parse({ ...clip(), look: "unknown" })).toThrow();
  });
});
describe("stock source boundaries", () => {
  it("only accepts HTTPS Wikimedia media URLs", () => {
    expect(
      stockUrl("https://upload.wikimedia.org/wikipedia/commons/a.webm"),
    ).toContain("upload.wikimedia.org");
    for (const u of [
      "http://upload.wikimedia.org/a",
      "https://upload.wikimedia.org.evil.test/a",
      "https://user:pass@upload.wikimedia.org/a",
      "https://127.0.0.1/a",
      "file:///tmp/a",
      "https://upload.wikimedia.org:8080/a",
    ])
      expect(() => stockUrl(u)).toThrow();
  });
  it("separates source-page links from download URLs", () => {
    expect(
      stockUrl("https://commons.wikimedia.org/wiki/File:Example.webm", "page"),
    ).toContain("/wiki/");
    expect(() => stockUrl("https://example.com", "page")).toThrow();
  });
  it("displays creator metadata as plain text", () => {
    expect(plain('<a href="javascript:evil()">Alice &amp; Bob</a>')).toBe(
      "Alice & Bob",
    );
  });
});
