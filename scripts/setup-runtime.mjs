import {
  assertSupportedPlatform,
  prepareMediaBinaries,
} from "./setup-support.mjs";

assertSupportedPlatform();
const repaired = await prepareMediaBinaries();
console.log(
  repaired.length
    ? `Prepared executable permissions for ${repaired.join(", ")}.`
    : "FFmpeg and FFprobe executable permissions are ready.",
);
