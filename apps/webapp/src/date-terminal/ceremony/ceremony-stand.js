// VENDORED COPY — do not edit here. Edit the stand, then re-copy.
//
// Source: Gennety-iOS repo, design/meet-ceremony/ceremony.js at commit 6f05400
// (the founder-approved meeting-ceremony stand, 2026-09-29). The body below is
// verbatim; the only additions are this header and the `export` at the very
// end. The iOS port is checked against the
// same file by `Packages/DesignSystem/.../mascot-ceremony-parity.json`; this
// copy is checked by `ceremony-parity.test.ts` against a subset of it.
//
// Phone-specific wiring (a Telegram viewport is not in DEVICES, localized
// labels) lives in `adapter.ts`, never in here.
// Церемония встречи за столом — хореография и физическая модель.
//
// Стенд для ревью основателя (порядок 2026-09-13: движение сначала на стенде,
// потом Swift и Mini App). Кадр — чистая функция от миллисекунд, пары
// телефонов и сценария; никакого состояния между кадрами. После одобрения
// переносится в Swift теми же функциями и сверяется фикстурой, как
// `mascot-climb`.
//
// Мир — миллиметры стола. Телефоны лежат экраном вверх, верхними краями друг к
// другу (камера к камере). A — тот, от кого прыгает маскот, внизу картинки;
// B — напротив, повёрнут на 180°. Маскот одного роста в миллиметрах на любых
// экранах. Переход — прыжок над столом (правка основателя 2026-09-28, туннель
// «остров → остров» снят): у A он взлетает к зрителю в сторону партнёра,
// растёт, уходит из фокуса и растворяется в воздухе; у B проявляется из
// воздуха уже лицом к ней и падает на стекло. Пауза в воздухе прячет и стык
// телефонов (зазор и сдвиг вбок не важны), и расхождение часов.
//
// Церемония одна, бесплатная, у всех пользователей iOS (основатель,
// 2026-09-29): платное приветствие — фрак, букеты, ваза — снято целиком.
//
// Координаты экрана — точки (как у SwiftUI), тело — система 100 × 100
// (`ButterflyMark`).
"use strict";

const Ceremony = (() => {
  // ---------- Кривые (Mascot.CubicBezier) ----------
  const cubic = (x1, y1, x2, y2) => {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    return (p) => {
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      let t = p;
      for (let i = 0; i < 8; i++) {
        const e = ((ax * t + bx) * t + cx) * t - p;
        const d = (3 * ax * t + 2 * bx) * t + cx;
        if (Math.abs(e) < 1e-6 || d === 0) break;
        t -= e / d;
      }
      return ((ay * t + by) * t + cy) * t;
    };
  };
  const ease = {
    move: cubic(0.42, 0, 0.58, 1), // от покоя к покою
    out: cubic(0.22, 0.68, 0.3, 1), // резкий старт, мягкая посадка
    in: cubic(0.5, 0, 0.9, 0.5), // разгон к удару
    glide: cubic(0.45, 0, 0.25, 1), // перенос предмета
    soft: cubic(0.3, 0, 0.2, 1), // выдох сцены
  };
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const mix = (a, b, p) => a + (b - a) * p;
  const seg = (t, start, dur) => clamp((t - start) / dur);
  const lerp2 = (a, b, p) => [mix(a[0], b[0], p), mix(a[1], b[1], p)];
  /** Колокол 0 → 1 → 0: подъём, удержание, спад. */
  const bell = (t, start, up, hold, down) => {
    if (t <= start) return 0;
    if (t < start + up) return ease.move((t - start) / up);
    if (t < start + up + hold) return 1;
    return 1 - ease.move(clamp((t - start - up - hold) / down));
  };

  // ---------- Пружины (масса 1, одна аналитическая формула в TS и Swift) ----------
  /**
   * `response` и `dampingFraction` — как у SwiftUI `.spring`. `step` — переход
   * 0 → 1 с перелётом, `impulse` — отклик на толчок, нормированный так, что
   * первый пик = 1 (амплитуду задаёт вызывающий).
   */
  const spring = (response, damping) => {
    const w = (2 * Math.PI) / response;
    const z = damping;
    const wd = w * Math.sqrt(1 - z * z);
    const tp = Math.atan2(wd, z * w) / wd;
    const peak = (Math.exp(-z * w * tp) * Math.sin(wd * tp)) / wd;
    return {
      response, damping, k: w * w, c: 2 * z * w,
      step: (ms) => {
        if (ms <= 0) return 0;
        const t = ms / 1000, e = Math.exp(-z * w * t);
        return 1 - e * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
      },
      impulse: (ms) => {
        if (ms <= 0) return 0;
        const t = ms / 1000;
        return (Math.exp(-z * w * t) * Math.sin(wd * t)) / wd / peak;
      },
    };
  };
  const SPRING = {
    pos: spring(0.5, 0.65), // «фирменное событие» из таблицы thresholds §5.1
    squash: spring(0.26, 0.55), // приплюснутость на посадке — 13 % перелёта
    wings: spring(0.4, 0.32), // верхние лопасти — два затухающих качка
    pop: spring(0.34, 0.52), // появление из капсулы
    pad: spring(0.3, 0.6), // плашка
  };

  // ---------- Телефоны ----------
  const mmPerPt = (ppi, scale) => (25.4 * scale) / ppi;
  /**
   * Плотность — из паспорта экрана, рамки — замер корпуса (корпус минус
   * активная область). `portal` — чем сверху прикрыт экран: остров, вырез
   * камеры или просто рамка.
   */
  const DEVICES = {
    pro17: {
      name: "iPhone 17 Pro", w: 402, h: 874, mm: mmPerPt(460, 3), side: 2.65, top: 2.6, bottom: 2.6,
      bodyR: 11.5, screenR: 57, portal: { kind: "island", w: 125, h: 37, top: 11 }, status: 62, home: 34,
    },
    max16: {
      name: "iPhone 16 Pro Max", w: 440, h: 956, mm: mmPerPt(460, 3), side: 2.35, top: 2.3, bottom: 2.3,
      bodyR: 12.5, screenR: 62, portal: { kind: "island", w: 125, h: 37, top: 11 }, status: 62, home: 34,
    },
    se: {
      name: "iPhone SE", w: 375, h: 667, mm: mmPerPt(326, 2), side: 4.45, top: 17.25, bottom: 17.25,
      bodyR: 9.5, screenR: 0, portal: { kind: "edge" }, status: 20, home: 0,
    },
    pixel: {
      name: "Android · Pixel 9", w: 412, h: 923, mm: mmPerPt(422, 2.625), side: 3.45, top: 3.5, bottom: 3.5,
      bodyR: 10, screenR: 46, portal: { kind: "hole", d: 22, cy: 24 }, status: 44, home: 20,
    },
  };

  /** Рост маскота: миллиметров на единицу тела (100 единиц = 20 мм, ≈ 120 pt на 17 Pro). */
  const UNIT_MM = 0.2;
  /**
   * Прыжок над столом при скорости 280 мм/с (ползунок скорости сжимает всё
   * пропорционально). `rise` — у A от толчка до полного растворения, `air` —
   * не видно ни на одном экране, `fall` — у B от первого проблеска до касания.
   * `top` — где на экране вершина (доля высоты: ниже острова, чтобы маскот
   * не нырял в него), `grow` — насколько он вырастает к зрителю в вершине,
   * `blur` — расфокус в вершине, точки.
   */
  const FLIGHT = { rise: 420, air: 140, fall: 400, top: 0.3, grow: 0.55, blur: 10 };

  /** Раскладка экрана в точках: капсула, ступня маскота, вершина прыжка. */
  const layout = (d) => {
    const capY = Math.round(d.h * (d.home ? 0.74 : 0.79));
    const capW = Math.min(280, d.w - 80);
    return {
      capY, capW, capH: 56,
      foot: capY + (30 * UNIT_MM) / d.mm, apex: d.h * FLIGHT.top,
      panelTop: Math.round(d.h * 0.4),
    };
  };

  /**
   * Пара на столе. A стоит ровно, B — на 180° и может быть сдвинут вбок
   * (`off`, мм): люди кладут телефоны на глаз. Возвращает переводы
   * «точки экрана ↔ мм стола».
   */
  const pair = (dA, dB, gap, off) => {
    const A = {
      key: "A", d: dA, rot: 0,
      toWorld: (x, y) => [(x - dA.w / 2) * dA.mm, gap / 2 + dA.top + y * dA.mm],
      toLocal: (X, Y) => [X / dA.mm + dA.w / 2, (Y - gap / 2 - dA.top) / dA.mm],
    };
    const B = {
      key: "B", d: dB, rot: 180,
      toWorld: (x, y) => [-(x - dB.w / 2) * dB.mm + off, -(gap / 2 + dB.top + y * dB.mm)],
      toLocal: (X, Y) => [-(X - off) / dB.mm + dB.w / 2, (-Y - gap / 2 - dB.top) / dB.mm],
    };
    A.L = layout(dA);
    B.L = layout(dB);
    return { A, B };
  };

  // ---------- План: такты из геометрии и скорости ----------
  /**
   * cfg: { devA, devB, gap, offset, speed (мм/с), clock (мс, насколько часы B
   *        впереди), rm (Reduce Motion), markDX (где знак на плашке
   *        относительно её центра, точки) }
   */
  const plan = (cfg) => {
    const { A, B } = pair(DEVICES[cfg.devA], DEVICES[cfg.devB], cfg.gap, cfg.offset);
    // Точки на столе — только для рентгена стенда: полёт от них не зависит.
    const LA = A.toWorld(A.d.w / 2, A.L.foot), LB = B.toWorld(B.d.w / 2, B.L.foot);
    const EA = A.toWorld(A.d.w / 2, A.L.apex), EB = B.toWorld(B.d.w / 2, B.L.apex);
    const k = 280 / cfg.speed;
    const TA = FLIGHT.rise * k, TT = FLIGHT.air * k, TB = FLIGHT.fall * k;
    const leap = 720;
    const t1 = leap + TA, t2 = t1 + TT, t3 = t2 + TB;
    const b = {
      gather: 0, pop: 120, eyes: 260, look: 420, crouch: 600, leap,
      glance: t3 + 330, wink: t3 + 720, dissolve: t3 + 1150, plaque: t3 + 1250,
    };
    const tEnd = cfg.rm ? 1900 : b.plaque + 900;
    const P = {
      cfg, rm: !!cfg.rm, A, B, LA, LB, EA, EB, TA, TT, TB, t1, t2, t3,
      b, tEnd, markDX: cfg.markDX ?? -96,
    };
    P.beats = beats(P);
    P.haptics = haptics(P);
    return P;
  };

  const beats = (P) => {
    const { b, t1, t2, t3 } = P;
    if (P.rm) {
      return [
        { who: "AB", from: 0, to: 300, label: "Капсулы гаснут" },
        { who: "B", from: 300, to: 1300, label: "Маскот проявляется, улыбается" },
        { who: "AB", from: 1300, to: P.tEnd, label: "Плашка" },
      ];
    }
    return [
      { who: "A", from: b.gather, to: b.pop + 300, label: "Собрался из капсулы" },
      { who: "A", from: b.look, to: b.crouch, label: "Смотрит к партнёру" },
      { who: "A", from: b.crouch, to: b.leap, label: "Присел" },
      { who: "A", from: b.leap, to: t1, label: "Взлёт · растворяется в воздухе" },
      { who: "AB", from: t1, to: t2, label: "Над столом" },
      { who: "B", from: 0, to: 240, label: "Капсула гаснет" },
      { who: "B", from: t2, to: t3, label: "Проявляется и падает" },
      { who: "B", from: t3, to: t3 + 280, label: "Посадка · щелчок" },
      { who: "B", from: b.glance, to: b.glance + 540, label: "Смотрит на телефон партнёра" },
      { who: "B", from: b.wink, to: b.wink + 460, label: "Подмигивает" },
      { who: "B", from: b.dissolve, to: b.plaque + 180, label: "Становится знаком плашки" },
      { who: "AB", from: b.plaque, to: P.tEnd, label: "Плашка на обоих" },
    ];
  };

  /** Хаптика: словарь `Haptics.swift` + новые удары; в Telegram — ближайший стиль. */
  const haptics = (P) => {
    const { b, t3 } = P;
    if (P.rm) {
      return [
        { who: "B", t: 300, id: "magSafeSnap", note: "rigid 1.0 — событие остаётся и без движения", tg: "impact rigid" },
        { who: "A", t: 1300, id: "success", note: "плашка", tg: "notification success" },
      ];
    }
    return [
      { who: "A", t: b.leap, id: "ceremonyLaunch", note: "толчок + затухающее скольжение 160 мс", tg: "impact soft → light" },
      { who: "B", t: t3, id: "magSafeSnap", note: "rigid 1.0 по часам CHHapticEngine (±5 мс)", tg: "impact rigid" },
      { who: "A", t: b.plaque, id: "success", note: "у A посадки не было — плашка подтверждает", tg: "notification success" },
    ];
  };

  // ---------- Прыжок над столом ----------
  /**
   * Полёт на экране телефона `key`: где ступня (y, точки), во сколько раз
   * маскот вырос к зрителю, насколько он виден и насколько не в фокусе.
   * `z` — высота прыжка, 0 на стекле, 1 в вершине: у A взлёт тормозит к
   * вершине (1 − (1 − p)²), у B падение разгоняется к стеклу (1 − q²) —
   * одна баллистика, разрезанная паузой в воздухе. Переворота нет: у каждого
   * телефона маскот стоит лицом к своему владельцу.
   */
  const flight = (P, key, t) => {
    const L = P[key].L;
    const at = (z, alpha, blur) => ({ y: mix(L.foot, L.apex, z), grow: 1 + FLIGHT.grow * z, alpha, blur, z });
    const { b, t1, t2, t3 } = P;
    if (key === "A") {
      if (t <= b.leap) return at(0, 1, 0);
      if (t >= t1) return at(1, 0, FLIGHT.blur);
      const p = (t - b.leap) / P.TA, z = 1 - (1 - p) * (1 - p);
      return at(z, 1 - ease.move(clamp((p - 0.42) / 0.58)), FLIGHT.blur * ease.in(clamp((p - 0.2) / 0.8)));
    }
    if (t <= t2) return at(1, 0, FLIGHT.blur);
    if (t >= t3) return at(0, 1, 0);
    const q = (t - t2) / P.TB, z = 1 - q * q;
    return at(z, ease.move(clamp(q / 0.5)), FLIGHT.blur * (1 - ease.out(clamp(q / 0.72))));
  };
  /** Проекция на стол для рентгена стенда: у A, над стыком, у B. */
  const ground = (P, t) => {
    if (t <= P.t1) {
      const f = flight(P, "A", t);
      return P.A.toWorld(P.A.d.w / 2, f.y);
    }
    if (t < P.t2) return lerp2(P.EA, P.EB, (t - P.t1) / P.TT);
    const f = flight(P, "B", t);
    return P.B.toWorld(P.B.d.w / 2, f.y);
  };

  // ---------- Выразительные параметры ----------
  /**
   * Поза маскота без привязки к телефону: сжатие, лопасти, глаза, наклон.
   * Всё — функции `t`. Рук нет вовсе (основатель, 2026-09-28).
   */
  const expression = (P, t) => {
    const { b, t1, t2, t3 } = P;
    const o = {
      alpha: 1, scale: 1, sx: 1, sy: 1, anchor: 82, tilt: 0, flexL: 0, flexR: 0, lift: 0,
      eyes: { gx: 0, gy: 0, blinkL: 0, blinkR: 0, smileL: 0, smileR: 0 },
      sparkle: 0,
    };

    // Появление: капсула собралась в каплю, из неё — маскот с перелётом роста.
    o.scale = 0.35 + 0.65 * SPRING.pop.step(t - b.pop);
    o.alpha = clamp((t - b.pop) / 90);
    const opened = ease.out(seg(t, b.eyes, 140));
    o.eyes.blinkL = o.eyes.blinkR = 1 - opened;

    // Взгляд к партнёру (за верхний край) перед прыжком — глаза ведут действие.
    // У B он падает, глядя на неё.
    if (t < t2) o.eyes.gy = -3.5 * ease.move(seg(t, b.look, 170));

    // Присед → прыжок.
    const cr = t < b.leap ? ease.move(seg(t, b.crouch, b.leap - b.crouch)) : 0;
    o.sy = 1 - 0.14 * cr;
    o.sx = 1 + 0.1 * cr;
    o.flexL = o.flexR = -1.5 * ease.move(seg(t, b.look, 170)) * (t < b.leap ? 1 : 0);

    if (t >= b.leap && t < t3) {
      // Растяжение вдоль полёта: отрыв и разгон перед ударом о стекло.
      const st = Math.max(
        0.16 * (1 - ease.out(seg(t, b.leap, 150))),
        0.08 * ease.in(seg(t, t3 - 140, 140)),
      );
      o.sy = 1 + st;
      o.sx = 1 / Math.sqrt(o.sy);
      o.anchor = 50;
      // Лопасти отстают от рывка вверх (захлёст), потом догоняют; в падении
      // встречный воздух держит их поднятыми — до удара.
      if (t < t1) o.flexL = o.flexR = 3 * SPRING.wings.impulse(t - b.leap);
      else if (t >= t2) o.flexL = o.flexR = -2.2 * (1 - ease.in(seg(t, t2, t3 - t2)));
    }

    if (t >= t3) {
      const sq = SPRING.squash.impulse(t - t3);
      o.sy = 1 - 0.18 * sq;
      o.sx = 1 + 0.12 * sq;
      o.flexL = o.flexR = 4 * SPRING.wings.impulse(t - t3 - 30);
      const squint = Math.max(0, sq) * 0.85;
      o.eyes.blinkL = Math.max(o.eyes.blinkL, squint);
      o.eyes.blinkR = Math.max(o.eyes.blinkR, squint);
    }

    // Взгляд на телефон партнёра: он за верхним краем экрана B.
    const gl = bell(t, b.glance, 200, 180, 160);
    o.eyes.gy += -4.5 * gl;
    o.flexL += -2 * gl;
    o.flexR += -2 * gl;
    // Подмигивание: правый глаз в дугу, левый улыбается снизу, плечо вверх.
    const w0 = b.wink;
    const wk = ease.in(seg(t, w0, 100)) * (1 - ease.out(seg(t, w0 + 300, 160)));
    o.eyes.blinkR = Math.max(o.eyes.blinkR, wk);
    o.eyes.smileL = 0.4 * bell(t, w0, 100, 200, 260);
    o.tilt = 5 * ease.move(seg(t, w0, 110)) - 5 * SPRING.pos.step(t - (w0 + 300));
    o.flexR += -2.6 * ease.move(seg(t, w0, 110)) + 2.6 * SPRING.wings.step(t - (w0 + 300));
    o.sy *= 1 - 0.03 * bell(t, w0, 100, 200, 200);
    o.sparkle = bell(t, w0 + 90, 120, 60, 200);
    o.sparkleP = seg(t, w0 + 90, 380);
    // Становится знаком плашки: летит в него, уменьшаясь до его размера,
    // и в последний миг передаёт место нарисованному знаку.
    o.toMark = ease.glide(seg(t, b.dissolve, 380));
    o.alpha *= 1 - seg(t, b.dissolve + 300, 80);
    if (o.toMark > 0) o.eyes.blinkL = o.eyes.blinkR = Math.max(o.eyes.blinkR, ease.in(seg(t, b.dissolve + 180, 160)));
    return o;
  };

  // ---------- Reduce Motion ----------
  const reducedExpression = (P, t) => ({
    alpha: ease.move(seg(t, 300, 220)) * (1 - ease.move(seg(t, 1100, 220))),
    scale: 1, sx: 1, sy: 1, anchor: 82, tilt: 0, flexL: 0, flexR: 0, lift: 0,
    eyes: { gx: 0, gy: 0, blinkL: 0, blinkR: 0, smileL: 0.35, smileR: 0.35 },
    sparkle: 0,
  });

  // ---------- Кадр одного телефона ----------
  /**
   * Всё, что рисует телефон `key` в момент `t` по СВОИМ часам. У B часы
   * смещены на `cfg.clock` — так стенд показывает, что пауза в воздухе
   * прячет рассинхрон.
   */
  const frame = (P, key, tGlobal) => {
    const Ph = P[key];
    const t = key === "B" ? tGlobal + P.cfg.clock : tGlobal;
    const d = Ph.d, Lo = Ph.L;
    const f = { t, key, stage: 0, blur: 0, capsule: null, plaque: null, mascot: null };

    // Сцена: интерфейс под церемонией притухает и уходит в расфокус.
    f.stage = ease.move(seg(t, 0, 260));
    f.blur = 0.45 * f.stage;
    const cap = { x: d.w / 2, y: Lo.capY, w: Lo.capW, h: Lo.capH };

    if (P.rm) return reducedFrame(P, key, t, f, cap);

    const { b } = P;

    // Капсулы: у A собирается в каплю, из которой встаёт маскот; у B просто
    // складывается и гаснет — площадки под ним больше нет (правка 2026-09-28).
    if (t < 0) {
      f.capsule = key === "A"
        ? { ...cap, fill: 1, label: "Ждём Аню…", labelAlpha: 1, waiting: true }
        : { ...cap, fill: 1, label: "Готово", labelAlpha: 1 };
    } else if (t < 240) {
      const g = ease.in(seg(t, 0, 160));
      const w = mix(cap.w, cap.h, g);
      const shrink = t < 160 ? 1 : 1 - ease.move(seg(t, 160, 80));
      f.capsule = { ...cap, w: w * shrink, h: cap.h * shrink, fill: 1, label: key === "B" ? "Готово" : "",
        labelAlpha: 1 - seg(t, 0, 90), alpha: key === "B" ? 1 - ease.in(seg(t, 120, 120)) : 1 };
    }

    // Плашки.
    const plaque = (at, title, sub) => {
      const m = SPRING.pad.step(t - at);
      return { x: cap.x, y: cap.y, w: mix(56, 300, m), h: mix(26, 64, m), alpha: clamp((t - at) / 120),
        text: clamp((t - at - 110) / 180), title, sub, markX: cap.x + P.markDX };
    };
    if (t >= b.plaque) {
      f.plaque = plaque(b.plaque, "Встреча подтверждена", "Следующий билет — за мной");
      // У B знак на плашке — это сам маскот: рисованный появляется, когда он долетел.
      if (key === "B") {
        f.plaque.mark = seg(t, b.dissolve + 300, 80);
        f.plaque.text = seg(t, b.dissolve + 250, 180);
      }
    }

    // Маскот.
    const e = expression(P, t);
    f.mascot = place(P, Ph, t, e);
    return f;
  };

  /**
   * Поза в точках этого телефона: центр тела, масштаб, расфокус. Маскот
   * всегда по центру ширины и лицом к владельцу телефона.
   */
  const place = (P, Ph, t, e) => {
    const d = Ph.d, Lo = Ph.L;
    const s0 = UNIT_MM / d.mm;
    const fl = flight(P, Ph.key, t);
    let s = s0 * fl.grow * e.scale;
    let C = [d.w / 2, fl.y - 32 * s - e.lift];
    let alpha = e.alpha * fl.alpha;
    if (e.toMark > 0) {
      // Знак плашки: 18 pt, центр его рамки 100 × 100 на 1,4 pt выше строки.
      const M = [d.w / 2 + P.markDX, Lo.capY - 0.08 * 18];
      C = [mix(C[0], M[0], e.toMark), mix(C[1], M[1], e.toMark)];
      s = mix(s, 0.18, e.toMark);
    }
    return { C, s, rot: 0, sx: e.sx, sy: e.sy, e: alpha === e.alpha ? e : { ...e, alpha }, s0, blur: fl.blur };
  };

  /** Матрица «единицы тела → точки экрана»; сжатие рисующий кладёт сам. */
  const bodyMatrix = (m) => {
    const M = new DOMMatrix();
    M.translateSelf(m.C[0], m.C[1]);
    M.rotateSelf(m.rot);
    M.scaleSelf(m.s, m.s);
    M.translateSelf(-50, -50);
    M.translateSelf(50, 76).rotateSelf(m.e.tilt).translateSelf(-50, -76);
    return M;
  };
  const reducedFrame = (P, key, t, f, cap) => {
    const e = reducedExpression(P, t);
    const plaque = () => ({ x: cap.x, y: cap.y, w: 300, h: 64, alpha: seg(t, 1300, 220), text: 1, markX: cap.x + P.markDX,
      title: "Встреча подтверждена", sub: "Следующий билет — за мной" });
    if (key === "A") {
      if (t < 300) f.capsule = { ...cap, fill: 1, label: t < 0 ? "Ждём Аню…" : "", labelAlpha: 1 - seg(t, 0, 200), alpha: 1 - seg(t, 0, 300), waiting: t < 0 };
      if (t >= 1300) f.plaque = plaque();
      return f;
    }
    if (t < 300) f.capsule = { ...cap, fill: 1, label: "Готово", labelAlpha: 1 - seg(t, 0, 200), alpha: 1 - seg(t, 0, 300) };
    const Ph = P.B;
    const s0 = UNIT_MM / Ph.d.mm;
    f.mascot = { C: [Ph.d.w / 2, Ph.L.foot - 32 * s0], s: s0, rot: 0, sx: 1, sy: 1, e, s0, blur: 0 };
    if (t >= 1300) f.plaque = plaque();
    return f;
  };

  /**
   * Шов по часам: когда маскот последний раз виден у A и когда впервые у B.
   * Разница — сколько часы B могут спешить, прежде чем маскот мелькнёт на
   * двух экранах сразу. Отставать можно, пока пауза в воздухе не длиннее
   * ~320 мс: дольше она читается как заминка, а не как полёт.
   */
  const seamInfo = (P) => {
    let lastA = P.t1, firstB = P.t2;
    for (let t = P.b.leap; t <= P.t1; t += 2) if (flight(P, "A", t).alpha > 0.02) lastA = t;
    for (let t = P.t2; t <= P.t3; t += 2) if (flight(P, "B", t).alpha > 0.02) { firstB = t; break; }
    const hidden = Math.round(firstB - lastA);
    return { hiddenMs: hidden, aheadOk: hidden, behindOk: Math.max(0, 320 - hidden),
      riseMs: Math.round(P.TA), fallMs: Math.round(P.TB), lastA, firstB };
  };

  return {
    ease, clamp, mix, seg, bell, spring, SPRING, DEVICES, UNIT_MM,
    plan, frame, expression, place, bodyMatrix, seamInfo, layout, ground, flight, FLIGHT,
  };
})();

export { Ceremony };
