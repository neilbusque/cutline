import { describe, expect, it } from "vitest";
import { applyCommands } from "../src/shared/commands";
import {
  duration,
  newProject,
  validateProject,
  type Project,
} from "../src/shared/model";
import {
  createMotionDemoProject,
  createMotionScene,
  createShapeLayer,
  motionSceneIds,
  shapeTypes,
} from "../src/shared/motion-presets";

function commit(p: Project, created: ReturnType<typeof createMotionScene>) {
  return applyCommands(p, {
    projectId: p.id,
    revision: p.revision,
    label: "Add motion",
    commands: created.commands,
  });
}

describe("editable motion library", () => {
  it("scales every scene to the smallest, largest, landscape and portrait project canvases", () => {
    for (const [width, height] of [
      [320, 320],
      [3840, 3840],
      [1920, 1080],
      [1080, 1920],
      [320, 3840],
      [3840, 320],
    ]) {
      for (const fps of [24, 25, 30, 60] as const) {
        const p = { ...newProject(), width, height, fps };
        for (const id of motionSceneIds) {
          const created = createMotionScene(p, fps * 3, id);
          const next = commit(p, created);
          expect(() => validateProject(next)).not.toThrow();
          expect(created.clip).toMatchObject({
            x: 0,
            y: 0,
            width,
            height,
            start: fps * 3,
            duration: fps * 4,
          });
          for (const layer of created.motion.layers) {
            expect(layer.x).toBeGreaterThanOrEqual(0);
            expect(layer.y).toBeGreaterThanOrEqual(0);
            expect(layer.x + layer.width).toBeLessThanOrEqual(width + 0.00001);
            expect(layer.y + layer.height).toBeLessThanOrEqual(
              height + 0.00001,
            );
            expect(layer.fontSize).toBeGreaterThanOrEqual(8);
            expect(layer.fontSize).toBeLessThanOrEqual(500);
          }
        }
      }
    }
  });

  it("gives overlapping scenes their own track and reuses it only when space is available", () => {
    let p = newProject();
    const first = createMotionScene(p, 17, "kinetic-title");
    p = commit(p, first);
    const second = createMotionScene(p, 17, "neon-reveal");
    expect(second.clip.trackId).not.toBe(first.clip.trackId);
    expect(second.commands.map((command) => command.type)).toEqual([
      "motion.put",
      "track.add",
      "clip.add",
    ]);
    p = commit(p, second);
    const after = createMotionScene(p, 17 + first.clip.duration, "lower-third");
    expect([first.clip.trackId, second.clip.trackId]).toContain(
      after.clip.trackId,
    );
    expect(after.commands.map((command) => command.type)).toEqual([
      "motion.put",
      "clip.add",
    ]);
  });

  it("adds visible shapes when every existing text track is hidden, muted, or occupied", () => {
    let p = newProject();
    p.tracks = p.tracks.map((track) =>
      track.kind === "text" ? { ...track, hidden: true } : track,
    );
    for (const type of shapeTypes) {
      const created = createShapeLayer(p, 39, type);
      expect(created.motion.layers[0].type).toBe(type);
      p = commit(p, created);
      const track = p.tracks.find(
        (track) => track.id === created.clip.trackId,
      )!;
      expect(track.hidden).toBe(false);
      expect(track.muted).toBe(false);
      expect(created.clip.start).toBe(39);
      expect(p.clips.filter((clip) => clip.trackId === track.id)).toHaveLength(
        1,
      );
    }
    const objectIds = [...p.clips, ...p.motions, ...p.tracks].map(
      (object) => object.id,
    );
    expect(new Set(objectIds).size).toBe(objectIds.length);
  });

  it("preserves layer appearance, text choreography, loops and interpolation through project JSON", () => {
    let p = newProject();
    for (const [index, id] of motionSceneIds.entries())
      p = commit(p, createMotionScene(p, index * 120, id));
    const restored = validateProject(JSON.parse(JSON.stringify(p)));
    expect(restored.motions).toEqual(p.motions);
    const layers = restored.motions.flatMap((motion) => motion.layers);
    expect(layers.some((layer) => layer.fillStyle === "gradient")).toBe(true);
    expect(
      layers.some((layer) => layer.textAnimation === "character-rise"),
    ).toBe(true);
    expect(layers.some((layer) => layer.loop === "ping-pong")).toBe(true);
    expect(
      layers.some((layer) => layer.keyframes.some((key) => key.trim === 0)),
    ).toBe(true);
    expect(
      layers.some((layer) =>
        layer.keyframes.some((key) => key.easing === "spring"),
      ),
    ).toBe(true);
  });

  it("creates an eight-second showcase with continuous non-overlapping scenes and editable layers", () => {
    const p = createMotionDemoProject();
    expect(duration(p)).toBe(p.fps * 8);
    expect(p.clips).toHaveLength(4);
    expect(p.motions).toHaveLength(4);
    expect(p.clips.map((clip) => clip.start)).toEqual([0, 60, 120, 180]);
    expect(p.clips.every((clip) => clip.duration === 60)).toBe(true);
    expect(() => validateProject(p)).not.toThrow();
    for (const motion of p.motions) {
      for (const layer of motion.layers) {
        expect(
          layer.keyframes.every(
            (key, i) => i === 0 || key.frame > layer.keyframes[i - 1].frame,
          ),
        ).toBe(true);
      }
    }
  });
});
