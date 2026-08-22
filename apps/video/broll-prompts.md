# The real-world act — generation brief and prompts

> For §E.2 of `video-production-plan.md`. Twelve shots to generate; eight to ten
> reach the cut. **Everything below is written to be pasted verbatim** — the
> blocks are repeated in every prompt on purpose, not by accident.

---

## 0. The decisions this is built on

**The clean run goes BEFORE the Telegram card** (founder, 2026-08-22). So the
film ends:

```
… «Кожного дня у тебе є шанс на побачення»   ← the first shots play UNDER this
    the clean montage, no text
    Gennety · «Вже в Telegram» · the app being opened
    the mark
```

That keeps the product as the last thing on screen. The people are the argument;
the product is the answer. Reversing the two was the alternative and was
rejected.

**It is ONE day, not a relationship over months.** This is the single most
useful constraint in the document and it is doing three jobs at once:

- **The product's own claim is one real date.** A film that ends on one day from
  meeting to sunset is the promise made literal. A months-long montage is a
  different, vaguer claim.
- **Wardrobe never changes**, which is most of the character-consistency problem
  solved for free.
- **The light carries the arc without anyone having to direct it.** Midday →
  afternoon → golden hour → sunset. That progression IS the "logical build to an
  ending" — it happens whether or not any individual shot lands.

**Length.** Ten shots in the cut lands the film somewhere around **76–80 s**,
against 62.8 s now. That is a different category of film — fine for a site and a
presentation, long for paid social. The founder has taken that call knowingly;
it is recorded here so nobody re-litigates it later from the runtime alone.

---

## 1. Two blocks to paste into every single prompt

### CHARACTERS — verbatim, every time, no paraphrasing

```
HER: European woman, 26 years old, warm olive skin, light freckles across the
nose and cheeks, dark brown shoulder-length wavy hair worn loose, soft natural
makeup, thin gold chain necklace. Wearing an ivory linen midi dress with short
sleeves, tan leather sandals, small woven straw bag.

HIM: European man, 28 years old, light tan skin, dark brown short hair slightly
messy, light stubble. Wearing a sage-green linen shirt with the sleeves rolled
to the elbow, light beige chinos, white low-top sneakers.
```

**Paraphrasing this is how the two of them slowly become two other people over
twelve clips.** Copy it; do not improve it.

### STYLE — verbatim, every time

```
Cinematic 35mm film look, shallow depth of field, warm natural light, soft
halation on the highlights, fine film grain, gentle handheld camera with a
subtle float. Muted warm colour grade, creamy skin tones, warm shadows.
Vertical 9:16 composition, 1080x1920. Slow calm camera movement. Natural candid
performance, real laughter, nobody posing to camera.
```

### NEGATIVE — verbatim, every time

```
text, caption, subtitle, watermark, logo, brand name, smartphone, mobile phone,
phone screen, laptop, tablet, headphones, earbuds, screen, ui, interface,
timestamp, crowd, other people in focus, whip pan, crash zoom, violent camera
shake, teal and orange grade, cold blue light, oversaturated, plastic skin,
extra fingers, deformed hands, distorted face, morphing face, changing clothes,
changing hair colour
```

**Two entries in that list are not housekeeping.**

`smartphone / phone screen` — a phone in the last shots of a film that has just
said *«тобі треба їх видалити»* is the one thing that can actively work against
the piece. It is why shot 03 uses a film camera (below).

`changing clothes / changing hair colour` — this is what a video model does to a
couple across a long clip, and it is the failure that makes a montage look
assembled from stock.

---

## 2. The workflow — text-to-video alone will not hold these two people

Worth being blunt about, because it decides whether twelve clips look like one
couple or like twelve couples:

1. **Generate ONE reference still first.** Both of them, full body, standing on a
   plain sunlit street, neutral expressions, the exact wardrobe above. This is
   the anchor for everything else. Get it right before generating anything
   else — an hour here is worth more than any prompt below.
2. **For each shot, make a still from that reference** (image-to-image / a
   character-reference slot), placing them in the setting.
3. **Animate that still** (image-to-video) with the motion line from the prompt.

If the tool supports a character reference directly in text-to-video, step 2
collapses into step 3. If it does not, do not skip it — text-to-video from
scratch will hold the wardrobe for about three clips.

**Generate 7–8 s per shot as planned.** I cut 1.2–2.5 s out of the middle of
each: the first second is usually the model settling and the last second is
usually where hands and faces start to drift.

---

## 3. The twelve shots

Each carries: where it sits in the day, what I intend to cut from it, and the
prompt. Prompts are in English deliberately — every one of these models is
trained on English text and performs measurably worse on Russian or Ukrainian.

---

### 01 · THE ARRIVAL — midday, café terrace
*The half second before recognition. This is the whole film's turn: a stranger
becomes a person.* → **cut ~1.5 s**, the look up.

```
A young woman sits alone at a small round table on a sunlit café terrace on a
leafy European street, a coffee cup in front of her, looking down at her hands.
She glances up and her face opens into a spontaneous, surprised smile as she
recognises someone approaching off-camera. The camera pushes in slowly from a
medium-wide to a medium shot. Bright midday sun filtered through green tree
leaves, dappled moving light on the table and her face.
```

---

### 02 · THE FIRST WALK — midday, street
*Half a step apart. Not touching yet — the distance is the point, and it makes
everything after it read as progress.* → **cut ~2 s**

```
The couple walk side by side down a leafy European street, half a step apart,
not touching, both talking and laughing and glancing at each other. The camera
tracks backwards ahead of them at chest height, steady handheld. Midday sun,
warm stone buildings and green trees behind them, soft bokeh.
```

---

### 03 · THE PHOTOGRAPH — early afternoon, street corner
*The founder asked for «снимают друг друга». It is **a small film camera, not a
phone** — same gesture, opposite meaning: making a memory rather than looking at
a screen, and no glowing rectangle in a film that just told people to delete
their apps.* → **cut ~2 s**

```
The man raises a small vintage film camera and photographs the woman. She laughs
and half-hides her face behind her hand, then lowers it and looks straight down
the lens, still smiling. Medium close-up on her, the man's shoulder soft in the
foreground. Warm afternoon sunlight, a pastel-painted wall behind her.
```

---

### 04 · ICE CREAM — afternoon
→ **cut ~1.8 s**, the steal.

```
The couple walk slowly along a street holding ice cream cones. She leans in
quickly and takes a bite from his cone; he laughs and pulls it away a moment too
late, mock-outraged. Handheld medium shot moving alongside them. Bright warm
afternoon light, pastel storefronts blurred behind.
```

---

### 05 · RUNNING — afternoon, seafront
*The first shot where they touch.* → **cut ~1.5 s**

```
The couple run hand in hand along a wide empty seafront promenade, laughing, her
dress and her hair moving in the wind. The camera tracks alongside them at hip
height, smooth and fast. Warm afternoon sun, sparkling sea to one side, palm
shadows crossing the ground.
```

---

### 06 · THE WATER — late afternoon, beach
→ **cut ~1.8 s**, the splash.

```
The couple walk barefoot at the edge of the sea, sandals in hand. He kicks a
sheet of water toward her; she shrieks with laughter and splashes back. Low
camera close to the wet sand, tracking slowly. Late afternoon sun low and warm,
backlit spray glowing gold against the water.
```

---

### 07 · PLAY — late afternoon, park court
*Badly, and happily. If the model keeps re-dressing them in sportswear, switch
to **badminton on grass** — it reads identically at 1.5 s and keeps the
wardrobe.* → **cut ~1.5 s**

```
The couple play tennis badly and happily on a worn public outdoor court, still
in their day clothes, missing easy shots and laughing at each other. Wide
handheld shot. Late afternoon golden light through a chain-link fence, long
shadows across the court surface.
```

---

### 08 · FALLING — golden hour, long grass
→ **cut ~1.5 s**

```
The couple drop backwards together onto long summer grass, laughing and out of
breath, landing side by side. The camera is low in the grass looking along at
them, blades of grass soft and out of focus in the foreground. Golden hour sun
raking low across the field, warm haze in the air.
```

---

### 09 · LOOKING UP — golden hour, grass, overhead
*Shot from directly above. **This is a candidate for the shot the promise text
sits over** — the two of them are centred and everything around them is plain
grass, so the type has somewhere to live.* → **cut ~2.5 s**

```
Overhead shot looking straight down at the couple lying side by side on green
summer grass, heads close together, both smiling and talking quietly. She turns
her face toward him. The camera rises very slowly. Golden hour light, warm skin
tones, grass filling the frame around them.
```

---

### 10 · THE SPIN — golden hour
→ **cut ~1.5 s**

```
The woman runs into the man's arms and he lifts her and spins her once, both
laughing. The camera orbits slowly around them at medium distance. Golden hour
backlight, the sun flaring behind their silhouettes, warm dust in the air.
```

---

### 11 · FOREHEAD TO FOREHEAD — dusk
*The film's only still moment in the act. After ten shots of motion, stopping is
what makes the ending land.* → **cut ~2.5 s**

```
Very close two-shot: the couple stand forehead to forehead, eyes closed, both
smiling faintly, barely moving, breathing. The camera pushes in extremely
slowly. Dusk, soft blue-warm ambient light, a warm practical light glowing out
of focus behind them.
```

---

### 12 · AWAY — sunset. **The ending.**
*The camera holds still, which is what the rest of this film does 62 % of the
time. Everything before it moves; this one stops, and they get smaller.* →
**cut ~3 s**, held longest of all.

```
Wide shot from behind: the couple walk away from the camera hand in hand along
an empty seafront path into a low orange sun, small in the frame, rim-lit and
almost silhouetted. The camera is locked off and does not move. Sunset, deep
warm sky, long shadows reaching back toward the lens.
```

---

## 4. What to send back

All twelve, full length, straight out of the tool — **do not trim them.** I cut
against a filmstrip, and the two seconds you would remove are often exactly where
the usable moment is. Name them `broll-01.mp4` … `broll-12.mp4` and leave them on
the Desktop.

Expect to regenerate three or four. That is normal and is why there are twelve
rather than eight: shots 03, 07 and 10 are the ones most likely to come back with
the wardrobe changed or the hands wrong.
