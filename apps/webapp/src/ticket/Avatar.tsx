import type { ReactElement } from "react";

/**
 * Circular profile avatar for the ticket Mini App. Renders the photo when a
 * `src` is available, otherwise a monogram (first letter of `name`) so the UI
 * never shows a broken image. An optional `badge` emoji (❤️ / 🎩) floats over
 * the top-right corner.
 */
export function Avatar({
  src,
  name,
  size = 40,
  badge,
  className,
}: {
  src: string | null;
  name?: string | null;
  size?: number;
  badge?: string;
  className?: string;
}): ReactElement {
  const initial = (name?.trim()?.[0] ?? "★").toUpperCase();
  return (
    <span
      className={`tkt-avatar${className ? ` ${className}` : ""}`}
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      {src ? (
        <img className="tkt-avatar-img" src={src} alt="" loading="lazy" />
      ) : (
        <span className="tkt-avatar-mono">{initial}</span>
      )}
      {badge && (
        <span className="tkt-avatar-badge" aria-hidden="true">
          {badge}
        </span>
      )}
    </span>
  );
}
