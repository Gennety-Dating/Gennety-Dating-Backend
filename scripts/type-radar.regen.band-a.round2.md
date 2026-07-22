# Type Radar — Band A QC round 2

Verification of the 15 regenerated images against targets.

## Verdict
- **Forgot to generate (2):** f04, m11.
- **Failed the fix, redo (3):** f08 (still slim), f11 (one too slim / one too
  heavy), m09 (still has text on clothing).
- **Good, accepted (6):** f03, f06, f07, f10, m07, m08.
- **Borderline — your call (4):** f02, f09 (athletic reads slim), m03 (reads
  lean not athletic), m05 (big reads as very-muscular, not heavyset + tiny logo).
- Wins: mirror-selfie fix worked (f09/f11/m03/m05/m08 are candid now); the
  tattoo label errors are fixed (f08/f10/m04 now correctly show no tattoo);
  ethnicity improved (f03 no longer Asian); bottoms present everywhere.

Core remaining problem = the **curvy / big axis**: the generator swings between
skinny and plus-size and won't hold "fit-curvy". Prompts below target the middle
("slim-thick" hourglass / rugby-forward big) with negatives on BOTH extremes.

Band A ages: women 24, men 26. MJ flags; on Higgsfield drop `--` and keep the
inline guards. Save each as `<id>.jpg`.

---

### f04 — brunette / short / curvy / elegant / no  ·  (MISSING — not generated)
> Проверь: фигуристая «slim-thick» (полнее стройной, но подтянутая, НЕ худая и НЕ полная); тёмное каре; платье; тату НЕТ.
```
candid photo taken by a friend on a smartphone of a 24-year-old Eastern European Slavic woman with fair skin, NOT a mirror selfie, no phone in frame, a sleek chin-length dark-brown bob, a fit curvy slim-thick hourglass figure with noticeably fuller rounded hips, bust and thicker thighs than a slim girl but still toned and fit, NOT skinny and NOT overweight, wearing an elegant fitted black slip mini dress with delicate thin straps and minimal gold jewelry, bare arms with absolutely no tattoos, standing in a bright minimalist art gallery, three-quarter framing from mid-thigh up, relaxed natural standing posture, looking at the camera with a light genuine smile, natural minimal makeup, realistic skin texture, attractive girl-next-door look (not glossy), warm natural color grade, plain clothing with no text or logos, clean photograph with no watermark, no username, no border --ar 3:4 --style raw --no mirror, phone, text, watermark, logo, username, border, other people, underwear, skinny slim body, plus-size overweight obese
```

### m11 — dark / clean / big / classic / yes  ·  (MISSING — not generated)
> Проверь: крупный/широкий (как регбист/пауэрлифтер — больше обычного качка, но НЕ жирный); тёмные волосы; бритый; рубашка + брюки; тату ЕСТЬ; восточноевропеец.
```
candid photo taken by a friend on a smartphone of a 26-year-old Eastern European Slavic man with fair skin, NOT a mirror selfie, no phone in frame, short textured dark-brown hair, clean-shaven, a broad solidly-built powerful heavy athletic frame like a rugby forward or powerlifter — big, broad and thick through the shoulders and chest, clearly larger and heavier than a lean gym build, but NOT overweight, wearing a well-fitted light-blue oxford shirt with sleeves rolled to the elbow and navy chino trousers, a bold tattoo sleeve clearly visible on his forearm, standing in a warm sunlit apartment, three-quarter framing from mid-thigh up, relaxed natural standing posture, looking at the camera with a calm easy smile, realistic skin texture, naturally attractive guy-next-door look, warm natural color grade, plain clothing with no text or logos, clean photograph with no watermark, no username, no border --ar 3:4 --style raw --no mirror, phone, text, watermark, logo, username, border, other people, underwear, lean slim skinny physique, obese, mediterranean features
```

### f08 — blonde / long / curvy / edgy / no  ·  (redo: still slim)
> Проверь: фигуристая «slim-thick», НЕ стройная; длинный блонд; чёрная футболка (edgy); тату НЕТ.
```
candid photo taken by a friend on a smartphone of a 24-year-old Eastern European Slavic woman with fair skin, NOT a mirror selfie, no phone in frame, long straight golden-blonde hair, a fit curvy slim-thick hourglass figure with noticeably fuller rounded hips, bust and thicker thighs than a slim girl but still toned and fit, NOT skinny and NOT overweight, wearing a plain black t-shirt with rolled sleeves, layered silver necklaces and fitted dark jeans in an edgy alternative style, bare arms with absolutely no tattoos anywhere, standing in a stylish specialty coffee bar, three-quarter framing from mid-thigh up, relaxed natural standing posture, looking at the camera with a light genuine smile, natural minimal makeup, realistic skin texture, attractive girl-next-door look (not glossy), warm natural color grade, plain clothing with no text or logos, clean photograph with no watermark, no username, no border --ar 3:4 --style raw --no mirror, phone, text, watermark, logo, username, border, other people, underwear, skinny slim body, plus-size overweight obese
```

### f11 — blonde / short / curvy / sporty / yes  ·  (redo: one too slim, one too heavy)
> Проверь: фигуристая «slim-thick» — золотая середина: НЕ худая (как первый вариант) и НЕ полная (как второй); блонд-боб; тату ЕСТЬ.
```
candid photo taken by a friend on a smartphone of a 24-year-old Eastern European Slavic woman with fair skin, NOT a mirror selfie, no phone in frame, a chin-length blonde bob, a fit curvy slim-thick hourglass figure with noticeably fuller rounded hips, bust and thicker thighs than a slim girl but still toned and fit, NOT skinny and NOT overweight or plus-size, wearing a fitted white ribbed tank top and high-waist flared leggings, a delicate fine-line tattoo clearly visible on her forearm, standing in a marble-walled boutique hotel interior, three-quarter framing from mid-thigh up, relaxed natural standing posture, looking at the camera with a light genuine smile, natural minimal makeup, realistic skin texture, attractive girl-next-door look (not glossy), warm natural color grade, plain clothing with no text or logos, clean photograph with no watermark, no username, no border --ar 3:4 --style raw --no mirror, phone, text, watermark, logo, username, border, other people, underwear, skinny slim body, plus-size overweight obese
```

### m09 — dark / beard / lean / sporty / no  ·  (redo: still has text on clothing)
> Проверь: на футболке и штанах НЕТ вообще никаких надписей/логотипов; телосложение худощавое; борода; тату НЕТ; стоит.
```
candid photo taken by a friend on a smartphone of a 26-year-old Eastern European Slavic man with fair skin, NOT a mirror selfie, no phone in frame, short textured dark-brown hair, a full neatly trimmed short beard, a slim lean slender build with narrow shoulders, clearly not muscular, wearing a completely plain blank off-white athletic-fit t-shirt and matching plain jogger sweatpants with absolutely no text, letters, numbers, logos, prints or writing anywhere on the clothing, absolutely no tattoos, standing in a cozy candle-lit wine bar in the evening, three-quarter framing from mid-thigh up, relaxed natural standing posture, looking at the camera with a calm easy smile, realistic skin texture, naturally attractive guy-next-door look, warm natural color grade, clean photograph with no watermark, no username, no border --ar 3:4 --style raw --no text, letters, numbers, logo, writing, print, mirror, phone, watermark, username, border, other people, underwear, muscular bodybuilder physique
```
