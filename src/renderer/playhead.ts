import { useCallback, useSyncExternalStore } from "react";

/**
 * A value that changes often (the playhead moves 30 times a second while
 * playing) and that only a few small views should follow. Keeping it out of
 * React state means the rest of the editor does not re-render every frame.
 */
export type ValueStore<T> = {
  get: () => T;
  set: (value: T) => void;
  subscribe: (listener: () => void) => () => void;
};
export type Playhead = ValueStore<number>;

export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Follows every change: only for tiny views like the timecode. */
export function useStoreValue<T>(store: ValueStore<T>) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * Re-renders only when the selected value changes, such as whether any job
 * of a kind is running. The selector must return a primitive.
 */
export function useStoreSelect<T, R>(
  store: ValueStore<T>,
  select: (value: T) => R,
) {
  const read = () => select(store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}

/**
 * Re-renders only when the selected value changes, for example when the
 * playhead crosses into the next caption. The selector must return a
 * primitive.
 */
export function usePlayheadValue<T>(
  playhead: Playhead,
  select: (frame: number) => T,
) {
  const read = () => select(playhead.get());
  return useSyncExternalStore(playhead.subscribe, read, read);
}

/**
 * The playhead for a panel: every change while scrubbing, at most a few
 * updates a second while playing (`every`), and none while hidden (`live`
 * false). The panel still reads the current frame whenever it renders.
 */
export function usePlayheadFrame(
  playhead: Playhead,
  { live = true, every = 0 }: { live?: boolean; every?: number } = {},
) {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!live) return () => {};
      if (!every) return playhead.subscribe(notify);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = playhead.subscribe(() => {
        timer ??= setTimeout(() => {
          timer = undefined;
          notify();
        }, every);
      });
      return () => {
        off();
        if (timer !== undefined) clearTimeout(timer);
      };
    },
    [playhead, live, every],
  );
  return useSyncExternalStore(subscribe, playhead.get, playhead.get);
}
