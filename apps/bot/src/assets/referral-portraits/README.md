# Referral card portraits

The member photos in the referral invite card's portrait row
(`services/referral-card`, PRODUCT_SPEC §Referral).

Drop the files here named by slot, **1-indexed, left → right** as they appear on
the card:

```
1.jpg  2.jpg  3.jpg  4.jpg  5.jpg
```

`.jpg` / `.jpeg` / `.png` / `.webp` are all accepted (first match per slot wins).

Notes:

- A missing slot is **not** an error — it renders as a numbered placeholder ring
  and the remaining photos keep their positions, so slots never shift.
- Each photo is cropped to a circle (`objectFit: cover`), so the face should sit
  near the centre of the frame; a full-body shot will crop to the middle of the
  body, not the head. Pre-crop to a roughly square, face-centred image.
- These are read once and cached as data URIs at first render (the card renders
  on every share and every public `GET /v1/referral/card` hit), so **changing a
  file needs a process restart** to take effect.
- Ordinary repo assets: they ship with the standard code rsync, no bucket or CDN
  involved. Keep them small — they are base64-inlined into the SVG at render.
