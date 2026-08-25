/**
 * Minimal ambient declarations for the AudioWorkletGlobalScope.
 *
 * TypeScript's bundled lib.dom.d.ts declares AudioWorkletNodeOptions (the
 * main-thread-side config) but not the globals available *inside* a running
 * AudioWorkletProcessor: AudioWorkletProcessor itself, registerProcessor,
 * sampleRate, currentFrame, currentTime. lib.webworker.d.ts is not a fix
 * either — it cannot be combined with lib.dom.d.ts in the same TS program,
 * and this package's other modules (host.ts) need DOM types for
 * AudioContext/AudioWorkletNode. So: hand-rolled, scoped to exactly what
 * processor.ts uses, sourced from the Web Audio API spec.
 */

declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;
