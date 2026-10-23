import { describe, expect, it } from "vitest";
import { makeClip, newProject, type Project } from "../src/shared/model";
import { linkedCaptionCommands } from "../src/shared/linked-captions";

const fake = (clips: object[]) => ({ clips }) as unknown as Project;

describe("linked captions follow manual moves and trims", () => {
  it("shifts linked captions by the move distance", () => {
    const p = fake([
      { id: "a", start: 40, duration: 20, captionSourceId: "v" },
      { id: "b", start: 80, duration: 20, captionSourceId: "v" },
      { id: "x", start: 40, duration: 20, captionSourceId: "other" },
    ]);
    expect(
      linkedCaptionCommands(
        p,
        { id: "v", start: 30, duration: 120 },
        { start: 60, duration: 120 },
        "move",
      ),
    ).toEqual([
      { type: "clip.update", id: "a", patch: { start: 70 } },
      { type: "clip.update", id: "b", patch: { start: 110 } },
    ]);
  });

  it("removes captions a trim leaves outside the clip", () => {
    const p = fake([
      { id: "a", start: 40, duration: 20, captionSourceId: "v" },
      { id: "b", start: 130, duration: 15, captionSourceId: "v" },
    ]);
    expect(
      linkedCaptionCommands(
        p,
        { id: "v", start: 30, duration: 120 },
        { start: 30, duration: 90 },
        "trim",
      ),
    ).toEqual([{ type: "clip.delete", id: "b", ripple: false }]);
  });

  it("cuts a caption that straddles the new edge to the clip", () => {
    const p = newProject();
    const text = p.tracks.find((t) => t.kind === "text")!;
    const caption = {
      ...makeClip(p, "caption", text.id, 100),
      id: "cap",
      duration: 40,
      captionSourceId: "v",
    };
    p.clips = [caption];
    const [command] = linkedCaptionCommands(
      p,
      { id: "v", start: 0, duration: 200 },
      { start: 0, duration: 120 },
      "trim",
    );
    expect(command.type).toBe("clip.update");
    if (command.type !== "clip.update") return;
    expect(command.patch.start).toBe(100);
    expect(command.patch.duration).toBe(20);
  });

  it("does nothing for clips without captions", () => {
    expect(
      linkedCaptionCommands(
        fake([]),
        { id: "v", start: 0, duration: 10 },
        { start: 5, duration: 10 },
        "move",
      ),
    ).toEqual([]);
  });
});
