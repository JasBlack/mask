// The whole-body engine's models: a person detector (RTMDet-nano, 4 MB) and RTMW3D-L (230 MB), which gives 133
// points per person (body, feet, 68 face points, both hands) with depth, from one crop. Both from OpenMMLab
// (Apache-2.0), run with ONNX Runtime Web on the graphics card (WebGPU), or much more slowly on the processor.
//
// Nothing here is loaded until the engine is chosen. The models are kept in the browser's cache storage after the
// first download, so they are fetched once.

const MODELS = {
  det: 'models/rtmdet-n-person.onnx',
  pose: 'models/rtmw3d-l.onnx',
};
const DET_SIZE = 320;
const POSE_W = 288, POSE_H = 384;
// RTMDet was trained on BGR pictures, RTMW3D on RGB, both with the ImageNet mean and spread in 0-255 units
const MEAN = [123.675, 116.28, 103.53], STD = [58.395, 57.12, 57.375];

async function fetchModel(path, onProgress) {
  const url = new URL(path, document.baseURI).href;
  let cache = null;
  try { cache = await caches.open('mask-layer-models-v1'); } catch { /* no cache storage: fetch every time */ }
  const hit = await cache?.match(url);
  if (hit) { onProgress?.(1, 0); return new Uint8Array(await hit.arrayBuffer()); }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download ${path} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    // (a compressed transfer counts more bytes than it says; without a length, only the bytes so far are known)
    onProgress?.(total ? Math.min(0.99, got / total) : NaN, got);
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  try { await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* full: fetch next time */ }
  return bytes;
}

/**
 * @param {{ onProgress?: (what: string, fraction: number, bytes?: number) => void }} o
 *   fraction is NaN while the size of a download is not known
 * @returns {Promise<WholeBody>}
 */
export async function createWholeBody({ onProgress } = {}) {
  // the runtime's own wasm is bundled by Vite next to the page's code (assets/ort-wasm-*.wasm)
  const ort = await import('onnxruntime-web/webgpu');
  // one thread: several need a cross-origin-isolated page, which GitHub Pages cannot give, and with the runtime
  // bundled by Vite they never started in a page that was isolated
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  let gpu = false;
  try { gpu = !!(await navigator.gpu?.requestAdapter()); } catch { gpu = false; }
  const eps = gpu ? ['webgpu', 'wasm'] : ['wasm'];

  const detBytes = await fetchModel(MODELS.det, (f, b) => onProgress?.('person detector', f, b));
  const poseBytes = await fetchModel(MODELS.pose, (f, b) => onProgress?.('whole-body model', f, b));
  onProgress?.('starting', 1);
  const opts = { executionProviders: eps, graphOptimizationLevel: 'all' };
  const det = await ort.InferenceSession.create(detBytes, opts);
  const pose = await ort.InferenceSession.create(poseBytes, opts);
  return new WholeBody(ort, det, pose, gpu ? 'webgpu' : 'cpu');
}

export class WholeBody {
  constructor(ort, det, pose, device) {
    this.ort = ort;
    this.det = det;
    this.pose = pose;
    this.device = device;
    this.detCanvas = Object.assign(document.createElement('canvas'), { width: DET_SIZE, height: DET_SIZE });
    this.detCtx = this.detCanvas.getContext('2d', { willReadFrequently: true });
    this.detBuf = new Float32Array(3 * DET_SIZE * DET_SIZE);
    this.poseCanvas = Object.assign(document.createElement('canvas'), { width: POSE_W, height: POSE_H });
    this.poseCtx = this.poseCanvas.getContext('2d', { willReadFrequently: true });
    this.poseBuf = new Float32Array(3 * POSE_W * POSE_H);
    this.stats = { detMs: 0, poseMs: 0 };
  }

  /**
   * People in the picture, as boxes in picture pixels, surest first.
   * @returns {Promise<{ x0: number, y0: number, x1: number, y1: number, score: number }[]>}
   */
  async detect(image, w, h, minScore = 0.35) {
    const t0 = performance.now();
    const r = Math.min(DET_SIZE / w, DET_SIZE / h);
    const ctx = this.detCtx;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, DET_SIZE, DET_SIZE);
    ctx.drawImage(image, 0, 0, w, h, 0, 0, w * r, h * r);
    const px = ctx.getImageData(0, 0, DET_SIZE, DET_SIZE).data;
    const n = DET_SIZE * DET_SIZE, buf = this.detBuf;
    // BGR planes
    for (let i = 0; i < n; i++) {
      buf[i] = (px[i * 4 + 2] - MEAN[2]) / STD[2];
      buf[n + i] = (px[i * 4 + 1] - MEAN[1]) / STD[1];
      buf[2 * n + i] = (px[i * 4] - MEAN[0]) / STD[0];
    }
    const out = await this.det.run({ input: new this.ort.Tensor('float32', buf, [1, 3, DET_SIZE, DET_SIZE]) });
    const d = out.dets.data, count = out.dets.dims[1];
    const boxes = [];
    for (let i = 0; i < count; i++) {
      const s = d[i * 5 + 4];
      if (s < minScore) continue;
      boxes.push({ x0: d[i * 5] / r, y0: d[i * 5 + 1] / r, x1: d[i * 5 + 2] / r, y1: d[i * 5 + 3] / r, score: s });
    }
    for (const t of Object.values(out)) t.dispose?.();
    this.stats.detMs = performance.now() - t0;
    return boxes.sort((a, b) => b.score - a.score);
  }

  /**
   * The 133 points of the person in `box`.
   * @returns {Promise<{ kp: Float32Array, sc: Float32Array, crop: { x: number, y: number, w: number, h: number } }>}
   *   kp: x, y in picture pixels and z in metres from the pelvis (further from the camera is larger), per point
   */
  async estimate(image, box) {
    const t0 = performance.now();
    // the box widened by a quarter and stretched to the model's 3:4
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    let bw = (box.x1 - box.x0) * 1.25, bh = (box.y1 - box.y0) * 1.25;
    if (bw / bh > POSE_W / POSE_H) bh = (bw * POSE_H) / POSE_W; else bw = (bh * POSE_W) / POSE_H;
    const crop = { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
    const ctx = this.poseCtx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, POSE_W, POSE_H);
    ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, POSE_W, POSE_H);
    const px = ctx.getImageData(0, 0, POSE_W, POSE_H).data;
    const n = POSE_W * POSE_H, buf = this.poseBuf;
    for (let i = 0; i < n; i++) {
      buf[i] = (px[i * 4] - MEAN[0]) / STD[0];
      buf[n + i] = (px[i * 4 + 1] - MEAN[1]) / STD[1];
      buf[2 * n + i] = (px[i * 4 + 2] - MEAN[2]) / STD[2];
    }
    const out = await this.pose.run({ input: new this.ort.Tensor('float32', buf, [1, 3, POSE_H, POSE_W]) });
    const k = out.keypoints.data, s = out.scores.data;
    const kp = new Float32Array(133 * 3), sc = new Float32Array(133);
    for (let i = 0; i < 133; i++) {
      kp[i * 3] = crop.x + (k[i * 3] * crop.w) / POSE_W;
      kp[i * 3 + 1] = crop.y + (k[i * 3 + 1] * crop.h) / POSE_H;
      kp[i * 3 + 2] = k[i * 3 + 2];
      sc[i] = s[i];
    }
    for (const t of Object.values(out)) t.dispose?.();
    this.stats.poseMs = performance.now() - t0;
    return { kp, sc, crop };
  }
}
