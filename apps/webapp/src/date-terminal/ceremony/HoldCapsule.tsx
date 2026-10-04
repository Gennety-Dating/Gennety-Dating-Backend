import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent, PointerEvent, ReactElement } from "react";

import { HOLD_IDLE, holdProgress, holdStep, type HoldEvent, type HoldState } from "./hold.js";
import { Render } from "./render-stand.js";
import { CEREMONY_DARK } from "./overlay.js";

export interface HoldCapsuleProps {
  label: string;
  /** Committed and waiting for the server: full, and deaf to new presses. */
  busy: boolean;
  /** The ceremony overlay is drawing this capsule itself. */
  hidden: boolean;
  /** Finger down — buzz, and warm the clock up while the fill runs. */
  onPress: () => void;
  /** Held long enough. `centerY` is where the scene's capsule must stand. */
  onCommit: (centerY: number) => void;
}

/**
 * The hold capsule: the stand's burgundy capsule, filling left to right while
 * the finger stays on it. A pointer or a held Space/Enter key works; lifting
 * before the fill completes cancels, lifting after it cancels nothing.
 */
export function HoldCapsule(props: HoldCapsuleProps): ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const state = useRef<HoldState>(HOLD_IDLE);
  const raf = useRef(0);
  const live = useRef(props);
  live.current = props;

  const paint = useCallback((): void => {
    const p = holdProgress(state.current, performance.now());
    fillRef.current?.style.setProperty("--hold", p.toFixed(4));
  }, []);

  const dispatch = useCallback(
    (event: HoldEvent): void => {
      const step = holdStep(state.current, event);
      state.current = step.state;
      paint();
      if (step.commit) {
        const rect = buttonRef.current?.getBoundingClientRect();
        live.current.onCommit(rect ? rect.top + rect.height / 2 : window.innerHeight * 0.8);
      }
    },
    [paint],
  );

  const loop = useCallback((): void => {
    dispatch({ type: "tick", at: performance.now() });
    if (state.current.kind === "pressing") raf.current = requestAnimationFrame(loop);
  }, [dispatch]);

  const press = useCallback((): void => {
    if (live.current.busy || state.current.kind !== "idle") return;
    dispatch({ type: "press", at: performance.now() });
    live.current.onPress();
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(loop);
  }, [dispatch, loop]);

  const release = useCallback((): void => {
    cancelAnimationFrame(raf.current);
    dispatch({ type: "release", at: performance.now() });
  }, [dispatch]);

  // The server answered: the capsule is a capsule again.
  useEffect(() => {
    if (!props.busy && state.current.kind === "waiting") dispatch({ type: "settle" });
  }, [props.busy, dispatch]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers cannot be captured; the release still arrives.
    }
    press();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      press();
    }
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      release();
    }
  };

  return (
    <button
      type="button"
      ref={buttonRef}
      className={props.hidden ? "hold-capsule is-hidden" : "hold-capsule"}
      data-busy={props.busy ? "1" : undefined}
      aria-busy={props.busy}
      onPointerDown={onPointerDown}
      onPointerUp={release}
      onPointerCancel={release}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="hold-capsule-fill" ref={fillRef} aria-hidden="true" />
      <span className="hold-capsule-label">{props.label}</span>
    </button>
  );
}

/** The stand's placement hint: two phones top edge to top edge, camera to camera. */
export function PlacementHint(): ReactElement {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = 64;
    const h = 124;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The drawing spans −15…+32 px around its centre (the arc and the mark sit
    // right of the phones), so the centre goes left of the middle.
    Render.placementHint(ctx, 23.5, h / 2, Render.palette(CEREMONY_DARK));
  }, []);
  return <canvas className="hold-hint-art" ref={ref} width={64} height={124} aria-hidden="true" />;
}
