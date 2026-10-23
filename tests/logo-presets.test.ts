import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
import { applyCommands } from "../src/shared/commands";
import {
  MotionSchema,
  makeClip,
  newProject,
  validateProject,
  duration,
} from "../src/shared/model";
import { isMotionAccentLayer, motionValue } from "../src/shared/motion";
import { trimClip } from "../src/shared/timeline";
import {
  applyLogoReveal,
  createLogoRevealCommands,
  logoRevealStyles,
  originalLogoPaths,
  originalLogoViewBox,
} from "../src/shared/logo-presets";
import {
  createLogoDemoProject,
  createMotionScene,
  logoSceneIds,
} from "../src/shared/motion-presets";

const imported = () =>
  MotionSchema.parse({
    id: "shared-logo",
    name: "Imported design",
    source: "original.svg",
    layers: [
      {
        name: "Custom mark",
        type: "path",
        vectorPath: originalLogoPaths[0].path,
        vectorViewBox: [-10, -20, 256, 256],
        vectorFillRule: "evenodd",
        vectorTransform: [1, 0, 0, 1, 3, -2],
        x: 210,
        y: 330,
        width: 260,
        height: 260,
        background: "#8C5A3C",
        stroke: "#312A25",
        strokeWidth: 0,
        fillOpacity: 0.73,
        scale: 1.2,
        rotate: 7,
        opacity: 0.9,
        keyframes: [
          {
            frame: 0,
            x: 0,
            y: 0,
            opacity: 0.7,
            easing: "cubic-bezier",
            bezier: [0.16, 1, 0.3, 1],
          },
          { frame: 100, x: 15, y: -5, opacity: 0.9, easing: "ease-in-out" },
          { frame: 200, x: 45, y: 5, opacity: 0.7 },
        ],
      },
      {
        name: "Stroke detail",
        type: "path",
        vectorPath: "M0 20L100 20",
        vectorViewBox: [0, 0, 100, 40],
        x: 300,
        y: 660,
        width: 200,
        height: 80,
        background: "transparent",
        stroke: "#5E675F",
        strokeWidth: 3,
        keyframes: [
          { frame: 0, strokeWidth: 3, easing: "ease-in-out" },
          { frame: 200, strokeWidth: 5 },
        ],
      },
      {
        name: "Hidden alternate",
        type: "path",
        hidden: true,
        vectorPath: originalLogoPaths[1].path,
        vectorViewBox: originalLogoViewBox,
        loop: "cycle",
        keyframes: [
          { frame: 0, rotate: 0 },
          { frame: 40, rotate: 30 },
        ],
      },
      {
        name: "Existing text",
        type: "text",
        text: "Independent",
        keyframes: [
          { frame: 0, y: 15 },
          { frame: 30, y: 0 },
        ],
      },
    ],
  });

describe("editable custom vector logo reveals", () => {
  it("draws an outline before filling, derives a temporary stroke for fill-only art, and staggers separate paths", () => {
    const original = imported();
    const revealed = applyLogoReveal(original, {
      style: "draw",
      animationOffset: 100,
    });
    const mark = revealed.layers[0],
      stroke = revealed.layers[1];
    expect(mark.stroke).toBe(original.layers[0].background);
    expect(mark.strokeWidth).toBe(0);
    expect(motionValue(mark, "trim", 100)).toBe(0);
    expect(motionValue(mark, "fillOpacity", 100)).toBe(0);
    expect(motionValue(mark, "strokeWidth", 100)).toBeGreaterThan(1);
    expect(motionValue(mark, "trim", 144)).toBe(1);
    expect(motionValue(mark, "fillOpacity", 144)).toBe(0);
    expect(motionValue(mark, "fillOpacity", 167)).toBeCloseTo(0.73);
    expect(motionValue(mark, "strokeWidth", 167)).toBe(0);
    expect(motionValue(mark, "trim", 103)).toBeGreaterThan(0);
    expect(motionValue(stroke, "trim", 103)).toBe(0);
    expect(stroke.background).toBe("transparent");
    expect(stroke.stroke).toBe(original.layers[1].stroke);
    for (const frame of [0, 30, 100, 160, 200]) {
      expect(motionValue(stroke, "fillOpacity", frame)).toBe(0);
      expect(motionValue(stroke, "strokeWidth", frame)).toBe(
        motionValue(original.layers[1], "strokeWidth", frame),
      );
    }
  });

  it("preserves design metadata and exact x/y curves, including conflicting same-frame easing", () => {
    const original = imported(),
      snapshot = structuredClone(original);
    for (const style of logoRevealStyles) {
      const next = applyLogoReveal(original, { style, animationOffset: 100 });
      for (const property of [
        "name",
        "vectorPath",
        "vectorViewBox",
        "vectorFillRule",
        "vectorTransform",
        "x",
        "y",
        "width",
        "height",
        "background",
        "fillOpacity",
      ] as const)
        expect(next.layers[0][property]).toEqual(original.layers[0][property]);
      for (let frame = 0; frame <= 240; frame += 3)
        for (const property of ["x", "y"] as const)
          expect(motionValue(next.layers[0], property, frame)).toBeCloseTo(
            motionValue(original.layers[0], property, frame),
            9,
          );
      expect(next.layers[2]).toEqual(original.layers[2]);
      expect(next.layers[3]).toEqual(original.layers[3]);
      expect(next.source).toBe(original.source);
    }
    expect(original).toEqual(snapshot);
  });

  it("clones only the selected trimmed/split clip's definition and undoes or redoes the complete edit atomically", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cutline-logo-test-"));
    try {
      let p = newProject();
      p.motions.push(imported());
      const clip = {
        ...makeClip(p, "text", "titles", 0),
        id: "logo-clip",
        preset: "custom" as const,
        motionId: p.motions[0].id,
        duration: 240,
      };
      p.clips.push(clip, { ...clip, id: "linked-copy", start: 240 });
      p = applyCommands(p, {
        projectId: p.id,
        revision: p.revision,
        label: "Split logo",
        commands: [{ type: "clip.split", id: clip.id, frame: 90 }],
      });
      const right = p.clips.find((item) => item.start === 90)!;
      const trimmed = trimClip(p, right, "left", 100);
      p.clips = p.clips.map((item) => (item.id === right.id ? trimmed : item));
      const store = new Store(path.join(directory, "recovery.cutline"));
      store.commit(p, "Shared logo fixture");
      const before = structuredClone(store.project);
      const commands = createLogoRevealCommands(
        store.project,
        right.id,
        "orbit",
      );
      expect(commands.map((command) => command.type)).toEqual([
        "motion.put",
        "clip.update",
      ]);
      store.transact({
        projectId: store.project.id,
        revision: store.project.revision,
        label: "Orbit logo",
        commands,
      });
      const selected = store.project.clips.find(
        (item) => item.id === right.id,
      )!;
      expect(selected.motionId).not.toBe(clip.motionId);
      expect({ ...selected, motionId: clip.motionId }).toEqual(trimmed);
      expect(
        store.project.clips
          .filter((item) => item.id !== selected.id)
          .every((item) => item.motionId === clip.motionId),
      ).toBe(true);
      expect(
        store.project.motions.find((item) => item.id === clip.motionId),
      ).toEqual(imported());
      const cloned = store.project.motions.find(
        (item) => item.id === selected.motionId,
      )!;
      expect(
        motionValue(cloned.layers[0], "trim", selected.animationOffset),
      ).toBe(0);
      expect(
        motionValue(
          cloned.layers[0],
          "fillOpacity",
          selected.animationOffset + selected.duration - 1,
        ),
      ).toBeCloseTo(0.73);
      expect(
        validateProject(JSON.parse(JSON.stringify(store.project))),
      ).toEqual(store.project);
      store.undo();
      expect({ ...store.project, revision: before.revision }).toEqual(before);
      store.redo();
      expect(
        store.project.clips.find((item) => item.id === selected.id)?.motionId,
      ).toBe(selected.motionId);
      expect(() =>
        applyCommands(before, {
          projectId: before.id,
          revision: before.revision + 1,
          label: "Stale logo",
          commands,
        }),
      ).toThrow("Project changed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects looped vectors and missing or too-short targets without mutating their animation", () => {
    for (const loop of ["cycle", "ping-pong"] as const) {
      const original = imported();
      original.layers[0].loop = loop;
      const snapshot = structuredClone(original);
      expect(() => applyLogoReveal(original, { style: "draw" })).toThrow(
        /Turn off vector looping/,
      );
      expect(original).toEqual(snapshot);
    }
    const p = newProject();
    expect(() => createLogoRevealCommands(p, "missing", "draw")).toThrow(
      /Select a custom motion clip/,
    );
    p.motions.push(imported());
    const clip = {
      ...makeClip(p, "text", "titles", 0),
      preset: "custom" as const,
      motionId: p.motions[0].id,
      duration: 1,
    };
    p.clips.push(clip);
    expect(() => createLogoRevealCommands(p, clip.id, "draw")).toThrow(
      /2 to 18,000/,
    );
    expect(() =>
      createLogoRevealCommands(p, clip.id, "draw", { durationFrames: 10 }),
    ).toThrow(/fit inside/);
  });

  it("keeps every logo scene's original custom paths, names, palette and reveal timing schema-valid at short and long durations", () => {
    for (const fps of [24, 25, 30, 60] as const) {
      for (const durationFrames of [2, 3, 60, 138, 240, 18000]) {
        const p = { ...newProject(), width: 1080, height: 1920, fps };
        for (const id of logoSceneIds) {
          const created = createMotionScene(p, 33, id, { durationFrames });
          const paths = created.motion.layers.filter(
            (layer) => layer.type === "path",
          );
          expect(paths.map((layer) => layer.vectorPath)).toEqual(
            originalLogoPaths.map((mark) => mark.path),
          );
          expect(
            paths.every(
              (layer) => layer.vectorViewBox?.join() === "0,0,256,256",
            ),
          ).toBe(true);
          expect(paths.every((layer) => layer.musicAccent === false)).toBe(
            true,
          );
          expect(
            created.motion.layers.some(
              (layer) =>
                layer.musicAccent === true &&
                isMotionAccentLayer(layer, created.clip),
            ),
          ).toBe(true);
          expect(
            created.motion.layers.every(
              (layer) => typeof layer.musicAccent === "boolean" && layer.name,
            ),
          ).toBe(true);
          expect(
            new Set(created.motion.layers.map((layer) => layer.name)).size,
          ).toBe(created.motion.layers.length);
          const next = applyCommands(p, {
            projectId: p.id,
            revision: p.revision,
            label: "Logo scene",
            commands: created.commands,
          });
          expect(() => validateProject(next)).not.toThrow();
          for (const layer of paths) {
            expect(
              layer.keyframes.every((key) => key.frame < durationFrames),
            ).toBe(true);
            expect(motionValue(layer, "fillOpacity", durationFrames - 1)).toBe(
              1,
            );
          }
        }
      }
    }
  });

  it("builds the original three-logo study on cumulative eight-beat boundaries", () => {
    const p = createLogoDemoProject();
    expect(p.clips.map((clip) => clip.start)).toEqual([0, 138, 277]);
    expect(duration(p)).toBe(415);
    expect(p.motions.map((motion) => motion.source)).toEqual(logoSceneIds);
    expect(p.clips.every((clip) => clip.fontFamily === "Helvetica")).toBe(true);
    expect(validateProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
});
