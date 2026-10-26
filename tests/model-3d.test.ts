import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { prepareModel3D, parseModel3D } from "../src/main/model-3d";
import {
  Model3DSettingsSchema,
  Model3DMetadataSchema,
} from "../src/shared/model-3d";
import { Hyperframes, hyperframesDimensions } from "../src/main/hyperframes";
import { AssetSchema, type Asset } from "../src/shared/model";
import { Jobs } from "../src/main/media";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const json = (patch: Record<string, unknown> = {}) => ({
  asset: { version: "2.0" },
  scenes: [{ nodes: [] }],
  scene: 0,
  ...patch,
});
const binary = (value = json(), bin?: Buffer) => {
  const source = Buffer.from(JSON.stringify(value));
  const jsonBytes = Buffer.alloc(Math.ceil(source.length / 4) * 4, 0x20);
  source.copy(jsonBytes);
  const result = Buffer.alloc(
    20 + jsonBytes.length + (bin ? 8 + Math.ceil(bin.length / 4) * 4 : 0),
  );
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonBytes.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(result, 20);
  if (bin) {
    const offset = 20 + jsonBytes.length;
    result.writeUInt32LE(Math.ceil(bin.length / 4) * 4, offset);
    result.writeUInt32LE(0x004e4942, offset + 4);
    bin.copy(result, offset + 8);
  }
  return result;
};
async function files() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutline-model3d-"));
  roots.push(root);
  const input = path.join(root, "input"),
    output = path.join(root, "output");
  await mkdir(input);
  await mkdir(output);
  return { root, input, output };
}

describe("bounded glTF model sources", () => {
  it("accepts GLB 2.0 and rejects truncated, wrong-version and malformed chunks before rendering", () => {
    const valid = binary();
    expect(parseModel3D(valid, "glb").asset?.version).toBe("2.0");
    expect(() =>
      parseModel3D(valid.subarray(0, valid.length - 1), "glb"),
    ).toThrow(/incomplete/);
    const wrongVersion = Buffer.from(valid);
    wrongVersion.writeUInt32LE(1, 4);
    expect(() => parseModel3D(wrongVersion, "glb")).toThrow(/2.0/);
    const chunk = Buffer.from(valid);
    chunk.writeUInt32LE(valid.length, 12);
    expect(() => parseModel3D(chunk, "glb")).toThrow(/chunk/);
    expect(() =>
      parseModel3D(Buffer.from('{"asset":{"version":"1.0"}}'), "gltf"),
    ).toThrow(/2.0/);
  });

  it("rejects unsupported compression, oversized accessors and cyclic node graphs", () => {
    for (const model of [
      json({ extensionsUsed: ["KHR_draco_mesh_compression"] }),
      json({ images: [{ mimeType: "image/ktx2", bufferView: 0 }] }),
      json({
        meshes: [
          { primitives: [{ extensions: { EXT_meshopt_compression: {} } }] },
        ],
      }),
      json({ extensionsRequired: ["Unknown_required_extension"] }),
      json({ accessors: [{ count: 2000001 }] }),
      json({ nodes: [{ children: [1] }, { children: [0] }] }),
    ])
      expect(() =>
        parseModel3D(Buffer.from(JSON.stringify(model)), "gltf"),
      ).toThrow();
  });

  it("copies only model dependencies and survives removal of the original folder", async () => {
    const { input, output } = await files();
    await mkdir(path.join(input, "textures"));
    await writeFile(path.join(input, "body.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(
      path.join(input, "textures", "body.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfoAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await writeFile(
      path.join(input, "unrelated-private.txt"),
      "not part of the model",
    );
    await writeFile(
      path.join(input, "lens.gltf"),
      JSON.stringify(
        json({
          buffers: [{ uri: "body.bin", byteLength: 4 }],
          images: [{ uri: "textures/body.png" }],
          animations: [{ name: "Focus", channels: [], samplers: [] }],
        }),
      ),
    );
    const model = await prepareModel3D(path.join(input, "lens.gltf"), output);
    expect(model).toEqual({
      file: "model/cutline-model.gltf",
      format: "gltf",
      animations: ["Focus"],
    });
    await rm(input, { recursive: true });
    expect(await readFile(path.join(output, "model/body.bin"))).toEqual(
      Buffer.from([0, 1, 2, 3]),
    );
    expect(
      await readFile(path.join(output, "model/textures/body.png")),
    ).toEqual(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfoAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    expect(await readdir(path.join(output, "model"))).not.toContain(
      "unrelated-private.txt",
    );
  });

  it("rejects missing, remote, escaping and symlinked model dependencies", async () => {
    const { root, input, output } = await files();
    const file = path.join(input, "lens.gltf");
    await writeFile(path.join(root, "outside.bin"), "private");
    await symlink(
      path.join(root, "outside.bin"),
      path.join(input, "linked.bin"),
    );
    for (const uri of [
      "missing.bin",
      "https://example.com/model.bin",
      "../outside.bin",
      "%2e%2e/outside.bin",
      "/absolute.bin",
      "linked.bin",
    ]) {
      await writeFile(
        file,
        JSON.stringify(json({ buffers: [{ uri, byteLength: 4 }] })),
      );
      await expect(prepareModel3D(file, output)).rejects.toThrow();
    }
    expect(await readdir(output)).toEqual([]);
  });

  it("normalizes generated model filenames and validates external, data and GLB texture pixels", async () => {
    const { input, output } = await files();
    const png = await sharp({
      create: { width: 1, height: 1, channels: 4, background: "#fff" },
    })
      .png()
      .toBuffer();
    const oversized = await sharp({
      create: { width: 8193, height: 1, channels: 4, background: "#fff" },
    })
      .png()
      .toBuffer();
    const unusual = path.join(input, "Camera #1?.glb");
    await writeFile(
      unusual,
      binary(
        json({
          buffers: [{ byteLength: png.length }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
          images: [{ bufferView: 0, mimeType: "image/png" }],
        }),
        png,
      ),
    );
    const accepted = await prepareModel3D(unusual, output);
    expect(accepted.file).toBe("model/cutline-model.glb");
    expect(() =>
      Model3DMetadataSchema.parse({ ...accepted, settings: {} }),
    ).not.toThrow();
    for (const image of [
      { uri: "large.png" },
      { uri: "data:image/png;base64," + oversized.toString("base64") },
      { bufferView: 0, mimeType: "image/png" },
    ]) {
      await writeFile(path.join(input, "large.png"), oversized);
      await writeFile(
        unusual,
        binary(
          json({
            buffers: [{ byteLength: oversized.length }],
            bufferViews: [
              { buffer: 0, byteOffset: 0, byteLength: oversized.length },
            ],
            images: [image],
          }),
          oversized,
        ),
      );
      await expect(prepareModel3D(unusual, output)).rejects.toThrow(
        /8192|texture/,
      );
    }
    await writeFile(
      unusual,
      binary(
        json({
          buffers: [{ byteLength: png.length + 4 }],
          bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: png.length + 4 },
          ],
          images: [{ bufferView: 0 }],
        }),
        png,
      ),
    );
    await expect(prepareModel3D(unusual, output)).rejects.toThrow(/truncated/);
  });

  it("bounds model controls and managed relative paths", () => {
    expect(Model3DSettingsSchema.parse({})).toMatchObject({
      durationSeconds: 6,
      cameraDistance: 1,
      animationIndex: 0,
    });
    for (const settings of [
      { durationSeconds: 121 },
      { cameraDistance: 0 },
      { animationSpeed: Infinity },
      { cameraElevation: 90 },
    ])
      expect(() => Model3DSettingsSchema.parse(settings)).toThrow();
    for (const file of [
      "/model.glb",
      "model/../secret",
      "model\\secret",
      "https://example.com/model.glb",
    ])
      expect(() =>
        Model3DMetadataSchema.parse({
          file,
          format: "glb",
          settings: {},
          animations: [],
        }),
      ).toThrow();
  });
});

describe("immutable model scene versions", () => {
  it("keeps the model and settings through updates and rerenders, but detaches controls after explicit HTML edits", async () => {
    const { root, input } = await files();
    const modelPath = path.join(input, "lens.glb");
    await writeFile(modelPath, binary());
    const jobs = new Jobs(() => {});
    const renderer = new Hyperframes({
      directory: path.join(root, "scenes"),
      jobs,
      browserExecutable: "/unused/chrome",
      ffmpeg: "/unused/ffmpeg",
      ffprobe: "/unused/ffprobe",
      media: {
        import: async (file): Promise<Asset> =>
          AssetSchema.parse({
            id: "render-id",
            name: "render",
            path: file,
            kind: "video",
            duration: 6,
            width: 640,
            height: 360,
          }),
      },
      renderWorker: async (request) => {
        await writeFile(request.output, "render");
      },
    });
    const original = await renderer.render({
      model3d: {
        path: modelPath,
        width: 640,
        height: 360,
        settings: { motion: "static", cameraAzimuth: 42 },
      },
    });
    renderer.accept(original);
    await rm(input, { recursive: true });
    const next = await renderer.render(
      { model3d: { width: 640, height: 360, settings: { cameraAzimuth: 90 } } },
      original,
    );
    expect(next.id).toBe(original.id);
    expect(next.composition!.model3d!.settings).toMatchObject({
      cameraAzimuth: 90,
      motion: "static",
    });
    expect(next.composition!.sourceHash).not.toBe(
      original.composition!.sourceHash,
    );
    expect(
      await readFile(
        path.join(
          path.dirname(original.composition!.entry),
          original.composition!.model3d!.file,
        ),
      ),
    ).toEqual(binary());
    const rerender = await renderer.render(
      { name: "Transparent model", transparent: true },
      next,
    );
    expect(rerender.composition!.model3d!.settings.cameraAzimuth).toBe(90);
    expect(rerender.composition!.transparent).toBe(true);
    expect(rerender.path).toMatch(/\.webm$/u);
    expect(rerender.composition!.source).toContain("background:transparent");
    const html = `<div id="scene" data-composition-id="scene" data-no-timeline data-width="640" data-height="360" data-duration="6">Custom scene</div>`;
    const custom = await renderer.render({ html }, next);
    expect(custom.composition!.model3d).toBeUndefined();
    expect(custom.composition!.source).toBe(html);
    expect(hyperframesDimensions(original.composition!.source)).toEqual({
      width: 640,
      height: 360,
      duration: 6,
    });
    expect(
      await readFile(
        path.join(
          path.dirname(original.composition!.entry),
          "cutline-runtime/addons/loaders/GLTFLoader.js",
        ),
        "utf8",
      ),
    ).toContain("class GLTFLoader");
    renderer.close();
  });
});
