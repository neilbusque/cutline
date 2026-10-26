import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, readdir, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  collectListeningEvidence,
  measureListeningAudio,
  parseListeningAlignment,
} from "../src/main/listening-evidence";
import { makeClip, newProject } from "../src/shared/model";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
function token(
  text: string,
  anchor: number,
  from: number,
  to: number,
  p = 0.9,
) {
  return { text, t_dtw: anchor, offsets: { from, to }, p };
}
describe("Fresh local listening alignment", () => {
  it("joins subword tokens and keeps DTW anchors distinct from normal token offsets", () => {
    const words = parseListeningAlignment(
      {
        transcription: [
          {
            tokens: [
              token("[_BEG_]", -1, 0, 0),
              token(" that", 100, 800, 1000),
              token(" del", 130, 1100, 1200),
              token("etes", 145, 1200, 1500),
              token(" now", 170, 1600, 1850),
            ],
          },
        ],
      },
      2,
    );
    expect(words).toHaveLength(3);
    expect(words[1]).toMatchObject({
      text: "deletes",
      anchorSeconds: 1.3,
      lastAnchorSeconds: 1.45,
      startSeconds: 1.1,
      endSeconds: 1.5,
    });
  });
  it("does not manufacture anchors when DTW is absent or outside the actual soundtrack", () => {
    expect(
      parseListeningAlignment(
        {
          transcription: [
            {
              tokens: [
                token(" bad", -1, 0, 100),
                token(" outside", 300, 100, 200),
              ],
            },
          ],
        },
        1,
      ),
    ).toEqual([]);
    expect(
      parseListeningAlignment(
        { transcription: [{ text: "words without tokens" }] },
        1,
      ),
    ).toEqual([]);
  });
});
const ffmpeg = path.resolve(
  "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg",
);
function wav(seconds = 1, amplitude = 0.25) {
  const rate = 48000,
    frames = rate * seconds,
    buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame++) {
    const v = Math.round(
      Math.sin((2 * Math.PI * 440 * frame) / rate) * amplitude * 32767,
    );
    buffer.writeInt16LE(v, 44 + frame * 4);
    buffer.writeInt16LE(v, 46 + frame * 4);
  }
  return buffer;
}
describe.runIf(existsSync(ffmpeg))(
  "Bounded real PCM listening evidence",
  () => {
    it("measures the full file and reports finite peak, LUFS and frame-aligned activity", async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "cutline-listening-test-"),
      );
      directories.push(directory);
      const file = path.join(directory, "tone.wav");
      await writeFile(file, wav());
      const result = await measureListeningAudio({
        ffmpeg,
        path: file,
        durationSeconds: 1,
      });
      expect(result.complete).toBe(true);
      expect(result.analyzedSeconds).toBeCloseTo(1, 3);
      expect(result.samplePeakDbfs).toBeCloseTo(-12.04, 1);
      expect(result.truePeakDbtp).not.toBeNull();
      expect(result.integratedLufs).not.toBeNull();
      expect(result.activity.rmsDbfs).toHaveLength(50);
      expect(result.clippedSampleCount).toBe(0);
    });
    it("reports missing speech tools as a limitation and removes temporary evidence files", async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "cutline-listening-test-"),
      );
      directories.push(directory);
      const file = path.join(directory, "tone.wav");
      await writeFile(file, wav());
      const project = newProject();
      const asset = {
        id: "audio",
        name: "Tone",
        kind: "audio" as const,
        path: file,
        duration: 1,
        hasAudio: true,
      };
      project.assets = [asset];
      project.clips = [
        { ...makeClip(project, "audio", "audio", 0, asset), duration: 30 },
        {
          ...makeClip(project, "caption", "captions", 0),
          duration: 30,
          text: "stem",
        },
      ];
      const result = await collectListeningEvidence({
        project,
        mediaPath: file,
        ffmpeg,
        whisperPath: path.join(directory, "missing-whisper"),
        whisperModelPath: "/missing-model",
        workDir: directory,
      });
      expect(result.mix.complete).toBe(true);
      expect(result.alignment.status).toBe("unavailable");
      expect(result.limitations.join(" ")).toContain(
        "Fresh caption alignment unavailable",
      );
      expect(await readdir(directory)).toEqual(["tone.wav"]);
    });
    it("aligns the complete native voice stem instead of the louder mix, preserving timeline seconds", async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "cutline-listening-test-"),
      );
      directories.push(directory);
      const mix = path.join(directory, "mix.wav"),
        voice = path.join(directory, "voice.wav"),
        whisper = path.join(directory, "fake-whisper.cjs");
      await writeFile(mix, wav(1, 0.25));
      await writeFile(voice, wav(1, 0.05));
      await writeFile(
        whisper,
        `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);const audio=fs.readFileSync(args[args.indexOf('-f')+1]);const start=audio.indexOf(Buffer.from('data'))+8;let peak=0;for(let i=start;i+1<audio.length;i+=2)peak=Math.max(peak,Math.abs(audio.readInt16LE(i)));const text=peak<3276?' stem':' mix';fs.writeFileSync(args[args.indexOf('-of')+1]+'.json',JSON.stringify({result:{language:'en'},transcription:[{tokens:[{text,t_dtw:50,offsets:{from:400,to:600},p:.99}]}]}));
`,
      );
      await chmod(whisper, 0o755);
      const project = newProject();
      const asset = {
        id: "audio",
        name: "Audio",
        kind: "audio" as const,
        path: mix,
        duration: 1,
        hasAudio: true,
      };
      project.assets = [asset];
      project.clips = [
        { ...makeClip(project, "audio", "audio", 0, asset), duration: 30 },
        {
          ...makeClip(project, "caption", "captions", 0),
          duration: 30,
          text: "stem",
        },
      ];
      const result = await collectListeningEvidence({
        project,
        mediaPath: mix,
        stems: { voice },
        ffmpeg,
        whisperPath: whisper,
        whisperModelPath: "/test-model",
        workDir: directory,
      });
      expect(result.alignment.status).toBe("complete");
      expect(result.alignment.method).toContain("complete native voice stem");
      expect(result.alignment.words[0]).toMatchObject({
        text: "stem",
        anchorSeconds: 0.5,
      });
    });
    it("does not run Whisper or report missing alignment for a music-only video without visible captions", async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "cutline-listening-test-"),
      );
      directories.push(directory);
      const file = path.join(directory, "music.wav");
      const whisper = path.join(directory, "unexpected-whisper.cjs");
      const marker = path.join(directory, "whisper-was-started");
      await writeFile(file, wav());
      await writeFile(
        whisper,
        `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');process.exit(1);
`,
      );
      await chmod(whisper, 0o755);
      const project = newProject();
      const asset = {
        id: "music",
        name: "Music",
        kind: "audio" as const,
        path: file,
        duration: 1,
        hasAudio: true,
      };
      project.assets = [asset];
      project.clips = [
        {
          ...makeClip(project, "audio", "audio", 0, asset),
          duration: 30,
          audioRole: "music",
        },
        {
          ...makeClip(project, "text", "titles", 0),
          duration: 30,
          text: "A title is not a spoken caption",
        },
        {
          ...makeClip(project, "caption", "captions", 0),
          duration: 30,
          text: "Hidden caption",
        },
      ];
      project.tracks.find((track) => track.id === "captions")!.hidden = true;
      const result = await collectListeningEvidence({
        project,
        mediaPath: file,
        ffmpeg,
        whisperPath: whisper,
        whisperModelPath: "/missing-model",
        workDir: directory,
      });
      expect(result.mix.complete).toBe(true);
      expect(result.alignment.status).toBe("not-needed");
      expect(result.alignment.method).toContain("No visible captions");
      expect(result.limitations).toEqual([]);
      expect(existsSync(marker)).toBe(false);
      expect((await readdir(directory)).sort()).toEqual([
        "music.wav",
        "unexpected-whisper.cjs",
      ]);
    });
    it("honors a pre-aborted request without starting a decoder", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        measureListeningAudio({
          ffmpeg,
          path: "/not-a-file",
          durationSeconds: 1,
          signal: controller.signal,
        }),
      ).rejects.toThrow("cancelled");
    });
  },
);
