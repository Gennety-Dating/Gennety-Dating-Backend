/**
 * React wrapper for the shared "butterfly spins away, tick draws" success mark.
 *
 * The markup is authored once, as a string, in `butterfly-success.ts` — the
 * vanilla-TS Mini Apps drop it into `innerHTML`, and this component is how the
 * React ones (Type Radar, and onboarding's final screen) render the same thing.
 * Re-writing it as JSX would give the animation two definitions to keep in step,
 * and here the geometry is the part that must not drift: the viewBox is sized
 * to the widest frame of the SPIN rather than to the butterfly at rest, so a
 * hand-copied copy is one that shears a wing a quarter-turn in.
 *
 * `dangerouslySetInnerHTML` is deliberate and contained to this one file. The
 * markup is a module-level constant apart from `label`, which
 * `butterflySuccessMarkup` HTML-escapes — no call site passes anything but its
 * own i18n string anyway.
 *
 * The haptic is NOT fired here. It belongs to the call site, which is the only
 * thing that knows whether this render is a real settle or a re-render of a
 * screen the user has been looking at for a minute — `onSuccessSettle` is the
 * helper for that, and a mark that buzzed on mount would buzz again on every
 * parent state change.
 */

import type { ReactElement } from "react";
import { butterflySuccessMarkup, type ButterflySuccessOptions } from "./butterfly-success";

export function ButterflySuccess(props: ButterflySuccessOptions): ReactElement {
  return <div dangerouslySetInnerHTML={{ __html: butterflySuccessMarkup(props) }} />;
}
