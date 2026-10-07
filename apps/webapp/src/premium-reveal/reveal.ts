import "../fonts.css";
import "./reveal.css";
import {
  beats,
  DESIGN_WIDTH,
  FS,
  makeField,
  poseAt,
  REDUCED_END,
  T,
  timeline,
  VS,
  WORD,
  type Field,
  type Timeline,
} from "./stand";

/**
 * «Premium после покупки» в Mini App: экран покупки уходит «под воду», и
 * надпись «Premium» всплывает жидким металлом по буквам (стенд
 * `design/premium-unlock/`, отделка «Металл в воде», утверждена 2026-10-07).
 *
 * Тот же рисунок и те же такты, что в iOS: поле считается в единицах стенда
 * (полоса 320 pt) и растягивается на ширину окна, серединой на 40 % высоты.
 * Проигрыш один; дальше свет по надписи ездит только от наклона телефона.
 */

const FAMILY = '"Gennety Display"';

let fieldPromise: Promise<Field | null> | null = null;

/**
 * Поле надписи — один раз и заранее: на слабом телефоне это сотни
 * миллисекунд, и считать их в момент оплаты значило бы задержать праздник.
 * `null` — шрифт или холст не поднялись; тогда церемонии нет, как раньше.
 */
export function prepareRevealField(): Promise<Field | null> {
  if (!fieldPromise) {
    fieldPromise = (async () => {
      try {
        await document.fonts.load(`800 56px ${FAMILY}`);
        if (!document.fonts.check(`800 56px ${FAMILY}`)) return null;
        return makeField(FAMILY);
      } catch {
        return null;
      }
    })();
  }
  return fieldPromise;
}

export interface RevealCopy {
  /** Строка под надписью: «Работает и в приложении, и в Telegram.» */
  works: string;
  done: string;
  /** Название полосы для экранного диктора: «Premium активен». */
  label: string;
}

export interface RevealOptions {
  /** Экран покупки — он и уходит «под воду». */
  page: HTMLElement;
  field: Field;
  copy: RevealCopy;
  /** Капля буквы и застывание — у Telegram: `impactOccurred("soft")` и `notificationOccurred("success")`. */
  haptics: { drop(): void; settled(): void };
  /** Застывший кадр предпросмотра (`?preview=reveal&t=…`): ни вибраций, ни конца. */
  frozen?: number | undefined;
  /** Отклик стекла под пальцем — тот же, что у «Оформить подписку». */
  decorate?(button: HTMLButtonElement): void;
  onDone(): void;
}

export interface RevealHandle {
  /** «Активен до …» — когда сервер подтвердил подписку. */
  setUntil(text: string): void;
  destroy(): void;
}

export function playPremiumReveal(o: RevealOptions): RevealHandle {
  const { field: L, page } = o;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dark = document.documentElement.dataset.theme !== "light";
  const TL: Timeline = timeline(L.lastArrival, L.lastFocus);
  const duration = reduced ? REDUCED_END : TL.end;
  const due = beats(TL, WORD.length, reduced);

  const overlay = document.createElement("div");
  overlay.className = "pr-reveal";
  const canvas = document.createElement("canvas");
  canvas.className = "pr-band";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", o.copy.label);
  const copy = document.createElement("div");
  copy.className = "pr-copy";
  const until = document.createElement("div");
  until.className = "pr-until";
  const works = document.createElement("div");
  works.className = "pr-works";
  works.textContent = o.copy.works;
  copy.append(until, works);
  const done = document.createElement("button");
  done.type = "button";
  done.className = "pm-cta pr-done";
  done.append(Object.assign(document.createElement("span"), { textContent: o.copy.done }));
  done.addEventListener("click", () => o.onDone());
  o.decorate?.(done);
  // Проявление — у обёртки: у самой `.pm-cta` свои переходы на transform и
  // opacity (отклик нажатия), и покадровые значения они бы размазали.
  const dock = document.createElement("div");
  dock.className = "pr-dock";
  dock.append(done);
  overlay.append(canvas, copy, dock);
  document.body.append(overlay);

  // ---------- Раскладка: полоса стенда во всю ширину окна ----------
  let k = 1;
  const layout = (): void => {
    const width = Math.min(window.innerWidth, 480);
    k = width / DESIGN_WIDTH;
    const bandH = L.bandH * k;
    const top = Math.round(window.innerHeight * 0.4 - bandH / 2);
    // Пикселей не больше двух на CSS-пиксель: шейдер тяжёлый, а разницы
    // между 2× и 3× на размытой капле не видно.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${bandH}px`;
    canvas.style.top = `${top}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(bandH * dpr);
    copy.style.top = `${Math.round(top + L.baseline * k + 30)}px`;
    copy.style.width = `${width - 40}px`;
  };
  layout();

  // ---------- WebGL2; без него — застывшая надпись серебром ----------
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
  const loc: Record<string, WebGLUniformLocation | null> = {};
  let glOK = false;
  if (gl) {
    const sh = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = sh(gl.VERTEX_SHADER, VS);
    const fs = sh(gl.FRAGMENT_SHADER, FS);
    const prog = gl.createProgram()!;
    if (vs && fs) {
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      glOK = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
    }
    if (glOK) {
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const al = gl.getAttribLocation(prog, "a");
      gl.enableVertexAttribArray(al);
      gl.vertexAttribPointer(al, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, L.W, L.H, 0, gl.RGBA, gl.FLOAT, L.data);
      for (const n of ["uField", "uSize", "uS", "uTime", "uStroke", "uLight", "uRest", "uEdge", "uDark", "uV",
        "uSettle", "uWX0", "uWX1", "uCapTop", "uCapBase", "uBlur", "uInflate", "uLead", "uPad"]) {
        loc[n] = gl.getUniformLocation(prog, n);
      }
    }
  }
  if (!glOK) {
    const word = document.createElement("div");
    word.className = "pr-fallback";
    word.textContent = WORD;
    word.style.top = canvas.style.top;
    word.style.height = canvas.style.height;
    word.style.fontSize = `${L.big * k}px`;
    word.setAttribute("aria-label", o.copy.label);
    canvas.replaceWith(word);
  }
  const reducedRun = reduced || !glOK;

  const draw = (t: number, light: number, rest: 0 | 1, wordT: number): void => {
    if (!gl || !glOK) return;
    const uS = canvas.width / DESIGN_WIDTH;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1i(loc.uField, 0);
    gl.uniform2f(loc.uSize, canvas.width, canvas.height);
    gl.uniform1f(loc.uS, uS);
    gl.uniform1f(loc.uEdge, 2 / uS);
    gl.uniform1f(loc.uTime, wordT);
    gl.uniform1f(loc.uStroke, L.stroke);
    gl.uniform1f(loc.uLight, light);
    gl.uniform1f(loc.uRest, rest);
    gl.uniform1i(loc.uDark, dark ? 1 : 0);
    gl.uniform1f(loc.uV, T.v);
    gl.uniform1f(loc.uSettle, T.settle);
    gl.uniform1f(loc.uWX0, L.wx0);
    gl.uniform1f(loc.uWX1, L.wx1);
    gl.uniform1f(loc.uCapTop, L.capTop);
    gl.uniform1f(loc.uCapBase, L.capBase);
    gl.uniform1f(loc.uBlur, T.blur * L.big);
    gl.uniform1f(loc.uInflate, T.inflate * L.big);
    gl.uniform1f(loc.uLead, T.lead * L.big);
    gl.uniform1f(loc.uPad, L.pad);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    void t;
  };

  // ---------- Наклон: свет после прохода ----------
  let rollTarget = 0;
  let roll = 0;
  let rollSeen = false;
  const onOrient = (e: DeviceOrientationEvent): void => {
    if (e.gamma == null) return;
    rollTarget = Math.max(-0.6, Math.min(0.6, (e.gamma * Math.PI) / 180));
    if (!rollSeen) {
      rollSeen = true;
      roll = rollTarget;
    }
    kick();
  };
  // Под Reduce Motion свет стоит в опорном положении — как в iOS.
  if (!reducedRun) window.addEventListener("deviceorientation", onOrient);
  const onResize = (): void => {
    layout();
    kick();
  };
  window.addEventListener("resize", onResize);

  // ---------- Кадр ----------
  const start = performance.now();
  let raf = 0;
  let last = 0;
  let fired = 0;
  let finished = false;
  let destroyed = false;

  const style = (el: HTMLElement, k01: number, lift: number, blur: number): void => {
    el.style.opacity = String(k01);
    el.style.transform = `translateY(${(lift * (1 - k01)).toFixed(2)}px)`;
    el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
  };

  const frame = (now: number): void => {
    raf = 0;
    if (destroyed) return;
    const t = o.frozen ?? (now - start) / 1000;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    const diff = rollTarget - roll;
    const rollMoving = Math.abs(diff) > 0.0005;
    roll = rollMoving ? roll + diff * Math.min(1, dt * 9) : rollTarget;
    const P = poseAt(TL, t, reducedRun, roll);

    page.style.opacity = String(1 - P.pwOut);
    page.style.transform = `translateY(${(-10 * P.pwOut).toFixed(2)}px) scale(${(1 - 0.03 * P.pwOut).toFixed(4)})`;
    page.style.filter = P.blurOut > 0.05 ? `blur(${P.blurOut.toFixed(2)}px)` : "none";
    page.style.pointerEvents = P.pwOut > 0.5 ? "none" : "";
    page.setAttribute("aria-hidden", P.pwOut > 0.5 ? "true" : "false");
    style(copy, P.copyK, 8, P.blurIn);
    style(dock, P.doneK, 10, P.blurDone);
    dock.style.pointerEvents = P.doneK > 0.5 ? "auto" : "none";
    done.tabIndex = P.doneK > 0.5 ? 0 : -1;
    canvas.style.opacity = String(P.wordOpacity);
    draw(t, P.light, P.rest, P.wordT);

    if (o.frozen == null) {
      while (fired < due.length && due[fired].t <= t) {
        if (due[fired].kind === "drop") o.haptics.drop();
        else o.haptics.settled();
        fired++;
      }
      if (!finished && t >= duration) finished = true;
    }
    // Движение кончилось и свет догнал наклон — кадров не нужно; новый крен
    // будит их снова.
    const still = o.frozen != null || finished;
    if (!still || rollMoving) raf = requestAnimationFrame(frame);
    else last = 0;
  };
  const kick = (): void => {
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  };
  kick();

  return {
    setUntil(text: string): void {
      until.textContent = text;
    },
    destroy(): void {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("deviceorientation", onOrient);
      window.removeEventListener("resize", onResize);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      overlay.remove();
      for (const p of ["opacity", "transform", "filter", "pointerEvents"] as const) page.style[p] = "";
      page.removeAttribute("aria-hidden");
    },
  };
}
