import { Rng } from "./dsp/rng.js";

/**
 * Adaptive-limit just-intonation lattice walker
 * =============================================
 *
 * Two problems rule out the obvious approach of a fixed scale in equal
 * temperament. A small fixed note set is exactly what makes months of
 * listening feel same-y. And equal temperament mistunes every interval
 * except the octave, so sustained pads beat against themselves — producing
 * the roughness a calm texture is trying to avoid.
 *
 * SoundFX instead walks a just-intonation lattice. A pitch is a point
 * (b, c, d) meaning the ratio 3^b * 5^c * 7^d reduced into an octave. Intervals
 * are exact small-integer ratios, so partials lock and sustained textures are
 * genuinely smooth.
 *
 * The key move: the *reachable region* of the lattice is a continuous function
 * of ControlVector.tension, via Tenney harmonic distance
 *
 *     HD(b,c,d) = |b|*log2(3) + |c|*log2(5) + |d|*log2(7)
 *
 * tension 0 admits only octaves and fifths; tension 1 opens 7-limit territory
 * (septimal thirds, neutral-sounding intervals, wide clusters). Harmonic
 * tension therefore becomes a *continuous, controllable* dimension rather than
 * a fixed scale choice. A scale is a discrete set; this is a continuous
 * region whose size the controller can steer.
 *
 * Reference pitch is arbitrary and slowly drifting. No particular tuning
 * frequency is claimed to have any intrinsic property; see docs/07-claims.md.
 */

const LOG2_3 = Math.log2(3);
const LOG2_5 = Math.log2(5);
const LOG2_7 = Math.log2(7);

export interface LatticePoint {
  b: number;
  c: number;
  d: number;
  /** Octave-reduced ratio in [1,2). */
  ratio: number;
  /** Tenney harmonic distance. */
  hd: number;
}

function reduce(b: number, c: number, d: number): LatticePoint {
  let logRatio = b * LOG2_3 + c * LOG2_5 + d * LOG2_7;
  logRatio -= Math.floor(logRatio);
  return {
    b,
    c,
    d,
    ratio: Math.pow(2, logRatio),
    hd: Math.abs(b) * LOG2_3 + Math.abs(c) * LOG2_5 + Math.abs(d) * LOG2_7,
  };
}

export class HarmonicWalker {
  /** Current lattice position. */
  private b = 0;
  private c = 0;
  private d = 0;

  /** Root frequency in Hz; drifts slowly so no session has a fixed "key". */
  private rootHz: number;
  private rootDriftPhase: number;

  /** Chord memory: the last few points, used to build sustaining harmony. */
  private readonly memory: LatticePoint[] = [];

  /**
   * Token-set cap. 0 = unbounded (the default: the walk may visit any
   * admissible lattice point, so pitches essentially never recur).
   *
   * When set, the walker collects distinct points until the set is full and
   * thereafter only steps to points already in it. This implements the
   * token-set-size finding from the irrelevant-sound literature: disruption
   * of verbal serial recall grows with the number of distinguishable tokens
   * in the background stream, so a small recurring set is far less
   * disruptive than endless novelty. Read mode uses it.
   */
  private tokenSetLimit = 0;
  private readonly tokenSet: LatticePoint[] = [];

  constructor(
    private readonly rng: Rng,
    rootHz = 55 * Math.pow(2, 1 / 3),
  ) {
    this.rootHz = rootHz;
    this.rootDriftPhase = rng.next();
    this.memory.push(reduce(0, 0, 0));
  }

  get root(): number {
    return this.rootHz;
  }

  /** Slow, aperiodic root drift: +/- 35 cents over ~7 minutes. */
  driftRoot(dt: number): void {
    this.rootDriftPhase += dt / 419.0;
    if (this.rootDriftPhase > 1) this.rootDriftPhase -= 1;
    const cents = 35 * Math.sin(2 * Math.PI * this.rootDriftPhase);
    this.rootHz = 55 * Math.pow(2, 1 / 3) * Math.pow(2, cents / 1200);
  }

  /**
   * Cap the number of distinct pitches in play. 0 removes the cap.
   * Lowering the limit does not evict already-collected tokens; the set
   * simply stops growing, so the change is audible as settling rather than
   * as a jump.
   */
  setTokenSetLimit(limit: number): void {
    this.tokenSetLimit = Math.max(0, Math.floor(limit));
  }

  /** Distinct pitches currently in the recurring set. */
  get tokenCount(): number {
    return this.tokenSet.length;
  }

  private samePoint(a: LatticePoint, b: LatticePoint): boolean {
    return a.b === b.b && a.c === b.c && a.d === b.d;
  }

  /**
   * Take one step. Proposes a neighbouring lattice point and accepts it with a
   * Metropolis rule whose temperature is set by `tension`, so the stationary
   * distribution over the lattice is itself a function of the control vector.
   */
  step(tension: number, complexity: number): LatticePoint {
    if (this.tokenSetLimit > 0) return this.steppedWithinTokenSet(tension, complexity);
    return this.freeStep(tension, complexity);
  }

  /**
   * Constrained walk: grow the token set until it is full, then only ever
   * return points already in it.
   */
  private steppedWithinTokenSet(tension: number, complexity: number): LatticePoint {
    if (this.tokenSet.length < this.tokenSetLimit) {
      const candidate = this.freeStep(tension, complexity);
      if (!this.tokenSet.some((p) => this.samePoint(p, candidate))) this.tokenSet.push(candidate);
      return candidate;
    }

    // Set is full. Bias heavily toward repeating the current pitch: a
    // sequence that mostly repeats one token is the "steady-state" condition
    // that the irrelevant-sound literature finds least disruptive, and it is
    // the repetition *between adjacent events* that matters, not the size of
    // the set alone.
    let point: LatticePoint;
    if (this.rng.next() < 0.55) {
      point = reduce(this.b, this.c, this.d);
    } else {
      // Uniform choice from the set. Indexed directly rather than via
      // rng.pick to avoid allocating a weight array on the audio thread.
      const idx = Math.min(this.tokenSet.length - 1, Math.floor(this.rng.next() * this.tokenSet.length));
      point = this.tokenSet[idx];
      this.b = point.b;
      this.c = point.c;
      this.d = point.d;
    }
    this.memory.push(point);
    if (this.memory.length > 6) this.memory.shift();
    return point;
  }

  private freeStep(tension: number, complexity: number): LatticePoint {
    const budget = 0.6 + 5.4 * tension; // max admissible Tenney distance
    const nSteps = 1 + (this.rng.next() < complexity * 0.6 ? 1 : 0);

    for (let s = 0; s < nSteps; s++) {
      const axis = this.rng.pick([
        1.0, // 3-limit: always available
        0.35 + 0.9 * tension, // 5-limit opens with tension
        0.02 + 0.75 * Math.max(0, tension - 0.45) * 2, // 7-limit, high tension only
      ]);
      const dir = this.rng.next() < 0.5 ? -1 : 1;
      let nb = this.b;
      let nc = this.c;
      let nd = this.d;
      if (axis === 0) nb += dir;
      else if (axis === 1) nc += dir;
      else nd += dir;

      const cand = reduce(nb, nc, nd);
      if (cand.hd <= budget) {
        this.b = nb;
        this.c = nc;
        this.d = nd;
      } else {
        // Reject softly: with low probability step *toward* the origin instead,
        // which keeps the walk recurrent rather than drifting off the lattice.
        if (this.rng.next() < 0.5) {
          this.b -= Math.sign(this.b);
          this.c -= Math.sign(this.c);
          this.d -= Math.sign(this.d);
        }
      }
    }

    const point = reduce(this.b, this.c, this.d);
    this.memory.push(point);
    if (this.memory.length > 6) this.memory.shift();
    return point;
  }

  /**
   * Absolute frequency for a lattice point in a given register.
   * `register` is an octave offset; fractional values glide between octaves.
   */
  frequency(point: LatticePoint, register: number): number {
    return this.rootHz * point.ratio * Math.pow(2, register);
  }

  /**
   * The currently sounding harmonic field — the set of pitches a sustaining
   * voice should support. Returns octave-reduced ratios, most recent first.
   */
  field(): readonly LatticePoint[] {
    return this.memory;
  }
}
