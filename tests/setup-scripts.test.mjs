import {
  browserDirectory,
  browserExecutable,
  browserOptions,
} from "../scripts/browser-config.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  assertPortableWhisper,
  assertChromeManifestVersion,
  assertRedistributableFfmpeg,
  assertSupportedPlatform,
  developmentEnvironment,
  chromeDistribution,
  chromeFileNames,
  downloadVerified,
  packageIgnore,
  prepareMediaBinaries,
  replaceVerifiedDirectory,
  stageVendorResources,
  validateVendorResources,
  validateChromeResources,
  vendorResourceFiles,
  verifiedFile,
} from "../scripts/setup-support.mjs";
import {
  assertSelfContainedDirectory,
  packageWithVendorResources,
} from "../scripts/package-vendor.mjs";

let directory;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "cutline-setup-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const expected = (bytes = Buffer.from("verified model")) => ({
  url: "https://example.invalid/model.bin",
  size: bytes.length,
  sha: createHash("sha256").update(bytes).digest("hex"),
});

describe("Verified local dependency setup", () => {
  it.each(["copy", "validation"])(
    "cleans a rejected Chrome stage after %s failure and preserves the working browser",
    async (failure) => {
      const destination = path.join(directory, "browser");
      await mkdir(destination);
      await writeFile(path.join(destination, "old"), "working browser");
      await expect(
        replaceVerifiedDirectory(
          "unused",
          destination,
          async () => {
            throw Error("bad executable");
          },
          async (_source, staged) => {
            await mkdir(staged);
            await writeFile(path.join(staged, "partial"), "unfinished copy");
            if (failure === "copy") throw Error("disk full");
          },
        ),
      ).rejects.toThrow(failure === "copy" ? "disk full" : "bad executable");
      expect(await readdir(directory)).toEqual(["browser"]);
      expect(await readFile(path.join(destination, "old"), "utf8")).toBe(
        "working browser",
      );
    },
  );

  it("replaces the browser only after successful validation and removes the old stage", async () => {
    const source = path.join(directory, "source"),
      destination = path.join(directory, "browser");
    await mkdir(source);
    await mkdir(destination);
    await writeFile(path.join(source, "new"), "new browser");
    await writeFile(path.join(destination, "old"), "old browser");
    await replaceVerifiedDirectory(source, destination, async (staged) => {
      expect(await readFile(path.join(staged, "new"), "utf8")).toBe(
        "new browser",
      );
      expect(await readFile(path.join(destination, "old"), "utf8")).toBe(
        "old browser",
      );
    });
    expect((await readdir(directory)).sort()).toEqual(["browser", "source"]);
    expect(await readdir(destination)).toEqual(["new"]);
  });

  it("installs exact bytes and reuses valid files without any network request", async () => {
    const destination = path.join(directory, "nested/model.bin");
    const bytes = Buffer.from("verified model");
    const fetcher = vi.fn(async () => new Response(bytes));
    expect(await downloadVerified(destination, expected(bytes), fetcher)).toBe(
      true,
    );
    expect(await readFile(destination)).toEqual(bytes);
    expect(await verifiedFile(destination, expected(bytes))).toBe(true);
    expect(await downloadVerified(destination, expected(bytes), fetcher)).toBe(
      false,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readdir(path.dirname(destination))).toEqual(["model.bin"]);
  });

  it.each([
    "wrong digest",
    "short body",
    "oversized body",
    "HTTP error",
    "stream failure",
  ])(
    "keeps the old model and removes temporary files after %s",
    async (failure) => {
      const destination = path.join(directory, "model.bin");
      const old = Buffer.from("older valid model");
      await writeFile(destination, old);
      const bytes = Buffer.from("verified model");
      const fetcher = vi.fn(async () => {
        if (failure === "HTTP error")
          return new Response("Denied", { status: 403 });
        if (failure === "stream failure")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                controller.error(Error("connection lost"));
              },
            }),
          );
        const body =
          failure === "short body"
            ? bytes.subarray(0, 3)
            : failure === "oversized body"
              ? Buffer.concat([bytes, bytes])
              : Buffer.alloc(bytes.length, 65);
        return new Response(body);
      });
      await expect(
        downloadVerified(destination, expected(bytes), fetcher),
      ).rejects.toThrow();
      expect(await readFile(destination)).toEqual(old);
      expect(await readdir(directory)).toEqual(["model.bin"]);
    },
  );

  it("repairs corrupted files only after the replacement checksum passes", async () => {
    const destination = path.join(directory, "model.bin");
    await writeFile(destination, "corrupt");
    expect(await verifiedFile(destination, expected())).toBe(false);
    await downloadVerified(
      destination,
      expected(),
      async () => new Response("verified model"),
    );
    expect(await verifiedFile(destination, expected())).toBe(true);
  });

  it("rejects non-HTTPS dependency sources without contacting them", async () => {
    const fetcher = vi.fn();
    await expect(
      downloadVerified(
        path.join(directory, "model.bin"),
        { ...expected(), url: "http://example.invalid/model.bin" },
        fetcher,
      ),
    ).rejects.toThrow("HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("Source and package boundaries", () => {
  const speechFiles = [
    { name: "config.json" },
    { name: "onnx/model_quantized.onnx" },
  ];
  const chrome = {
    files: [
      "chrome-headless-shell",
      "LICENSE.headless_shell",
      "gen/frontend.js",
    ].map((name) => ({
      name,
      ...expected(Buffer.from(`required chrome-mac-arm64/${name}`)),
    })),
  };
  const vendorFixture = async () => {
    const root = path.join(directory, "vendor");
    for (const file of vendorResourceFiles(speechFiles, chrome)) {
      const destination = path.join(root, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, `required ${file}`);
    }
    await chmod(path.join(root, "whisper-cli"), 0o755);
    return root;
  };

  it("stages every approved runtime file and notice with executable permissions", async () => {
    const root = await vendorFixture(),
      destination = path.join(directory, "staged");
    await writeFile(path.join(root, "whisper-cli.json"), "source provenance");
    const expectedFiles = [
      ...vendorResourceFiles(speechFiles, chrome),
      "whisper-cli.json",
    ].sort();
    await stageVendorResources(root, destination, speechFiles, chrome);
    expect(
      await validateVendorResources(destination, speechFiles, chrome),
    ).toEqual(expectedFiles);
    for (const file of expectedFiles)
      expect(await readFile(path.join(destination, file))).toEqual(
        await readFile(path.join(root, file)),
      );
    expect(
      (await stat(path.join(destination, "whisper-cli"))).mode & 0o777,
    ).toBe(0o755);
  });

  it.each([
    ".env",
    "chrome-mac-arm64.partial-1/private.txt",
    "kokoro/private.txt",
    "chrome-mac-arm64/private.txt",
  ])(
    "rejects unexpected vendor payload %s before copying anything",
    async (file) => {
      const root = await vendorFixture(),
        destination = path.join(directory, "staged");
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "must never ship");
      await expect(
        stageVendorResources(root, destination, speechFiles, chrome),
      ).rejects.toThrow("Unexpected vendor resource");
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("requires all vendor notices and rejects symlinks even at an approved filename", async () => {
    const root = await vendorFixture(),
      file = path.join(root, "kokoro/LICENSE");
    await rm(file);
    await expect(
      validateVendorResources(root, speechFiles, chrome),
    ).rejects.toThrow("Missing vendor resources: kokoro/LICENSE");
    await symlink(path.join(root, "whisper-LICENSE"), file);
    await expect(
      validateVendorResources(root, speechFiles, chrome),
    ).rejects.toThrow("Unexpected vendor resource");
  });

  it("preserves exact reviewed relative framework links through replacement and staging", async () => {
    const root = await vendorFixture();
    const browser = path.join(root, browserDirectory);
    const linkedManifest = {
      files: [...chrome.files, { name: "Current", symlink: "gen" }],
    };
    await symlink("gen", path.join(browser, "Current"));
    const copied = path.join(directory, "replacement");
    await replaceVerifiedDirectory(browser, copied, (folder) =>
      validateChromeResources(folder, linkedManifest),
    );
    expect(await readlink(path.join(copied, "Current"))).toBe("gen");
    expect(await realpath(path.join(copied, "Current"))).toBe(
      await realpath(path.join(copied, "gen")),
    );
    const staged = path.join(directory, "staged");
    await stageVendorResources(root, staged, speechFiles, linkedManifest);
    expect(await readlink(path.join(staged, browserDirectory, "Current"))).toBe(
      "gen",
    );
    await expect(
      validateVendorResources(staged, speechFiles, linkedManifest),
    ).resolves.toContain(`${browserDirectory}/Current`);
  });

  it("keeps the final app self-contained after deleting the temporary vendor stage", async () => {
    const root = await vendorFixture();
    const linkedManifest = {
      files: [...chrome.files, { name: "Current", symlink: "gen" }],
    };
    await symlink("gen", path.join(root, browserDirectory, "Current"));
    const output = path.join(directory, "release");
    const app = path.join(output, "Cutline.app");
    const createPackages = vi.fn(async () => {
      await mkdir(path.join(app, "Contents/Resources"), { recursive: true });
      return [output];
    });
    expect(
      await packageWithVendorResources({
        vendorRoot: root,
        speechFiles,
        createPackages,
        chrome: linkedManifest,
        temporaryRoot: directory,
      }),
    ).toEqual([output]);
    expect(createPackages).toHaveBeenCalledOnce();
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith("cutline-package-"),
      ),
    ).toEqual([]);
    // Remove the original cache too: neither source nor temporary resources
    // should be necessary for a copied app's framework links to resolve.
    await rm(root, { recursive: true });
    const browser = path.join(
      app,
      "Contents/Resources/vendor",
      browserDirectory,
    );
    expect(await readlink(path.join(browser, "Current"))).toBe("gen");
    expect(
      await readFile(path.join(browser, "Current/frontend.js"), "utf8"),
    ).toBe(`required ${browserDirectory}/gen/frontend.js`);
    await expect(assertSelfContainedDirectory(app)).resolves.toBeUndefined();
    await expect(
      validateVendorResources(
        path.join(app, "Contents/Resources/vendor"),
        speechFiles,
        linkedManifest,
      ),
    ).resolves.toContain(`${browserDirectory}/Current`);
  });

  it.each(["dangling", "escaping"])(
    "rejects a completed app with a %s link and cleans temporary resources",
    async (kind) => {
      const root = await vendorFixture();
      const output = path.join(directory, "release");
      const outside = path.join(directory, "outside.txt");
      if (kind === "escaping") await writeFile(outside, "outside the app");
      await expect(
        packageWithVendorResources({
          vendorRoot: root,
          speechFiles,
          chrome,
          temporaryRoot: directory,
          createPackages: async () => {
            const app = path.join(output, "Cutline.app");
            await mkdir(path.join(app, "Contents/Resources"), {
              recursive: true,
            });
            await symlink(outside, path.join(app, "unexpected-link"));
            return [output];
          },
        }),
      ).rejects.toThrow(
        kind === "dangling" ? "symlink is dangling" : "symlink escapes the app",
      );
      expect(
        (await readdir(directory)).filter((name) =>
          name.startsWith("cutline-package-"),
        ),
      ).toEqual([]);
    },
  );

  it.each(["gen/frontend.js", "/tmp", "../outside", "regular file"])(
    "rejects a reviewed framework link replaced by %s",
    async (target) => {
      const root = await vendorFixture();
      const file = path.join(root, browserDirectory, "Current");
      const linkedManifest = {
        files: [...chrome.files, { name: "Current", symlink: "gen" }],
      };
      if (target === "regular file") await writeFile(file, "not a link");
      else await symlink(target, file);
      await expect(
        stageVendorResources(
          root,
          path.join(directory, "staged"),
          speechFiles,
          linkedManifest,
        ),
      ).rejects.toThrow(/Chrome/u);
      await expect(stat(path.join(directory, "staged"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([
    "../outside",
    "/absolute",
    "gen/../outside",
    "gen\\outside",
    "gen//outside",
  ])("rejects unsafe reviewed link target %s before reading files", (symlink) =>
    expect(() =>
      chromeFileNames({ files: [{ name: "Current", symlink }] }),
    ).toThrow("Invalid reviewed"),
  );

  it("pins the complete reviewed browser to every direct Remotion package", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (name === "remotion" || name.startsWith("@remotion/"))
        expect(() => assertChromeManifestVersion(version)).not.toThrow();
    }
    expect(() => assertChromeManifestVersion("0.0.0")).toThrow(
      "manifest differ",
    );
    expect(chromeDistribution.archive.url).toBe(
      `https://storage.googleapis.com/chrome-for-testing-public/${chromeDistribution.version}/mac-arm64/chrome-mac-arm64.zip`,
    );
    expect(chromeDistribution.archive.sha).toMatch(/^[a-f0-9]{64}$/u);
    const files = chromeFileNames();
    expect(files).toContain(browserExecutable);
    expect(files).toContain("ABOUT");
    expect(files.some((name) => name.endsWith("WidevineCdm/LICENSE"))).toBe(
      true,
    );
    expect(chromeDistribution.directory).toBe(browserDirectory);
    expect(chromeDistribution.chromeMode).toBe(browserOptions.chromeMode);
    expect(
      chromeDistribution.files.filter((file) => file.symlink),
    ).toHaveLength(5);
  });

  it.each(["content", "size", "missing notice", "extra", "symlink"])(
    "rejects a browser %s mismatch before staging the app",
    async (failure) => {
      const root = await vendorFixture();
      const browser = path.join(root, "chrome-mac-arm64");
      const helper = path.join(browser, "gen/frontend.js");
      if (failure === "content") {
        const old = await readFile(helper);
        await writeFile(helper, Buffer.alloc(old.length, 65));
      } else if (failure === "size") await writeFile(helper, "truncated");
      else if (failure === "missing notice")
        await rm(path.join(browser, "LICENSE.headless_shell"));
      else if (failure === "extra")
        await writeFile(path.join(browser, "gen/private.env"), "private");
      else {
        await rm(helper);
        await symlink(path.join(browser, "chrome-headless-shell"), helper);
      }
      await expect(validateChromeResources(browser, chrome)).rejects.toThrow(
        /Chrome resource/u,
      );
      const destination = path.join(directory, "staged");
      await expect(
        stageVendorResources(root, destination, speechFiles, chrome),
      ).rejects.toThrow();
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    "../outside",
    "/absolute",
    "gen/../outside",
    "gen\\outside",
    "gen//outside",
  ])("rejects unsafe Chrome manifest path %s", (name) => {
    expect(() =>
      chromeFileNames({ files: [{ ...chrome.files[0], name }] }),
    ).toThrow("Invalid reviewed");
  });

  it("rejects a symlink used as the browser directory itself", async () => {
    const root = await vendorFixture();
    const linked = path.join(directory, "linked-browser");
    await symlink(path.join(root, "chrome-mac-arm64"), linked);
    await expect(validateChromeResources(linked, chrome)).rejects.toThrow(
      "symlinks are not allowed",
    );
  });

  it("repairs binaries from installs that skipped package hooks without changing bytes", async () => {
    for (const [tool, mode] of [
      ["ffmpeg", 0o755],
      ["ffprobe", 0o640],
    ]) {
      const file = path.join(
        directory,
        `node_modules/@${tool}-installer/darwin-arm64/${tool}`,
      );
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${tool} pinned bytes`);
      await chmod(file, mode);
    }
    expect(await prepareMediaBinaries(directory)).toEqual([
      "node_modules/@ffprobe-installer/darwin-arm64/ffprobe",
    ]);
    for (const [tool, mode] of [
      ["ffmpeg", 0o755],
      ["ffprobe", 0o751],
    ]) {
      const file = path.join(
        directory,
        `node_modules/@${tool}-installer/darwin-arm64/${tool}`,
      );
      expect((await stat(file)).mode & 0o777).toBe(mode);
      expect(await readFile(file, "utf8")).toBe(`${tool} pinned bytes`);
    }
    expect(await prepareMediaBinaries(directory)).toEqual([]);
  });

  it("gives a useful install error when media dependencies are missing or not files", async () => {
    await expect(prepareMediaBinaries(directory)).rejects.toThrow("Run npm ci");
    await mkdir(
      path.join(
        directory,
        "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
      ),
      { recursive: true },
    );
    await expect(prepareMediaBinaries(directory)).rejects.toThrow(
      "Expected a file",
    );
  });

  it("fails clearly on platforms that have no runtime binaries", () => {
    expect(() => assertSupportedPlatform("darwin", "arm64")).not.toThrow();
    for (const [platform, arch] of [
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
    ])
      expect(() => assertSupportedPlatform(platform, arch)).toThrow(
        "Apple Silicon",
      );
  });

  it("removes inherited Electron Node mode without mutating the parent environment", () => {
    const original = {
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/safe/bin",
      CUTLINE_DATA_DIR: "/tmp/project",
    };
    expect(developmentEnvironment(original, "http://127.0.0.1:5199")).toEqual({
      PATH: "/safe/bin",
      CUTLINE_DATA_DIR: "/tmp/project",
      CUTLINE_DEV_URL: "http://127.0.0.1:5199",
    });
    expect(original.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("keeps developer credentials and user files out of packages while retaining runtime and notices", () => {
    for (const file of [
      "/.env",
      "/.env.local",
      "/work/private.cutline",
      "/outputs/export.mp4",
      "/src/main/main.ts",
      "/vendor/model.bin",
      "/docs/private-export.mp4",
      "/release/Cutline.app",
      "/node_modules/.remotion/chrome",
      "/node_modules/.bin/node",
      "/node_modules/some-package/.env",
      "/node_modules/electron/dist",
      "/node_modules/onnxruntime-node/bin/napi-v3/linux/libonnx.so",
      "\\.env",
    ])
      expect(packageIgnore(file), file).toBe(true);
    for (const file of [
      "",
      "/",
      "/package.json",
      "/dist/main/main.cjs",
      "/dist/main/tts-worker.cjs",
      "/dist/ui/index.html",
      "/licenses/whisper-LICENSE",
      "/THIRD_PARTY_NOTICES.md",
      "/docs",
      "/docs/getting-started.md",
      "/SECURITY.md",
      "/CONTRIBUTING.md",
      "/LICENSE",
      "/assets/Cutline.icns",
      "/node_modules/react/index.js",
      "/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/libonnx.dylib",
    ])
      expect(packageIgnore(file), file).toBe(false);
  });

  it("rejects Intel-only or machine-specific Whisper dynamic libraries", () => {
    const portable =
      "whisper-cli:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t/System/Library/Frameworks/Metal.framework/Versions/A/Metal (compatibility version 1.0.0)";
    expect(() => assertPortableWhisper("arm64", portable)).not.toThrow();
    expect(() => assertPortableWhisper("x86_64", portable)).toThrow("arm64");
    for (const linked of [
      "@rpath/libggml.dylib",
      "/opt/homebrew/lib/libwhisper.dylib",
    ])
      expect(() =>
        assertPortableWhisper(
          "arm64",
          `${portable}\n\t${linked} (compatibility version 1.0.0)`,
        ),
      ).toThrow("external libraries");
  });

  it("blocks nonfree FFmpeg packages unless an explicit local-only override is provided", () => {
    const nonfree =
      "ffmpeg configuration: --enable-gpl --enable-version3 --enable-nonfree";
    expect(() => assertRedistributableFfmpeg(nonfree)).toThrow(
      "cannot be redistributed",
    );
    expect(assertRedistributableFfmpeg(nonfree, true)).toContain(
      "Do not upload, publish or share",
    );
    expect(() =>
      assertRedistributableFfmpeg("ffmpeg --enable-gpl --enable-version3"),
    ).not.toThrow();
  });
});
