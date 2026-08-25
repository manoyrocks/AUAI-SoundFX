import type { ControlVector } from "@soundfx/engine";
import type { ClfsTelemetry } from "@soundfx/engine";

/**
 * Generative field visual.
 *
 * This is the M1 placeholder for the full cross-modal sync bus (M3: WebGPU
 * shader visuals driven by the same control vector that drives light and
 * haptics). It is deliberately built from the *same* control-vector +
 * telemetry stream the audio consumes — same latency, same continuity — so
 * what you see morphing on screen is evidence of, not decoration for, the
 * live control-vector morphing under test.
 *
 * Rendering: a ring of soft radial particles orbiting a common centre.
 *  - hue           <- valence (warm/cool)
 *  - saturation    <- brightness
 *  - particle count/size <- density, air
 *  - orbit speed   <- tempo, arousal
 *  - jitter        <- tension, complexity
 *  - glow radius   <- depth
 *  - pulse         <- actual engine RMS (telemetry), not the setpoint —
 *                     this is what makes it feel alive rather than simulated.
 */

interface Particle {
  angle: number;
  radius: number;
  speed: number;
  size: number;
  phase: number;
}

export class FieldVisual {
  private readonly ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private raf = 0;
  private control: ControlVector | null = null;
  private telemetry: ClfsTelemetry | null = null;
  /** Rate-limited brightness pulse; see draw(). */
  private pulseSmoothed = 0.15;
  private t = 0;
  private dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  private motionScale = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    // Accessibility: a generative field that constantly drifts and pulses is
    // exactly the pattern prefers-reduced-motion exists to tame. Vestibular
    // sensitivity aside, this is also a wellness product — a visual that
    // agitates a user who asked their OS for less motion works against the
    // product's own purpose. Motion-linked parameters (orbit speed, jitter)
    // are scaled down; colour/size (which carry the actual state info) are
    // untouched, so the display stays informative, just calmer.
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const applyMotionPref = (mql: MediaQueryList | MediaQueryListEvent) => {
      this.motionScale = mql.matches ? 0.12 : 1;
    };
    if (reduceMotion) {
      applyMotionPref(reduceMotion);
      reduceMotion.addEventListener("change", applyMotionPref);
    }
    this.seedParticles(48);

    // Measure synchronously now — getBoundingClientRect forces layout (not
    // paint/composite), so this is accurate even if the page hasn't produced
    // a composited frame yet. Relying on this alone was the original bug: a
    // single construction-time read that never gets corrected if it races
    // the stylesheet. So it's paired with a ResizeObserver for every later
    // change (first settle after paint, side panel toggling, font reflow,
    // window resize) — the two together cover both "layout already ready
    // now" and "layout changes later" without depending on which is true.
    this.resize();
    const parent = this.canvas.parentElement;
    if (parent && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const box = entries[0]?.contentBoxSize?.[0];
        if (box) this.applySize(box.inlineSize, box.blockSize);
        else this.resize();
      });
      ro.observe(parent);
    }

    // Belt-and-braces alongside the ResizeObserver, not instead of it.
    // ResizeObserver callbacks are delivered as part of the rendering
    // pipeline, so anything that suspends or throttles rendering also
    // suspends them — leaving a stale canvas. Tablet rotation is the case
    // that must not break, so the coarse events back it up. applySize is
    // idempotent and skips no-op sizes, so double-firing costs nothing.
    const onViewportChange = () => this.resize();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    // Rotation on iOS reports the new size a beat after the event fires.
    window.addEventListener("orientationchange", () => setTimeout(onViewportChange, 250));
  }

  private resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    const w = rect?.width ?? window.innerWidth;
    const h = rect?.height ?? window.innerHeight;
    this.applySize(w, h);
  }

  private applySize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return; // ignore transient zero-size layout passes
    const nextW = Math.round(w * this.dpr);
    const nextH = Math.round(h * this.dpr);
    // Writing canvas.width/height clears the bitmap even when the value is
    // unchanged, which would strobe the trail-fade effect on every spurious
    // resize event. Bail out when nothing actually changed.
    if (this.canvas.width === nextW && this.canvas.height === nextH) return;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  private seedParticles(n: number): void {
    this.particles = [];
    for (let i = 0; i < n; i++) {
      this.particles.push({
        angle: (i / n) * Math.PI * 2,
        radius: 0.35 + Math.random() * 0.55,
        speed: 0.15 + Math.random() * 0.4,
        size: 0.5 + Math.random(),
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  setControl(c: ControlVector): void {
    this.control = c;
  }

  setTelemetry(t: ClfsTelemetry): void {
    this.telemetry = t;
  }

  start(): void {
    if (this.raf) return;
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const minDim = Math.min(w, h);

    // Scaling the shared time accumulator (rather than each formula that
    // reads it) calms orbit speed, wobble, and lightness pulsing together in
    // one place when prefers-reduced-motion is set.
    this.t += (1 / 60) * this.motionScale;

    ctx.fillStyle = "rgba(5,6,10,0.22)";
    ctx.fillRect(0, 0, w, h);

    const c = this.control;
    const tel = this.telemetry;
    if (!c) return; // nothing to render yet — session hasn't started

    const hue = 200 - c.valence * 90; // warm (amber) at high valence, cool (blue) at low
    const sat = 35 + c.brightness * 45;
    // Rate-limited brightness pulse.
    //
    // Telemetry arrives at 5 Hz, so a mode with a fast periodic event rate —
    // Move runs up to 200 spm, i.e. 3.3 Hz — can alias into visible flicker
    // around 1-2.5 Hz. That sits below the WCAG 2.3.1 flash threshold (three
    // flashes per second at high contrast over a large area) and below the
    // 3-60 Hz range associated with photosensitivity, and this is a soft
    // gradient rather than a flash. But leaving it as an accident of the
    // telemetry rate is not the same as guaranteeing it, so the pulse is
    // explicitly slewed to well under 1 Hz here. Nothing is lost: this value
    // is ambience, not information that needs per-event resolution.
    const targetPulse = tel ? Math.min(1, tel.rms * 6) : 0.15;
    // Same fixed-step convention as the time accumulator above: at 0.9 per
    // second a full 0-to-1 swing takes over a second, so the pulse cannot
    // complete a bright/dark cycle faster than roughly 0.5 Hz.
    const maxStep = 0.9 / 60;
    this.pulseSmoothed += Math.max(-maxStep, Math.min(maxStep, targetPulse - this.pulseSmoothed));
    const pulse = this.pulseSmoothed;
    const baseR = minDim * (0.14 + 0.05 * c.depth);
    const glow = minDim * (0.22 + 0.28 * c.depth);

    // Central glow — depth and reverb send made visible.
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glow);
    grad.addColorStop(0, `hsla(${hue}, ${sat}%, 62%, ${0.16 + pulse * 0.25})`);
    grad.addColorStop(1, "hsla(0,0%,0%,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, glow, 0, Math.PI * 2);
    ctx.fill();

    const orbitSpeed = 0.05 + (c.tempo / 120) * 0.35 * (0.4 + 0.8 * c.arousal);
    const jitterAmt = (c.tension * 0.6 + c.complexity * 0.6) * minDim * 0.02 * this.motionScale;
    const count = Math.round(18 + c.density * (this.particles.length - 18));

    for (let i = 0; i < count; i++) {
      const p = this.particles[i];
      const ang = p.angle + this.t * orbitSpeed * (0.6 + p.speed);
      const wob = Math.sin(this.t * (0.3 + p.speed) + p.phase) * jitterAmt;
      const r = baseR + p.radius * glow * (0.55 + 0.3 * c.motion) + wob;
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r * 0.82; // slight ellipse, calmer than a circle
      const size = (2.2 + p.size * 3.2 + c.air * 3) * this.dpr * (0.7 + pulse * 0.6);

      const pg = ctx.createRadialGradient(x, y, 0, x, y, size * 3);
      const lightness = 55 + 20 * Math.sin(p.phase + this.t * 0.2);
      pg.addColorStop(0, `hsla(${hue + p.phase * 6}, ${sat + 10}%, ${lightness}%, ${0.55 + pulse * 0.3})`);
      pg.addColorStop(1, "hsla(0,0%,0%,0)");
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(x, y, size * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Core: brightness of the centre reflects transient/complexity activity.
    const coreR = baseR * (0.34 + 0.1 * pulse);
    const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    coreGrad.addColorStop(0, `hsla(${hue}, ${sat + 15}%, 82%, 0.9)`);
    coreGrad.addColorStop(1, `hsla(${hue}, ${sat}%, 60%, 0)`);
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
  }
}
