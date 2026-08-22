/**
 * React twin of the shared referral chip (`referral-hint.ts`), for the two
 * React Mini Apps — the Date Ticket gate and the ticket store.
 *
 * Copy and styling come from that module, so the two rails cannot drift on
 * either; only the markup is re-expressed, exactly like `butterfly-loader` /
 * `butterfly-loader-react`. The envelope is `LetterMark`, which is already the
 * React twin of `icons.ts`'s `letter` and carries the same path data.
 */

import type { ReactElement } from "react";
import { LetterMark } from "./ticket/marks.js";
import { referralHintText, type ReferralLang } from "./referral-hint.js";

export interface ReferralChipProps {
  lang: ReferralLang;
  onTap: () => void;
  /**
   * Halve the top gap because another secondary row sits directly above — the
   * Premium counterfactual. Two equal rows at equal spacing read as a list of
   * two options rather than as an offer plus its footnote, which is the exact
   * complaint §3.9 records against the venue board's own stacked pair. Mirrors
   * the vanilla twin's `tight`, so the two rails cannot drift.
   */
  tight?: boolean;
}

export function ReferralChip({ lang, onTap, tight }: ReferralChipProps): ReactElement {
  return (
    <button
      type="button"
      className={tight ? "gn-referral gn-referral--tight" : "gn-referral"}
      onClick={onTap}
    >
      <LetterMark />
      <span>{referralHintText(lang)}</span>
    </button>
  );
}
