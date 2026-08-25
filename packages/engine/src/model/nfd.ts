/**
 * Neural Field Decoder (NFD)
 * =========================
 *
 * The NFD is the piece that structurally replaces "pick and gate a pre-authored
 * stem". It is a small MLP that maps
 *
 *     [ latent z (16) , normalised ControlVector (10) ]  ->  46 synthesis params
 *
 * evaluated at control rate (~86 Hz at 128-frame quanta / 48 kHz) inside the
 * audio worklet. Its outputs are not gains on recorded material; they are the
 * *timbre coordinates* of a resonator bank and a spectral bed that synthesise
 * every sample from silence.
 *
 * Why an MLP and not a diffusion/RVQ model in the worklet: the worklet thread
 * has a hard ~2.6 ms budget per quantum and no GPU access. The large streaming
 * generative model (see docs/03-a2-generative-model.md) runs on the *main*
 * thread over WebGPU at ~10 Hz and emits latent trajectories and style
 * embeddings; the NFD is the distilled, real-time decoder that turns those into
 * per-quantum synthesis parameters without ever touching the audio deadline.
 * This split is what makes neural generation viable on a phone at <5%/hr.
 *
 * Shape: 26 -> 48 -> 48 -> 46, SiLU hidden, grouped output activations.
 * ~5.9k parameters, ~5.7k MAC per evaluation, ~0.5 MFLOP/s at control rate.
 */

export const NFD_IN = 26;
export const NFD_HIDDEN = 48;
export const NFD_OUT = 46;
export const NFD_LATENT = 16;

/** Byte layout of a .nfd weight file: magic, version, then row-major matrices. */
export const NFD_MAGIC = 0x4e464431; // "NFD1"

export interface NfdOutputLayout {
  partialGain: [number, number];
  partialStretch: [number, number];
  bandGain: [number, number];
  excitationTone: number;
  excitationNoise: number;
  ringTime: number;
  grainRate: number;
  grainSpread: number;
  subLevel: number;
  shimmer: number;
  transient: number;
}

export const NFD_LAYOUT: NfdOutputLayout = {
  partialGain: [0, 16],
  partialStretch: [16, 24],
  bandGain: [24, 38],
  excitationTone: 38,
  excitationNoise: 39,
  ringTime: 40,
  grainRate: 41,
  grainSpread: 42,
  subLevel: 43,
  shimmer: 44,
  transient: 45,
};

function silu(x: number): number {
  return x / (1 + Math.exp(-x));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class NeuralFieldDecoder {
  private w1 = new Float32Array(NFD_HIDDEN * NFD_IN);
  private b1 = new Float32Array(NFD_HIDDEN);
  private w2 = new Float32Array(NFD_HIDDEN * NFD_HIDDEN);
  private b2 = new Float32Array(NFD_HIDDEN);
  private w3 = new Float32Array(NFD_OUT * NFD_HIDDEN);
  private b3 = new Float32Array(NFD_OUT);

  private h1 = new Float32Array(NFD_HIDDEN);
  private h2 = new Float32Array(NFD_HIDDEN);
  readonly out = new Float32Array(NFD_OUT);
  private readonly input = new Float32Array(NFD_IN);

  /** False until real weights are installed; the analytic prior runs instead. */
  private loaded = false;
  version = "analytic-prior";

  get hasWeights(): boolean {
    return this.loaded;
  }

  /**
   * Install trained weights from a .nfd buffer.
   * Returns false (and leaves the analytic prior active) on any mismatch, so a
   * corrupt or stale model file degrades to sound rather than to silence.
   */
  loadWeights(buffer: ArrayBuffer): boolean {
    const dv = new DataView(buffer);
    if (buffer.byteLength < 16) return false;
    if (dv.getUint32(0, true) !== NFD_MAGIC) return false;
    const nIn = dv.getUint32(4, true);
    const nHidden = dv.getUint32(8, true);
    const nOut = dv.getUint32(12, true);
    if (nIn !== NFD_IN || nHidden !== NFD_HIDDEN || nOut !== NFD_OUT) return false;

    const expected =
      16 +
      4 * (NFD_HIDDEN * NFD_IN + NFD_HIDDEN + NFD_HIDDEN * NFD_HIDDEN + NFD_HIDDEN + NFD_OUT * NFD_HIDDEN + NFD_OUT);
    if (buffer.byteLength < expected) return false;

    let off = 16;
    const take = (dst: Float32Array) => {
      for (let i = 0; i < dst.length; i++) {
        dst[i] = dv.getFloat32(off, true);
        off += 4;
      }
    };
    take(this.w1);
    take(this.b1);
    take(this.w2);
    take(this.b2);
    take(this.w3);
    take(this.b3);
    this.loaded = true;
    this.version = "nfd-v1";
    return true;
  }

  /**
   * Evaluate. `z` is the 16-D latent, `ctrl` the 10-D normalised control vector.
   * Result lands in `this.out`, activations applied.
   */
  evaluate(z: Float32Array, ctrl: Float32Array): Float32Array {
    const x = this.input;
    for (let i = 0; i < NFD_LATENT; i++) x[i] = z[i];
    for (let i = 0; i < 10; i++) x[NFD_LATENT + i] = ctrl[i];

    if (!this.loaded) return this.analyticPrior(x);

    for (let j = 0; j < NFD_HIDDEN; j++) {
      let acc = this.b1[j];
      const base = j * NFD_IN;
      for (let i = 0; i < NFD_IN; i++) acc += this.w1[base + i] * x[i];
      this.h1[j] = silu(acc);
    }
    for (let j = 0; j < NFD_HIDDEN; j++) {
      let acc = this.b2[j];
      const base = j * NFD_HIDDEN;
      for (let i = 0; i < NFD_HIDDEN; i++) acc += this.w2[base + i] * this.h1[i];
      this.h2[j] = silu(acc);
    }
    for (let j = 0; j < NFD_OUT; j++) {
      let acc = this.b3[j];
      const base = j * NFD_HIDDEN;
      for (let i = 0; i < NFD_HIDDEN; i++) acc += this.w3[base + i] * this.h2[i];
      this.out[j] = acc;
    }

    // Grouped activations.
    const [ps, pe] = NFD_LAYOUT.partialStretch;
    for (let i = 0; i < NFD_OUT; i++) {
      if (i >= ps && i < pe) this.out[i] = Math.tanh(this.out[i]);
      else this.out[i] = sigmoid(this.out[i]);
    }
    return this.out;
  }

  /**
   * Analytic prior — a hand-derived closed-form decoder used before weights
   * arrive, on devices that decline the model download, and as the control
   * condition in the model-level N-of-1 test ("is the learned decoder actually
   * better than the rule I could have written?").
   *
   * It is deliberately good enough to ship: psychoacoustically shaped partial
   * rolloff, brightness-tilted bed, tension-driven inharmonicity.
   */
  private analyticPrior(x: Float32Array): Float32Array {
    const o = this.out;
    // Control dims in CONTROL_KEYS order, all normalised to [0,1].
    const valence = x[16];
    const arousal = x[17];
    const density = x[18];
    const tempo = x[19];
    const tension = x[20];
    const brightness = x[21];
    const air = x[22];
    const motion = x[23];
    const depth = x[24];
    const complexity = x[25];

    // Latent contributes slow multiplicative wobble so the prior still breathes.
    const wob = (i: number, amt: number) => 1 + amt * x[i % NFD_LATENT];

    // Partial gains: exponential rolloff whose slope opens with brightness.
    const slope = 2.6 - 1.9 * brightness;
    for (let i = 0; i < 16; i++) {
      const n = i + 1;
      let g = Math.pow(n, -slope);
      // Odd-partial emphasis at low valence gives a hollower, more sombre tone.
      if (i % 2 === 1) g *= 0.55 + 0.6 * valence;
      g *= wob(i, 0.35);
      o[i] = Math.min(1, g);
    }

    // Inharmonicity: strings stretch, bells stretch more; tension drives it.
    for (let i = 0; i < 8; i++) {
      o[16 + i] = (tension * 0.5 + 0.02) * Math.tanh(x[i] * 1.5) * (1 + i * 0.12);
    }

    // Spectral bed: 14 bark-ish bands, tilt from brightness, lift from air.
    for (let i = 0; i < 14; i++) {
      const f = i / 13;
      const tilt = Math.exp(-Math.pow((f - brightness * 0.85) / 0.42, 2));
      const pink = Math.pow(1 - f * 0.92, 1.1);
      o[24 + i] = Math.min(1, air * (0.35 * pink + 0.85 * tilt) * wob(i + 3, 0.22));
    }

    o[38] = 0.25 + 0.5 * (1 - complexity); // excitationTone
    o[39] = 0.2 + 0.55 * arousal; // excitationNoise
    o[40] = 0.35 + 0.6 * depth; // ringTime
    o[41] = 0.1 + 0.75 * density; // grainRate
    o[42] = 0.2 + 0.7 * motion; // grainSpread
    o[43] = 0.25 + 0.45 * (1 - brightness); // subLevel
    o[44] = 0.15 + 0.6 * air * brightness; // shimmer
    o[45] = 0.15 + 0.6 * arousal * (0.4 + 0.6 * tempo); // transient
    return o;
  }
}
