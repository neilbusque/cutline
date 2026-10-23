import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  downloadVerified,
  loadSpeechManifest,
  speechNotices,
} from "./setup-support.mjs";

const { speechModelFiles, speechModelRevision } = await loadSpeechManifest();
for (const file of speechModelFiles) {
  const changed = await downloadVerified(
    path.resolve("vendor/kokoro", file.name),
    {
      ...file,
      url: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/${speechModelRevision}/${file.name}`,
    },
  );
  console.log(`${changed ? "Downloaded" : "Verified"} ${file.name}`);
}
for (const notice of speechNotices)
  await downloadVerified(path.resolve("vendor/kokoro", notice.name), notice);
await writeFile(
  "vendor/kokoro/NOTICE",
  `Kokoro 82M v1.0 local voice model, Apache License 2.0.\nOriginal model: https://huggingface.co/hexgrad/Kokoro-82M\nONNX conversion: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX\nPinned conversion revision: ${speechModelRevision}\nSee LICENSE and MODEL_CARD.md for the upstream terms and credits.\n`,
);
console.log(
  "Local voice models and notices are ready. Verified files were reused.",
);
