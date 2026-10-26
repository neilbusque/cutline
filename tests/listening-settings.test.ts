import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readListeningSettings,
  writeListeningSettings,
} from "../src/main/listening-settings";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cutline-listening-settings-"),
  );
  roots.push(root);
  return { root, file: path.join(root, "listening.json") };
}

describe("listening review settings", () => {
  it("keeps hosted review disabled on a fresh install without creating a file", async () => {
    const { root, file } = await setup();
    expect(readListeningSettings(file)).toEqual({
      enabled: false,
      autoFix: true,
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("persists an explicit opt-in and preserves omitted settings in later updates", async () => {
    const { file } = await setup();
    expect(writeListeningSettings(file, { enabled: true })).toEqual({
      enabled: true,
      autoFix: true,
    });
    expect(readListeningSettings(file)).toEqual({
      enabled: true,
      autoFix: true,
    });
    expect(writeListeningSettings(file, { autoFix: false })).toEqual({
      enabled: true,
      autoFix: false,
    });
    expect(writeListeningSettings(file, { enabled: false })).toEqual({
      enabled: false,
      autoFix: false,
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      enabled: false,
      autoFix: false,
    });
  });

  it.each([
    { enabled: "true" },
    { autoFix: 1 },
    { enabled: true, uploadAllMedia: true },
    null,
    [],
    "enabled",
    { provider: "untrusted.example" },
  ])(
    "rejects an invalid update without changing the existing consent: %j",
    async (patch) => {
      const { file } = await setup();
      writeListeningSettings(file, { enabled: false, autoFix: false });
      const before = await readFile(file, "utf8");
      expect(() => writeListeningSettings(file, patch)).toThrow();
      expect(await readFile(file, "utf8")).toBe(before);
      expect(readListeningSettings(file)).toEqual({
        enabled: false,
        autoFix: false,
      });
    },
  );

  it.each([
    "{invalid",
    '{"enabled":true}',
    '{"enabled":"true","autoFix":true}',
    '{"enabled":true,"autoFix":true,"extra":1}',
    "null",
  ])(
    "fails closed on corrupt or incompatible persisted settings: %s",
    async (content) => {
      const { file } = await setup();
      await writeFile(file, content);
      expect(readListeningSettings(file)).toEqual({
        enabled: false,
        autoFix: true,
      });
      expect(await readFile(file, "utf8")).toBe(content);
    },
  );

  it("creates parent folders, writes owner-only settings, and leaves no temporary file", async () => {
    const { root } = await setup();
    const file = path.join(root, "preferences", "listening.json");
    writeListeningSettings(file, { enabled: true, autoFix: true });
    expect(await readdir(path.dirname(file))).toEqual(["listening.json"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(readListeningSettings(file)).toEqual({
      enabled: true,
      autoFix: true,
    });
  });
});
