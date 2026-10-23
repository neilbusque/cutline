import type { Store } from "./store";

export type UnsavedChoice = "save" | "discard" | "cancel";

/**
 * Before New, Open or a backup replaces a project that exists only in
 * Cutline's recovery file (never saved, or its file can't be written), asks
 * whether to save it first. Returns false when the person cancels or closes
 * the save dialog. Whatever they choose, the store keeps a dated backup.
 */
export async function confirmReplace(
  store: Pick<Store, "hasUnsavedWork" | "project">,
  ask: (name: string) => Promise<UnsavedChoice>,
  save: () => Promise<boolean>,
) {
  if (!store.hasUnsavedWork()) return true;
  const choice = await ask(store.project.name);
  if (choice === "save") return save();
  return choice === "discard";
}
