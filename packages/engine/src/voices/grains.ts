import { Rng } from "../dsp/rng.js";

/**
 * Granular shimmer field
 * ======================
 *
 * Short windowed FM grains scattered by an inhomogeneous Poisson process. This
 * is the layer that gives a session its sense of *place* and incident —
 * droplets, glints, distant flecks — without a single recorded sound.
 *
 * Two properties are load-bearing:
 *
 *  1. The arrival process is Poisson with a rate that is a continuous function
 *     of the control vector, so grain onsets are exponentially distributed. The
 *     ear cannot lock onto a pulse that has no fixed period, which is precisely
 *     why this reads as "environment" rather than "music with a beat" — and why
 *     it does not recruit attention during deep work.
 *
 *  2. Every grain draws its frequency, duration, FM index and pan
 *     independently, so grain-level repetition has probability zero.
 */

const MAX_GRAINS = 48;

export class GrainField {
  private readonly phase = new Float32Array(MAX_GRAINS);
  private readonly inc = new Float32Array(MAX_GRAINS);
  private readonly modPhase = new Float32Array(MAX_GRAINS);
  private readonly modInc = new Float32Array(MAX_GRAINS);
  private readonly modIndex = new Float32Array(MAX_GRAINS);
  private readonly envPos = new Float32Array(MAX_GRAINS);
  private readonly envInc = new Float32Array(MAX_GRAINS);
  private readonly amp = new Float32Array(MAX_GRAINS);
  private readonly panL = new Float32Array(MAX_GRAINS);
  private readonly panR = new Float32Array(MAX_GRAINS);
  private readonly active = new Uint8Array(MAX_GRAINS);

  /** Fractional samples until the next arrival. */
  private nextArrival = 0;

  constructor(private readonly sr: number) {}

  get activeGrains(): number {
    let n = 0;
    for (let i = 0; i < MAX_GRAINS; i++) n += this.active[i];
    return n;
  }

  /**
   * @param rateHz    mean arrivals per second
   * @param centreHz  centre of the grain frequency distribution
   * @param spread    0..1, octave spread of grain frequencies
   * @param brightMod 0..1, FM index scale (adds sidebands / metallic glint)
   * @param width     0..1, stereo spread
   */
  render(
    outL: Float32Array,
    outR: Float32Array,
    offset: number,
    n: number,
    rateHz: number,
    centreHz: number,
    spread: number,
    brightMod: number,
    width: number,
    rng: Rng,
  ): void {
    // Schedule arrivals inside this block.
    if (rateHz > 1e-4) {
      let t = this.nextArrival;
      while (t < n) {
        this.spawn(centreHz, spread, brightMod, width, rng);
        // Exponential inter-arrival: -ln(U)/lambda.
        const lambda = rateHz / this.sr;
        t += -Math.log(1 - rng.next() * 0.999999) / lambda;
      }
      this.nextArrival = t - n;
    } else {
      this.nextArrival = Math.max(0, this.nextArrival - n);
    }

    for (let g = 0; g < MAX_GRAINS; g++) {
      if (!this.active[g]) continue;
      let ph = this.phase[g];
      let mp = this.modPhase[g];
      let ep = this.envPos[g];
      const inc = this.inc[g];
      const minc = this.modInc[g];
      const mi = this.modIndex[g];
      const einc = this.envInc[g];
      const a = this.amp[g];
      const gl = this.panL[g];
      const gr = this.panR[g];

      for (let k = 0; k < n; k++) {
        if (ep >= 1) break;
        // Hann grain envelope, evaluated from a phase counter.
        const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * ep);
        const m = Math.sin(2 * Math.PI * mp);
        const y = Math.sin(2 * Math.PI * ph + mi * m) * env * a;
        outL[offset + k] += y * gl;
        outR[offset + k] += y * gr;
        ph += inc;
        if (ph >= 1) ph -= 1;
        mp += minc;
        if (mp >= 1) mp -= 1;
        ep += einc;
      }

      this.phase[g] = ph;
      this.modPhase[g] = mp;
      this.envPos[g] = ep;
      if (ep >= 1) this.active[g] = 0;
    }
  }

  private spawn(centreHz: number, spread: number, brightMod: number, width: number, rng: Rng): void {
    let g = -1;
    for (let i = 0; i < MAX_GRAINS; i++) {
      if (!this.active[i]) {
        g = i;
        break;
      }
    }
    if (g < 0) return; // field saturated: drop the grain rather than steal

    const octaves = rng.normal() * spread * 1.6;
    const f = Math.min(this.sr * 0.45, Math.max(30, centreHz * Math.pow(2, octaves)));
    // Duration inversely related to frequency: high glints are short, low
    // grains are long. Keeps perceived grain "size" roughly constant.
    const durSec = (0.035 + 0.42 * rng.next() * rng.next()) * (400 / Math.max(120, f)) * 1.6;

    this.phase[g] = rng.next();
    this.inc[g] = f / this.sr;
    // Inharmonic modulator ratio -> glassy, non-pitched sidebands.
    const ratio = 1.41 + rng.next() * 2.6;
    this.modPhase[g] = rng.next();
    this.modInc[g] = (f * ratio) / this.sr;
    this.modIndex[g] = brightMod * rng.next() * 2.4;
    this.envPos[g] = 0;
    this.envInc[g] = 1 / Math.max(8, durSec * this.sr);
    this.amp[g] = 0.06 + 0.12 * rng.next() * rng.next();

    const p = Math.max(-1, Math.min(1, rng.normal() * width));
    const theta = ((p + 1) * Math.PI) / 4;
    this.panL[g] = Math.cos(theta);
    this.panR[g] = Math.sin(theta);
    this.active[g] = 1;
  }
}
