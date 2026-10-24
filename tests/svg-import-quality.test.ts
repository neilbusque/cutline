import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MotionGraphicAtFrame } from "../src/composition/MotionGraphic";
import { newProject, validateProject } from "../src/shared/model";
import { applyCommands } from "../src/shared/commands";
import { createVectorScene } from "../src/shared/vector-scenes";
import {
  MAX_VECTOR_LAYERS,
  parseEditableSvg,
  svgColor,
} from "../src/shared/vector-path";

// Shaped like an Adobe Illustrator export: classes in a style block, chained
// gradients with a transform, and a stroke miter limit.
const illustrator = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" x="0px" y="0px" xml:space="preserve" enable-background="new 0 0 200 100">
  <defs>
    <style>
      .cls-1{fill:url(#linear-gradient);}
      .cls-2{fill:none;stroke:#1d1d1f;stroke-miterlimit:10;stroke-width:4px;}
      .cls-3, .cls-4 { fill: rgba(255, 0, 0, 0.5) }
      @media print { .cls-1 { fill: black } }
    </style>
    <linearGradient id="base" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ff7a00"/>
      <stop offset=".5" style="stop-color:hsl(330, 100%, 50%);stop-opacity:.8"/>
      <stop offset="100%" stop-color="rebeccapurple"/>
    </linearGradient>
    <linearGradient id="linear-gradient" xlink:href="#base" gradientTransform="rotate(45 .5 .5)"/>
  </defs>
  <title>Brand</title>
  <rect class="cls-1" width="200" height="100" rx="20"/>
  <circle class="cls-2" cx="100" cy="50" r="30"/>
  <path class="cls-3" d="M10 10h20v20h-20z"/>
</svg>`;

describe("SVG import from real design tools and AI output", () => {
  it("imports Illustrator-style classes, chained gradients and colors", () => {
    const parsed = parseEditableSvg(illustrator);
    expect(parsed.layers).toHaveLength(3);
    const [card, ring, square] = parsed.layers;
    expect(card.vectorGradient).toMatchObject({
      type: "linear",
      units: "objectBoundingBox",
      x2: 1,
      stops: [
        { offset: 0, color: "#ff7a00", opacity: 1 },
        { offset: 0.5, color: "#ff0080", opacity: 0.8 },
        { offset: 1, color: "#663399", opacity: 1 },
      ],
    });
    expect(card.vectorGradient!.transform![0]).toBeCloseTo(Math.SQRT1_2);
    expect(card.background).not.toBe("transparent");
    expect(ring).toMatchObject({
      background: "transparent",
      stroke: "#1d1d1f",
      strokeWidth: 4,
    });
    expect(square.background).toBe("#ff000080");
    expect(parsed.warnings ?? []).toEqual([]);
  });

  it("reads every CSS color form", () => {
    expect(svgColor("Tomato")).toBe("#ff6347");
    expect(svgColor("rgb(0 128 255 / 50%)")).toBe("#0080ff80");
    expect(svgColor("hsl(120, 100%, 25%)")).toBe("#008000");
    expect(svgColor("#ABC")).toBe("#aabbcc");
    expect(svgColor("#aabbccff")).toBe("#aabbcc");
    expect(svgColor("none")).toBe("transparent");
    expect(svgColor("banana")).toBeUndefined();
  });

  it("pushes group opacity down, resolves currentColor and reuses symbols", () => {
    const parsed = parseEditableSvg(`<svg viewBox="0 0 100 100" color="#00ff00">
      <defs><symbol id="dot" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></symbol></defs>
      <g opacity=".5" fill="currentColor"><path opacity=".5" d="M0 0H10V10Z"/></g>
      <use href="#dot" x="50" y="50" width="20" height="20" fill="blue"/>
      <g display="none"><path d="M0 0H1V1Z"/></g>
    </svg>`);
    expect(parsed.layers).toHaveLength(2);
    expect(parsed.layers[0]).toMatchObject({
      background: "#00ff00",
      opacity: 0.25,
    });
    expect(parsed.layers[1].background).toBe("#0000ff");
    expect(parsed.layers[1].vectorTransform).toEqual([2, 0, 0, 2, 50, 50]);
  });

  it("keeps importing when it meets text, filters and clips, and says what it left out", () => {
    const parsed = parseEditableSvg(`<svg viewBox="0 0 100 100">
      <defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter><clipPath id="c"><rect width="50" height="50"/></clipPath></defs>
      <g clip-path="url(#c)"><rect width="100" height="100" fill="#111" filter="url(#f)"/></g>
      <text x="10" y="20">Hello</text>
      <sodipodi:namedview id="base"/>
    </svg>`);
    expect(parsed.layers).toHaveLength(1);
    expect(parsed.warnings!.join(" ")).toMatch(/Text was left out/);
    expect(parsed.warnings!.join(" ")).toMatch(/Filters/);
    expect(parsed.warnings!.join(" ")).toMatch(/Clipping/);
  });

  it("supports percentages, units, user-space radial gradients and nested viewports", () => {
    const parsed =
      parseEditableSvg(`<svg width="10cm" height="5cm" viewBox="0 0 200 100">
      <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="50%" cy="50" r="40">
        <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
      </radialGradient>
      <rect width="100%" height="100%" fill="url(#glow)"/>
      <svg x="100" width="100" height="100" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>
    </svg>`);
    expect(parsed.width).toBeCloseTo(377.95, 1);
    expect(parsed.layers[0].vectorPath).toBe("M0 0H200V100H0Z");
    expect(parsed.layers[0].vectorGradient).toMatchObject({
      type: "radial",
      units: "userSpaceOnUse",
      cx: 100,
      cy: 50,
      r: 40,
      fx: 100,
      fy: 50,
    });
    expect(parsed.layers[1].vectorTransform).toEqual([10, 0, 0, 10, 100, 0]);
  });

  it("combines same-colored neighbours when a file has more shapes than layers", () => {
    const dots = Array.from(
      { length: 120 },
      (_, i) =>
        `<circle cx="${i}" cy="${i % 2 ? 10 : 20}" r="1" fill="${i < 60 ? "red" : "blue"}"/>`,
    ).join("");
    const parsed = parseEditableSvg(
      `<svg viewBox="0 0 120 30">${dots}<path d="m5 5 h2 v2 z" fill="blue"/></svg>`,
    );
    expect(parsed.layers.length).toBeLessThanOrEqual(MAX_VECTOR_LAYERS);
    expect(parsed.layers).toHaveLength(2);
    expect(parsed.layers[1].vectorPath).toContain(" M5 5");
    expect(parsed.warnings!.join(" ")).toMatch(/combined/);
    const many = Array.from(
      { length: 70 },
      (_, i) =>
        `<rect x="${i}" width="1" height="1" fill="#${(i + 16).toString(16).padStart(6, "0")}"/>`,
    ).join("");
    expect(() =>
      parseEditableSvg(`<svg viewBox="0 0 70 1">${many}</svg>`),
    ).toThrow(/simplify/);
  });

  it("joins same-colored shapes without punching holes where they overlap", () => {
    // 63 small shapes in their own colors push the file past 64 layers.
    const filler = Array.from(
      { length: 63 },
      (_, i) =>
        `<rect x="${i * 3}" y="200" width="1" height="1" fill="#${(i + 16).toString(16).padStart(6, "0")}"/>`,
    ).join("");
    const svg = (head: string) =>
      parseEditableSvg(
        `<svg viewBox="0 0 200 210">${filler}<rect x="45" y="70" width="10" height="30" fill="#ff0000"/>${head}</svg>`,
      );
    // A lollipop: the head overlaps its stick. Both wind clockwise, so one
    // path fills them both.
    const lollipop = svg('<circle cx="50" cy="70" r="12" fill="#ff0000"/>');
    expect(lollipop.layers).toHaveLength(64);
    expect(lollipop.layers.at(-1)!.vectorPath).toBe(
      "M45 70H55V100H45Z M38 70A12 12 0 1 1 62 70A12 12 0 1 1 38 70Z",
    );
    // A path drawn the other way round would cancel where they overlap, so
    // it stays a layer of its own; here that is one layer too many.
    const diamond = '<path d="M38 70L50 82L62 70L50 58Z" fill="#ff0000"/>';
    expect(() => svg(diamond)).toThrow(/simplify/);
    // Apart from the stick it joins as before.
    expect(
      svg(
        diamond.replace(
          /M38 70L50 82L62 70L50 58Z/u,
          "M138 70L150 82L162 70L150 58Z",
        ),
      ).layers,
    ).toHaveLength(64);
    // See-through circles would darken where they overlap, so only ones
    // apart from each other join.
    const tinted = (second: number) =>
      parseEditableSvg(
        `<svg viewBox="0 0 200 210">${filler}<circle cx="50" cy="70" r="12" fill="#ff0000" fill-opacity="0.5"/><circle cx="${second}" cy="70" r="12" fill="#ff0000" fill-opacity="0.5"/></svg>`,
      );
    expect(tinted(100).layers).toHaveLength(64);
    expect(() => tinted(55)).toThrow(/simplify/);
  });

  it("renders an imported gradient in preview and export markup and survives a project round trip", () => {
    let p = newProject();
    const created = createVectorScene(p, 0, parseEditableSvg(illustrator));
    p = applyCommands(p, {
      projectId: p.id,
      revision: p.revision,
      label: "Import",
      commands: created.commands,
    });
    expect(validateProject(JSON.parse(JSON.stringify(p))).motions).toEqual(
      p.motions,
    );
    const html = renderToStaticMarkup(
      React.createElement(MotionGraphicAtFrame, {
        motion: p.motions[0],
        c: p.clips[0],
        frame: 10,
      } as any),
    );
    expect(html).toMatch(/<linearGradient[^>]*gradientTransform="matrix/);
    expect(html).toContain('stop-color="#ff0080"');
    expect(html).toMatch(/fill="url\(#motion-gradient-/);
  });
});
