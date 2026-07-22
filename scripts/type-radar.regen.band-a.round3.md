# Type Radar — Band A QC round 3

Round-2 results: m11 (big ✓), f11 (curvy ✓ — the reference for "right curvy"),
m09 (no-text ✓) all ACCEPTED. Only the two curvy-in-non-sportswear failed again:
f04 (elegant dress) and f08 (edgy tee) still render slim.

Root cause: curvy lands in tight sportswear but collapses to a slim fashion
model in a dress / loose tee. Fix = push the body harder AND force **fitted**
clothing that reveals the figure (f08's baggy tee also hid the shape entirely).

If text prompts still fail: use the ACCEPTED f11 image as an image-to-image
**body/pose reference** at ~0.4–0.5 strength, overriding hair/outfit/scene via
the prompt — the f11 body is exactly the target curvy.

Band A, woman 24. Save as `<id>.jpg`.

### f04 — brunette / short / curvy / elegant / no
> Проверь: пышная фигуристая (широкие бёдра, объёмные ягодицы, полные бёдра), НЕ худая/модельная и НЕ полная; облегающее платье показывает формы; тёмное каре; тату нет.
```
candid photo taken by a friend on a smartphone of a 24-year-old Eastern European Slavic woman with fair skin, NOT a mirror selfie, no phone in frame, a sleek chin-length dark-brown bob, a thick curvy slim-thick hourglass body with wide hips, large round glutes, thick toned thighs and a fuller bust — clearly voluptuous and curvy, definitely NOT slim, thin or model-skinny, but fit and toned not overweight, wearing a fitted bodycon black slip mini dress that hugs her curvy hips and waist, bare arms with absolutely no tattoos, standing in a bright minimalist art gallery, three-quarter framing from mid-thigh up, relaxed natural standing posture, looking at the camera with a light genuine smile, natural minimal makeup, realistic skin texture, attractive girl-next-door look (not glossy), warm natural color grade, plain clothing with no text or logos, clean photograph with no watermark, no username, no border --ar 3:4 --style raw --no mirror, phone, text, watermark, logo, username, border, other people, underwear, skinny slim thin body, flat model-thin figure, plus-size overweight obese
```

### f08 — blonde / long / curvy / edgy / no
> Проверь: пышная фигуристая; ОБЛЕГАЮЩАЯ футболка (НЕ балахон) + обтягивающие джинсы показывают формы; длинный блонд; тату нет.
```
candid photo taken by a friend on a smartphone of a 24-year-old Eastern European Slavic woman with fair skin, NOT a mirror selfie, no phone in frame, long straight golden-blonde hair, a thick curvy slim-thick hourglass body with wide hips, large round glutes, thick toned thighs and a fuller bust — clearly voluptuous and curvy, definitely NOT slim, thin or model-skinny, but fit and toned not overweight, wearing a fitted form-hugging black t-shirt tucked into high-waist fitted dark jeans that show her curvy hips, layered silver necklaces in an edgy alternative style, bare arms with absolutely no tattoos anywhere, standing in a stylish specialty coffee bar, three-quarter framing from mid-thigh up, relaxed natural standing posture, looking at the camera with a light genuine smile, natural minimal makeup, realistic skin texture, attractive girl-next-door look (not glossy), warm natural color grade, plain clothing with no text or logos, clean photograph with no watermark, no username, no border --ar 3:4 --style raw --no mirror, phone, text, watermark, logo, username, border, other people, underwear, oversized baggy loose shirt, skinny slim thin body, flat model-thin figure, plus-size overweight obese
```
