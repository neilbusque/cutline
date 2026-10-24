/** The parts of the editor window this needs, so tests can stand in for it. */
export type EditorWindow = {
  isDestroyed(): boolean;
  on(event: "unresponsive" | "responsive", listener: () => void): unknown;
  webContents: {
    on(
      event: "render-process-gone",
      listener: (event: unknown, details: { reason: string }) => void,
    ): unknown;
    reload(): void;
    forcefullyCrashRenderer(): void;
  };
};

/** Crashes in a row that reload the editor by themselves. */
const autoReloads = 3;
const autoReloadWindowMs = 120_000;

/**
 * Brings the editor page back after it crashes or hangs. The project lives in
 * the main process, so a reload loses no work. Agent preview requests waiting
 * on the old page are answered at once instead of timing out.
 */
export function keepEditorAlive(
  win: EditorWindow,
  options: {
    /** Preview requests the page has not answered yet. */
    pending: Map<string, { reject: (error: Error) => void }>;
    /** Asks whether to reload a page that stopped responding. */
    askReload: () => Promise<boolean>;
    later?: (run: () => void, ms: number) => unknown;
    now?: () => number;
  },
) {
  const now = options.now ?? Date.now;
  const settle = () => {
    for (const [id, request] of options.pending) {
      options.pending.delete(id);
      request.reject(Error("The editor restarted. Retry."));
    }
  };
  const reload = () => {
    settle();
    if (!win.isDestroyed()) win.webContents.reload();
  };
  let crashes: number[] = [];
  win.webContents.on("render-process-gone", (_event, details) => {
    settle();
    if (details.reason === "clean-exit") return;
    // A page that crashes as soon as it loads is not reloaded forever; View >
    // Reload editor still works.
    crashes = [...crashes, now()].filter(
      (time) => now() - time < autoReloadWindowMs,
    );
    if (crashes.length > autoReloads) return;
    (options.later ?? setTimeout)(reload, 500);
  });
  let asking = false,
    responding = true;
  win.on("responsive", () => (responding = true));
  win.on("unresponsive", async () => {
    responding = false;
    if (asking) return;
    asking = true;
    try {
      // A page that recovered while the question was open is left alone.
      if ((await options.askReload()) && !responding && !win.isDestroyed())
        win.webContents.forcefullyCrashRenderer();
    } finally {
      asking = false;
    }
  });
  return { reload };
}
