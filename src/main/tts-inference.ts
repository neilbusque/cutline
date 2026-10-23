import { parentPort, workerData } from "node:worker_threads";
import { writeFile } from "node:fs/promises";
import { KokoroTTS } from "kokoro-js";
import {
  env,
  StyleTextToSpeech2Model,
  AutoTokenizer,
} from "@huggingface/transformers";
import { speechChunks, SpeechInputSchema } from "../shared/tts";

async function main() {
  const { modelDirectory, output, input } = workerData;
  const parsed = SpeechInputSchema.parse(input);
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;
  env.localModelPath = "";
  parentPort?.postMessage({
    progress: 0.03,
    message: "Loading Kokoro locally…",
  });
  const [model, loadedTokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(modelDirectory, {
      dtype: "q8",
      device: "cpu",
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    }),
    AutoTokenizer.from_pretrained(modelDirectory),
  ]);
  const tts = new KokoroTTS(model, loadedTokenizer);
  // The library otherwise truncates exceptionally long phoneme strings.
  const tokenizer = tts.tokenizer;
  tts.tokenizer = ((text: string) => {
    const encoded = tokenizer(text, { truncation: false });
    if (encoded.input_ids.dims.at(-1)! > 512)
      throw Error(
        "A phrase is too long to speak clearly. Add punctuation or split it into shorter sentences.",
      );
    return encoded;
  }) as typeof tokenizer;
  const chunks = speechChunks(parsed.text);
  const segments: Float32Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    parentPort?.postMessage({
      progress: 0.08 + (0.87 * i) / chunks.length,
      message: `Speaking passage ${i + 1} of ${chunks.length}…`,
    });
    const audio = await tts.generate(chunks[i], {
      voice: parsed.voice,
      speed: parsed.speed,
    });
    const samples = new Float32Array(audio.audio);
    if (!samples.length || samples.some((value) => !Number.isFinite(value)))
      throw Error("Kokoro returned invalid audio. Try a shorter passage.");
    segments.push(samples);
  }
  const count = segments.reduce((sum, segment) => sum + segment.length, 0);
  const wav = Buffer.alloc(44 + count * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + count * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(count * 2, 40);
  let offset = 44;
  for (const segment of segments)
    for (const value of segment) {
      const sample = Math.max(-1, Math.min(1, value));
      wav.writeInt16LE(
        Math.round(sample * (sample < 0 ? 32768 : 32767)),
        offset,
      );
      offset += 2;
    }
  await writeFile(output, wav, { flag: "wx" });
  parentPort?.postMessage({ done: true, duration: count / 24000 });
}
main().catch((error) =>
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : String(error),
  }),
);
