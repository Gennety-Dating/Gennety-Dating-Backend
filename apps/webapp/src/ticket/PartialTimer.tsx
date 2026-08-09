import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { formatCountdown, msUntil } from "./ticket-state.js";
import type { TicketStrings } from "./i18n.js";

/**
 * Live countdown to the `partial` payment deadline. Ticks once a minute (the
 * label only changes at minute granularity). When it hits zero the parent's
 * next poll picks up the cron's refund → free-scheduling transition.
 *
 * It renders inside the page header, directly under the "waiting on them"
 * sentence, and that placement is load-bearing rather than cosmetic. It used to
 * be the LAST item in the scroll, under the ticket — which put it in the one
 * band the floating action bar passes over, so on a screen the ticket already
 * fills it was read through a translucent button (`--fill` is 6% white). And
 * orphaned down there it answered neither "how long" for what nor for whom;
 * beside the sentence that names the person waiting, it is one thought.
 */
export function PartialTimer(props: {
  expiresAt: string | null;
  strings: TicketStrings;
}): ReactElement | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!props.expiresAt) return null;
  const remaining = msUntil(props.expiresAt, now);
  if (remaining <= 0) return null;

  const time = formatCountdown(remaining, {
    hours: props.strings.timeHours,
    minutes: props.strings.timeMinutes,
    soon: props.strings.timeSoon,
  });
  return <p className="ticket-timer">{props.strings.waitingTimer.replace("{time}", time)}</p>;
}
