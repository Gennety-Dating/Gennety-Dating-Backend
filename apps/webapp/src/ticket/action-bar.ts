import { useCallback, useEffect, useRef } from "react";

/**
 * The floating action bar reserves exactly its own height at the end of the
 * scroll — no more, no less.
 *
 * The bar paints OVER the scroll area (`.action-bar` in ticket.css) so content
 * dissolves under it through a scrim instead of being cut off at a hard edge.
 * That only works if the scroll ends with as much padding as the bar is tall,
 * and a constant cannot be that: the bar carries one, two or three buttons
 * depending on the screen, and a long Russian or Ukrainian label wraps a button
 * onto a second line. Too little padding hides the last row of content; too
 * much leaves a dead strip at the end of a short list.
 *
 * So the height is measured rather than guessed, and re-measured whenever the
 * bar changes shape. Written as `--bar-space` on the document element, because
 * exactly one ticket page is mounted at a time; the property is removed on
 * unmount so a screen with no bar (the store before a purchase) falls back to
 * the `0px` default and reserves nothing.
 */
export function useActionBarSpace(): (el: HTMLElement | null) => void {
  const observer = useRef<ResizeObserver | null>(null);

  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
      document.documentElement.style.removeProperty("--bar-space");
    },
    [],
  );

  return useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) {
      document.documentElement.style.removeProperty("--bar-space");
      return;
    }
    const write = (): void => {
      document.documentElement.style.setProperty(
        "--bar-space",
        `${Math.ceil(el.offsetHeight)}px`,
      );
    };
    write();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(write);
    ro.observe(el);
    observer.current = ro;
  }, []);
}
