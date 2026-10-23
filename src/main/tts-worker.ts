import { Worker } from "node:worker_threads";
import path from "node:path";

// ONNX's native callbacks are stable in a worker isolate, but terminating that
// isolate during inference can abort its process. Keep it inside a disposable
// child: the editor cancels the whole process, never the live worker thread.
process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
process.once("message", (input) => {
  const worker = new Worker(path.join(__dirname, "tts-inference.cjs"), {
    workerData: input,
  });
  let finished = false;
  const sendFinal = (message: unknown, code: number) => {
    if (finished) return;
    finished = true;
    process.send?.(message as any, () => process.exit(code));
  };
  worker.on("message", (message) => {
    if (message.done) sendFinal(message, 0);
    else if (message.error) sendFinal(message, 1);
    else process.send?.(message);
  });
  worker.on("error", (error) =>
    sendFinal(
      { error: error instanceof Error ? error.message : String(error) },
      1,
    ),
  );
  worker.on("exit", (code) => {
    if (!finished)
      sendFinal({ error: `Voice inference stopped (${code}). Try again.` }, 1);
  });
});
