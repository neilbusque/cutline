import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { browserRelativePath } from "./browser-config.mjs";

// Run from the source checkout: node scripts/qa-promo-alpha.mjs
// Compile the real component in memory and inspect Chromium's rendered pixels.
// No app, project, account, existing browser session or output file is touched.
const require = createRequire(import.meta.url);
const source = fileURLToPath(
  new URL("../src/composition/RgbSplit.tsx", import.meta.url),
);
const compiled = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["react", "react/jsx-runtime"],
});
const componentModule = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  require,
  componentModule,
  componentModule.exports,
);
const { RgbSplit } = componentModule.exports;
assert.equal(typeof RgbSplit, "function");

const cellSize = 160;
// SVG filtering and direct CSS alpha may round a fractional channel one code
// value apart. Fully opaque/transparent coverage and channel edges stay exact.
const translucentChannelTolerance = 1;
const fixtures = [
  { name: "half white", color: "#ffffff", opacity: 0.5 },
  { name: "half black", color: "#000000", opacity: 0.5 },
  { name: "quarter color", color: "#bf6090", opacity: 0.25 },
  { name: "opaque white", color: "#ffffff", opacity: 1 },
  { name: "transparent white", color: "#ffffff", opacity: 0 },
];
const shape = (fixture) =>
  React.createElement("div", {
    style: {
      position: "absolute",
      left: 40,
      top: 40,
      width: 80,
      height: 80,
      background: fixture.color,
      opacity: fixture.opacity,
    },
  });
const cell = (fixture, amount) =>
  React.createElement(
    "div",
    {
      style: {
        width: cellSize,
        height: cellSize,
        background: "#00ff00",
        position: "relative",
      },
    },
    amount === null
      ? shape(fixture)
      : React.createElement(RgbSplit, { amount }, shape(fixture)),
  );
const markup = renderToStaticMarkup(
  React.createElement(
    "div",
    { style: { display: "grid", gridTemplateColumns: "repeat(3, 160px)" } },
    ...fixtures.flatMap((fixture) =>
      [null, 0, 12].map((amount) => cell(fixture, amount)),
    ),
  ),
);

const bundledBrowser = fileURLToPath(
  new URL(`../vendor/${browserRelativePath}`, import.meta.url),
);
const browserExecutable = process.env.CUTLINE_QA_BROWSER ?? bundledBrowser;
assert(
  existsSync(browserExecutable),
  "The tested render browser is missing. Run npm run setup:vendor first.",
);
const browser = await chromium.launch({
  executablePath: browserExecutable,
  headless: true,
  args: ["--force-color-profile=srgb"],
});
try {
  const page = await browser.newPage({
    viewport: { width: cellSize * 3, height: cellSize * fixtures.length },
    deviceScaleFactor: 1,
  });
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<body style="margin:0">${markup}</body>`);
  const { data, info } = await sharp(await page.screenshot())
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (row, column, x = 80, y = 80) => {
    const offset =
      ((row * cellSize + y) * info.width + column * cellSize + x) *
      info.channels;
    return [...data.subarray(offset, offset + 3)];
  };
  const interiors = fixtures.map((fixture, row) => {
    const direct = pixel(row, 0);
    const neutral = pixel(row, 1);
    const split = pixel(row, 2);
    assert.deepEqual(
      neutral,
      direct,
      `${fixture.name}: zero amount is neutral`,
    );
    const allowedDifference =
      fixture.opacity > 0 && fixture.opacity < 1
        ? translucentChannelTolerance
        : 0;
    let maximumChannelDifference = 0;
    // Every sample is inside the overlap of the three shifted channels.
    for (let y = 48; y < 112; y++) {
      for (let x = 56; x < 104; x++) {
        const original = pixel(row, 0, x, y);
        assert.deepEqual(pixel(row, 1, x, y), original);
        maximumChannelDifference = Math.max(
          maximumChannelDifference,
          ...pixel(row, 2, x, y).map((value, i) =>
            Math.abs(value - original[i]),
          ),
        );
      }
    }
    assert(
      maximumChannelDifference <= allowedDifference,
      `${fixture.name}: interior opacity changed by ${maximumChannelDifference}/255`,
    );
    return {
      name: fixture.name,
      direct,
      neutral,
      split,
      maximumChannelDifference,
    };
  });

  const opaqueRow = fixtures.findIndex(({ opacity }) => opacity === 1);
  const edges = {
    left: pixel(opaqueRow, 2, 44),
    right: pixel(opaqueRow, 2, 116),
    outside: pixel(opaqueRow, 2, 30),
  };
  assert.deepEqual(pixel(opaqueRow, 1, 44), [255, 255, 255]);
  assert.deepEqual(pixel(opaqueRow, 1, 116), [255, 255, 255]);
  assert.deepEqual(edges.left, [0, 255, 255], "red channel shifts right");
  assert.deepEqual(edges.right, [255, 255, 0], "blue channel shifts left");
  assert.deepEqual(
    edges.outside,
    [0, 255, 0],
    "source alpha bounds remain intact",
  );
  console.log(JSON.stringify({ passed: true, interiors, edges }, null, 2));
} finally {
  await browser.close();
}
