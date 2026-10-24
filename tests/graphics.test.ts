import { describe, expect, it, vi } from "vitest";
import {
  generateGraphic,
  pictureRequest,
  placePicture,
  type PictureResult,
} from "../src/shared/graphics";
import { newProject, type Asset } from "../src/shared/model";

const good =
  '<svg viewBox="0 0 512 512"><path id="cup" d="M100 200H400V400H100Z" fill="#c0703a"/></svg>';
const better =
  '<svg viewBox="0 0 512 512"><path id="cup" d="M120 200H392V400H120Z" fill="#c0703a"/><path id="handle" d="M392 250H440V330H392Z" fill="#c0703a"/></svg>';
const picture: PictureResult = {
  file: "/tmp/picture.png",
  width: 900,
  height: 700,
  cutout: true,
  usd: "0.04",
};

/** A scripted assistant: replies in order, recording whether it saw an image. */
function assistant(...replies: string[]) {
  const calls: { system: string; prompt: string; image: boolean }[] = [];
  const ask = vi.fn(async (system: string, prompt: string, image?: Uint8Array) => {
    calls.push({ system, prompt, image: !!image });
    const reply = replies.shift();
    if (reply === undefined) throw Error("No more replies");
    return reply;
  });
  return { ask, calls };
}
const render = async () => new Uint8Array([137, 80, 78, 71]);

describe("making a graphic", () => {
  it("draws a vector, shows the assistant its render, and keeps a good drawing", async () => {
    const { ask, calls } = assistant(good, "<ok/>");
    const made = await generateGraphic({ prompt: "a coffee cup" }, { ask, render });
    expect(made).toMatchObject({ kind: "vector", svg: good, layers: 1, attempts: 2 });
    expect(calls[0].image).toBe(false);
    expect(calls[1].image).toBe(true);
    expect(calls[1].prompt).toContain("a coffee cup");
    expect(calls[1].prompt).toContain(good);
  });

  it("uses the review's corrected drawing", async () => {
    const { ask } = assistant(good, "Fixed:\n" + better);
    const made = await generateGraphic({ prompt: "a coffee cup" }, { ask, render });
    expect(made).toMatchObject({ kind: "vector", svg: better, layers: 2, revised: true });
  });

  it("keeps the first drawing when the review fails or returns nothing usable", async () => {
    const failing = assistant(good);
    expect(
      await generateGraphic({ prompt: "a cup" }, { ask: failing.ask, render }),
    ).toMatchObject({ kind: "vector", svg: good });
    const broken = assistant(good, "<svg><text>oops</text></svg>");
    expect(
      await generateGraphic({ prompt: "a cup" }, { ask: broken.ask, render }),
    ).toMatchObject({ kind: "vector", svg: good });
  });

  it("only offers to decline when a picture can take over", async () => {
    const off = assistant(good, "<ok/>");
    await generateGraphic({ prompt: "a cup" }, { ask: off.ask, render });
    expect(off.calls[0].system).not.toContain("<too-detailed/>");
    const on = assistant(good, "<ok/>");
    await generateGraphic(
      { prompt: "a cup" },
      { ask: on.ask, render, picture: async () => picture },
    );
    expect(on.calls[0].system).toContain("<too-detailed/>");
  });

  it("turns a declined drawing into a Higgsfield picture", async () => {
    const { ask } = assistant("<too-detailed/>");
    const make = vi.fn(async () => picture);
    const steps: string[] = [];
    const made = await generateGraphic(
      { prompt: "a sunset city skyline reflected in a river", aspect: "wide" },
      { ask, render, picture: make, onStep: (step) => steps.push(step) },
    );
    expect(made).toMatchObject({ kind: "picture", reason: "too-detailed", file: picture.file });
    expect(make).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a sunset city skyline reflected in a river", aspect: "wide" }),
    );
    expect(steps).toEqual(["drawing", "picture"]);
  });

  it("makes a picture when the review finds the subject too detailed", async () => {
    const { ask } = assistant(good, "<too-detailed/>");
    const made = await generateGraphic(
      { prompt: "a crowded market" },
      { ask, render, picture: async () => picture },
    );
    expect(made).toMatchObject({ kind: "picture", reason: "too-detailed" });
  });

  it("makes a picture when the vector would lose detail on import", async () => {
    const shapes = Array.from(
      { length: 70 },
      (_, i) =>
        `<rect x="${i * 7}" y="${(i * 13) % 500}" width="5" height="5" fill="${["#e4572e", "#29335c", "#f3a712"][Math.floor(i / 24)]}"/>`,
    ).join("");
    const crowded = `<svg viewBox="0 0 512 512">${shapes}</svg>`;
    const { ask } = assistant(crowded, crowded);
    const made = await generateGraphic(
      { prompt: "a field of confetti" },
      { ask, render, picture: async () => picture },
    );
    expect(made).toMatchObject({ kind: "picture", reason: "lost-detail" });
    // A reply the importer cannot use at all also becomes a picture.
    const unique = crowded.replace(/fill="[^"]+"/gu, (_, at: number) => `fill="#${(0x100000 + at * 997).toString(16).slice(-6)}"`);
    const again = assistant(unique, unique);
    expect(
      await generateGraphic(
        { prompt: "a field of confetti" },
        { ask: again.ask, render, picture: async () => picture },
      ),
    ).toMatchObject({ kind: "picture", reason: "unusable" });
  });

  it("lets the review's score send weak drawings and middling scenes to Higgsfield", async () => {
    const make = vi.fn(async () => picture);
    const weak = assistant(good, "<score>2</score>\n" + better);
    expect(
      await generateGraphic({ prompt: "a cup" }, { ask: weak.ask, render, picture: make }),
    ).toMatchObject({ kind: "picture", reason: "too-detailed", drawing: { svg: good, layers: 1 } });
    const scene = assistant(good, "<score>3</score>\n<ok/>");
    expect(
      await generateGraphic(
        { prompt: "a city skyline at sunset with reflections in the river" },
        { ask: scene.ask, render, picture: make },
      ),
    ).toMatchObject({ kind: "picture", reason: "too-detailed" });
    // A plain subject at 3 is fixed in place, not paid for.
    const plain = assistant(good, "<score>3</score>\n" + better);
    expect(
      await generateGraphic({ prompt: "a cup" }, { ask: plain.ask, render, picture: make }),
    ).toMatchObject({ kind: "vector", svg: better, score: 3, revised: true });
    expect(make).toHaveBeenCalledTimes(2);
  });

  it("notes when a weak drawing could have been a picture", async () => {
    const { ask } = assistant(good, "<score>2</score><ok/>");
    expect(
      await generateGraphic(
        { prompt: "a cup" },
        { ask, render, pictureUnavailable: "Connect Higgsfield in Settings." },
      ),
    ).toMatchObject({ kind: "vector", score: 2, note: "Connect Higgsfield in Settings." });
  });

  it("goes straight to Higgsfield when a picture is asked for", async () => {
    const { ask } = assistant();
    const made = await generateGraphic(
      { prompt: "a cup", route: "picture" },
      { ask, picture: async () => picture },
    );
    expect(made).toMatchObject({ kind: "picture", reason: "asked" });
    expect(ask).not.toHaveBeenCalled();
    await expect(
      generateGraphic(
        { prompt: "a cup", route: "picture" },
        { ask, pictureUnavailable: "Connect Higgsfield in Settings." },
      ),
    ).rejects.toThrow("Connect Higgsfield in Settings.");
  });

  it("never pays for a picture when the vector route is chosen", async () => {
    const { ask } = assistant("<too-detailed/>", good, "<ok/>");
    const make = vi.fn(async () => picture);
    const made = await generateGraphic(
      { prompt: "a cup", route: "vector" },
      { ask, render, picture: make },
    );
    expect(make).not.toHaveBeenCalled();
    expect(made.kind).toBe("vector");
  });

  it("stops at once when cancelled", async () => {
    const ask = vi.fn(async () => {
      throw Error("Cancelled");
    });
    const make = vi.fn(async () => picture);
    await expect(
      generateGraphic({ prompt: "a cup" }, { ask, render, picture: make }),
    ).rejects.toThrow("Cancelled");
    expect(make).not.toHaveBeenCalled();
  });
});

describe("Higgsfield picture requests", () => {
  it("asks Recraft for one subject on a flat backdrop it can remove", () => {
    const { endpoint, body, backdrop } = pictureRequest({
      prompt: "a friendly green monster eating stickers.",
      style: "flat",
      aspect: "tall",
      palette: ["#112233"],
      onto: "near-black video",
    });
    expect(endpoint).toBe("recraft/v4.1/text-to-image");
    expect(backdrop.name).toBe("magenta");
    expect(body).toEqual({
      prompt: expect.stringContaining("a friendly green monster eating stickers"),
      resolution: "1k",
      aspect_ratio: "9:16",
      output_format: "png",
      background_color: { rgb: [255, 0, 255] },
      colors: [{ rgb: [17, 34, 51] }],
    });
    expect(body.prompt).toContain("plain flat solid magenta (#ff00ff) background");
    expect(body.prompt).toContain("stand out on near-black video");
    expect(body.prompt).not.toContain("stickers..");
  });
});

describe("placing a picture", () => {
  const asset: Asset = {
    id: "pic",
    name: "Monster",
    path: "/tmp/monster.png",
    kind: "image",
    duration: 0,
    width: 800,
    height: 600,
    hasAudio: false,
  } as Asset;

  it("centers it above the captions on a tall frame, on a Graphics track", () => {
    const p = { ...newProject(), width: 1080, height: 1920, fps: 30 as const, assets: [asset] };
    const placed = placePicture(p, 45, asset);
    expect(placed.track.name).toBe("Graphics");
    expect(placed.commands[0]).toMatchObject({ type: "track.add" });
    expect(placed.clip).toMatchObject({ start: 45, duration: 120, fit: "contain" });
    expect(placed.clip.x + placed.clip.width / 2).toBeCloseTo(540, 0);
    expect(placed.clip.y + placed.clip.height / 2).toBeCloseTo(1920 * 0.4, 0);
    expect(placed.clip.width / placed.clip.height).toBeCloseTo(800 / 600, 1);
  });

  it("reuses a free Graphics track", () => {
    const base = { ...newProject(), assets: [asset] };
    const first = placePicture(base, 0, asset);
    const withTrack = {
      ...base,
      tracks: [first.track, ...base.tracks],
      clips: [...base.clips, first.clip],
    };
    expect(placePicture(withTrack, 0, asset).commands[0].type).toBe("track.add");
    expect(placePicture(withTrack, 500, asset).commands).toHaveLength(1);
  });
});
