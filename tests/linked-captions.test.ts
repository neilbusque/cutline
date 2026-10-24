import { describe, expect, it } from "vitest";
import {
  makeClip,
  newProject,
  validateProject,
  type Project,
} from "../src/shared/model";
import { linkedCaptionCommands } from "../src/shared/linked-captions";
import { applyAgentEdit } from "../src/shared/agent-edit";
import { toSrt } from "../src/shared/subtitles";

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

  it("removes a caption whose words a trim leaves out, so no blank cue is exported", () => {
    // 30 fps: "Hey you" is spoken in frames 0 to 15 of a cue that ends at 19.
    const p = newProject();
    p.assets = [
      {
        id: "talk",
        name: "Talk",
        kind: "video",
        path: "/local/talk.mp4",
        duration: 20,
        hasAudio: true,
      },
    ];
    const video = {
      ...makeClip(p, "video", "video", 0, p.assets[0]),
      id: "v",
      duration: 300,
    };
    const spoken = {
      ...makeClip(p, "caption", "captions", 0),
      id: "early",
      duration: 19,
      captionSourceId: "v",
      text: "Hey you",
      words: [
        { text: "Hey", start: 0, end: 0.25 },
        { text: "you", start: 0.27, end: 0.5 },
      ],
    };
    const later = {
      ...makeClip(p, "caption", "captions", 19),
      id: "later",
      duration: 40,
      captionSourceId: "v",
      text: "over here",
      words: [
        { text: "over", start: 0.1, end: 0.6 },
        { text: "here", start: 0.7, end: 1.2 },
      ],
    };
    p.clips = [video, spoken, later];
    const commands = linkedCaptionCommands(
      p,
      video,
      { start: 16, duration: 284 },
      "trim",
    );
    expect(commands).toEqual([
      { type: "clip.delete", id: "early", ripple: false },
    ]);
    // The agent's clip.trim follows the same rule.
    const trimmed = applyAgentEdit(validateProject(p), {
      projectId: p.id,
      revision: p.revision,
      label: "Trim head",
      actions: [{ type: "clip.trim", clipId: "v", start: { frame: 16 } }],
    }).project;
    expect(trimmed.clips.map((c) => c.id)).toEqual(["v", "later"]);
    // An empty caption never becomes an empty subtitle cue.
    expect(
      toSrt(
        [{ ...spoken, text: " ", words: [] }, later],
        p.fps,
      ),
    ).toBe("1\n00:00:00,633 --> 00:00:01,967\nover here\n");
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
