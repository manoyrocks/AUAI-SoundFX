import { ClfsCore } from "../clfs.js";
import { unpackControl } from "../control.js";

/**
 * AudioWorkletProcessor host for the CLFS engine.
 *
 * Everything here runs on the dedicated real-time audio rendering thread, which
 * is why the module graph it imports (clfs.ts and below) contains no DOM calls,
 * no allocation-heavy code paths in the per-sample loops, and no dependency on
 * `window`. That isolation is what keeps the audio glitch rate at zero
 * regardless of what the main thread (React, the copilot, telemetry) is doing —
 * a GC pause or a long task on the UI thread cannot skip a single audio frame.
 *
 * Wire protocol (main thread -> processor), all via port.postMessage:
 *   { type: 'target',  vector: Float32Array(10) }   // new ControlVector target
 *   { type: 'snap',    vector: Float32Array(10) }   // immediate jump (session start)
 *   { type: 'style',   embedding: Float32Array(16)|null, weight: number }
 *   { type: 'weights', buffer: ArrayBuffer }         // trained NFD weights
 *   { type: 'fade',    gain: number }                // 0..1 master fade
 *
 * Wire protocol (processor -> main thread), throttled to ~5 Hz:
 *   { type: 'telemetry', ...ClfsTelemetry }
 */
class ClfsProcessor extends AudioWorkletProcessor {
  private readonly core: ClfsCore;
  private telemetryCountdown = 0;
  private scratch: Float32Array | null = null;

  private monoScratch(n: number): Float32Array {
    if (!this.scratch || this.scratch.length < n) this.scratch = new Float32Array(n);
    return this.scratch;
  }

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const opts = (options?.processorOptions ?? {}) as { seed?: number; maxVoices?: number; fftSize?: number };
    this.core = new ClfsCore(sampleRate, opts);
    this.port.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
  }

  private handleMessage(msg: any): void {
    switch (msg?.type) {
      case "target":
        this.core.setTarget(unpackControl(msg.vector));
        break;
      case "snap":
        this.core.snapTo(unpackControl(msg.vector));
        break;
      case "style":
        this.core.setStyle(msg.embedding ?? null, msg.weight ?? 1);
        break;
      case "constraints":
        // Replaces the whole set — see ClfsHost.setConstraints for why a
        // partial merge here would let one mode's acoustic rule leak into
        // the next.
        this.core.setConstraints(msg.constraints ?? {});
        break;
      case "weights": {
        const ok = this.core.loadNfdWeights(msg.buffer as ArrayBuffer);
        this.port.postMessage({ type: "weightsLoaded", ok });
        break;
      }
      case "fade":
        this.core.setMasterTarget(msg.gain);
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const n = out[0].length;
    if (out.length > 1) {
      this.core.process(out[0], out[1], n);
    } else {
      // Mono output device: render a scratch right channel and sum it in,
      // rather than aliasing L and R onto the same array (which would make
      // the core's stereo write-then-write clobber itself).
      const r = this.monoScratch(n);
      this.core.process(out[0], r, n);
      const l = out[0];
      for (let i = 0; i < n; i++) l[i] = (l[i] + r[i]) * 0.5;
    }

    this.telemetryCountdown -= n;
    if (this.telemetryCountdown <= 0) {
      this.telemetryCountdown += sampleRate * 0.2; // 5 Hz
      this.port.postMessage({ type: "telemetry", ...this.core.telemetry() });
    }
    return true;
  }
}

registerProcessor("clfs-processor", ClfsProcessor);
