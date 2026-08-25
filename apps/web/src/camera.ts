import { RppgSession, type RppgReading } from "@soundfx/biosignal";

/**
 * Camera capture loop for rPPG.
 *
 * Privacy: the MediaStream feeds only a <video> element and an in-memory
 * analysis canvas. No frame is ever written to disk, uploaded, or passed to
 * any network call — grep this file: there is no fetch, no XHR, no
 * WebSocket. That is the literal implementation of "raw biometrics never
 * leave the device" for the camera channel.
 */
export class CameraSensor {
  readonly session = new RppgSession();
  private stream: MediaStream | null = null;
  private raf = 0;
  private useVfc = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly overlay: HTMLCanvasElement,
  ) {}

  get active(): boolean {
    return this.stream != null;
  }

  async start(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.stream) return { ok: true };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 24 } },
        audio: false,
      });
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      this.session.reset();
      this.useVfc = typeof (this.video as any).requestVideoFrameCallback === "function";
      this.loop();
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Camera permission was not granted.";
      return { ok: false, reason };
    }
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.session.reset();
    this.clearOverlay();
  }

  onReading(fn: (r: RppgReading) => void): () => void {
    return this.session.onReading(fn);
  }

  private loop = (): void => {
    if (!this.stream) return;
    if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
      const now = performance.now();
      this.session.pushFrame(this.video, this.video.videoWidth, this.video.videoHeight, now);
      this.drawOverlay();
    }
    if (this.useVfc) {
      (this.video as any).requestVideoFrameCallback(() => this.loop());
    } else {
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  private drawOverlay(): void {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const w = this.overlay.width;
    const h = this.overlay.height;
    ctx.clearRect(0, 0, w, h);
    const roi = this.session.reading.roi;
    if (!roi || this.video.videoWidth === 0) return;

    const sx = w / this.video.videoWidth;
    const sy = h / this.video.videoHeight;
    // Video is mirrored via CSS (scaleX(-1)); mirror the box to match.
    const x = w - (roi.x + roi.w) * sx;
    const y = roi.y * sy;
    const bw = roi.w * sx;
    const bh = roi.h * sy;

    ctx.strokeStyle = "rgba(124,240,200,0.85)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, bw, bh);
  }

  private clearOverlay(): void {
    const ctx = this.overlay.getContext("2d");
    ctx?.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}
