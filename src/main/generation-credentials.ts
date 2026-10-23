import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
export type GenerationCredentialStatus = {
  configured: boolean;
  secureStorageAvailable: boolean | null;
  storageError?: string;
};

/** Inject Electron safeStorage after app.whenReady(). Never import this into the renderer. */
export type SecureStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export class GenerationCredentials {
  private storageAvailable: boolean | null = null;
  constructor(
    private file: string,
    private encryption: SecureStorage,
  ) {}

  async status(): Promise<GenerationCredentialStatus> {
    const secureStorageAvailable = this.storageAvailable;
    try {
      // A settings read reports saved ciphertext, not whether Keychain can
      // currently unlock it. Only an explicit provider action decrypts it.
      const contents = await readFile(this.file, "utf8");
      this.encryptedValue(contents);
      return {
        configured: true,
        secureStorageAvailable,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { configured: false, secureStorageAvailable };
      return {
        configured: false,
        secureStorageAvailable,
        storageError:
          "The saved Higgsfield key could not be read. Save your key again.",
      };
    }
  }

  /** Main-process use only; status() is the only read exposed over IPC. */
  async getKey(): Promise<string | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw Error("Unable to read the saved Higgsfield key.");
    }
    if (!this.checkStorageAvailable())
      throw Error(
        "Secure key storage is unavailable. Unlock your macOS keychain and try again.",
      );
    try {
      return this.validate(
        this.encryption.decryptString(this.encryptedValue(contents)),
      );
    } catch {
      throw Error(
        "The saved Higgsfield key could not be read. Save your key again.",
      );
    }
  }

  async setKey(value: unknown): Promise<GenerationCredentialStatus> {
    const key = this.validate(value);
    if (!this.checkStorageAvailable())
      throw Error(
        "Secure key storage is unavailable. Unlock your macOS keychain and try again.",
      );
    const encrypted = this.encryption.encryptString(key).toString("base64");
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, higgsfield: encrypted }),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return this.status();
  }

  async clearKey(): Promise<GenerationCredentialStatus> {
    await unlink(this.file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return this.status();
  }

  /** Even availability probes may prompt Keychain on macOS. Probe only on use. */
  private checkStorageAvailable(): boolean {
    this.storageAvailable = null;
    this.storageAvailable = this.encryption.isEncryptionAvailable();
    return this.storageAvailable;
  }

  /** Validate only the envelope. Never touch Keychain while reporting status. */
  private encryptedValue(contents: string): Buffer {
    const stored = JSON.parse(contents);
    const encoded = stored?.higgsfield;
    if (
      stored?.version !== 1 ||
      typeof encoded !== "string" ||
      !encoded.length ||
      encoded.length > 16384 ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      throw Error("Invalid saved credential envelope.");
    const ciphertext = Buffer.from(encoded, "base64");
    if (!ciphertext.length || ciphertext.toString("base64") !== encoded)
      throw Error("Invalid saved credential envelope.");
    return ciphertext;
  }

  private validate(value: unknown) {
    if (typeof value !== "string") throw Error("Enter a Higgsfield API key.");
    const key = value.trim();
    if (key.length < 8 || key.length > 4096 || /[^\x21-\x7e]/.test(key))
      throw Error("Enter a valid Higgsfield API key with no spaces.");
    return key;
  }
}
