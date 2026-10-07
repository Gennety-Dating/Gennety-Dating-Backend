/**
 * «Premium после покупки», отделка «Металл в воде» — копия ядра стенда
 * `design/premium-unlock/index.html` из репозитория Gennety-iOS (утверждён
 * основателем 2026-10-07). Та же копия, что у iOS (`PremiumRevealField`,
 * `PremiumRevealTimeline`, `PremiumReveal.metal`); план —
 * `docs/architecture/premium-reveal-plan.md` там же.
 *
 * **Движение правится только на стенде.** Затем
 * `scripts/premium-reveal-fixtures.sh <этот каталог>/fixture.json` (iOS-репо)
 * переснимает эталон, и `stand.test.ts` показывает, что разъехалось здесь.
 *
 * Отличия от стенда — только экранные и языковые:
 * 1. ветка отделки одна («в воде»), отделок «было» нет;
 * 2. холст — во всю ширину окна, поэтому `uS` — пикселей на pt стенда по
 *    холсту, а сглаживание кромки — в пикселях (`uEdge = 2 / uS`), как в iOS;
 * 3. шаг соседей для нормали — не меньше 1 pt стенда (`max(uS, …)`; на стенде
 *    при S = 2 это те же 2 px).
 */

// ---------- Хореография — числа стенда, общие с iOS ----------
export const T = {
  fadeOut: 0.4, // экран покупки уходит «под воду»
  word: 0.25, // первая капля
  stagger: 0.12, // шаг между каплями букв
  v: 80, // скорость фронта капли, pt стенда в секунду
  settle: 0.95, // не в фокусе → резкий металл
  lightDur: 1.5, // проход света — как у шапки «нуара»
  blur: 0.26, // размытие капли, доля кегля
  inflate: 0.19, // раздутие капли, доля кегля
  lead: 0.2, // насколько рябь бежит впереди капли, доля кегля
} as const;

/** Полоса стенда: 320 pt, два пикселя на pt. */
export const DESIGN_WIDTH = 320;
export const S = 2;
export const LIGHT_W = 0.3;
export const ENTRY = -0.35;
/** Под Reduce Motion: надпись 0,15–0,45 с, срок и «Готово» 0,25–0,55 с. */
export const REDUCED_END = 0.6;
export const WORD = "Premium";

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const ease = {
  outCubic: (x: number): number => 1 - Math.pow(1 - x, 3),
  out: (x: number): number => 1 - Math.pow(1 - x, 2.2),
};

export interface Seed {
  x: number;
  y: number;
  maxR: number;
}

export interface Field {
  big: number;
  pad: number;
  bandH: number;
  W: number;
  H: number;
  /** RGBA32F, строки снизу вверх: sdf (pt), приход (с), до капли (pt), фокус (с). */
  data: Float32Array;
  glyphX: number[];
  seeds: Seed[];
  stroke: number;
  wx0: number;
  wx1: number;
  /** От НИЗА полосы. */
  capTop: number;
  capBase: number;
  /** Базовая линия от ВЕРХА полосы. */
  baseline: number;
  lastArrival: number;
  lastFocus: number;
}

export interface Timeline {
  wordEnd: number;
  lightStart: number;
  copyIn: number;
  end: number;
}

// ---------- Поле надписи — makeLayout() стенда ----------
export function makeField(family: string): Field {
  const m = document.createElement("canvas").getContext("2d")!;
  const fontAt = (px: number): string => `800 ${px}px ${family}`;
  const word = WORD;
  const track = -0.02;
  m.font = fontAt(100);
  const big = Math.floor(
    (0.8 * DESIGN_WIDTH * 100) / (m.measureText(word).width + track * 100 * (word.length - 1)),
  );
  // Запас сверху и снизу: под раздутую размытую каплю и под рябь.
  const pad = Math.round(big * 1.15);
  m.font = fontAt(big);
  const asc = m.measureText("P").actualBoundingBoxAscent;
  const wordW = m.measureText(word).width + track * big * (word.length - 1);
  const x0 = (DESIGN_WIDTH - wordW) / 2;
  const yTop = pad;
  const base = pad + asc;
  const glyphs: { ch: string; x: number; w: number }[] = [];
  for (let i = 0; i < word.length; i++) {
    const pre = m.measureText(word.slice(0, i)).width + track * big * i;
    glyphs.push({ ch: word[i], x: x0 + pre, w: m.measureText(word[i]).width });
  }
  const bandH = Math.ceil(base + pad);
  const W = DESIGN_WIDTH * S;
  const H = bandH * S;

  // Маска всего слова и номер буквы на пиксель.
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d", { willReadFrequently: true })!;
  const alpha = new Float32Array(W * H);
  const idx = new Int16Array(W * H).fill(-1);
  glyphs.forEach((g, gi) => {
    c.clearRect(0, 0, W, H);
    c.font = fontAt(big * S);
    c.fillStyle = "#fff";
    c.fillText(g.ch, g.x * S, base * S);
    const d = c.getImageData(0, 0, W, H).data;
    for (let i = 0, j = 3; i < W * H; i++, j += 4) {
      const a = d[j] / 255;
      if (a > alpha[i]) alpha[i] = a;
      if (a > 0.5) idx[i] = gi;
    }
  });
  // Расстояния (Фельценшвальб): до ближайшего внешнего и внутреннего пикселя.
  const INF = 1e20;
  const fIn = new Float64Array(W * H);
  const fOut = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const inside = alpha[i] > 0.5;
    fIn[i] = inside ? INF : 0;
    fOut[i] = inside ? 0 : INF;
  }
  edt2d(fIn, W, H);
  edt2d(fOut, W, H);
  const sdf = new Float32Array(W * H);
  let stroke = 0;
  for (let i = 0; i < W * H; i++) {
    let d = Math.sqrt(fIn[i]) - Math.sqrt(fOut[i]);
    d += d > 0 ? -0.5 : 0.5;
    const a = alpha[i];
    if (a > 0.02 && a < 0.98 && Math.abs(d) < 1.5) d = a - 0.5;
    sdf[i] = d / S;
    if (sdf[i] > stroke) stroke = sdf[i];
  }
  // Семя буквы — глубокая точка штриха поближе к середине буквы.
  const cen = glyphs.map(() => ({ x: 0, y: 0, n: 0 }));
  for (let i = 0; i < W * H; i++) {
    if (idx[i] < 0 || alpha[i] <= 0.5) continue;
    const c0 = cen[idx[i]];
    c0.x += (i % W) / S;
    c0.y += Math.floor(i / W) / S;
    c0.n++;
  }
  const seeds = glyphs.map(() => ({ d: -1e9, x: 0, y: 0, maxR: 0 }));
  for (let i = 0; i < W * H; i++) {
    if (idx[i] < 0 || sdf[i] <= 0) continue;
    const c0 = cen[idx[i]];
    const x = (i % W) / S;
    const y = Math.floor(i / W) / S;
    const score = sdf[i] - 0.35 * Math.hypot(x - c0.x / c0.n, y - c0.y / c0.n);
    const s = seeds[idx[i]];
    if (score > s.d) {
      s.d = score;
      s.x = x;
      s.y = y;
    }
  }
  // Карта прихода: минимум по всем каплям — волны сливаются, швов нет.
  const starts = glyphs.map((_, i) => T.word + i * T.stagger);
  const data = new Float32Array(W * H * 4);
  const arrival = new Float32Array(W * H);
  let lastArrival = 0;
  for (let py = 0; py < H; py++) {
    const y = py / S;
    for (let px = 0; px < W; px++) {
      const x = px / S;
      const i = py * W + px;
      let a = 1e9;
      let dmin = 1e9;
      for (let g = 0; g < seeds.length; g++) {
        const dx = x - seeds[g].x;
        const dy = y - seeds[g].y;
        const r = Math.sqrt(dx * dx + dy * dy);
        const v = starts[g] + r / T.v;
        if (v < a) a = v;
        if (r < dmin) dmin = r;
        if (idx[i] === g && r > seeds[g].maxR) seeds[g].maxR = r;
      }
      if (sdf[i] > -0.5 && a > lastArrival) lastArrival = a;
      arrival[i] = a;
      const o = ((H - 1 - py) * W + px) * 4;
      data[o] = sdf[i];
      data[o + 1] = a;
      data[o + 2] = dmin;
    }
  }
  // Карта фокуса — приход, сглаженный на полбуквы.
  const focus = boxBlur3(arrival, W, H, Math.round(14 * S));
  let lastFocus = 0;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px;
      if (sdf[i] > -0.5 && focus[i] > lastFocus) lastFocus = focus[i];
      data[((H - 1 - py) * W + px) * 4 + 3] = focus[i];
    }
  }
  let wx0 = 1e9;
  let wx1 = -1e9;
  glyphs.forEach((g) => {
    wx0 = Math.min(wx0, g.x);
    wx1 = Math.max(wx1, g.x + g.w);
  });
  return {
    big,
    pad,
    bandH,
    W,
    H,
    data,
    glyphX: glyphs.map((g) => g.x),
    seeds: seeds.map(({ x, y, maxR }) => ({ x, y, maxR })),
    stroke,
    wx0,
    wx1,
    capTop: bandH - yTop,
    capBase: bandH - base,
    baseline: base,
    lastArrival,
    lastFocus,
  };
}

/** Три прохода скользящего среднего ≈ гауссово размытие; края — повтором крайнего пикселя. */
export function boxBlur3(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const a = Float32Array.from(src);
  const b = new Float32Array(W * H);
  const pass = (
    from: Float32Array,
    to: Float32Array,
    n: number,
    stride: number,
    lines: number,
    lineStride: number,
  ): void => {
    for (let l = 0; l < lines; l++) {
      const base = l * lineStride;
      const at = (k: number): number => from[base + Math.min(n - 1, Math.max(0, k)) * stride];
      let s = 0;
      for (let k = -r; k <= r; k++) s += at(k);
      for (let k = 0; k < n; k++) {
        to[base + k * stride] = s / (2 * r + 1);
        s += at(k + r + 1) - at(k - r);
      }
    }
  };
  for (let it = 0; it < 3; it++) {
    pass(a, b, W, 1, H, W);
    pass(b, a, H, W, W, 1);
  }
  return a;
}

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -1e20;
  z[1] = 1e20;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Квадраты евклидовых расстояний на месте (Фельценшвальб — Хуттенлохер). */
export function edt2d(g: Float64Array, W: number, H: number): void {
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[y * W + x] = d[x];
  }
}

// ---------- Такты и кадр — timeline() и poseAt() стенда ----------
export function timeline(lastArrival: number, lastFocus: number): Timeline {
  const wordEnd = Math.max(lastFocus + T.settle, lastArrival + 0.15);
  const lightStart = wordEnd - 0.15;
  const copyIn = wordEnd - 0.1;
  const end = lightStart + T.lightDur + 0.1;
  return { wordEnd, lightStart, copyIn, end };
}

export function lightAt(TL: Timeline, t: number, roll: number, rm: boolean): number {
  const target = 0.5 + roll / 1.2;
  if (rm) return target;
  if (t < TL.lightStart) return ENTRY;
  const k = ease.out(clamp01((t - TL.lightStart) / T.lightDur));
  return ENTRY + (target - ENTRY) * k;
}

export interface Pose {
  pwOut: number;
  copyK: number;
  doneK: number;
  blurOut: number;
  blurIn: number;
  blurDone: number;
  wordOpacity: number;
  wordT: number;
  rest: 0 | 1;
  light: number;
}

export function poseAt(TL: Timeline, t: number, rm: boolean, roll = 0): Pose {
  const pwOut = ease.outCubic(clamp01(t / T.fadeOut));
  const copyK = rm ? clamp01((t - 0.25) / 0.3) : ease.outCubic(clamp01((t - TL.copyIn) / 0.5));
  const doneK = rm ? copyK : ease.outCubic(clamp01((t - TL.copyIn - 0.15) / 0.5));
  return {
    pwOut,
    copyK,
    doneK,
    blurOut: rm ? 0 : 8 * pwOut,
    blurIn: rm ? 0 : 6 * (1 - copyK),
    blurDone: rm ? 0 : 6 * (1 - doneK),
    wordOpacity: rm ? clamp01((t - 0.15) / 0.3) : 1,
    wordT: rm ? 99 : t,
    rest: rm || t >= TL.end ? 1 : 0,
    light: lightAt(TL, t, roll, rm),
  };
}

export type Beat = { t: number; kind: "drop" | "settled"; progress: number };

/** Вибрации по тактам: капля на букву по нарастающей и застывание. Под Reduce Motion — ни одной. */
export function beats(TL: Timeline, glyphs: number, rm: boolean): Beat[] {
  if (rm || glyphs <= 0) return [];
  const list: Beat[] = [];
  for (let i = 0; i < glyphs; i++) {
    list.push({ t: T.word + i * T.stagger, kind: "drop", progress: (i + 1) / glyphs });
  }
  list.push({ t: TL.wordEnd, kind: "settled", progress: 1 });
  return list.sort((a, b) => a.t - b.t);
}

// ---------- Шейдер — FS стенда, ветка «в воде» ----------
export const VS = `#version 300 es
in vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }`;

export const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uField;
uniform vec2 uSize;
uniform float uS, uTime, uStroke, uLight, uRest, uEdge;
uniform int uDark;
uniform float uV, uSettle, uWX0, uWX1, uCapTop, uCapBase;
uniform float uBlur, uInflate, uLead, uPad;
out vec4 o;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + 1.), f.x), f.y); }
vec4 tap(vec2 fc){ return texture(uField, fc / uSize); }
// Квадрат — умножением: pow(x, 2.) от отрицательного x не определён.
float sq(float x){ return x * x; }

float settleE(float since){
  float k = clamp(since / uSettle, 0., 1.);
  return k * k * (3. - 2. * k);
}

// x — поле (плюс внутри), y — размытие кромки (pt), z — застывание.
vec3 field(vec2 fc){
  vec2 p = fc / uS;
  vec4 T = tap(fc);
  // Толща воды: пока металл жидкий, поле читается через бегущую рябь.
  float live0 = 1. - settleE(uTime - T.a);
  vec2 fl = vec2(vnoise(p * .05 + vec2(uTime * .55, 3.1)), vnoise(p * .05 + vec2(11.7, -uTime * .45))) - .5;
  T = tap(fc + fl * 6. * live0 * live0 * uS);
  float sdf = T.r, since = uTime - T.g;
  float e = settleE(uTime - T.a), live = 1. - e;
  float n = vnoise(p * .03 + vec2(uTime * .5, -uTime * .35)) * .65 + vnoise(p * .061 - vec2(uTime * .3, 0.)) * .35;
  float front = since * uV - 1.5 + (n - .5) * 20. * live;
  float inflate = uInflate * pow(max(live, 0.), 1.5);
  float blur = uBlur * pow(max(live, 0.), 1.25);
  float a = sdf + inflate;
  float k = 2. + 16. * live;
  float h = max(k - abs(a - front), 0.) / k;
  return vec3(min(a, front) - h * h * k * .25, blur, e);
}

vec3 hex(float r, float g, float b){ return vec3(r, g, b) / 255.; }

void main(){
  vec2 fc = gl_FragCoord.xy;
  vec3 c = field(fc);
  float f = c.x, blur = c.y, e = c.z;
  bool dark = uDark == 1;
  float xFrac = (fc.x / uS - uWX0) / (uWX1 - uWX0);
  float crest = 1. - smoothstep(0., ${LIGHT_W.toFixed(2)}, abs(xFrac - uLight));
  float grainSeed = uRest > .5 ? 0. : floor(uTime * 24.);
  float grain = hash(floor(fc) + grainSeed * 17.31) - .5;

  float lift = blur * .9;
  float bevel = mix(uStroke * .42, uStroke * 1.35 + blur * .6, 1. - e) + lift;
  float st = max(uS, blur * .55 * uS);
  #define H(v) (clamp(((v) + lift) / bevel, 0., 1.) * (2. - clamp(((v) + lift) / bevel, 0., 1.)))
  float hL = H(field(fc - vec2(st, 0.)).x);
  float hR = H(field(fc + vec2(st, 0.)).x);
  float hD = H(field(fc - vec2(0., st)).x);
  float hU = H(field(fc + vec2(0., st)).x);
  float slope = mix(.55, 1.5, 1. - e);
  float k = bevel * uS / (2. * st) * slope;
  vec3 n = normalize(vec3((hL - hR) * k, (hD - hU) * k, 1.));
  vec3 faceBase = dark ? hex(139., 139., 147.) : hex(44., 44., 49.);
  vec3 faceCrest = dark ? vec3(1.) : hex(133., 133., 141.);
  vec3 bright = dark ? vec3(1.) : hex(246., 246., 250.);
  vec3 mid = dark ? hex(120., 120., 128.) : hex(58., 58., 64.);
  vec3 deep = dark ? hex(20., 20., 23.) : hex(5., 5., 6.);
  vec3 floorC = dark ? hex(182., 182., 192.) : hex(110., 110., 118.);
  float up = n.y;
  float sky = smoothstep(-.05, .85, up);
  float horizon = exp(-sq((up + .1) / .28));
  float flo = smoothstep(-.3, -.95, up);
  float strip = exp(-sq((n.x - (uLight - .5) * 1.7) / .26)) * (1. - abs(up) * .5);
  vec3 env = mix(mid, bright, sky);
  env = mix(env, deep, horizon * .5);
  env = mix(env, floorC, flo * .6);
  env = mix(env, bright, strip * .6);
  vec3 face = mix(faceBase, faceCrest, crest);
  float yv = clamp((fc.y / uS - uCapBase) / (uCapTop - uCapBase), 0., 1.);
  face *= mix(.95, 1.05, yv);
  float flatK = smoothstep(.80, .99, n.z);
  float live = 1. - e;
  env = mix(env, deep, horizon * .45 * live);
  float rimL = exp(-sq((f + blur * .25) / (1.2 + blur * .22))) * live;
  env = mix(env, dark ? vec3(1.) : hex(20., 20., 24.), rimL * .9);
  flatK *= smoothstep(.55, 1., e);
  vec3 col = mix(env, face, flatK);
  float soft = clamp(blur / max(uBlur, 1e-3), 0., 1.);
  col += grain * .02 * (1. - soft);
  float a = smoothstep(-.75 * uEdge - blur * .6, .75 * uEdge, f);
  vec4 outC = vec4(clamp(col, 0., 1.) * a, a);

  if (uRest < .5) {
    float ha = live * smoothstep(-(10. + blur * 1.7), -blur * .25, f) * (dark ? .22 : .12);
    vec3 hc = dark ? hex(170., 170., 178.) : hex(52., 52., 58.);
    outC += vec4(hc * ha, ha) * (1. - outC.a);
    vec4 T = tap(fc);
    float g = ((uTime - T.g) * uV + uLead) / 2.6;
    float lit = exp(-g * g) * smoothstep(.6, -.4, g);
    float shade = exp(-(g + 1.3) * (g + 1.3) * 1.6);
    float fade = smoothstep(6., 20., -T.r) * exp(-max(-T.r - 18., 0.) / 26.)
               * smoothstep(uPad * .9, uPad * .4, -T.r) * smoothstep(22., 40., T.b);
    float la = lit * (dark ? .22 : .7) * fade;
    float sa = shade * (dark ? .28 : .12) * fade;
    vec3 shadeC = dark ? vec3(0.) : hex(40., 40., 46.);
    vec4 ring = vec4(vec3(1.) * la, la) + vec4(shadeC * sa, sa) * (1. - la);
    outC = outC + ring * (1. - outC.a);
  }
  o = outC;
}`;
