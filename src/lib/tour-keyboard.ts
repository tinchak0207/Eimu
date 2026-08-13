import type { Driver } from "driver.js";

export const DESKTOP_TOUR_KEY_HINT = "键盘：A 上一步 · D 下一步";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) return true;
  return target.matches("input, textarea, select");
}

export function bindDesktopTourKeyboard(tour: Pick<Driver, "moveNext" | "movePrevious">): () => void {
  if (typeof window === "undefined" || !window.matchMedia("(min-width: 1024px)").matches) {
    return () => {};
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;

    const key = event.key.toLowerCase();
    if (key !== "a" && key !== "d") return;

    event.preventDefault();
    event.stopPropagation();
    if (key === "a") tour.movePrevious();
    else tour.moveNext();
  };

  document.addEventListener("keydown", handleKeyDown, true);
  return () => document.removeEventListener("keydown", handleKeyDown, true);
}
