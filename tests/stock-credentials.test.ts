import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StockCredentials } from "../src/main/stock-credentials";

let folder: string;
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) =>
    Buffer.from(value.split("").reverse().join("")),
  decryptString: (value: Buffer) =>
    value.toString().split("").reverse().join(""),
};
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "cutline-credential-test-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("stock credentials", () => {
  it("encrypts at rest, limits file permissions, and exposes only a configured flag", async () => {
    const file = path.join(folder, "stock-credentials.json"),
      store = new StockCredentials(file, encryption),
      key = "a-test-pexels-key-never-real";
    expect(await store.status()).toEqual({
      pexelsConfigured: false,
      secureStorageAvailable: null,
    });
    expect(await store.setPexels(key)).toEqual({
      pexelsConfigured: true,
      secureStorageAvailable: true,
    });
    expect(await readFile(file, "utf8")).not.toContain(key);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.getPexels()).toBe(key);
    expect(Object.keys(await store.status())).toEqual([
      "pexelsConfigured",
      "secureStorageAvailable",
    ]);
    await store.clearPexels();
    expect(await store.getPexels()).toBeUndefined();
    expect(await readdir(folder)).toEqual([]);
  });
  it("does not fall back to plaintext storage when encryption is unavailable", async () => {
    const store = new StockCredentials(path.join(folder, "key.json"), {
      ...encryption,
      isEncryptionAvailable: () => false,
    });
    await expect(
      store.setPexels("a-test-pexels-key-never-real"),
    ).rejects.toThrow("Secure key storage is unavailable");
    expect(await readdir(folder)).toEqual([]);
  });
  it("rejects invalid key shapes without storing them", async () => {
    const store = new StockCredentials(
      path.join(folder, "key.json"),
      encryption,
    );
    for (const key of [
      "",
      "short",
      "this key contains spaces",
      "test-key\ninjected-header",
    ])
      await expect(store.setPexels(key)).rejects.toThrow("valid Pexels");
    expect(await readdir(folder)).toEqual([]);
  });
});
