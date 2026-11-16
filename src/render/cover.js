// Hides the real person in the picture, under whatever is drawn over them: the head alone, or the whole body.
//
// Where to hide is the union of three things, so each covers what the others miss:
//   - every pixel the segmenter labels as hair or face skin (beard, bald scalp, ears, the back of the head), and in
//     whole-body mode every pixel of a person. This is not tied to the tracked heads: anyone in the picture whose
//     hair or face the segmenter sees is covered, tracked or not
//   - the shape of a head, skull and jaw, solid in 3D, turned and placed as the tracked head is and drawn where it
//     falls in the picture: it covers the head in profile and from behind, where there is no face to outline
//   - the outline of the face itself, and in whole-body mode the tracked body's limbs, drawn fat
// What is put there is the picture itself in coarse blocks, a flat colour, a blur, or, for `erase`, the same
// place as it looked with nobody in it.
//
// That empty place is learned as the video runs: every frame, whatever is well clear of everybody is blended into
// a plate. Where the plate has never seen behind a person it is still clear, and the blocks show through instead.
// It only makes sense for a camera that stays put.
import { FACE_OVAL, FOV_DEG, HEAD_PROXY } from '../tracking/canonical.js';
import { FACE, HOLD } from '../tracking/headTracker.js';
import { J } from '../body/skeleton.js';

// limbs as [from, to, width], widths in the body's own unit (about a shoulder width)
const LIMBS = [
  [J.shoulderL, J.elbowL, 0.46], [J.elbowL, J.wristL, 0.38], [J.shoulderR, J.elbowR, 0.46], [J.elbowR, J.wristR, 0.38],
  [J.hipL, J.kneeL, 0.6], [J.kneeL, J.ankleL, 0.44], [J.hipR, J.kneeR, 0.6], [J.kneeR, J.ankleR, 0.44],
  [J.heelL, J.toeL, 0.34], [J.heelR, J.toeR, 0.34], [J.ankleL, J.heelL, 0.34], [J.ankleR, J.heelR, 0.34],
  [J.wristL, J.indexL, 0.36], [J.wristR, J.indexR, 0.36], [J.wristL, J.pinkyL, 0.36], [J.wristR, J.pinkyR, 0.36],
];

const canvas = () => document.createElement('canvas');

// a head as solid shapes in the head tracker's own space (cm): the skull, and the jaw and chin under it
const HEAD_SHAPES = [
  { c: HEAD_PROXY.center, r: HEAD_PROXY.radii },
  { c: [0, -8.6, 1.4], r: [7.4, 7.2, 7.6] },
];
// points over the surface of a unit sphere, to be stretched into each shape
const SPHERE = [];
for (let i = 0; i <= 8; i++) {
  const lat = (i / 8 - 0.5) * Math.PI;
  for (let j = 0; j < 16; j++) {
    const lon = (j / 16) * Math.PI * 2;
    SPHERE.push([Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)]);
  }
}

/** Grow the set pixels of a w x h mask by r in every direction (a square), in place. `tmp` is a scratch mask. */
function dilate(a, w, h, r, tmp) {
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let run = -1e9;
    for (let x = 0; x < w; x++) { if (a[o + x]) run = x; tmp[o + x] = x - run <= r ? 1 : 0; }
    run = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (a[o + x]) run = x; if (run - x <= r) tmp[o + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let run = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; a[y * w + x] = y - run <= r ? 1 : 0; }
    run = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) a[y * w + x] = 1; }
  }
}

/** The outline round a set of points (Andrew's monotone chain). */
function hull(points) {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Where the solid head of track `t` falls in a w x h picture, grown by `grow`, as one outline per shape. */
function headOutlines(t, w, h, grow) {
  const f = h / 2 / Math.tan(((FOV_DEG * Math.PI) / 180) / 2);
  const q = t.quat, s = t.scale, P = t.pos;
  const out = [];
  for (const { c, r } of HEAD_SHAPES) {
    const pts = [];
    for (const [x0, y0, z0] of SPHERE) {
      // the point in head space, then turned (quaternion times vector) and moved
      const x = (c[0] + x0 * r[0] * grow) * s, y = (c[1] + y0 * r[1] * grow) * s, z = (c[2] + z0 * r[2] * grow) * s;
      const ix = q.w * x + q.y * z - q.z * y, iy = q.w * y + q.z * x - q.x * z, iz = q.w * z + q.x * y - q.y * x, iw = -q.x * x - q.y * y - q.z * z;
      const X = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y + P.x;
      const Y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z + P.y;
      const Z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x + P.z;
      if (Z > -1) return []; // behind the camera: nothing sensible to draw
      pts.push([w / 2 + (f * X) / -Z, h / 2 - (f * Y) / -Z]);
    }
    out.push(hull(pts));
  }
  return out;
}

export class Cover {
  constructor() {
    this.shape = canvas(); this.sctx = this.shape.getContext('2d');
    this.fill = canvas(); this.fctx = this.fill.getContext('2d');
    this.plate = canvas(); this.pctx = this.plate.getContext('2d');
    this.cut = canvas(); this.cctx = this.cut.getContext('2d');
    this.tiny = canvas(); this.tctx = this.tiny.getContext('2d');
    this.seg = canvas(); this.gctx = this.seg.getContext('2d');
    this.segImage = null;
    this.segTmp = null;
    this.w = 0; this.h = 0;
    this.learned = 0;
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    for (const c of [this.shape, this.fill, this.plate, this.cut]) { c.width = w; c.height = h; }
    this.learned = 0;
  }

  /** Forget the empty place: a new source, or a jump in time. */
  reset() {
    this.pctx.clearRect(0, 0, this.w, this.h);
    this.learned = 0;
  }

  /** Draw everywhere a person is, solid, into `ctx`. `grow` widens it. */
  _people(ctx, tracks, body, grow) {
    const { w, h } = this;
    ctx.fillStyle = ctx.strokeStyle = '#fff';
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const t of tracks) {
      // the head: its solid shape where it falls in the picture, the outline of the face when there is one, and
      // an oval round where the head was last seen, wider the longer it is lost
      const lost = t.state === HOLD ? Math.min(2.2, 1 + t.heldMs / 600) : 1;
      for (const outline of headOutlines(t, w, h, 1.12 * grow * (t.state === HOLD ? lost : 1))) {
        if (outline.length < 3) continue;
        ctx.beginPath();
        outline.forEach(([x, y], n) => (n ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fill();
      }
      if (t.state === FACE && t.landmarks) {
        let cx = 0, cy = 0;
        for (const i of FACE_OVAL) { cx += t.landmarks[i].x; cy += t.landmarks[i].y; }
        cx = (cx / FACE_OVAL.length) * w; cy = (cy / FACE_OVAL.length) * h;
        const k = 1.16 * grow;
        ctx.beginPath();
        FACE_OVAL.forEach((i, n) => {
          const p = t.landmarks[i];
          const x = cx + (p.x * w - cx) * k, y = cy + (p.y * h - cy) * k;
          if (n) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
      } else {
        const rx = 0.5 * t.sizePx * 1.65 * grow * lost;
        ctx.beginPath();
        ctx.ellipse(t.cx, t.cy, rx, rx * 1.25, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      const b = body ? t.body : null;
      if (!b) continue;
      const x = (i) => b.px[i * 2], y = (i) => b.px[i * 2 + 1];
      const shx = (x(11) + x(12)) / 2, shy = (y(11) + y(12)) / 2, hpx = (x(23) + x(24)) / 2, hpy = (y(23) + y(24)) / 2;
      // the body's unit: shoulder width, or the trunk when the person is side on and the shoulders close up
      const unit = Math.max(Math.hypot(x(11) - x(12), y(11) - y(12)), 0.62 * Math.hypot(shx - hpx, shy - hpy), 0.9 * t.sizePx) * grow * lost;
      ctx.lineWidth = 0.5 * unit;
      ctx.beginPath();
      ctx.moveTo(x(11), y(11)); ctx.lineTo(x(12), y(12)); ctx.lineTo(x(24), y(24)); ctx.lineTo(x(23), y(23));
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.lineWidth = 0.44 * unit;
      ctx.beginPath(); ctx.moveTo(shx, shy); ctx.lineTo(t.cx, t.cy); ctx.stroke();
      for (const [a, c, width] of LIMBS) {
        ctx.lineWidth = width * unit;
        ctx.beginPath(); ctx.moveTo(x(a), y(a)); ctx.lineTo(x(c), y(c)); ctx.stroke();
      }
    }
  }

  /**
   * Draw, solid into `ctx`, every pixel the segmenter labelled as wanted: hair and face skin for a head, any part of
   * a person for a whole body. Widened by `radius` pixels of the labelling, then scaled up to the picture.
   * @param {{ classes: Uint8Array, w: number, h: number } | null} seg
   */
  _labelled(ctx, seg, whole, radius) {
    if (!seg) return;
    const { w: sw, h: sh, classes } = seg;
    if (this.seg.width !== sw || this.seg.height !== sh) {
      this.seg.width = sw; this.seg.height = sh;
      this.segImage = this.gctx.createImageData(sw, sh);
      this.segTmp = new Uint8Array(sw * sh);
      this.segRow = new Uint8Array(sw * sh);
      this.segNear = null;
    }
    const a = this.segTmp;
    const n = sw * sh;
    if (whole) {
      for (let i = 0; i < n; i++) a[i] = classes[i] !== 0 ? 1 : 0;
    } else {
      // hair and face skin; and skin the model calls body skin where it touches them: a face blurred by movement,
      // or an ear, is often labelled body skin at its edge
      for (let i = 0; i < n; i++) a[i] = classes[i] === 1 || classes[i] === 3 ? 1 : 0;
      const near = this.segNear ?? (this.segNear = new Uint8Array(n));
      near.set(a);
      dilate(near, sw, sh, Math.max(3, Math.round(sw / 48)), this.segRow);
      for (let i = 0; i < n; i++) if (classes[i] === 2 && near[i]) a[i] = 1;
    }
    // widen: the labels stop just short of stray hairs and the edge of a beard
    dilate(a, sw, sh, Math.max(1, radius), this.segRow);
    const px = this.segImage.data;
    for (let i = 0; i < a.length; i++) { const o = i * 4; px[o] = px[o + 1] = px[o + 2] = 255; px[o + 3] = a[i] ? 255 : 0; }
    this.gctx.putImageData(this.segImage, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.seg, 0, 0, this.w, this.h);
  }

  /**
   * Blend what is well clear of everybody into the plate of the empty place.
   * @param {HTMLCanvasElement} frame
   */
  learn(frame, tracks, body, margin) {
    const { w, h, cctx, pctx } = this;
    cctx.globalCompositeOperation = 'source-over';
    cctx.drawImage(frame, 0, 0);
    cctx.globalCompositeOperation = 'destination-out';
    if (tracks.length) this._people(cctx, tracks, body, margin * 1.7);
    // nothing of anybody the segmenter sees goes into the plate either, tracked or not
    this._labelled(cctx, tracks.segments, true, Math.round(4 * margin));
    cctx.globalCompositeOperation = 'source-over';
    pctx.globalAlpha = this.learned < 3 ? 1 : 0.2;
    pctx.drawImage(this.cut, 0, 0, w, h);
    pctx.globalAlpha = 1;
    this.learned++;
  }

  /**
   * Draw the cover onto the finished picture.
   * @param {CanvasRenderingContext2D} out
   * @param {HTMLCanvasElement} frame this frame, untouched
   * @param {{ mode: string, color: string, margin: number, body: boolean }} o
   */
  apply(out, frame, tracks, { mode, color, margin, body }) {
    if (mode === 'off') return;
    if (!tracks.length && !tracks.segments) return;
    const { w, h, sctx, fctx } = this;
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, w, h);
    this._people(sctx, tracks, body, margin);
    this._labelled(sctx, tracks.segments, body, Math.round(2 * margin + (body ? 1 : 0)));

    if (mode === 'solid') {
      fctx.fillStyle = color;
      fctx.fillRect(0, 0, w, h);
    } else if (mode === 'blur') {
      const size = Math.max(h / 8, ...tracks.map((t) => t.sizePx));
      fctx.filter = `blur(${Math.max(8, Math.round(size / 5))}px)`;
      fctx.drawImage(frame, 0, 0);
      fctx.filter = 'none';
    } else {
      // about six blocks across a face: nothing of it survives
      const block = Math.max(10, Math.round(Math.max(h / 8, ...tracks.map((t) => t.sizePx)) / 6));
      const tw = Math.max(1, Math.round(w / block)), th = Math.max(1, Math.round(h / block));
      if (this.tiny.width !== tw || this.tiny.height !== th) { this.tiny.width = tw; this.tiny.height = th; }
      this.tctx.drawImage(frame, 0, 0, tw, th);
      fctx.imageSmoothingEnabled = false;
      fctx.drawImage(this.tiny, 0, 0, tw, th, 0, 0, w, h);
      fctx.imageSmoothingEnabled = true;
      if (mode === 'erase') fctx.drawImage(this.plate, 0, 0);
    }
    sctx.globalCompositeOperation = 'source-in';
    sctx.drawImage(this.fill, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    out.drawImage(this.shape, 0, 0);
  }
}
