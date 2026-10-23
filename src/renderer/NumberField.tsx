import React, { useEffect, useRef } from "react";
import "./stage-controls.css";

/** A numeric edit or label scrub commits once; Escape restores the stored value. */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<() => void>(() => {});
  const shown = Math.round(value * 1000) / 1000;
  const bound = (n: number) =>
    Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  useEffect(() => () => cancel.current(), []);
  const scrub = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled || event.button !== 0 || !input.current) return;
    event.preventDefault();
    const field = input.current,
      start = event.clientX;
    let next = shown;
    const clean = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", abort);
      cancel.current = () => {};
      field.closest("label")?.classList.remove("is-scrubbing");
    };
    const abort = () => {
      clean();
      field.value = String(shown);
    };
    const end = () => {
      clean();
      if (next !== shown) onChange(next);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        abort();
      }
    };
    const move = (e: PointerEvent) => {
      const sensitivity = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      next = bound(
        Math.round((value + (e.clientX - start) * step * sensitivity) * 1000) /
          1000,
      );
      field.value = String(next);
    };
    cancel.current = abort;
    field.closest("label")?.classList.add("is-scrubbing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", abort, { once: true });
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", abort, { once: true });
  };
  return (
    <label className="field number-field">
      <span
        className={disabled ? undefined : "number-scrub"}
        onPointerDown={scrub}
        title="Drag to adjust · Shift for larger steps · Option for precision · Escape to cancel"
      >
        {label}
      </span>
      <input
        ref={input}
        key={value}
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        defaultValue={shown}
        onBlur={(e) => {
          const n = bound(e.target.valueAsNumber);
          if (Number.isFinite(n) && n !== shown) onChange(n);
          else e.target.value = String(shown);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.value = String(shown);
            e.currentTarget.blur();
          }
          if (e.key === "Enter") e.currentTarget.blur();
          if (
            (e.shiftKey || e.altKey) &&
            (e.key === "ArrowUp" || e.key === "ArrowDown")
          ) {
            e.preventDefault();
            const base = Number.isFinite(e.currentTarget.valueAsNumber)
              ? e.currentTarget.valueAsNumber
              : shown;
            e.currentTarget.value = String(
              bound(
                Math.round(
                  (base +
                    (e.key === "ArrowUp" ? 1 : -1) *
                      step *
                      (e.shiftKey ? 10 : 0.1)) *
                    1000,
                ) / 1000,
              ),
            );
          }
        }}
      />
    </label>
  );
}
