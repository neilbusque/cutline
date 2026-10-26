/** Original, offline glTF fixture. No exporter, downloaded model or brand assets. */
import * as THREE from "three";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function barrelTexture() {
  const width = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(width * (1 + width * 3));
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const grain = ((x * 13 + y * 7 + ((x * y) % 17)) % 11) - 5;
      const value = 235 + grain - (x % 4 === 0 ? 9 : 0);
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      pixels.fill(value, offset, offset + 3);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Writes a GLB and an equivalent glTF with local buffer and texture dependencies. */
export async function createModel3dFixture(outputDirectory) {
  const directory = path.resolve(outputDirectory);
  await mkdir(path.join(directory, "textures"), { recursive: true });
  const scene = {
    asset: {
      version: "2.0",
      generator: "Cutline original precision lens fixture",
    },
    scene: 0,
    scenes: [{ name: "Precision lens", nodes: [0] }],
    nodes: [{ name: "Precision lens", children: [] }],
    meshes: [],
    materials: [
      {
        name: "Graphite anodized barrel",
        pbrMetallicRoughness: {
          baseColorFactor: [0.047, 0.055, 0.067, 1],
          baseColorTexture: { index: 0 },
          metallicFactor: 0.7,
          roughnessFactor: 0.34,
        },
      },
      {
        name: "Rubber focus grip",
        pbrMetallicRoughness: {
          baseColorFactor: [0.026, 0.03, 0.038, 1],
          metallicFactor: 0.12,
          roughnessFactor: 0.68,
        },
      },
      {
        name: "Brushed titanium",
        pbrMetallicRoughness: {
          baseColorFactor: [0.52, 0.57, 0.63, 1],
          metallicFactor: 0.86,
          roughnessFactor: 0.3,
        },
      },
      {
        name: "Warm focus index",
        pbrMetallicRoughness: {
          baseColorFactor: [0.78, 0.31, 0.105, 1],
          metallicFactor: 0.65,
          roughnessFactor: 0.28,
        },
      },
      {
        name: "Coated optical glass",
        pbrMetallicRoughness: {
          baseColorFactor: [0.025, 0.065, 0.125, 1],
          metallicFactor: 0.6,
          roughnessFactor: 0.085,
        },
        emissiveFactor: [0.007, 0.015, 0.03],
      },
      {
        name: "Optical coating edge",
        pbrMetallicRoughness: {
          baseColorFactor: [0.07, 0.28, 0.27, 1],
          metallicFactor: 0.75,
          roughnessFactor: 0.15,
        },
      },
    ],
    samplers: [
      { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 },
    ],
    textures: [{ source: 0, sampler: 0 }],
    images: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
    animations: [],
  };
  const chunks = [];
  let byteLength = 0;
  const view = (bytes, target) => {
    const padding = (4 - (byteLength % 4)) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      byteLength += padding;
    }
    const id = scene.bufferViews.length;
    scene.bufferViews.push({
      buffer: 0,
      byteOffset: byteLength,
      byteLength: bytes.length,
      ...(target ? { target } : {}),
    });
    chunks.push(bytes);
    byteLength += bytes.length;
    return id;
  };
  const accessor = (array, itemSize, target, bounds = false) => {
    const componentType =
      array instanceof Uint16Array
        ? 5123
        : array instanceof Uint32Array
          ? 5125
          : 5126;
    const entry = {
      bufferView: view(
        Buffer.from(array.buffer, array.byteOffset, array.byteLength),
        target,
      ),
      componentType,
      count: array.length / itemSize,
      type: ["", "SCALAR", "VEC2", "VEC3", "VEC4"][itemSize],
    };
    if (bounds) {
      entry.min = Array(itemSize).fill(Infinity);
      entry.max = Array(itemSize).fill(-Infinity);
      for (let i = 0; i < array.length; i++) {
        const axis = i % itemSize;
        entry.min[axis] = Math.min(entry.min[axis], array[i]);
        entry.max[axis] = Math.max(entry.max[axis], array[i]);
      }
    }
    scene.accessors.push(entry);
    return scene.accessors.length - 1;
  };
  const geometryCache = new Map();
  const meshCache = new Map();
  const add = (name, geometry, material, parent = 0, transform = {}) => {
    let primitive = geometryCache.get(geometry);
    if (!primitive) {
      primitive = { attributes: {} };
      for (const [key, semantic] of [
        ["position", "POSITION"],
        ["normal", "NORMAL"],
        ["uv", "TEXCOORD_0"],
      ]) {
        const attribute = geometry.attributes[key];
        if (attribute)
          primitive.attributes[semantic] = accessor(
            attribute.array,
            attribute.itemSize,
            34962,
            key === "position",
          );
      }
      if (geometry.index)
        primitive.indices = accessor(geometry.index.array, 1, 34963);
      geometryCache.set(geometry, primitive);
    }
    const key = `${geometry.uuid}:${material}`;
    let mesh = meshCache.get(key);
    if (mesh === undefined) {
      mesh = scene.meshes.length;
      scene.meshes.push({ name, primitives: [{ ...primitive, material }] });
      meshCache.set(key, mesh);
    }
    const id = scene.nodes.length;
    scene.nodes.push({ name, mesh, ...transform });
    scene.nodes[parent].children ??= [];
    scene.nodes[parent].children.push(id);
    return id;
  };
  const group = (name, parent = 0) => {
    const id = scene.nodes.length;
    scene.nodes.push({ name, children: [] });
    scene.nodes[parent].children.push(id);
    return id;
  };
  const cylinder = (radius, depth, segments = 96) =>
    new THREE.CylinderGeometry(radius, radius, depth, segments, 1).rotateX(
      Math.PI / 2,
    );
  const ring = (radius, thickness) =>
    new THREE.TorusGeometry(radius, thickness, 12, 96);
  const at = (z, extra = {}) => ({ translation: [0, 0, z], ...extra });

  add("Main barrel", cylinder(0.88, 1.48), 0);
  add("Rear bayonet", cylinder(0.72, 0.19), 2, 0, at(-0.83));
  add("Rear barrel edge", ring(0.86, 0.045), 2, 0, at(-0.7));
  add("Rear rubber band", cylinder(0.91, 0.21), 1, 0, at(-0.47));
  const focus = group("Focus ring");
  add("Focus collar", cylinder(0.94, 0.56), 1, focus, at(0.04));
  const rib = new THREE.BoxGeometry(0.027, 0.049, 0.47);
  for (let i = 0; i < 72; i++) {
    const angle = (i / 72) * Math.PI * 2;
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      angle - Math.PI / 2,
    );
    add(`Focus grip ${i + 1}`, rib, 1, focus, {
      translation: [Math.cos(angle) * 0.952, Math.sin(angle) * 0.952, 0.04],
      rotation: q.toArray(),
    });
  }
  add("Focus rear trim", ring(0.933, 0.025), 0, focus, at(-0.24));
  add("Focus front trim", ring(0.933, 0.025), 0, focus, at(0.32));
  add("Focus index", new THREE.BoxGeometry(0.037, 0.02, 0.11), 3, focus, {
    translation: [0, 0.976, 0.12],
  });
  add("Copper accent ring", ring(0.885, 0.027), 3, 0, at(0.52));

  const front = group("Optical assembly");
  add("Extending front barrel", cylinder(0.83, 0.32), 0, front, at(0.77));
  add("Front bezel", ring(0.825, 0.058), 0, front, at(0.94));
  add("Filter thread", ring(0.785, 0.018), 2, front, at(0.966));
  const glass = new THREE.SphereGeometry(0.77, 64, 32).scale(1, 1, 0.09);
  add("Convex front glass", glass, 4, front, at(0.94));
  add("Optical coating lip", ring(0.756, 0.009), 5, front, at(0.965));
  add("Inner optical ring", ring(0.63, 0.009), 5, front, at(0.981));
  const bolt = cylinder(0.025, 0.008, 16);
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    add(`Bezel fastener ${i + 1}`, bolt, 2, front, {
      translation: [Math.cos(angle) * 0.825, Math.sin(angle) * 0.825, 0.998],
    });
  }

  const times = accessor(
    new Float32Array([0, 1.2, 3, 4.8, 6]),
    1,
    undefined,
    true,
  );
  const positions = accessor(
    new Float32Array([0, 0, 0, 0, 0, 0.04, 0, 0, 0.23, 0, 0, 0.04, 0, 0, 0]),
    3,
  );
  const angles = [0, 0.12, 0.72, 0.12, 0];
  const rotations = accessor(
    new Float32Array(
      angles.flatMap((angle) => [
        0,
        0,
        Math.sin(angle / 2),
        Math.cos(angle / 2),
      ]),
    ),
    4,
  );
  scene.animations.push({
    name: "Focus pull",
    samplers: [
      { input: times, output: positions, interpolation: "LINEAR" },
      { input: times, output: rotations, interpolation: "LINEAR" },
    ],
    channels: [
      { sampler: 0, target: { node: front, path: "translation" } },
      { sampler: 1, target: { node: focus, path: "rotation" } },
    ],
  });
  const texture = barrelTexture();
  scene.images.push({
    name: "Barrel grain",
    bufferView: view(texture),
    mimeType: "image/png",
  });
  const endPadding = (4 - (byteLength % 4)) % 4;
  if (endPadding) chunks.push(Buffer.alloc(endPadding));
  const binary = Buffer.concat(chunks);
  scene.buffers.push({ byteLength: binary.length });
  const json = Buffer.from(JSON.stringify(scene));
  const jsonPadded = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 0x20),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  const glbPath = path.join(directory, "precision-lens.glb");
  await writeFile(
    glbPath,
    Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binary]),
  );
  const external = structuredClone(scene);
  external.buffers[0].uri = "precision-lens.bin";
  external.images[0] = {
    name: "Barrel grain",
    uri: "textures/barrel-grain.png",
  };
  const gltfPath = path.join(directory, "precision-lens.gltf");
  await writeFile(gltfPath, JSON.stringify(external, null, 2) + "\n");
  await writeFile(path.join(directory, "precision-lens.bin"), binary);
  await writeFile(path.join(directory, "textures/barrel-grain.png"), texture);
  const boundsAt = (focusDistance) => {
    const bounds = new THREE.Box3();
    const visit = (id, parentMatrix = new THREE.Matrix4()) => {
      const node = scene.nodes[id];
      const position =
        id === front ? [0, 0, focusDistance] : (node.translation ?? [0, 0, 0]);
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3(...position),
        new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
        new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
      );
      const world = parentMatrix.clone().multiply(local);
      if (node.mesh !== undefined) {
        const data =
          scene.accessors[
            scene.meshes[node.mesh].primitives[0].attributes.POSITION
          ];
        bounds.union(
          new THREE.Box3(
            new THREE.Vector3(...data.min),
            new THREE.Vector3(...data.max),
          ).applyMatrix4(world),
        );
      }
      for (const child of node.children ?? []) visit(child, world);
    };
    visit(0);
    return bounds.getSize(new THREE.Vector3());
  };
  const rest = boundsAt(0);
  const extended = boundsAt(0.23);
  for (const geometry of geometryCache.keys()) geometry.dispose();
  return {
    glbPath,
    gltfPath,
    animation: "Focus pull",
    durationSeconds: 6,
    nodeCount: scene.nodes.length,
    meshCount: scene.meshes.length,
    glbBytes: header.readUInt32LE(8),
    dimensions: {
      width: Number(rest.x.toFixed(4)),
      height: Number(rest.y.toFixed(4)),
      depthAtRest: Number(rest.z.toFixed(4)),
      depthAtFocus: Number(extended.z.toFixed(4)),
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output =
    process.argv[2] ??
    fileURLToPath(new URL("../../../3d-proof/model", import.meta.url));
  console.log(JSON.stringify(await createModel3dFixture(output), null, 2));
}
