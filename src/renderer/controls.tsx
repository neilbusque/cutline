import React from "react";

/**
 * A failure as Neil should read it: without Electron's "Error invoking remote
 * method" prefix, and without telling him to refresh or inspect the project,
 * which only an agent can do.
 */
export function errorText(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': /u, "")
    .replace(/^[A-Za-z]*Error: /u, "");
  return /^Project changed\. (?:Refresh|Inspect) the project and retry/u.test(
    message,
  )
    ? "Cutline changed while you were editing. Try again."
    : message;
}

export function IconButton({
  title,
  onClick,
  children,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      aria-label={title}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
/** Tab and Shift-Tab wrap around inside an open dialog. */
export function keepFocusInside(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab") return;
  const elements = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]',
    ),
  ).filter((el) => el.getClientRects().length > 0);
  const first = elements[0],
    last = elements[elements.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first?.focus();
  }
}
