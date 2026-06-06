import type { ReactElement } from "react";
import { fill, type TicketStrings } from "./i18n.js";
import { formatUsd } from "./ticket-state.js";

/**
 * Mock Stripe Payment Element. Purely cosmetic card fields — there is no real
 * tokenization. The actual "charge" is the fixed bottom-bar button (owned by
 * App), wired to POST /confirm.
 *
 * // TODO: Stripe Production Mode
 * // Replace this whole component with the real Stripe Payment Element:
 * //   import { Elements, PaymentElement } from "@stripe/react-stripe-js";
 * //   <Elements stripe={stripePromise} options={{ clientSecret }}>
 * //     <PaymentElement />
 * //   </Elements>
 * // and confirm via stripe.confirmPayment(...). The surrounding App phase
 * // machine (intent → element → confirm) stays the same.
 */
export function MockPayment(props: {
  amountCents: number;
  strings: TicketStrings;
}): ReactElement {
  const s = props.strings;
  const amount = formatUsd(props.amountCents);
  return (
    <div className="mock-pay">
      <div className="mock-badge">{s.mockBadge}</div>
      <h2 className="mock-title">{s.mockTitle}</h2>
      <p className="mock-sub">{fill(s.mockSub, { amount })}</p>

      <label className="mock-field">
        <span className="mock-field-label">{s.mockCardLabel}</span>
        <div className="mock-input mock-input-card">
          <span className="mock-card-brand">VISA</span>
          <span className="mock-card-digits">4242&nbsp;4242&nbsp;4242&nbsp;4242</span>
        </div>
      </label>
      <div className="mock-field-row">
        <label className="mock-field">
          <span className="mock-field-label">{s.mockExpLabel}</span>
          <div className="mock-input">12&nbsp;/&nbsp;34</div>
        </label>
        <label className="mock-field">
          <span className="mock-field-label">{s.mockCvcLabel}</span>
          <div className="mock-input">123</div>
        </label>
      </div>
    </div>
  );
}
