import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GenerationCredentials,
  type SecureStorage,
} from "../src/main/generation-credentials";
import { StockCredentials } from "../src/main/stock-credentials";

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "cutline-credential-status-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});
const providers = [
  {
    name: "Higgsfield",
    field: "higgsfield",
    flag: "configured",
    make(file: string, encryption: SecureStorage) {
      const store = new GenerationCredentials(file, encryption);
      return {
        status: () => store.status(),
        get: () => store.getKey(),
        save: (key: string) => store.setKey(key),
        clear: () => store.clearKey(),
      };
    },
  },
  {
    name: "Pexels",
    field: "pexels",
    flag: "pexelsConfigured",
    make(file: string, encryption: SecureStorage) {
      const store = new StockCredentials(file, encryption);
      return {
        status: () => store.status(),
        get: () => store.getPexels(),
        save: (key: string) => store.setPexels(key),
        clear: () => store.clearPexels(),
      };
    },
  },
];
const key = "test-only-cloud-key-never-real";
const ciphertext = Buffer.from("encrypted credential fixture").toString(
  "base64",
);
const encryption = () => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn(() => Buffer.from("encrypted credential fixture")),
  decryptString: vi.fn((_value: Buffer): string => {
    throw Error(
      "Keychain decryption must require an explicit provider action.",
    );
  }),
});

for (const provider of providers) {
  describe(`${provider.name} credentials metadata`, () => {
    it("never calls any safeStorage method for missing, saved or malformed metadata", async () => {
      const file = path.join(folder, "credentials.json"),
        secure = encryption();
      secure.isEncryptionAvailable.mockImplementation(() => {
        throw Error("Keychain availability probe must require explicit use.");
      });
      secure.encryptString.mockImplementation(() => {
        throw Error("Encryption must require an explicit save.");
      });
      const store = provider.make(file, secure);
      expect(await store.status()).toEqual({
        [provider.flag]: false,
        secureStorageAvailable: null,
      });
      const saved = JSON.stringify({
        version: 1,
        [provider.field]: ciphertext,
      });
      await writeFile(file, saved);
      expect(await store.status()).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: null,
      });
      expect(await readFile(file, "utf8")).toBe(saved);
      await expect(store.get()).rejects.toThrow(
        "Keychain availability probe must require explicit use",
      );
      expect(await store.status()).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: null,
      });
      expect(secure.isEncryptionAvailable).toHaveBeenCalledTimes(1);
      secure.isEncryptionAvailable.mockClear();
      await writeFile(file, "{");
      expect(await store.status()).toMatchObject({
        [provider.flag]: false,
        secureStorageAvailable: null,
        storageError: expect.any(String),
      });
      expect(await store.clear()).toEqual({
        [provider.flag]: false,
        secureStorageAvailable: null,
      });
      expect(secure.isEncryptionAvailable).not.toHaveBeenCalled();
      expect(secure.encryptString).not.toHaveBeenCalled();
      expect(secure.decryptString).not.toHaveBeenCalled();
    });

    it("caches availability for status but rechecks it on every explicit use", async () => {
      const file = path.join(folder, "credentials.json"),
        secure = encryption();
      const store = provider.make(file, secure);
      await store.save(key);
      expect(secure.isEncryptionAvailable).toHaveBeenCalledTimes(1);
      expect(await store.status()).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: true,
      });
      expect(secure.isEncryptionAvailable).toHaveBeenCalledTimes(1);
      secure.isEncryptionAvailable.mockReturnValue(false);
      await expect(store.get()).rejects.toThrow(
        "Secure key storage is unavailable",
      );
      expect(await store.status()).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: false,
      });
      expect(secure.isEncryptionAvailable).toHaveBeenCalledTimes(2);
      expect(secure.decryptString).not.toHaveBeenCalled();
      secure.isEncryptionAvailable.mockReturnValue(true);
      secure.decryptString.mockReturnValue(key);
      expect(await store.get()).toBe(key);
      expect(await store.status()).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: true,
      });
      expect(secure.isEncryptionAvailable).toHaveBeenCalledTimes(3);
    });

    it("allows an explicit save to retry after secure storage becomes available", async () => {
      const file = path.join(folder, "credentials.json"),
        secure = encryption();
      const original = JSON.stringify({
        version: 1,
        [provider.field]: ciphertext,
      });
      await writeFile(file, original);
      const store = provider.make(file, secure);
      secure.isEncryptionAvailable.mockReturnValue(false);
      await expect(store.save(key)).rejects.toThrow(
        "Secure key storage is unavailable",
      );
      expect(await store.status()).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: false,
      });
      expect(await readFile(file, "utf8")).toBe(original);
      expect(secure.encryptString).not.toHaveBeenCalled();
      expect(secure.decryptString).not.toHaveBeenCalled();
      secure.isEncryptionAvailable.mockReturnValue(true);
      expect(await store.save(key)).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: true,
      });
      expect(secure.isEncryptionAvailable).toHaveBeenCalledTimes(2);
      expect(secure.encryptString).toHaveBeenCalledWith(key);
      expect(secure.decryptString).not.toHaveBeenCalled();
      expect(await readdir(folder)).toEqual(["credentials.json"]);
    });

    it("reports a saved key without decrypting it, while explicit use still reports Keychain failure", async () => {
      const file = path.join(folder, "credentials.json"),
        secure = encryption();
      const store = provider.make(file, secure);
      expect(await store.save(key)).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: true,
      });
      const saved = await readFile(file, "utf8");
      expect(saved).not.toContain(key);
      expect(await store.status()).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: true,
      });
      expect(secure.decryptString).not.toHaveBeenCalled();
      await expect(store.get()).rejects.toThrow(
        `The saved ${provider.name} key could not be read`,
      );
      expect(secure.decryptString).toHaveBeenCalledTimes(1);
      expect(await readFile(file, "utf8")).toBe(saved);
      expect(await store.status()).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: true,
      });
      expect(secure.decryptString).toHaveBeenCalledTimes(1);
    });

    it("reports absent credentials and clears a saved key without a decrypt request", async () => {
      const file = path.join(folder, "credentials.json"),
        secure = encryption();
      const store = provider.make(file, secure);
      expect(await store.status()).toEqual({
        [provider.flag]: false,
        secureStorageAvailable: null,
      });
      expect(await store.get()).toBeUndefined();
      expect(secure.isEncryptionAvailable).not.toHaveBeenCalled();
      await store.save(key);
      expect(await store.clear()).toEqual({
        [provider.flag]: false,
        secureStorageAvailable: true,
      });
      expect(secure.decryptString).not.toHaveBeenCalled();
      expect(await readdir(folder)).toEqual([]);
    });

    it("reports encryption availability separately from a saved envelope", async () => {
      const file = path.join(folder, "credentials.json"),
        secure = encryption();
      secure.isEncryptionAvailable.mockReturnValue(false);
      const saved = JSON.stringify({
        version: 1,
        [provider.field]: ciphertext,
      });
      await writeFile(file, saved);
      const store = provider.make(file, secure);
      expect(await store.status()).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: null,
      });
      expect(secure.isEncryptionAvailable).not.toHaveBeenCalled();
      await expect(store.get()).rejects.toThrow(
        "Secure key storage is unavailable",
      );
      expect(await store.status()).toEqual({
        [provider.flag]: true,
        secureStorageAvailable: false,
      });
      await expect(store.save(key)).rejects.toThrow(
        "Secure key storage is unavailable",
      );
      expect(secure.decryptString).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8")).toBe(saved);
    });

    it("still decrypts and validates a key when a provider explicitly uses it", async () => {
      const file = path.join(folder, "credentials.json"),
        secure = encryption();
      await writeFile(
        file,
        JSON.stringify({ version: 1, [provider.field]: ciphertext }),
      );
      const store = provider.make(file, secure);
      secure.decryptString.mockReturnValue(key);
      expect(await store.get()).toBe(key);
      expect(secure.decryptString).toHaveBeenCalledWith(
        Buffer.from(ciphertext, "base64"),
      );
      secure.decryptString.mockReturnValue("short");
      await expect(store.get()).rejects.toThrow(
        `The saved ${provider.name} key could not be read`,
      );
      expect(secure.decryptString).toHaveBeenCalledTimes(2);
      expect(await store.status()).toMatchObject({ [provider.flag]: true });
      expect(secure.decryptString).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["invalid JSON", "{"],
      ["null envelope", "null"],
      ["array envelope", "[]"],
      ["missing fields", "{}"],
      [
        "unsupported version",
        JSON.stringify({ version: 2, [provider.field]: ciphertext }),
      ],
      [
        "non-string ciphertext",
        JSON.stringify({ version: 1, [provider.field]: 123 }),
      ],
      [
        "empty ciphertext",
        JSON.stringify({ version: 1, [provider.field]: "" }),
      ],
      [
        "invalid base64",
        JSON.stringify({ version: 1, [provider.field]: "@@!!" }),
      ],
      [
        "non-canonical base64",
        JSON.stringify({ version: 1, [provider.field]: "YR==" }),
      ],
      [
        "unbounded ciphertext",
        JSON.stringify({ version: 1, [provider.field]: "a".repeat(16388) }),
      ],
    ])(
      "reports %s without decrypting or rewriting the saved file",
      async (_name, contents) => {
        const file = path.join(folder, "credentials.json"),
          secure = encryption();
        await writeFile(file, contents);
        const store = provider.make(file, secure);
        expect(await store.status()).toEqual({
          [provider.flag]: false,
          secureStorageAvailable: null,
          storageError: `The saved ${provider.name} key could not be read. Save your key again.`,
        });
        expect(secure.decryptString).not.toHaveBeenCalled();
        await expect(store.get()).rejects.toThrow(
          `The saved ${provider.name} key could not be read`,
        );
        expect(secure.decryptString).not.toHaveBeenCalled();
        expect(await readFile(file, "utf8")).toBe(contents);
      },
    );
  });
}
