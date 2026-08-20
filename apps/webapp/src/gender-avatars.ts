/**
 * The two portraits behind the "your gender" screen (`ChoiceScreen` in
 * onboarding-basics.tsx).
 *
 * One drawing per option, background already removed. They are shown as a warm
 * monochrome at rest and bloom into full colour on the tap that commits the
 * answer — so at rest all the colour on the screen belongs to the two buttons
 * themselves, and the colour of the person is the reward for choosing. Same
 * rule the loading mark states from the other side: structure stays neutral,
 * colour is spent only on the thing that carries meaning.
 *
 * They are cropped mid-chest by their own frame, so the bottom of the drawing
 * has no silhouette — just a hard horizontal edge where the source ends. The
 * button dissolves that edge into its own gradient with a mask rather than
 * covering it (`.ob-gender-art`, onboarding.css), which is also what leaves the
 * label legible without a scrim over it.
 *
 * Prepared by `~/Desktop/gennety-gender-avatars/prepare.mjs`, which trims each
 * source to its alpha bounding box and downscales it to ~3x the button's CSS
 * width. Never copy an original in by hand: they are 1254px PNGs at ~2 MB each,
 * against ~46 KB of WebP here, on the onboarding path. Same rule and same
 * reason as the preference photographs.
 */
import femaleAvatar from "./gender/female.webp";
import maleAvatar from "./gender/male.webp";

export const GENDER_AVATARS: Readonly<Record<"male" | "female", string>> = {
  male: maleAvatar,
  female: femaleAvatar,
};
