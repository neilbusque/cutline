import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MotionGraphicAtFrame } from "../src/composition/MotionGraphic";
import {
  MotionLayerSchema,
  newProject,
  validateProject,
} from "../src/shared/model";
import { applyCommands } from "../src/shared/commands";
import { applyAgentEdit, agentEditingSchemas } from "../src/shared/agent-edit";
import { motionValue } from "../src/shared/motion";
import { moveMotionKey } from "../src/shared/motion-edit";
import { resizeCanvas } from "../src/shared/canvas";
import { createVectorScene } from "../src/shared/vector-scenes";
import {
  parseEditableSvg,
  parseVectorPath,
  parseVectorTransform,
  pointsToVectorPath,
  vectorPathToPoints,
  validateVectorPath,
} from "../src/shared/vector-path";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><g transform="translate(5 8)" fill="black"><path id="Mark" d="M0 0L40 0L40 30L0 30Z"/></g></svg>';
describe("bounded editable vectors", () => {
  it("accepts every absolute/relative SVG command, implicit repeats, scientific coordinates and multiple contours", () => {
    const path =
      "M1e1 -2.5 l5,2 H20v8 C20 10 30 10 30 20s4 6 8 2 Q40 24 42 28t4 8 A5 8 20 0 1 50 40a3 4 0 1 0 6 4z M0 0 1 1Z";
    expect(() => validateVectorPath(path)).not.toThrow();
    expect(parseVectorPath("m0 0 4 4 8 8z").map((s) => s.command)).toEqual([
      "m",
      "l",
      "l",
      "z",
    ]);
    expect(parseVectorPath("M.5-.2L10.5.3")[0].values).toEqual([0.5, -0.2]);
  });
  it("parses compact arc flags independently from their endpoint numbers", () => {
    expect(parseVectorPath("M0 0 A10 10 0 0110 20")[1].values).toEqual([
      10, 10, 0, 0, 1, 10, 20,
    ]);
    expect(
      parseVectorPath("M0 0a10 10 0 01-10-.5 5 5 0 10.5.2")[2].values,
    ).toEqual([5, 5, 0, 1, 0, 0.5, 0.2]);
    expect(
      parseEditableSvg('<svg><path d="M0 0A10 10 0 0110 20"/></svg>').layers[0]
        .vectorPath,
    ).toBe("M0 0A10 10 0 0110 20");
    for (const path of [
      "M0 0A1 1 0 +0 1 2 2",
      "M0 0A1 1 0 .0 1 2 2",
      "M0 0A1 1 0 0210 20",
    ])
      expect(() => validateVectorPath(path)).toThrow();
  });
  it("rejects malformed, unbounded and executable path data before rendering", () => {
    for (const path of [
      "",
      "L0 0",
      "M0",
      "M0 0C1 2",
      "M0 0A1 1 0 2 0 5 5",
      "M0 0A-1 1 0 0 0 5 5",
      "M0 0R1 1",
      "M0 0Z5 5",
      "M0,,0",
      "M,0 0",
      "M0 0,",
      "M0 0 L",
      "MInfinity 0",
      "M1e999 0",
      "M10000001 0",
      "M0 0<script>",
      "M0 0" + "L0 0".repeat(17000),
    ])
      expect(() => validateVectorPath(path)).toThrow();
  });
  it("round-trips cubic pen handles, closed curves and relative lines without inventing node data for arcs/compound paths", () => {
    const points = [
      { x: 0, y: 0, out: { x: 25, y: -15 }, in: { x: -10, y: 0 } },
      { x: 80, y: 40, in: { x: 60, y: 5 }, out: { x: 80, y: 60 } },
      { x: 0, y: 80 },
    ];
    const d = pointsToVectorPath(points, { closed: true });
    const restored = vectorPathToPoints(d)!;
    expect(restored).toMatchObject({ points, closed: true });
    expect(
      pointsToVectorPath(restored.points, { closed: restored.closed }),
    ).toBe(d);
    expect(vectorPathToPoints("m10 10l20 0h20v30")).toEqual({
      closed: false,
      points: [
        { x: 10, y: 10 },
        { x: 30, y: 10 },
        { x: 50, y: 10 },
        { x: 50, y: 40 },
      ],
    });
    expect(vectorPathToPoints("M0 0A4 4 0 0 1 8 8")).toBeNull();
    expect(vectorPathToPoints("M0 0L10 10M20 20L30 30")).toBeNull();
    expect(() =>
      pointsToVectorPath([
        { x: NaN, y: 0 },
        { x: 1, y: 2 },
      ]),
    ).toThrow();
    expect(() => pointsToVectorPath([{ x: 0, y: 0 }])).toThrow();
  });
  it("flattens safe nested transforms, inherited paint and style into named independent paths", () => {
    const parsed = parseEditableSvg(svg);
    expect(parsed).toMatchObject({
      width: 100,
      height: 50,
      viewBox: [0, 0, 100, 50],
    });
    expect(parsed.layers[0]).toMatchObject({
      name: "Mark",
      vectorTransform: [1, 0, 0, 1, 5, 8],
      background: "#000000",
      strokeWidth: 0,
    });
    const styled = parseEditableSvg(
      '<svg viewBox="0 0 100 100"><g fill="#fff" stroke="rgb(255, 0, 128)" transform="translate(10 20) scale(2)"><path d="M0 0L10 10" style="fill:black;fill-opacity:.4;stroke-width:2;stroke-opacity:.5" transform="translate(3 4)"/></g></svg>',
    );
    expect(styled.layers[0]).toMatchObject({
      background: "#000000",
      fillOpacity: 0.4,
      stroke: "#ff008080",
      strokeWidth: 2,
      vectorTransform: [2, 0, 0, 2, 16, 28],
    });
    expect(
      parseVectorTransform("rotate(90 10 20)").map((n) => Math.round(n)),
    ).toEqual([0, 1, -1, 0, 30, 10]);
    expect(() => parseVectorTransform("skewX(90)")).toThrow();
  });
  it("converts common primitive geometry without importing raw SVG elements", () => {
    const source =
      '<svg viewBox="0 0 100 100"><rect x="1" y="2" width="40" height="30" rx="4"/><circle cx="50" cy="50" r="8"/><ellipse cx="50" cy="50" rx="20" ry="10"/><polygon points="0,0 10,0 10,10"/><polyline points="0 0 10 10"/><line x1="1" y1="2" x2="5" y2="6" stroke="#fff"/></svg>';
    const parsed = parseEditableSvg(source);
    expect(parsed.layers).toHaveLength(6);
    expect(
      parsed.layers.every(
        (layer) => layer.type === "path" && !layer.vectorPath.includes("<"),
      ),
    ).toBe(true);
    parsed.layers.forEach((layer) =>
      expect(() => validateVectorPath(layer.vectorPath)).not.toThrow(),
    );
    expect(parsed.layers[0].vectorPath).toContain("A4 4");
    expect(parsed.layers[5].vectorPath).toBe("M1 2L5 6");
  });
  it("rejects unsafe or broken SVG content atomically and bounds nesting", () => {
    const bad = [
      "<svg><script>alert(1)</script></svg>",
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg/>',
      '<svg><use href="#other"/></svg>',
      '<svg><image href="https://example.com/x"/></svg>',
      "<svg><text>Brand</text></svg>",
      '<svg><path d="M0 0L1 1"/><path d="bad"/></svg>',
      '<svg viewBox="0 0 -1 2"><path d="M0 0L1 1"/></svg>',
      '<svg><path d="M0 0L1 1"></g></svg>',
      "<svg>" +
        "<g>".repeat(70) +
        '<path d="M0 0L1 1"/>' +
        "</g>".repeat(70) +
        "</svg>",
      "x".repeat(262145),
      "x".repeat(1048577),
    ];
    bad.forEach((text) => expect(() => parseEditableSvg(text)).toThrow());
    // Event handlers and scripts never reach the project: only path data does.
    const handled = parseEditableSvg(
      '<svg><script>alert(1)</script><path d="M0 0L1 1" onclick="alert(1)"/></svg>',
    );
    expect(JSON.stringify(handled)).not.toMatch(/alert|onclick|script/);
    expect(
      parseEditableSvg(
        '<?xml version="1.0"?><svg><title>A &amp; B</title><!--safe--><path d="M0 0L1 1"/></svg>',
      ).layers,
    ).toHaveLength(1);
  });
});

describe("vector model, creation, rendering and structured editing", () => {
  it("resizes viewport placement and pixel outlines while retaining source coordinates, matrix and fill timing", () => {
    let p = { ...newProject(), width: 1920, height: 1080 };
    const created = createVectorScene(p, 0, parseEditableSvg(svg), {
      width: 500,
      height: 250,
    });
    created.motion.layers[0].strokeWidth = 8;
    created.motion.layers[0].keyframes = [
      { frame: 0, fillOpacity: 0, strokeWidth: 4, easing: "linear" },
      { frame: 20, fillOpacity: 1, strokeWidth: 8, easing: "linear" },
    ];
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Place vector",
      commands: created.commands,
    });
    const before = p.motions[0].layers[0];
    const resized = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Resize",
      commands: resizeCanvas(p, 960, 540),
    }).motions[0].layers[0];
    expect(resized).toMatchObject({
      width: 250,
      height: 125,
      strokeWidth: 4,
      vectorPath: before.vectorPath,
      vectorViewBox: before.vectorViewBox,
      vectorTransform: before.vectorTransform,
    });
    expect(
      resized.keyframes.map((key) => [
        key.frame,
        key.fillOpacity,
        key.strokeWidth,
      ]),
    ).toEqual([
      [0, 0, 2],
      [20, 1, 4],
    ]);
    expect(motionValue(resized, "fillOpacity", 10)).toBe(0.5);
    expect(before.strokeWidth).toBe(8);
  });
  it("keeps neutral legacy fill opacity and requires safe geometry for path layers", () => {
    expect(MotionLayerSchema.parse({ type: "rectangle" }).fillOpacity).toBe(1);
    for (const layer of [
      { type: "path" },
      { type: "path", vectorPath: "M0 0L1 1", vectorViewBox: [0, 0, 0, 10] },
      {
        type: "path",
        vectorPath: "M0 0<script>",
        vectorViewBox: [0, 0, 10, 10],
      },
    ])
      expect(() => MotionLayerSchema.parse(layer)).toThrow();
    const layer = MotionLayerSchema.parse({
      ...parseEditableSvg(svg).layers[0],
      keyframes: [
        { frame: 0, fillOpacity: 0 },
        { frame: 20, fillOpacity: 1 },
      ],
    });
    expect(motionValue(layer, "fillOpacity", 10)).toBe(0.5);
    expect(
      moveMotionKey(layer, "fillOpacity", 0, 5)?.find((key) => key.frame === 5)
        ?.fillOpacity,
    ).toBe(0);
  });
  it("creates a useful centered scene with an atomic new track when occupied and source-space geometry unchanged", () => {
    let p = newProject();
    const parsed = parseEditableSvg(svg);
    const source = structuredClone(parsed);
    const created = createVectorScene(p, 0, parsed, { name: "Imported mark" });
    expect(created.motion.layers[0].width).toBeCloseTo(p.width * 0.65);
    expect(created.motion.layers[0].vectorPath).toBe(
      source.layers[0].vectorPath,
    );
    expect(created.motion.layers[0].vectorTransform).toEqual([
      1, 0, 0, 1, 5, 8,
    ]);
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Import",
      commands: created.commands,
    });
    const next = createVectorScene(p, 0, parsed);
    expect(next.commands.some((command) => command.type === "track.add")).toBe(
      true,
    );
    expect(parsed).toEqual(source);
    expect(validateProject(JSON.parse(JSON.stringify(p))).motions).toEqual(
      p.motions,
    );
  });
  it("converts uniform SVG stroke units to viewport pixels and averages distorted outlines", () => {
    const p = newProject(),
      source = parseEditableSvg(
        '<svg viewBox="0 0 100 100"><path d="M0 0L20 20" stroke="black" stroke-width="2" transform="scale(2)"/></svg>',
      );
    const created = createVectorScene(p, 0, source, {
      width: 500,
      height: 500,
    });
    expect(created.motion.layers[0].strokeWidth).toBe(20);
    const stretched = createVectorScene(
      p,
      0,
      parseEditableSvg(
        '<svg viewBox="0 0 100 100"><path d="M0 0L20 20" stroke="black" transform="scale(2 1)"/></svg>',
      ),
      { width: 500, height: 500 },
    );
    expect(stretched.motion.layers[0].strokeWidth).toBeCloseTo(Math.SQRT2 * 5);
    expect(() => createVectorScene(p, 0, source, { width: 4001 })).toThrow();
  });
  it("renders imported paths with transforms, evenodd fill, independent fill reveal and a pixel-true outline", () => {
    const p = newProject(),
      parsed = parseEditableSvg(svg);
    parsed.layers[0].vectorFillRule = "evenodd";
    const created = createVectorScene(p, 0, parsed);
    const layer = created.motion.layers[0];
    layer.stroke = "#ffffff";
    layer.strokeWidth = 3;
    layer.keyframes = [
      { frame: 0, trim: 0, fillOpacity: 0, easing: "linear" },
      { frame: 20, trim: 1, fillOpacity: 1, easing: "linear" },
    ];
    const markup = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, {
        motion: created.motion,
        c: created.clip,
        frame: 10,
      }),
    );
    expect(markup).toContain('viewBox="0 0 100 50"');
    expect(markup).toContain('transform="matrix(1 0 0 1 5 8)"');
    expect(markup).toContain('fill-rule="evenodd"');
    expect(markup).toContain('fill-opacity="0.5"');
    expect(markup).toContain('stroke-dashoffset="0.5"');
    // 3 canvas px drawn in path units (7.02 px per unit), so the dash reveal
    // and the outline share one coordinate space.
    expect(markup).not.toContain("vector-effect");
    expect(
      Number(markup.match(/ stroke-width="([^"]+)"/)![1]) * 7.02,
    ).toBeCloseTo(3);
    expect(markup).not.toContain("NaN");
  });
  it("exposes SVG/pen/reveal actions and preserves revision/atomic failure guarantees", () => {
    const p = newProject();
    const input = (actions: unknown[]) => ({
      projectId: p.id,
      revision: p.revision,
      label: "Logo",
      actions,
    });
    const edited = applyAgentEdit(
      p,
      input([
        { type: "motion.svg", svg, at: { frame: 0 }, ref: "logo" },
        { type: "motion.logoReveal", clipId: "$logo", style: "draw" },
        {
          type: "motion.layer.update",
          motionId: "$logo.motion",
          layer: 0,
          patch: { name: "Revealed mark", hidden: true },
        },
      ]),
    );
    expect(edited.project.clips[0].motionId).toBe(
      edited.references["logo.motion"],
    );
    expect(
      edited.project.motions.find(
        (m) => m.id === edited.project.clips[0].motionId,
      )?.layers[0],
    ).toMatchObject({ name: "Revealed mark", hidden: true });
    expect(edited.project.motions[0].layers[0].name).toBe("Mark");
    expect(
      edited.project.motions.find(
        (m) => m.id === edited.references["logo.motion"],
      )?.layers[0],
    ).toMatchObject({
      vectorPath: edited.project.motions[0].layers[0].vectorPath,
      vectorViewBox: [0, 0, 100, 50],
      vectorTransform: [1, 0, 0, 1, 5, 8],
      background: "#000000",
    });
    const vector = applyAgentEdit(
      p,
      input([
        {
          type: "motion.vector",
          points: [
            { x: 0, y: 0, out: { x: 20, y: 0 } },
            { x: 100, y: 100, in: { x: 100, y: 80 } },
          ],
          viewBox: [0, 0, 100, 100],
          at: { frame: 0 },
          width: 500,
          ref: "pen",
        },
      ]),
    );
    expect(vector.project.motions[0].layers[0].vectorPath).toContain("C");
    expect(() =>
      applyAgentEdit(p, {
        ...input([{ type: "motion.svg", svg, at: { frame: 0 } }]),
        revision: p.revision + 1,
      }),
    ).toThrow(/Project changed/);
    const before = JSON.stringify(p);
    expect(() =>
      applyAgentEdit(
        p,
        input([
          { type: "motion.svg", svg, at: { frame: 0 } },
          {
            type: "motion.svg",
            svg: "<svg><script/></svg>",
            at: { frame: 120 },
          },
        ]),
      ),
    ).toThrow();
    expect(JSON.stringify(p)).toBe(before);
    const schema = { schemas: agentEditingSchemas() };
    expect(schema.schemas.motionLayer).toHaveProperty("properties.vectorPath");
    expect(JSON.stringify(schema.schemas.action)).toContain("motion.vector");
    expect(JSON.stringify(schema.schemas.action)).toContain(
      "motion.logoReveal",
    );
  });
  it("preserves explicit path and pen geometry, colors and independent creation references", () => {
    const p = newProject();
    const result = applyAgentEdit(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Two editable marks",
      actions: [
        {
          type: "motion.vector",
          path: "M0 0A10 10 0 0110 20",
          viewBox: [-10, -10, 100, 100],
          transform: [2, 0, 0, 2, 5, 8],
          fill: "#123456",
          stroke: "#abcdef",
          strokeWidth: 1,
          fillRule: "evenodd",
          width: 500,
          at: { frame: 0 },
          ref: "arc",
        },
        {
          type: "motion.vector",
          points: [
            { x: 0, y: 0, out: { x: 20, y: 5 } },
            { x: 100, y: 100, in: { x: 80, y: 95 } },
          ],
          closed: true,
          viewBox: [0, 0, 100, 100],
          fill: "#fedcba",
          stroke: "#654321",
          strokeWidth: 2,
          width: 500,
          at: { frame: 0 },
          ref: "pen",
        },
      ],
    });
    const arc = result.project.motions.find(
      (m) => m.id === result.references["arc.motion"],
    )!.layers[0];
    const pen = result.project.motions.find(
      (m) => m.id === result.references["pen.motion"],
    )!.layers[0];
    expect(arc).toMatchObject({
      vectorPath: "M0 0A10 10 0 0110 20",
      vectorViewBox: [-10, -10, 100, 100],
      vectorTransform: [2, 0, 0, 2, 5, 8],
      vectorFillRule: "evenodd",
      background: "#123456",
      stroke: "#abcdef",
      strokeWidth: 10,
    });
    expect(pen).toMatchObject({
      vectorPath: "M0 0C20 5 80 95 100 100Z",
      vectorViewBox: [0, 0, 100, 100],
      background: "#fedcba",
      stroke: "#654321",
      strokeWidth: 10,
    });
    for (const ref of ["arc", "pen"])
      expect(
        result.project.clips.find((c) => c.id === result.references[ref])!
          .motionId,
      ).toBe(result.references[`${ref}.motion`]);
    expect(result.references.arc).not.toBe(result.references.pen);
  });
});
