import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { formatCountdown, msUntil } from "./ticket-state.js";

/**
 * Live countdown to the `partial` payment deadline. Ticks once a minute (the
 * label only changes at minute granularity). When it hits zero the parent's
 * next poll picks up the cron's refund → free-scheduling transition.
 */
export function PartialTimer(props: {
  expiresAt: string | null;
  template: string; // contains "{time}"
}): ReactElement | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!props.expiresAt) return null;
  const remaining = msUntil(props.expiresAt, now);
  if (remaining <= 0) return null;

  return (
    <p className="ticket-timer">
      {props.template.replace("{time}", formatCountdown(remaining))}
    </p>
  );
}
