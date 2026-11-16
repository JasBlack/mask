// The head's pose from 68 face points in the picture: the turn and place of MediaPipe's canonical face that,
// drawn with the tracking camera, lands on them. Levenberg-Marquardt on the six numbers (a rotation vector and a
// position), weighted by how sure the model is of each point.
//
// Two things make a profile hard, both learned on real frames:
//   - a turned head hides half its face, but the pose model still places every point, the hidden ones squashed
//     against the silhouette. So points whose surface faces away from the camera at the fitted turn are dropped and
//     the fit is run again.
//   - even so, the 68 points pull a profile back toward the front. Past 25 degrees the head is fitted again on what
//     a profile really shows: the midline (brow, bridge, nose, lips, chin), the near side, and the near ear.
import * as THREE from 'three';
import { POINTS_68, NORMALS_68, EARS } from './face68.js';
import { FOV_DEG } from './canonical.js';

const NP = 70; // 68 face points + 2 ears
const P = new Float64Array(NP * 3);
const PN = new Float64Array(NP * 3);
P.set(POINTS_68); P.set(EARS, 68 * 3);
PN.set(NORMALS_68); PN.set([1, 0, 0, -1, 0, 0], 68 * 3);
// the jawline is the face's outline: a different place on the jaw for every turn, so it counts for little
const BASE = new Float64Array(NP).map((_, i) => (i < 17 ? 0.25 : i < 27 ? 0.7 : i < 48 ? 1 : i < 68 ? 0.8 : 0));
const MID = [27, 28, 29, 30, 33, 8, 51, 57, 62, 66];
// the wearer's left (+X) and right halves of the 68, for a profile
const LEFT_SIDE = [9, 10, 11, 12, 13, 14, 15, 16, 22, 23, 24, 25, 26, 42, 43, 44, 45, 46, 47, 52, 53, 54, 55, 56, 63, 64, 65];
const RIGHT_SIDE = [0, 1, 2, 3, 4, 5, 6, 7, 17, 18, 19, 20, 21, 36, 37, 38, 39, 40, 41, 48, 49, 50, 58, 59, 60, 61, 67];

function rotMat(rx, ry, rz, out) {
  const th = Math.hypot(rx, ry, rz);
  if (th < 1e-9) { out.set([1, 0, 0, 0, 1, 0, 0, 0, 1]); return out; }
  const kx = rx / th, ky = ry / th, kz = rz / th, c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  out[0] = c + kx * kx * v; out[1] = kx * ky * v - kz * s; out[2] = kx * kz * v + ky * s;
  out[3] = ky * kx * v + kz * s; out[4] = c + ky * ky * v; out[5] = ky * kz * v - kx * s;
  out[6] = kz * kx * v - ky * s; out[7] = kz * ky * v + kx * s; out[8] = c + kz * kz * v;
  return out;
}
function matToVec(R) {
  const c = THREE.MathUtils.clamp((R[0] + R[4] + R[8] - 1) / 2, -1, 1);
  const th = Math.acos(c);
  if (th < 1e-6) return [0, 0, 0];
  const s = 2 * Math.sin(th);
  return [((R[7] - R[5]) / s) * th, ((R[2] - R[6]) / s) * th, ((R[3] - R[1]) / s) * th];
}

const R_ = new Float64Array(9);
const RES = new Float64Array(NP * 2), RES2 = new Float64Array(NP * 2);
const J = new Float64Array(NP * 2 * 6);

export class HeadFit {
  constructor() {
    this.prev = null; // last answer, [rx, ry, rz, tx, ty, tz]
    this.obs = new Float64Array(NP * 2);
    this.w0 = new Float64Array(NP);
  }

  reset() { this.prev = null; }

  _residuals(x, w, f, cx, cy, out) {
    rotMat(x[0], x[1], x[2], R_);
    let e = 0;
    for (let i = 0; i < NP; i++) {
      const wi = w[i];
      if (!wi) { out[i * 2] = out[i * 2 + 1] = 0; continue; }
      const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
      const X = R_[0] * px + R_[1] * py + R_[2] * pz + x[3];
      const Y = R_[3] * px + R_[4] * py + R_[5] * pz + x[4];
      const Z = Math.min(R_[6] * px + R_[7] * py + R_[8] * pz + x[5], -1);
      const rx = (cx + (f * X) / -Z - this.obs[i * 2]) * wi;
      const ry = (cy - (f * Y) / -Z - this.obs[i * 2 + 1]) * wi;
      out[i * 2] = rx; out[i * 2 + 1] = ry;
      e += rx * rx + ry * ry;
    }
    return e;
  }

  _fit(x0, w, f, cx, cy, iters = 30) {
    const x = Float64Array.from(x0);
    let lam = 1e-2;
    let e = this._residuals(x, w, f, cx, cy, RES);
    const xt = new Float64Array(6), A = new Float64Array(36), g = new Float64Array(6), step = new Float64Array(6);
    const m = NP * 2;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < 6; k++) {
        xt.set(x);
        const d = k < 3 ? 1e-4 : 1e-2;
        xt[k] += d;
        this._residuals(xt, w, f, cx, cy, RES2);
        for (let r = 0; r < m; r++) J[r * 6 + k] = (RES2[r] - RES[r]) / d;
      }
      A.fill(0); g.fill(0);
      for (let r = 0; r < m; r++) {
        const res = RES[r];
        if (!res && !J[r * 6] && !J[r * 6 + 3]) continue;
        for (let a = 0; a < 6; a++) {
          const ja = J[r * 6 + a];
          g[a] += ja * res;
          for (let b = a; b < 6; b++) A[a * 6 + b] += ja * J[r * 6 + b];
        }
      }
      for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) A[a * 6 + b] = A[b * 6 + a];
      // solve (A + lam diag A) step = -g
      const M = Float64Array.from(A);
      for (let a = 0; a < 6; a++) M[a * 6 + a] += lam * (A[a * 6 + a] + 1e-9);
      if (!solve6(M, g, step)) break;
      for (let a = 0; a < 6; a++) xt[a] = x[a] - step[a];
      const en = this._residuals(xt, w, f, cx, cy, RES2);
      if (en < e) { x.set(xt); e = en; RES.set(RES2); lam *= 0.3; } else lam *= 4;
      let big = 0;
      for (let a = 0; a < 6; a++) big = Math.max(big, Math.abs(step[a]));
      if (big < 1e-6) break;
    }
    return { x, e };
  }

  /** Which points face the camera at pose x (plus the jawline, always). */
  _visible(x, base, out) {
    rotMat(x[0], x[1], x[2], R_);
    for (let i = 0; i < NP; i++) {
      if (!base[i]) { out[i] = 0; continue; }
      if (i < 17) { out[i] = base[i]; continue; }
      const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
      const X = R_[0] * px + R_[1] * py + R_[2] * pz + x[3];
      const Y = R_[3] * px + R_[4] * py + R_[5] * pz + x[4];
      const Z = R_[6] * px + R_[7] * py + R_[8] * pz + x[5];
      const nx = PN[i * 3], ny = PN[i * 3 + 1], nz = PN[i * 3 + 2];
      const Nx = R_[0] * nx + R_[1] * ny + R_[2] * nz, Ny = R_[3] * nx + R_[4] * ny + R_[5] * nz, Nz = R_[6] * nx + R_[7] * ny + R_[8] * nz;
      const l = Math.hypot(X, Y, Z) || 1;
      out[i] = -(Nx * X + Ny * Y + Nz * Z) / l > 0.05 ? base[i] : 0;
    }
    return out;
  }

  /**
   * @param {Float32Array} kp the 133 points (x, y px, z m), @param {Float32Array} sc their scores
   * @returns {{ pos: THREE.Vector3, quat: THREE.Quaternion, error: number, yaw: number } | null}
   */
  solve(kp, sc, w, h) {
    const f = h / 2 / Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2);
    const cx = w / 2, cy = h / 2;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, faceScore = 0;
    for (let i = 0; i < 68; i++) {
      const u = kp[(23 + i) * 3], v = kp[(23 + i) * 3 + 1];
      this.obs[i * 2] = u; this.obs[i * 2 + 1] = v;
      xmin = Math.min(xmin, u); xmax = Math.max(xmax, u); ymin = Math.min(ymin, v); ymax = Math.max(ymax, v);
      faceScore += sc[23 + i];
      this.w0[i] = BASE[i] * THREE.MathUtils.clamp(sc[23 + i], 0.05, 1);
    }
    faceScore /= 68;
    if (faceScore < 0.4) { this.prev = null; return null; }
    // the ears, from the body's points 3 and 4, only where the model is sure of them
    for (const [i, k] of [[68, 3], [69, 4]]) {
      this.obs[i * 2] = kp[k * 3]; this.obs[i * 2 + 1] = kp[k * 3 + 1];
      this.w0[i] = sc[k] > 0.6 ? 1.5 * sc[k] : 0;
    }
    const size = Math.max(xmax - xmin, (ymax - ymin) * 0.8, 4);
    const vis = new Float64Array(NP);

    let best = null;
    const tryFrom = (x0) => {
      let r = this._fit(x0, this.w0, f, cx, cy);
      for (let k = 0; k < 2; k++) r = this._fit(r.x, this._visible(r.x, this.w0, vis), f, cx, cy, 15);
      this._visible(r.x, this.w0, vis);
      let sw = 0, hidden = 0;
      for (let i = 0; i < NP; i++) { sw += vis[i]; if (i >= 17 && i < 68 && !vis[i]) hidden++; }
      const cost = r.e / (sw * size * size + 1e-9) + 0.0004 * hidden;
      if (!best || cost < best.cost) best = { x: r.x, cost };
    };
    if (this.prev) tryFrom(this.prev);
    if (!this.prev || best.cost > 0.01) {
      // no answer to start from, or it went wrong: start from a spread of turns
      const d0 = (f * 14) / size;
      const nu = this.obs[30 * 2], nv = this.obs[30 * 2 + 1];
      for (const yaw of [-90, -60, -30, 0, 30, 60, 90]) {
        tryFrom([0, THREE.MathUtils.degToRad(yaw), 0, ((nu - cx) * d0) / f, (-(nv - cy) * d0) / f, -d0]);
      }
    }
    let x = best.x;
    rotMat(x[0], x[1], x[2], R_);
    let yaw = THREE.MathUtils.radToDeg(Math.atan2(R_[2], R_[8]));

    if (Math.abs(yaw) > 25) {
      const nearLeft = sc[3] >= sc[4]; // the surer ear: that side faces the camera
      const w2 = new Float64Array(NP);
      for (const i of MID) w2[i] = this.w0[i] || BASE[i] * 0.5;
      for (const i of nearLeft ? LEFT_SIDE : RIGHT_SIDE) w2[i] = this.w0[i];
      w2[nearLeft ? 68 : 69] = 2;
      let best2 = null;
      const sgn = Math.sign(yaw);
      for (const target of [yaw, sgn * 60, sgn * 75, sgn * 90, sgn * 105]) {
        // the current answer turned about the vertical to `target`
        const dy = THREE.MathUtils.degToRad(target - yaw);
        const turn = rotMat(0, dy, 0, new Float64Array(9));
        const Rn = mul3(turn, R_);
        const v = matToVec(Rn);
        const r = this._fit([v[0], v[1], v[2], x[3], x[4], x[5]], w2, f, cx, cy, 20);
        if (!best2 || r.e < best2.e) best2 = r;
      }
      x = best2.x;
      rotMat(x[0], x[1], x[2], R_);
      yaw = THREE.MathUtils.radToDeg(Math.atan2(R_[2], R_[8]));
    }
    this.prev = Array.from(x);
    const m = new THREE.Matrix4().set(R_[0], R_[1], R_[2], 0, R_[3], R_[4], R_[5], 0, R_[6], R_[7], R_[8], 0, 0, 0, 0, 1);
    return { pos: new THREE.Vector3(x[3], x[4], x[5]), quat: new THREE.Quaternion().setFromRotationMatrix(m), error: best.cost, yaw, size };
  }
}

function mul3(a, b) {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

/** Solve the 6 x 6 system M s = g in place (Gaussian elimination with pivoting). */
function solve6(M, g, s) {
  const a = Float64Array.from(M), b = Float64Array.from(g);
  for (let c = 0; c < 6; c++) {
    let p = c;
    for (let r = c + 1; r < 6; r++) if (Math.abs(a[r * 6 + c]) > Math.abs(a[p * 6 + c])) p = r;
    if (Math.abs(a[p * 6 + c]) < 1e-12) return false;
    if (p !== c) {
      for (let k = 0; k < 6; k++) { const t = a[c * 6 + k]; a[c * 6 + k] = a[p * 6 + k]; a[p * 6 + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    for (let r = c + 1; r < 6; r++) {
      const k = a[r * 6 + c] / a[c * 6 + c];
      for (let q = c; q < 6; q++) a[r * 6 + q] -= k * a[c * 6 + q];
      b[r] -= k * b[c];
    }
  }
  for (let r = 5; r >= 0; r--) {
    let v = b[r];
    for (let q = r + 1; q < 6; q++) v -= a[r * 6 + q] * s[q];
    s[r] = v / a[r * 6 + r];
  }
  return true;
}

/**
 * Expressions from the 68 face points, in the ARKit names the masks understand. The pose model has no expression
 * output, so these are read from the shape of the eyes, brows and mouth; rougher than MediaPipe's.
 * @returns {Record<string, number>}
 */
export function expressions68(kp, yaw) {
  const p = (i) => [kp[(23 + i) * 3], kp[(23 + i) * 3 + 1]];
  const d = (a, b) => { const A = p(a), B = p(b); return Math.hypot(A[0] - B[0], A[1] - B[1]); };
  const faceH = d(27, 8) + 1e-6;
  const clamp01 = (v) => THREE.MathUtils.clamp(v, 0, 1);
  // eye openness: lid gap over eye width
  const ear = (a, b, c, e, g, k) => (d(b, k) + d(c, g)) / (2 * d(a, e) + 1e-6);
  const right = ear(36, 37, 38, 39, 40, 41), left = ear(42, 43, 44, 45, 46, 47);
  // in profile the far eye cannot be read: both follow the near one (turned toward +X, the wearer's left side
  // goes away from the camera and the right eye is the near one)
  const near = yaw > 20 ? right : yaw < -20 ? left : null;
  const blink = (v) => clamp01((0.24 - v) / 0.13);
  const gap = d(62, 66) / faceH;
  const width = d(48, 54) / (d(36, 45) + 1e-6);
  const browR = (d(19, 37) / faceH), browL = (d(24, 44) / faceH);
  return {
    eyeBlinkRight: blink(near ?? right),
    eyeBlinkLeft: blink(near ?? left),
    jawOpen: clamp01((gap - 0.03) / 0.22),
    mouthSmileRight: clamp01((width - 0.78) / 0.22),
    mouthSmileLeft: clamp01((width - 0.78) / 0.22),
    mouthPucker: clamp01((0.6 - width) / 0.15),
    browDownRight: clamp01((0.115 - browR) / 0.04),
    browDownLeft: clamp01((0.115 - browL) / 0.04),
    browInnerUp: clamp01((Math.min(browR, browL) - 0.16) / 0.05),
  };
}
