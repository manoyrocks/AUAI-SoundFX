import { Rng } from "./dsp/rng.js";
import { NFD_LATENT } from "./model/nfd.js";

/**
 * Latent trajectory
 * =================
 *
 * The soundscape's "position" is a point z in a 16-D latent space that moves
 * continuously and never revisits. Two superposed processes drive it:
 *
 *  1. An Ornstein-Uhlenbeck mean-reverting diffusion pulled toward mu(control).
 *     dz = theta * (mu - z) dt + sigma dW
 *     This gives stationary, controllable wandering: the sound stays *in* the
 *     region the controller asked for without ever settling on a fixed timbre.
 *
 *  2. A bank of 5 mutually incommensurable slow oscillators (frequency ratios
 *     chosen irrational) projected into the latent space. Because their periods
 *     have no common multiple, the combined trajectory is aperiodic by
 *     construction — there is no cycle length at which the texture can repeat.
 *     This is the formal basis for the "zero audible loops in 8 hours" bar: the
 *     recurrence time is not long, it is undefined.
 *
 * Style packs and learned personal styles are latent *offsets* added to mu.
 * That is the whole mechanism — no separate asset set per style.
 */
export class LatentTrajectory {
  readonly z = new Float32Array(NFD_LATENT);
  private readonly mu = new Float32Array(NFD_LATENT);
  private readonly proj: Float32Array; // 10 -> 16 control projection
  private readonly oscProj: Float32Array; // 5 -> 16 oscillator projection
  private readonly oscPhase = new Float32Array(5);
  private readonly oscRate: Float32Array;
  private style: Float32Array | null = null;
  private styleWeight = 0;

  /** Mean-reversion strength (1/s). Slow: the timbre glides, never snaps. */
  theta = 0.06;
  /** Diffusion scale. Modulated by ControlVector.motion at runtime. */
  sigma = 0.09;

  constructor(private readonly rng: Rng, projectionSeed = 0x5f3759df) {
    const pr = new Rng(projectionSeed);
    this.proj = new Float32Array(NFD_LATENT * 10);
    for (let i = 0; i < this.proj.length; i++) this.proj[i] = pr.normal() * 0.45;
    this.oscProj = new Float32Array(NFD_LATENT * 5);
    for (let i = 0; i < this.oscProj.length; i++) this.oscProj[i] = pr.normal() * 0.32;

    // Irrational period ratios: golden-ratio powers scaled into 40 s .. 11 min.
    // No two share a rational relationship, so the sum never repeats.
    const PHI = 1.6180339887498949;
    this.oscRate = new Float32Array(5);
    const basePeriod = 41.7;
    for (let i = 0; i < 5; i++) {
      this.oscRate[i] = 1 / (basePeriod * Math.pow(PHI, i));
      this.oscPhase[i] = rng.next();
    }
    for (let i = 0; i < NFD_LATENT; i++) this.z[i] = rng.normal() * 0.3;
  }

  /**
   * Install a style embedding (artist pack, or a personal style distilled from
   * the user's own listening). weight 0..1 blends it against the neutral prior.
   */
  setStyle(embedding: Float32Array | null, weight = 1): void {
    this.style = embedding && embedding.length >= NFD_LATENT ? embedding : null;
    this.styleWeight = Math.min(1, Math.max(0, weight));
  }

  /**
   * Advance by dt seconds.
   * @param ctrlNorm normalised 10-D control vector
   * @param motion   ControlVector.motion, scales diffusion
   */
  step(ctrlNorm: Float32Array, motion: number, dt: number): Float32Array {
    // mu = proj . control  (+ style offset)
    for (let i = 0; i < NFD_LATENT; i++) {
      let acc = 0;
      const base = i * 10;
      for (let j = 0; j < 10; j++) acc += this.proj[base + j] * (ctrlNorm[j] - 0.5);
      if (this.style) acc = acc * (1 - this.styleWeight) + this.style[i] * this.styleWeight;
      this.mu[i] = acc;
    }

    // Aperiodic oscillator bank.
    for (let i = 0; i < 5; i++) {
      this.oscPhase[i] += this.oscRate[i] * dt;
      if (this.oscPhase[i] > 1) this.oscPhase[i] -= Math.floor(this.oscPhase[i]);
    }

    const sig = this.sigma * (0.25 + 1.5 * motion);
    const sqdt = Math.sqrt(dt);
    for (let i = 0; i < NFD_LATENT; i++) {
      let osc = 0;
      const base = i * 5;
      for (let j = 0; j < 5; j++) osc += this.oscProj[base + j] * Math.sin(2 * Math.PI * this.oscPhase[j]);
      const target = this.mu[i] + 0.55 * osc * (0.3 + motion);
      this.z[i] += this.theta * (target - this.z[i]) * dt + sig * this.rng.normal() * sqdt;
      // Soft bound: the decoder was trained on a bounded latent region.
      if (this.z[i] > 3) this.z[i] = 3;
      else if (this.z[i] < -3) this.z[i] = -3;
    }
    return this.z;
  }
}
