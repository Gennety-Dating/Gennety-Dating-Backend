import { useEffect, useState, type ReactElement, type ReactNode } from "react";

/**
 * Circular profile avatar for the ticket Mini App. Renders the photo when a
 * `src` is available, otherwise a monogram (first letter of `name`) so the UI
 * never shows a broken image. An optional `badge` — an authored vector mark
 * from `marks.tsx`, never a platform emoji — floats over the top-right corner.
 *
 * A photo that FAILS to load falls back to the same monogram. The images are
 * proxied through the bot (`getFile` → Telegram) over a phone's connection, so
 * a failure is a real possibility — and until this fallback existed the result
 * was two empty circles on the "pay for us both" button, which a visitor read
 * (correctly) as the photos not having loaded. `alt=""` means a broken `<img>`
 * renders as nothing or as the client's broken-image glyph; an initial is
 * better than either.
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
  badge?: ReactNode;
  className?: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  // A new photo deserves a fresh attempt — otherwise one failure would stick to
  // this slot for the rest of the session, even after the screen swaps whose
  // face it shows.
  useEffect(() => setFailed(false), [src]);

  const initial = (name?.trim()?.[0] ?? "★").toUpperCase();
  const showPhoto = Boolean(src) && !failed;
  return (
    <span
      className={`tkt-avatar${className ? ` ${className}` : ""}`}
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      {showPhoto ? (
        <img
          className="tkt-avatar-img"
          src={src as string}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
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
