/**
 * POS (Plane-Orthogonal-to-Skin) rPPG algorithm.
 *
 * Wang, den Brinker, Stuijk & de Haan, "Algorithmic Principles of Remote PPG",
 * IEEE Trans. Biomedical Engineering, 2017. Chosen over naive green-channel
 * averaging (what most hobbyist rPPG demos use) because it projects the
 * RGB trace onto the plane orthogonal to the skin-tone vector under the
 * dichromatic reflection model, which cancels specular/lighting variation far
 * better than a single channel — the difference between a usable signal on a
 * laptop webcam and one that is dominated by exposure hunting.
 *
 * This module is pure math over a windowed RGB trace; it has no knowledge of
 * video frames, canvases, or timers, so it is directly unit-testable and
 * reusable from the eval harness.
 */

export interface PosResult {
  /** Pulse signal for the window, mean-zero. */
  signal: Float32Array;
}

/**
 * @param rTrace,gTrace,bTrace  per-frame mean channel values, equal length
 * @param windowLen             samples per POS window (~1.6 s of frames)
 */
export function posSignal(rTrace: Float32Array, gTrace: Float32Array, bTrace: Float32Array, windowLen = 48): Float32Array {
  const n = rTrace.length;
  const out = new Float32Array(n);
  if (n < windowLen) return out;

  for (let start = 0; start + windowLen <= n; start++) {
    // Temporal normalisation within the window: divide each channel by its
    // window mean so the projection is illumination-scale invariant.
    let mr = 0;
    let mg = 0;
    let mb = 0;
    for (let i = 0; i < windowLen; i++) {
      mr += rTrace[start + i];
      mg += gTrace[start + i];
      mb += bTrace[start + i];
    }
    mr /= windowLen;
    mg /= windowLen;
    mb /= windowLen;
    if (mr < 1e-6 || mg < 1e-6 || mb < 1e-6) continue;

    // Projection axes from the POS derivation:
    //   S1 = Gn - Bn ,  S2 = Gn + Bn - 2*Rn
    const s1 = new Float32Array(windowLen);
    const s2 = new Float32Array(windowLen);
    let s1mean = 0;
    let s2mean = 0;
    for (let i = 0; i < windowLen; i++) {
      const rn = rTrace[start + i] / mr;
      const gn = gTrace[start + i] / mg;
      const bn = bTrace[start + i] / mb;
      s1[i] = gn - bn;
      s2[i] = gn + bn - 2 * rn;
      s1mean += s1[i];
      s2mean += s2[i];
    }
    s1mean /= windowLen;
    s2mean /= windowLen;

    let var1 = 0;
    let var2 = 0;
    for (let i = 0; i < windowLen; i++) {
      var1 += (s1[i] - s1mean) ** 2;
      var2 += (s2[i] - s2mean) ** 2;
    }
    var1 = Math.sqrt(var1 / windowLen);
    var2 = Math.sqrt(var2 / windowLen);
    const alpha = var2 > 1e-9 ? var1 / var2 : 0;

    // Overlap-add the windowed pulse contribution (standard POS accumulation).
    const end = start + windowLen;
    for (let i = start; i < end; i++) {
      out[i] += s1[i - start] + alpha * s2[i - start];
    }
  }

  // Remove the window mean drift left by overlap-add.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  for (let i = 0; i < n; i++) out[i] -= mean;
  return out;
}
