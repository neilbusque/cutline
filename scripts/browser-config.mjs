// Chrome Headless Shell 156/157 stalls animation frames on macOS 27. The full
// stable Chrome for Testing build passes real preview and video rendering.
// Keep every preview/export/setup path on this same reviewed distribution.
export const browserDirectory = "chrome-mac-arm64";
export const browserExecutable =
  "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
export const browserRelativePath = `${browserDirectory}/${browserExecutable}`;
export const browserOptions = Object.freeze({
  chromeMode: "chrome-for-testing",
});
