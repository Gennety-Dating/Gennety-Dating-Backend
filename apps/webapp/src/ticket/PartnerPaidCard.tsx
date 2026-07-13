import type { ReactElement } from "react";
import { fill, type TicketStrings } from "./i18n.js";
import { Avatar } from "./Avatar.js";
import { HeartMark, CheckMark, ButterflyMark } from "./marks.js";

/**
 * The "your match already paid your ticket ❤️" surprise screen.
 *
 * Shown only when the partner covered THIS user's ticket (pay-for-both). The
 * woman opened the Mini App braced to pay — so this screen is deliberately
 * minimal-text, max-emotion: a softly glowing covered ticket with a sealed "PAID"
 * seal, drifting hearts, and two short lines. The continue CTA lives in the
 * shared action-bar (App.tsx). PRODUCT_SPEC §3.5b.
 */

// A few drifting hearts behind the hero — pure CSS animation (no canvas), so
// `prefers-reduced-motion` can freeze them with one rule.
const HEARTS: ReadonlyArray<{ left: string; delay: string; dur: string; size: string }> = [
  { left: "12%", delay: "0s", dur: "7.5s", size: "14px" },
  { left: "26%", delay: "1.9s", dur: "9s", size: "10px" },
  { left: "44%", delay: "0.8s", dur: "8.2s", size: "18px" },
  { left: "62%", delay: "2.6s", dur: "9.6s", size: "12px" },
  { left: "78%", delay: "1.2s", dur: "7s", size: "16px" },
  { left: "88%", delay: "3.1s", dur: "8.8s", size: "9px" },
];

export function PartnerPaidCard({
  partnerName,
  partnerPhotoUrl,
  strings,
}: {
  partnerName: string;
  partnerPhotoUrl: string | null;
  strings: TicketStrings;
}): ReactElement {
  const s = strings;
  return (
    <div className="pp-wrap">
      <div className="pp-hearts" aria-hidden="true">
        {HEARTS.map((h, i) => (
          <span
            key={i}
            className="pp-heart"
            style={{
              left: h.left,
              animationDelay: h.delay,
              animationDuration: h.dur,
              width: h.size,
              height: h.size,
            }}
          >
            <HeartMark />
          </span>
        ))}
      </div>

      <div className="pp-hero">
        <div className="pp-payer">
          {/* No badge: the payer's face carries the gesture on its own. A top-hat
              "gentleman" mark on top of it read as a costume prop, not as him. */}
          <Avatar
            src={partnerPhotoUrl}
            name={partnerName}
            size={124}
            className="tkt-avatar-hero pp-payer-avatar"
          />
        </div>
        {/* The float wrapper bobs the whole ticket *and* the corner stamp
            together; the inner .pp-ticket clips the shine + notches, while the
            stamp lives outside that clip so it can straddle the edge. */}
        <div className="pp-ticket-float">
          <div className="pp-ticket">
            <div className="pp-shine" aria-hidden="true" />
            <div className="pp-ticket-main">
              <span className="pp-logo" aria-hidden="true">
                <ButterflyMark />
              </span>
            </div>
            <div className="pp-ticket-stub" aria-hidden="true">
              <span className="pp-stub-dots" />
            </div>
          </div>
          <div className="pp-stamp">
            <span className="pp-stamp-tick" aria-hidden="true">
              <CheckMark />
            </span>
            {s.partnerPaidStamp}
          </div>
        </div>
      </div>

      <h1 className="pp-title">{fill(s.partnerPaidTitle, { name: partnerName })}</h1>
      <p className="pp-sub">{s.partnerPaidSub}</p>
    </div>
  );
}
