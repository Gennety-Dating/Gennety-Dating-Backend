// VENDORED SUBSET — do not restyle here. Edit the stand, then re-copy.
//
// Source: Gennety-iOS repo, design/meet-ceremony/render.js at commit 6f05400
// (the founder-approved meeting-ceremony stand, 2026-09-29). Copied: the mark
// (`bodyPath`, `wing`, `mark`), the eyes and the sparkle, the defocus (`soft`
// with `filterOK` / `scratch` / `fit`), the mascot, the capsule, the plaque,
// `plaqueMarkDX`, `placementHint` and `palette` — verbatim function bodies.
// NOT copied: the stand's date screen under the scene, the map, the status and
// home bars, the hardware (island / camera hole) and `screen` — on a real
// phone the terminal itself is the screen under the scene, and the phone
// brings its own hardware. The composition `screen` did (wash → capsule →
// plaque → mascot) is `paintCeremony` in `overlay.ts`.
//
// Deliberate deviations from the stand, each marked `// MINI APP:` below:
//   1. ES module: imports `Ceremony`, exports the pieces instead of a global.
//   2. Fonts: the stand's display face is Geologica, which the Mini App does
//      not load; `DISPLAY` / `SYS` are the terminal's own faces and can be set
//      by `setFonts` before the first draw.
//   3. `scratch` canvases are created on first use, so importing this file in
//      a test (Node, no `document`) does not throw.
//   4. `PX` (canvas pixels per point, for shadows) was set by `screen`; here
//      `setPixelRatio` sets it.
/* eslint-disable */
"use strict";

import { Ceremony } from "./ceremony-stand.js"; // MINI APP: 1

const Render = (() => {
  const { clamp, mix } = Ceremony;
  const TAU = Math.PI * 2;
  const LIGHT = "#FBF3F5";
  const EYE = { dx: 11, cy: 50, rx: 7.6, ry: 13.4 };
  // MINI APP: 2 — the terminal's faces instead of Geologica: Inter, which
  // date-terminal.html loads with Cyrillic. (Chosen when the page's display
  // face was Space Grotesk, which has none. Since 2026-10-01 the page also
  // loads Gennety Display — Geologica's own instance, fonts.css — so moving
  // DISPLAY onto it is open; not done here, the canvas would first have to
  // `document.fonts.load` its weights.)
  let DISPLAY = "Inter, ui-rounded, system-ui, sans-serif";
  let SYS = "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif";
  const setFonts = (display, sys) => {
    DISPLAY = display;
    SYS = sys;
  };
  /** Пикселей холста на точку: тень холста не проходит через преобразование. */
  let PX = 1;
  const setPixelRatio = (px) => { // MINI APP: 4
    PX = px;
  };

  const palette = (dark) => dark
    ? { base: "#030303", ink: "#FFFFFF", muted: "rgba(255,255,255,0.55)", faint: "rgba(255,255,255,0.08)", accent: "#8B253B", accentInk: "#C13352",
        glass: "rgba(44,40,42,0.62)", glassEdge: "rgba(255,255,255,0.16)", glassHi: "rgba(255,255,255,0.10)", panel: "#07080B",
        map: { bg: "#17171B", road: "#2B2B31", minor: "#212126", water: "#16222C", park: "#18201A", label: "rgba(255,255,255,0.35)" },
        wash: "rgba(3,3,3," }
    : { base: "#F5F5F5", ink: "#1C1C1E", muted: "rgba(0,0,0,0.5)", faint: "rgba(0,0,0,0.06)", accent: "#8B253B", accentInk: "#8B253B",
        glass: "rgba(255,255,255,0.62)", glassEdge: "rgba(255,255,255,0.9)", glassHi: "rgba(255,255,255,0.7)", panel: "#FFFFFF",
        map: { bg: "#ECE8E2", road: "#FFFFFF", minor: "#F6F3EE", water: "#CCDCE2", park: "#DCE4D1", label: "rgba(0,0,0,0.35)" },
        wash: "rgba(255,255,255," };

  // ---------- Знак ----------
  const bodyPath = (fL = 0, fR = 0) => {
    const p = new Path2D();
    p.moveTo(50, 35);
    p.bezierCurveTo(20 + 0.3 * fL, 0 + fL, -10 + 0.5 * fL, 30 + 0.55 * fL, 15, 55);
    p.bezierCurveTo(-5, 75, 25, 100, 50, 65);
    p.bezierCurveTo(75, 100, 105, 75, 85, 55);
    p.bezierCurveTo(110 - 0.5 * fR, 30 + 0.55 * fR, 80 - 0.3 * fR, 0 + fR, 50, 35);
    p.closePath();
    return p;
  };
  const wing = (ctx) => {
    const g = ctx.createRadialGradient(32.27, 82.51, 0, 32.27, 82.51, 77.07);
    g.addColorStop(0, "#C82356");
    g.addColorStop(0.3, "#C82356");
    g.addColorStop(0.7, "#8B253B");
    g.addColorStop(1, "#3B0B1E");
    return g;
  };
  /** Маленький знак для плашек и иллюстрации. */
  const mark = (ctx, x, y, size, color) => {
    ctx.save();
    ctx.translate(x - size / 2, y - size / 2 - size * 0.08);
    ctx.scale(size / 100, size / 100);
    ctx.fillStyle = color || wing(ctx);
    ctx.fill(bodyPath());
    ctx.restore();
  };

  // ---------- Глаза ----------
  /** Глаз: моргание сверху (в дугу), улыбка снизу (нижняя дуга поднимается). */
  const eye = (ctx, cx, cy, rx, ry, blink, smile) => {
    const lidRy = ry + (0.55 - ry) * blink;
    const arcOn = clamp((blink - 0.55) / 0.45);
    const base = ctx.globalAlpha;
    if (arcOn < 1) {
      ctx.save();
      ctx.globalAlpha = base * (1 - arcOn);
      const ery = Math.max(0.4, lidRy);
      if (smile > 0.01) {
        const edge = cy + ery * (1 - 0.12 * smile), mid = cy + ery - smile * ery * 1.05;
        const clip = new Path2D();
        clip.moveTo(cx - rx - 2, cy - ery - 2);
        clip.lineTo(cx + rx + 2, cy - ery - 2);
        clip.lineTo(cx + rx + 2, edge);
        clip.quadraticCurveTo(cx, 2 * mid - edge, cx - rx - 2, edge);
        clip.closePath();
        ctx.clip(clip);
      }
      ctx.fillStyle = LIGHT;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ery, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    if (arcOn > 0) {
      ctx.save();
      ctx.globalAlpha = base * arcOn;
      ctx.strokeStyle = LIGHT;
      ctx.lineWidth = 4.6;
      ctx.lineCap = "round";
      const w = rx * 1.06;
      ctx.beginPath();
      ctx.moveTo(cx - w, cy + 2.07);
      ctx.quadraticCurveTo(cx, cy - 4.37, cx + w, cy + 2.07);
      ctx.stroke();
      ctx.restore();
    }
  };

  const sparkle = (ctx, x, y, amt, p) => {
    if (amt <= 0.01) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p * 0.9);
    const R = 7.5 * amt, r = R * 0.22;
    ctx.fillStyle = LIGHT;
    ctx.globalAlpha *= amt;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4, rr = k % 2 ? r : R;
      ctx.lineTo(Math.sin(a) * rr, -Math.cos(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.3);
    g.addColorStop(0, "rgba(255,240,245,0.55)");
    g.addColorStop(1, "rgba(255,240,245,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.3, 0, TAU);
    ctx.fill();
    ctx.restore();
  };

  // ---------- Расфокус ----------
  let FILTER = null;
  /** Умеет ли холст `filter: blur` (Safari долго не умел). */
  const filterOK = () => {
    if (FILTER !== null) return FILTER;
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 9;
      const x = c.getContext("2d");
      x.filter = "blur(2px)";
      x.fillStyle = "#000";
      x.fillRect(4, 4, 1, 1);
      FILTER = x.getImageData(1, 4, 1, 1).data[3] > 0;
    } catch (e) {
      FILTER = false;
    }
    return FILTER;
  };
  // MINI APP: 3 — created on first use (the stand made them at load).
  const scratch = {
    get big() { return (this._big ??= document.createElement("canvas")); },
    get small() { return (this._small ??= document.createElement("canvas")); },
  };
  const fit = (c, w, h) => {
    if (c.width < w || c.height < h) {
      c.width = Math.max(c.width, Math.ceil(w * 1.15));
      c.height = Math.max(c.height, Math.ceil(h * 1.15));
    }
    return c;
  };
  /**
   * Рисует `fn` на отдельном холсте и кладёт результат с размытием `r` (в
   * текущих единицах). Прозрачность вызывающего применяется к группе целиком —
   * перекрытия не просвечивают. `bounds` — [x0, y0, x1, y1] в текущих
   * единицах, с запасом. Без поддержки `filter` — размытие уменьшением и
   * растяжением (мягче, но так же без краёв).
   */
  const soft = (ctx, r, bounds, fn) => {
    const T = ctx.getTransform();
    const px = r * Math.hypot(T.a, T.b);
    if (px < 0.35) {
      fn(ctx);
      return;
    }
    const [x0, y0, x1, y1] = bounds;
    const xs = [], ys = [];
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
      xs.push(T.a * x + T.c * y + T.e);
      ys.push(T.b * x + T.d * y + T.f);
    }
    const pad = Math.ceil(px * 3);
    const X0 = Math.max(0, Math.floor(Math.min(...xs)) - pad), Y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
    const X1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(...xs)) + pad);
    const Y1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(...ys)) + pad);
    const W = X1 - X0, H = Y1 - Y0;
    if (W <= 0 || H <= 0) return;
    const c = fit(scratch.big, W, H), o = c.getContext("2d");
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, W, H);
    o.setTransform(T.a, T.b, T.c, T.d, T.e - X0, T.f - Y0);
    o.save();
    fn(o);
    o.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (filterOK()) {
      ctx.filter = `blur(${px.toFixed(2)}px)`;
      ctx.drawImage(c, 0, 0, W, H, X0, Y0, W, H);
    } else {
      const f = Math.min(1, 1.6 / px);
      const sw = Math.max(1, Math.round(W * f)), sh = Math.max(1, Math.round(H * f));
      const s = fit(scratch.small, sw, sh), so = s.getContext("2d");
      so.setTransform(1, 0, 0, 1, 0, 0);
      so.clearRect(0, 0, sw, sh);
      so.imageSmoothingQuality = "high";
      so.drawImage(c, 0, 0, W, H, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(s, 0, 0, sw, sh, X0, Y0, W, H);
    }
    ctx.restore();
  };

  // ---------- Маскот целиком ----------
  /** m — поза из `Ceremony.place`. */
  const mascot = (ctx, m) => {
    if (!m || m.e.alpha <= 0.001) return;
    const e = m.e;
    ctx.save();
    ctx.globalAlpha *= e.alpha;
    const M = Ceremony.bodyMatrix(m);
    ctx.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    // В прыжке он уходит из фокуса целиком — как предмет у самого объектива.
    soft(ctx, (m.blur || 0) / m.s, [-50, -50, 180, 170], (c) => mascotBody(c, m));
    ctx.restore();
  };
  const mascotBody = (ctx, m) => {
    const e = m.e;
    ctx.save();
    ctx.translate(50, e.anchor);
    ctx.scale(m.sx, m.sy);
    ctx.translate(-50, -e.anchor);
    ctx.fillStyle = wing(ctx);
    ctx.fill(bodyPath(e.flexL, e.flexR));
    const E = e.eyes;
    eye(ctx, 50 - EYE.dx + E.gx, EYE.cy + E.gy, EYE.rx, EYE.ry, E.blinkL, E.smileL);
    eye(ctx, 50 + EYE.dx + E.gx, EYE.cy + E.gy, EYE.rx, EYE.ry, E.blinkR, E.smileR);
    sparkle(ctx, 73, 34, e.sparkle, e.sparkleP || 0);
    ctx.restore();
  };

  // ---------- Капсула и плашка ----------
  const glassPill = (ctx, x, y, w, h, pal, fillAlpha = 1) => {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
    ctx.globalAlpha *= fillAlpha;
    ctx.fillStyle = pal.glass;
    ctx.shadowColor = "rgba(0,0,0,0.18)";
    ctx.shadowBlur = 18 * PX;
    ctx.shadowOffsetY = 6 * PX;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = pal.glassEdge;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.restore();
  };

  const capsule = (ctx, c, pal, t) => {
    if (!c || c.w < 1) return;
    ctx.save();
    ctx.globalAlpha *= c.alpha ?? 1;
    const r = Math.min(c.w, c.h) / 2;
    ctx.beginPath();
    ctx.roundRect(c.x - c.w / 2, c.y - c.h / 2, c.w, c.h, r);
    const g = ctx.createLinearGradient(0, c.y - c.h / 2, 0, c.y + c.h / 2);
    g.addColorStop(0, "#9A1F40");
    g.addColorStop(1, "#4F0C1E");
    ctx.fillStyle = g;
    ctx.shadowColor = "rgba(79,12,30,0.35)";
    ctx.shadowBlur = 16 * PX;
    ctx.shadowOffsetY = 6 * PX;
    ctx.fill();
    ctx.shadowColor = "transparent";
    // Ожидание партнёра — единственное бесконечное движение (класс «загрузка»).
    if (c.waiting) {
      ctx.save();
      ctx.clip();
      const x = c.x - c.w / 2 + (((t % 1600) + 1600) % 1600) / 1600 * (c.w + 120) - 60;
      const sh = ctx.createLinearGradient(x - 60, 0, x + 60, 0);
      sh.addColorStop(0, "rgba(255,255,255,0)");
      sh.addColorStop(0.5, "rgba(255,255,255,0.16)");
      sh.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sh;
      ctx.fillRect(c.x - c.w / 2, c.y - c.h / 2, c.w, c.h);
      ctx.restore();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    if (c.label && c.labelAlpha > 0.01) {
      ctx.globalAlpha *= c.labelAlpha;
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `600 17px ${DISPLAY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(c.label, c.x, c.y + 1);
    }
    ctx.restore();
  };

  /** Где знак плашки относительно её центра, точки: туда маскот и летит. */
  const plaqueMarkDX = (title, sub) => {
    const c = document.createElement("canvas").getContext("2d");
    c.font = `600 16px ${DISPLAY}`;
    const tw = c.measureText(title).width;
    c.font = `13px ${SYS}`;
    const sw = sub ? c.measureText(sub).width : 0;
    return 9 - (26 + Math.max(tw, sw)) / 2;
  };
  const plaque = (ctx, q, pal) => {
    if (!q || q.alpha <= 0.01) return;
    ctx.save();
    ctx.globalAlpha *= q.alpha;
    glassPill(ctx, q.x, q.y, q.w, q.h, pal);
    ctx.textBaseline = "middle";
    ctx.font = `600 16px ${DISPLAY}`;
    const tw = ctx.measureText(q.title).width;
    ctx.font = `13px ${SYS}`;
    const sw = q.sub ? ctx.measureText(q.sub).width : 0;
    const x0 = q.markX !== undefined ? q.markX - 9 : q.x - (26 + Math.max(tw, sw)) / 2;
    if ((q.mark ?? 1) > 0.01) {
      ctx.save();
      ctx.globalAlpha *= q.mark ?? 1;
      mark(ctx, x0 + 9, q.y, 18);
      ctx.restore();
    }
    ctx.globalAlpha *= q.text;
    ctx.textAlign = "left";
    ctx.fillStyle = pal.ink;
    ctx.font = `600 16px ${DISPLAY}`;
    ctx.fillText(q.title, x0 + 26, q.sub ? q.y - 9 : q.y);
    if (q.sub) {
      ctx.font = `13px ${SYS}`;
      ctx.fillStyle = pal.muted;
      ctx.fillText(q.sub, x0 + 26, q.y + 11);
    }
    ctx.restore();
  };

  /** Подсказка раскладки: два телефона верхними краями, камера к камере. */
  const placementHint = (ctx, cx, cy, pal) => {
    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = pal.ink;
    ctx.globalAlpha = 0.55;
    const w = 30, h = 56, gap = 3;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy + gap / 2, w, h, 8);
    ctx.roundRect(cx - w / 2, cy - gap / 2 - h, w, h, 8);
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = pal.ink;
    ctx.beginPath();
    ctx.roundRect(cx - 5, cy + gap / 2 + 3.5, 10, 3.2, 1.6);
    ctx.roundRect(cx - 5, cy - gap / 2 - 3.5 - 3.2, 10, 3.2, 1.6);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = pal.accentInk;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([0.1, 4]);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx + 3, cy + gap / 2 + 14);
    ctx.bezierCurveTo(cx + 30, cy + 10, cx + 30, cy - 10, cx + 3, cy - gap / 2 - 14);
    ctx.stroke();
    ctx.setLineDash([]);
    mark(ctx, cx + 25, cy, 13);
    ctx.restore();
  };

  return { palette, mascot, mascotBody, mark, capsule, plaque, glassPill, plaqueMarkDX, placementHint, setFonts, setPixelRatio };
})();

export { Render };
