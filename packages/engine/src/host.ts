import { ControlVector, SynthesisConstraints, packControl } from "./control.js";
import type { ClfsTelemetry } from "./clfs.js";

/**
 * Main-thread host for the CLFS AudioWorklet.
 *
 * Owns the AudioContext and the worklet node; every method here is a thin,
 * allocation-light message across the worklet boundary. The host never touches
 * a sample — that isolation is deliberate (see worklet/processor.ts).
 */
export interface ClfsHostOptions {
  workletUrl: string;
  seed?: number;
  maxVoices?: number;
  fftSize?: number;
  onTelemetry?: (t: ClfsTelemetry) => void;
}

export class ClfsHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private readonly opts: ClfsHostOptions;
  private started = false;

  constructor(opts: ClfsHostOptions) {
    this.opts = opts;
  }

  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  get isRunning(): boolean {
    return this.started;
  }

  /**
   * Create the context and load the worklet module. Must be called from a user
   * gesture handler (browser autoplay policy) — call this on the "Begin
   * session" tap, not on page load.
   */
  async start(initial: ControlVector): Promise<void> {
    if (this.started) return;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    try {
      await ctx.audioWorklet.addModule(this.opts.workletUrl);
    } catch (err) {
      // Worklet 404, bad MIME type, or a browser without AudioWorklet support
      // (e.g. very old Safari) all land here. Close the context we just
      // opened rather than leaking it, and rethrow with enough context for
      // the caller to show a real message instead of a stuck "Starting…".
      await ctx.close().catch(() => {});
      throw new Error(`Failed to load the audio engine worklet: ${err instanceof Error ? err.message : String(err)}`);
    }

    const node = new AudioWorkletNode(ctx, "clfs-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        seed: this.opts.seed,
        maxVoices: this.opts.maxVoices,
        fftSize: this.opts.fftSize,
      },
    });
    node.port.onmessage = (ev: MessageEvent) => {
      if (ev.data?.type === "telemetry") this.opts.onTelemetry?.(ev.data as ClfsTelemetry);
    };
    node.connect(ctx.destination);

    this.ctx = ctx;
    this.node = node;
    this.started = true;

    if (this.pendingConstraints) {
      node.port.postMessage({ type: "constraints", constraints: this.pendingConstraints });
    }
    node.port.postMessage({ type: "snap", vector: packControl(initial) });
    node.port.postMessage({ type: "fade", gain: 1 });
  }

  /** Smoothly move the soundscape toward a new control vector. */
  setTarget(v: ControlVector): void {
    this.node?.port.postMessage({ type: "target", vector: packControl(v) });
  }

  /** Install a style embedding (artist pack or personal style). */
  setStyle(embedding: Float32Array | null, weight = 1): void {
    this.node?.port.postMessage({ type: "style", embedding, weight });
  }

  /**
   * Install the mode's hard acoustic rules.
   *
   * Sent as a whole object rather than as deltas: a constraint set is
   * categorical, and merging a partial update against whatever the worklet
   * currently holds is exactly how a previous mode's rule survives into the
   * next one. Always replace.
   */
  setConstraints(c: SynthesisConstraints): void {
    this.pendingConstraints = { ...c };
    this.node?.port.postMessage({ type: "constraints", constraints: this.pendingConstraints });
  }

  /** Held so constraints set before start() are applied on start. */
  private pendingConstraints: SynthesisConstraints | null = null;

  /** Push trained NFD weights fetched from the model CDN. */
  async loadWeights(url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) return;
    const buffer = await res.arrayBuffer();
    this.node?.port.postMessage({ type: "weights", buffer }, [buffer]);
  }

  /**
   * Graceful fade-out; resolves once the fade duration has elapsed.
   *
   * Always leaves the host back in a clean, restartable state — even if
   * disconnecting the node or closing the context throws (e.g. the context
   * was already torn down by the browser for an unrelated reason) — so a
   * failure here can never strand the UI with a session it can neither end
   * nor begin again.
   */
  async stop(fadeSeconds = 3): Promise<void> {
    if (!this.started || !this.ctx || !this.node) return;
    const ctx = this.ctx;
    const node = this.node;
    try {
      node.port.postMessage({ type: "fade", gain: 0 });
      await new Promise((r) => setTimeout(r, fadeSeconds * 1000));
      node.disconnect();
      if (ctx.state !== "closed") await ctx.close();
    } finally {
      this.ctx = null;
      this.node = null;
      this.started = false;
    }
  }

  async suspend(): Promise<void> {
    await this.ctx?.suspend();
  }

  async resume(): Promise<void> {
    await this.ctx?.resume();
  }
}
