import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Model3DMetadata } from "../shared/model-3d";

export const MODEL3D_MAX_BYTES = 128 * 1024 ** 2;
const MAX_TOTAL_BYTES = 128 * 1024 ** 2;
const MAX_FILES = 256;
const compressed = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_meshopt_compression",
  "KHR_texture_basisu",
]);
const supported = new Set([
  "KHR_lights_punctual",
  "KHR_materials_anisotropy",
  "KHR_materials_clearcoat",
  "KHR_materials_dispersion",
  "KHR_materials_emissive_strength",
  "KHR_materials_ior",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_materials_iridescence",
  "KHR_materials_unlit",
  "KHR_materials_volume",
  "KHR_mesh_quantization",
  "KHR_texture_transform",
  "EXT_materials_bump",
  "EXT_mesh_gpu_instancing",
  "EXT_texture_avif",
  "EXT_texture_webp",
]);
type Gltf = {
  asset?: { version?: unknown; minVersion?: unknown };
  buffers?: { uri?: unknown; byteLength?: unknown }[];
  images?: { uri?: unknown; bufferView?: unknown; mimeType?: unknown }[];
  extensionsUsed?: unknown[];
  extensionsRequired?: unknown[];
  animations?: { name?: unknown; channels?: unknown[] }[];
  accessors?: { count?: unknown; sparse?: { count?: unknown } }[];
  bufferViews?: {
    buffer?: unknown;
    byteOffset?: unknown;
    byteLength?: unknown;
  }[];
  meshes?: { primitives?: unknown[] }[];
  nodes?: { children?: unknown[] }[];
  textures?: unknown[];
  skins?: { joints?: unknown[] }[];
};
const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw Error("Cancelled");
};

export function parseModel3D(data: Buffer, format: "glb" | "gltf"): Gltf {
  let json: Buffer = data;
  if (data.length > MODEL3D_MAX_BYTES)
    throw Error("Keep each model file below 128 MB.");
  if (format === "glb") {
    if (
      data.length < 20 ||
      data.readUInt32LE(0) !== 0x46546c67 ||
      data.readUInt32LE(4) !== 2 ||
      data.readUInt32LE(8) !== data.length
    )
      throw Error("This GLB is incomplete or is not a glTF 2.0 binary file.");
    let offset = 12,
      chunks = 0,
      bins = 0;
    json = Buffer.alloc(0);
    while (offset < data.length) {
      if (offset + 8 > data.length)
        throw Error("The GLB contains a truncated chunk.");
      const size = data.readUInt32LE(offset),
        kind = data.readUInt32LE(offset + 4);
      offset += 8;
      if (size % 4 || offset + size > data.length)
        throw Error("The GLB contains an invalid chunk length.");
      if (chunks === 0 && kind !== 0x4e4f534a)
        throw Error("The first GLB chunk must contain glTF JSON.");
      if (kind === 0x4e4f534a) {
        if (json.length) throw Error("The GLB contains duplicate JSON chunks.");
        json = data.subarray(offset, offset + size);
      } else if (kind === 0x004e4942 && ++bins > 1)
        throw Error("The GLB contains duplicate binary chunks.");
      offset += size;
      chunks++;
    }
  }
  let result: Gltf;
  try {
    result = JSON.parse(json.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    throw Error("The model does not contain valid glTF JSON.");
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.asset?.version !== "2.0" ||
    (result.asset.minVersion !== undefined && result.asset.minVersion !== "2.0")
  )
    throw Error(
      "Cutline imports glTF 2.0 models. Export this model as GLB or glTF 2.0.",
    );
  for (const key of [
    "buffers",
    "images",
    "animations",
    "extensionsUsed",
    "extensionsRequired",
  ] as const) {
    if (result[key] !== undefined && !Array.isArray(result[key]))
      throw Error(`The model's ${key} must be a list.`);
  }
  for (const extension of [
    ...(result.extensionsUsed ?? []),
    ...(result.extensionsRequired ?? []),
  ]) {
    if (typeof extension !== "string")
      throw Error("The model contains an invalid extension name.");
    if (compressed.has(extension))
      throw Error(
        `This model uses ${extension}. Export an uncompressed GLB with PNG or JPEG textures for Cutline.`,
      );
  }
  for (const extension of result.extensionsRequired ?? []) {
    if (!supported.has(String(extension)))
      throw Error(
        `The required model extension ${String(extension)} is not supported. Export a standard glTF 2.0 model.`,
      );
  }
  for (const [key, limit] of Object.entries({
    accessors: 8192,
    bufferViews: 8192,
    meshes: 2048,
    nodes: 8192,
    textures: 256,
    skins: 128,
    animations: 128,
    images: 256,
    buffers: 256,
  })) {
    const value = (result as Record<string, unknown>)[key];
    if (value !== undefined && (!Array.isArray(value) || value.length > limit))
      throw Error(`Keep the model to at most ${limit} ${key}.`);
  }
  let accessorElements = 0;
  for (const accessor of result.accessors ?? []) {
    if (
      !accessor ||
      !Number.isInteger(accessor.count) ||
      Number(accessor.count) < 0 ||
      Number(accessor.count) > 2_000_000
    )
      throw Error(
        "A model accessor is invalid or exceeds two million elements. Simplify the mesh before importing.",
      );
    accessorElements += Number(accessor.count);
    if (accessorElements > 8_000_000)
      throw Error(
        "The model has too many geometry or animation elements. Simplify it before importing.",
      );
    if (
      accessor.sparse &&
      (!Number.isInteger(accessor.sparse.count) ||
        Number(accessor.sparse.count) < 0 ||
        Number(accessor.sparse.count) > Number(accessor.count))
    )
      throw Error("The model has an invalid sparse accessor.");
  }
  let primitives = 0,
    channels = 0;
  for (const mesh of result.meshes ?? []) {
    if (!mesh || !Array.isArray(mesh.primitives))
      throw Error("The model contains an invalid mesh.");
    primitives += mesh.primitives.length;
  }
  for (const animation of result.animations ?? []) {
    if (!animation || !Array.isArray(animation.channels))
      throw Error("The model contains an invalid animation.");
    channels += animation.channels.length;
  }
  if (primitives > 8192 || channels > 8192)
    throw Error(
      "Simplify the model to at most 8192 mesh parts and animation channels.",
    );
  for (const skin of result.skins ?? [])
    if (!skin || !Array.isArray(skin.joints) || skin.joints.length > 512)
      throw Error("Keep each animated skeleton to at most 512 joints.");
  const nodes = result.nodes ?? [];
  const parents = Array<number>(nodes.length).fill(0);
  for (const node of nodes) {
    if (!node || (node.children !== undefined && !Array.isArray(node.children)))
      throw Error("The model contains an invalid node.");
    for (const child of node.children ?? []) {
      if (
        !Number.isInteger(child) ||
        Number(child) < 0 ||
        Number(child) >= nodes.length ||
        ++parents[Number(child)] > 1
      )
        throw Error("The model has an invalid node hierarchy.");
    }
  }
  const queue = parents.flatMap((count, index) =>
    count === 0 ? [{ index, depth: 0 }] : [],
  );
  for (let at = 0; at < queue.length; at++) {
    const { index, depth } = queue[at];
    if (depth > 512)
      throw Error(
        "The model node hierarchy is too deep. Flatten it before importing.",
      );
    for (const child of nodes[index].children ?? [])
      queue.push({ index: Number(child), depth: depth + 1 });
  }
  if (queue.length !== nodes.length)
    throw Error("The model node hierarchy contains a cycle.");
  const pending: unknown[] = [result];
  let visited = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (++visited > 250_000)
      throw Error(
        "The model structure is too large. Simplify it before importing.",
      );
    const record = item as Record<string, unknown>;
    if (record.mimeType === "image/ktx2")
      throw Error("Export PNG or JPEG textures instead of KTX2 textures.");
    if (record.extensions && typeof record.extensions === "object")
      for (const extension of Object.keys(record.extensions))
        if (compressed.has(extension))
          throw Error(
            `This model uses ${extension}. Export an uncompressed GLB with PNG or JPEG textures for Cutline.`,
          );
    for (const key in record) {
      const value = record[key];
      if (value && typeof value === "object") pending.push(value);
    }
  }
  return result;
}

function dependency(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri)
    throw Error("A model resource has an invalid URI.");
  if (/^data:/iu.test(uri)) {
    if (
      !/^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp|avif));base64,[a-z\d+/]*={0,2}$/iu.test(
        uri,
      )
    )
      throw Error(
        "Embedded model resources must be base64 buffers or PNG, JPEG, WebP or AVIF images.",
      );
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw Error("A model resource has an invalid encoded filename.");
  }
  if (
    path.isAbsolute(decoded) ||
    /[\\\x00-\x1f:?#]/u.test(decoded) ||
    decoded.split("/").some((p) => !p || p === ".." || p === ".")
  )
    throw Error(
      "Model buffers and textures must use local relative files inside the model folder. Remote URLs and parent paths are not supported.",
    );
  return decoded;
}

function binaryChunk(data: Buffer): Buffer | undefined {
  for (let offset = 12; offset + 8 <= data.length;) {
    const size = data.readUInt32LE(offset),
      kind = data.readUInt32LE(offset + 4);
    if (kind === 0x004e4942)
      return data.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size;
  }
}

async function validateTextures(
  gltf: Gltf,
  data: Buffer,
  format: "glb" | "gltf",
  root: string,
  signal?: AbortSignal,
) {
  const fromUri = async (uri: unknown): Promise<Buffer> => {
    const relative = dependency(uri);
    return relative
      ? readFile(path.join(root, relative))
      : Buffer.from(String(uri).slice(String(uri).indexOf(",") + 1), "base64");
  };
  const buffers: Buffer[] = [];
  for (const [index, buffer] of (gltf.buffers ?? []).entries()) {
    check(signal);
    const bytes =
      buffer.uri !== undefined
        ? await fromUri(buffer.uri)
        : index === 0 && format === "glb"
          ? binaryChunk(data)
          : undefined;
    if (!bytes || bytes.length < Number(buffer.byteLength))
      throw Error("A model buffer is missing or truncated.");
    buffers.push(bytes);
  }
  let pixels = 0;
  for (const image of gltf.images ?? []) {
    check(signal);
    let bytes: Buffer;
    if (image.uri !== undefined) bytes = await fromUri(image.uri);
    else {
      const index = Number(image.bufferView);
      if (
        !Number.isInteger(image.bufferView) ||
        index < 0 ||
        index >= (gltf.bufferViews?.length ?? 0)
      )
        throw Error("The model contains an invalid texture buffer view.");
      const view = gltf.bufferViews![index];
      const bufferIndex = Number(view?.buffer),
        offset = Number(view?.byteOffset ?? 0),
        length = Number(view?.byteLength);
      if (
        !Number.isInteger(view?.buffer) ||
        bufferIndex < 0 ||
        bufferIndex >= buffers.length ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(length) ||
        length <= 0 ||
        offset + length > buffers[bufferIndex].length
      )
        throw Error("A model texture buffer view is invalid or truncated.");
      bytes = buffers[bufferIndex].subarray(offset, offset + length);
    }
    let width: number | undefined,
      height: number | undefined,
      imageFormat: string | undefined;
    try {
      const metadata = await sharp(bytes, {
        limitInputPixels: 32_000_000,
      }).metadata();
      if ((metadata.pages ?? 1) > 1)
        throw Error("Animated image textures are not supported.");
      width = metadata.width;
      height = metadata.height;
      imageFormat = metadata.format;
    } catch {
      throw Error(
        "A model texture is damaged or too large. Use PNG, JPEG, WebP or AVIF images within 8192 pixels per side and 32 million pixels in total.",
      );
    }
    if (
      !width ||
      !height ||
      width > 8192 ||
      height > 8192 ||
      !["png", "jpeg", "webp", "heif"].includes(imageFormat ?? "")
    )
      throw Error(
        "Model textures must be PNG, JPEG, WebP or AVIF images within 8192 pixels per side.",
      );
    pixels += width * height;
    if (pixels > 32_000_000)
      throw Error(
        "Keep model textures below 32 million decoded pixels in total.",
      );
  }
}

/** Copies the selected model and only its declared buffers/textures. */
export async function prepareModel3D(
  file: string,
  sourceDirectory: string,
  signal?: AbortSignal,
): Promise<Pick<Model3DMetadata, "file" | "format" | "animations">> {
  check(signal);
  if (!path.isAbsolute(file) || !/\.(?:glb|gltf)$/iu.test(file))
    throw Error("Choose an absolute local .glb or .gltf model file.");
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw Error("Choose the actual 3D model file, not a symbolic link.");
  if (info.size > MODEL3D_MAX_BYTES)
    throw Error("Keep each model file below 128 MB.");
  const format = path.extname(file).slice(1).toLowerCase() as "glb" | "gltf";
  const data = await readFile(file);
  check(signal);
  const gltf = parseModel3D(data, format);
  const root = await realpath(path.dirname(file));
  const files = new Map<string, string>();
  for (const item of [...(gltf.buffers ?? []), ...(gltf.images ?? [])]) {
    if (!item || typeof item !== "object")
      throw Error("The model contains an invalid resource.");
    if (
      "byteLength" in item &&
      (!Number.isInteger(item.byteLength) ||
        Number(item.byteLength) < 0 ||
        Number(item.byteLength) > MAX_TOTAL_BYTES)
    )
      throw Error("The model contains an invalid or oversized buffer.");
    if (item.uri === undefined) continue;
    const relative = dependency(item.uri);
    if (relative) files.set(relative, path.join(root, relative));
  }
  if (files.size + 1 > MAX_FILES)
    throw Error("Keep the model to at most 256 local files.");
  let bytes = data.length;
  for (const [relative, from] of files) {
    check(signal);
    // Every dependency path segment must be a real file/directory inside root.
    let cursor = root;
    for (const part of relative.split("/")) {
      cursor = path.join(cursor, part);
      let current;
      try {
        current = await lstat(cursor);
      } catch {
        throw Error(
          `Missing model resource: ${relative}. Keep the model and its textures together.`,
        );
      }
      if (current.isSymbolicLink())
        throw Error(`Model resources cannot be symbolic links: ${relative}.`);
    }
    const current = await lstat(from);
    if (!current.isFile())
      throw Error(`Model resource is not a file: ${relative}.`);
    bytes += current.size;
    if (current.size > MODEL3D_MAX_BYTES || bytes > MAX_TOTAL_BYTES)
      throw Error("Keep the model and its textures below 128 MB in total.");
  }
  await validateTextures(gltf, data, format, root, signal);
  check(signal);
  const destination = path.join(sourceDirectory, "model");
  let modelName = `cutline-model.${format}`,
    suffix = 0;
  while (files.has(modelName))
    modelName = `cutline-model-${++suffix}.${format}`;
  await mkdir(destination, { recursive: true });
  // Write the bytes that were validated, rather than re-reading a mutable source.
  await writeFile(path.join(destination, modelName), data);
  for (const [relative, from] of files) {
    check(signal);
    const to = path.join(destination, relative);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to, constants.COPYFILE_FICLONE);
  }
  return {
    file: `model/${modelName}`,
    format,
    animations: (gltf.animations ?? []).map((animation, index) =>
      typeof animation?.name === "string" && animation.name.trim()
        ? animation.name.trim().slice(0, 200)
        : `Animation ${index + 1}`,
    ),
  };
}
