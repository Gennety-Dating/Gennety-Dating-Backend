/**
 * React wrapper for the shared "butterflies in the stomach" loading mark.
 *
 * The markup is authored once, as a string, in `butterfly-loader.ts` — the
 * vanilla-TS Mini Apps drop it into `innerHTML`, and this component is how the
 * React ones (ticket, ticket store, radar) render the same thing. Re-writing it
 * as JSX would give the animation two definitions to keep in step, and the
 * geometry is the part that must not drift: the drift keyframes are hand-fitted
 * to the torso outline, so a divergent copy puts butterflies through the flank.
 *
 * `dangerouslySetInnerHTML` is deliberate and contained to this one file. The
 * markup is a module-level constant apart from `label`, which
 * `butterflyLoaderMarkup` HTML-escapes — no call site passes anything but its
 * own i18n string anyway.
 */

import type { ReactElement } from "react";
import { butterflyLoaderMarkup, type ButterflyLoaderOptions } from "./butterfly-loader";

export function ButterflyLoader(props: ButterflyLoaderOptions): ReactElement {
  return <div dangerouslySetInnerHTML={{ __html: butterflyLoaderMarkup(props) }} />;
}
