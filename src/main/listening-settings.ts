import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ListeningSettingsSchema = z
  .object({
    enabled: z.boolean(),
    autoFix: z.boolean(),
  })
  .strict();
export type ListeningSettings = z.infer<typeof ListeningSettingsSchema>;

/** Shared across sessions. A fresh installation never uploads audio implicitly. */
export function readListeningSettings(file: string): ListeningSettings {
  try {
    return ListeningSettingsSchema.parse(
      JSON.parse(readFileSync(file, "utf8")),
    );
  } catch {
    return { enabled: false, autoFix: true };
  }
}
export function writeListeningSettings(file: string, raw: unknown) {
  const patch = ListeningSettingsSchema.partial().parse(raw);
  const value = { ...readListeningSettings(file), ...patch };
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
  return value;
}
