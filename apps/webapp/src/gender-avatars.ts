/**
 * The two portraits behind the "your gender" screen (`ChoiceScreen` in
 * onboarding-basics.tsx).
 *
 * Photographs, background removed — deliberately the same register as the
 * "who do you want to meet?" screen one step later, which is also photographs.
 * A drawn pair shipped here first and was replaced: two illustrated buttons
 * followed by two photographic ones read as a seam between two products.
 *
 * They are shown as a warm monochrome at rest and bloom into full colour on the
 * tap that commits the answer — so at rest all the colour on the screen belongs
 * to the two buttons themselves, and the colour of a person is the reward for
 * choosing. Same rule the loading mark states from the other side: structure
 * stays neutral, colour is spent only on the thing that carries meaning.
 *
 * **These are not crops of their sources, and could not be.** Each figure is
 * PLACED into a canvas the shape of the button by measured landmarks. At
 * `object-fit: cover` in a 3:4 box the visible source height is 0.75x the
 * visible width, so fitting a head that occupies the top 60% of a 9:16 frame
 * needs at least 80% of that frame's width — and the camera in the woman's
 * raised hand starts at 82% of it. Every crop that cleared the camera cut her
 * chin, and every crop that kept her chin kept a slice of the camera. Placing
 * by landmarks decouples the two, and dropping the camera column becomes a
 * separate decision from where the face sits.
 *
 * **The asset feathers its own edges, and the button's fade cannot do it.** The
 * button's fade is anchored to the button; these figures do not reach it. The
 * man's content lands at x 61..558 of 540 and the woman's at 60..408, so the
 * straight vertical lines that read as a pasted cut-out — the source
 * photograph's frame cutting through a shoulder or an arm, and on her right the
 * clip column that drops the camera cutting through her hair — all sit 11-24%
 * in, where the button's fade still holds over 77% opacity and never touched
 * them. `prepare.mjs` therefore feathers any edge that falls INSIDE the button,
 * and leaves an edge that runs past it to the CSS fade, which already takes
 * that one to zero.
 *
 * Prepared by `~/Desktop/gennety-gender-avatars/prepare.mjs`. Never copy an
 * original in by hand: they are 2000x3555 PNGs against ~47 KB of WebP here, on
 * the onboarding path. Same rule and same reason as the preference photographs.
 */
import femaleAvatar from "./gender/female.webp";
import maleAvatar from "./gender/male.webp";

export const GENDER_AVATARS: Readonly<Record<"male" | "female", string>> = {
  male: maleAvatar,
  female: femaleAvatar,
};

/**
 * Where `prepare.mjs` puts the chin, as a percentage of the button's height.
 *
 * Exported only so the stylesheet can be held to it: the bottom fade must begin
 * BELOW this line, or it starts dissolving the face. That is not hypothetical —
 * the fade sat at 58% while the artwork was drawn and cropped differently, and
 * moving the artwork without moving the fade would silently eat a chin.
 */
export const GENDER_ART_CHIN_PCT = 68;
