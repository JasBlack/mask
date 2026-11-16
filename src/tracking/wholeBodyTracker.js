// The second tracking engine: one model sees the whole person at once. A person detector finds everybody in the
// picture, facing the camera or not, and RTMW3D reads 133 points from each: body, feet, 68 face points and both
// hands, with depth. Face and body come from the same crop of the same person, so they cannot disagree about who is
// who, and the face points are placed in profile and from behind too (less surely), where MediaPipe's face mesh
// gives up.
//
// It keeps the MediaPipe engine's promises and shares its last steps (HeadTracker._settle): heads in three states,
// one person never two, a lost head held, and the picture hidden while an established head is lost.
//   FACE  the 68 face points are read well enough to fit the head to them (headFit.js)
//   BODY  they are not (turned away, covered): the head follows the ears, eyes and nose in 3D
//   HOLD  the person was not found this frame
import * as THREE from 'three';
import { HeadTracker, Track, FACE, BODY, HOLD, EAR_MID, Q_NOSE_DIP, blendToward, relax } from './headTracker.js';
import { HeadFit, expressions68 } from './headFit.js';
import { CANON, FOV_DEG } from './canonical.js';

// MediaPipe's 33 pose joints from the 133 COCO-WholeBody points: the rest of the app (cover, figure, rigs) speaks
// MediaPipe's numbering. 23 + i is face point i (the 68-point layout), 91 the left hand, 112 the right.
const MP_FROM_WB = [
  0, 23 + 42, 1, 23 + 45, 23 + 39, 2, 23 + 36, 3, 4, 23 + 54, 23 + 48,
  5, 6, 7, 8, 9, 10,
  91 + 17, 112 + 17, 91 + 5, 112 + 5, 91 + 2, 112 + 2,
  11, 12, 13, 14, 15, 16,
  19, 22, 17, 20,
];
// lengths on an adult, in cm, to judge how far away a body is: [a, b, cm]
const BONES = [[5, 6, 36], [11, 12, 26], [5, 11, 50], [6, 12, 50], [5, 7, 29], [6, 8, 29], [7, 9, 25], [8, 10, 25], [11, 13, 42], [12, 14, 42], [13, 15, 40], [14, 16, 40]];
// the outline of the face: the jaw, then the brows back the other way (lifted onto the forehead when drawn)
const OUTLINE = [...Array.from({ length: 17 }, (_, i) => i), 26, 25, 24, 23, 22, 21, 20, 19, 18, 17];

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class WholeBodyTracker extends HeadTracker {
  /**
   * @param {import('./wholeBody.js').WholeBody} engine
   * @param {{ segments?: object }} lm MediaPipe's segmenter is still what labels the picture for the cover
   */
  constructor(engine, { segments } = {}) {
    super({ face: null, pose: null, zoom: null, segments });
    this.engine = engine;
    this.kind = 'rtmw3d';
    /** Run the person detector every this many frames while everybody is found (always when somebody is lost). */
    this.detectEvery = engine.device === 'webgpu' ? 1 : 3;
    this.stats = { detMs: 0, poseMs: 0, faceMs: 0, ranPose: true, zooms: 0, segMs: 0, people: 0 };
    this._queue = Promise.resolve();
    this._gen = 0;
  }

  async setMaxPeople(n) { this.maxPeople = n; }

  reset() {
    super.reset();
    this._gen++;
  }

  /**
   * As HeadTracker.update, but the models run on the graphics card and answer later: one frame at a time. Answers
   * null for a frame that was in the tracker when it was reset: there is nothing to show it with.
   */
  update(image, w, h, tMs) {
    const run = this._queue.then(() => this._update(image, w, h, tMs));
    this._queue = run.catch(() => {});
    return run;
  }

  async _update(image, w, h, tMs) {
    const gen = this._gen;
    let dt = this._lastT == null ? 1 / 30 : (tMs - this._lastT) / 1000;
    if (!(dt > 0) || dt > 0.5) {
      dt = 1 / 30;
      for (const t of this.tracks) t.snap = true;
    }
    dt = Math.max(dt, 1 / 240);
    this._lastT = tMs;
    this._ts += Math.max(1, Math.round(dt * 1000));
    this._frame++;
    const f = h / 2 / Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2);
    const eng = this.engine;

    // ---- who is where: the detector, or where each person's own points put them last frame
    const lost = this.tracks.some((t) => t.state === HOLD) || this.tracks.length === 0;
    let boxes = null;
    if (lost || this._frame % this.detectEvery === 0) {
      boxes = (await eng.detect(image, w, h)).slice(0, this.maxPeople);
      if (gen !== this._gen) return null;
      this.stats.detMs = eng.stats.detMs;
    }
    const work = []; // [track | null, box]
    const free = new Set(this.tracks);
    if (boxes) {
      const pairs = [];
      for (const t of this.tracks) {
        if (!t.box) continue;
        for (const b of boxes) pairs.push({ t, b, iou: iou(t.box, b) });
      }
      pairs.sort((p, q) => q.iou - p.iou);
      const taken = new Set();
      for (const { t, b, iou: o } of pairs) {
        if (o < 0.25 || taken.has(b) || !free.has(t)) continue;
        taken.add(b); free.delete(t);
        work.push([t, b]);
      }
      for (const b of boxes) if (!taken.has(b)) work.push([null, b]);
    }
    // a person the detector missed this frame is looked for where their points were (a detector skips a frame
    // now and then, and between detector frames this is how everybody is followed)
    for (const t of free) {
      if (t.box && t.state !== HOLD) work.push([t, t.box]);
    }

    // ---- the 133 points of each
    let poseMs = 0;
    const bodyOf = new Map();
    const seen = new Set();
    for (const [t0, box] of work) {
      const r = await eng.estimate(image, box);
      if (gen !== this._gen) return null;
      poseMs += eng.stats.poseMs;
      if (!personThere(r.sc)) continue;
      let t = t0;
      if (!t) {
        // somebody new, unless their head is one already followed (the same person boxed twice)
        const head = headPlace(r.kp, r.sc);
        if (this.tracks.some((o) => Math.hypot(o.cx - head.cx, o.cy - head.cy) < Math.max(o.sizePx, head.size, 1))) continue;
        if (this.tracks.length >= this.maxPeople * 2) continue;
        t = new Track(this._nextId++, tMs);
        t.fit = new HeadFit();
        this.tracks.push(t);
      }
      seen.add(t);
      this._read(t, r, w, h, f, dt, tMs, bodyOf);
    }
    this.stats.poseMs = poseMs;
    this.stats.people = seen.size;

    // ---- nobody found this frame: hold
    for (const t of this.tracks) {
      if (seen.has(t)) continue;
      t.landmarks = null; t.faceOutline = null; t.points = null;
      relax(t.blend, dt);
      t.state = HOLD;
      t.heldMs = tMs - t.lastSeen;
      if (t.heldMs < 250) t.pos.addScaledVector(t.vel, dt);
      t.vel.multiplyScalar(Math.exp(-dt / 0.1));
      t.snap = true;
      t.fit?.reset();
      _v.copy(EAR_MID).multiplyScalar(t.scale).applyQuaternion(t.quat).add(t.pos);
      if (_v.z < -1) {
        t.cx = w / 2 + (f * _v.x) / -_v.z;
        t.cy = h / 2 - (f * _v.y) / -_v.z;
      }
      t.nobodyThere = boxes != null && boxes.length === 0;
    }
    return this._settle(image, w, h, f, dt, tMs, bodyOf);
  }

  /** One person's points into their head and body. */
  _read(t, { kp, sc }, w, h, f, dt, tMs, bodyOf) {
    t.fit ??= new HeadFit();
    t.box = boxFromPoints(kp, sc, w, h);
    t.points = { kp, sc };
    // how much further the ears are than the pelvis, cm (the model's depths are from the pelvis, further larger)
    const earZ = ((kp[3 * 3 + 2] + kp[4 * 3 + 2]) / 2) * 100;
    const head = t.fit.solve(kp, sc, w, h);
    const place = headPlace(kp, sc);
    let depth; // of the pelvis from the camera, cm
    if (head) {
      this._measure(t, { pos: head.pos, quat: head.quat, scale: 1 }, FACE, dt);
      t.cx = place.cx; t.cy = place.cy;
      t.sizePx = Math.max(place.size, head.size);
      _v.copy(EAR_MID).applyQuaternion(t.quat).add(t.pos);
      t.faceDepth = -_v.z; t.faceSeen = tMs;
      const cats = Object.entries(expressions68(kp, head.yaw)).map(([categoryName, score]) => ({ categoryName, score }));
      blendToward(t.blend, cats, dt);
      t.faceOutline = faceOutline(kp);
      // one model saw head and body together: the body is where the head says it is. Bone lengths are only a
      // guess when the body is half out of the picture (a webcam at a desk)
      depth = t.faceDepth - earZ;
    } else {
      // no face to read: the head follows the ears, eyes and nose, at the distance the face was last seen at,
      // or failing that the distance the body's bones say
      relax(t.blend, dt);
      t.faceOutline = null;
      const recent = t.faceDepth && tMs - t.faceSeen < 2000;
      depth = recent ? t.faceDepth - earZ : (bodyDepth(kp, sc, f) ?? (t.faceDepth ? t.faceDepth - earZ : null));
      const size = depth ? (f * CANON.earWidth) / Math.max(depth + earZ, 10) : place.size;
      const quat = headTurn(kp, w, h, f, depth ?? (f * CANON.earWidth) / Math.max(place.size, 1));
      this._measure(t, this._bodyPose(t, { cx: place.cx, cy: place.cy, size, quat }, w, h, f), BODY, dt);
      t.cx = place.cx; t.cy = place.cy; t.sizePx = size;
    }
    if (depth) depth = Math.max(depth, 20);
    t.fitInfo = head ? { z: Math.round(head.pos.z), yaw: Math.round(head.yaw), err: +head.error.toFixed(4), size: Math.round(head.size), depth: Math.round(depth ?? 0) } : null;
    t.landmarks = null;
    t.lastSeen = tMs; t.heldMs = 0;
    if (this.wantBody && depth) {
      _v.set(0, 0, 1).applyQuaternion(t.quat);
      bodyOf.set(t, asPose(kp, sc, w, h, f, depth, { cx: t.cx, cy: t.cy, size: t.sizePx, yaw: Math.atan2(_v.x, _v.z) }));
    }
  }

}

/** Is there a person in these points at all (the detector can box a coat on a chair)? */
function personThere(sc) {
  let s = 0;
  for (let i = 0; i < 17; i++) s += sc[i];
  return s / 17 > 0.3;
}

function iou(a, b) {
  const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0), x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i;
  return u > 0 ? i / u : 0;
}

/** The middle of the head and its width in the picture, from the face points the model is surest of. */
function headPlace(kp, sc) {
  // ears and eyes and nose: always placed, even from behind
  let x = 0, y = 0, s = 0;
  for (const i of [0, 1, 2, 3, 4]) {
    const wgt = Math.max(sc[i], 0.05);
    x += kp[i * 3] * wgt; y += kp[i * 3 + 1] * wgt; s += wgt;
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 23; i < 91; i++) {
    x0 = Math.min(x0, kp[i * 3]); x1 = Math.max(x1, kp[i * 3]);
    y0 = Math.min(y0, kp[i * 3 + 1]); y1 = Math.max(y1, kp[i * 3 + 1]);
  }
  const ears = Math.hypot(kp[9] - kp[12], kp[10] - kp[13]);
  const size = Math.max(x1 - x0, 0.85 * (y1 - y0), ears);
  return { cx: x / s, cy: y / s, size };
}

/** The box to look in next frame: round every point the model was sure of, with room for the top of the head. */
function boxFromPoints(kp, sc, w, h) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 133; i++) {
    if (sc[i] < 0.3) continue;
    x0 = Math.min(x0, kp[i * 3]); x1 = Math.max(x1, kp[i * 3]);
    y0 = Math.min(y0, kp[i * 3 + 1]); y1 = Math.max(y1, kp[i * 3 + 1]);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  const bw = x1 - x0, bh = y1 - y0;
  const head = headPlace(kp, sc).size;
  return {
    x0: Math.max(-0.2 * w, x0 - 0.08 * bw), x1: Math.min(1.2 * w, x1 + 0.08 * bw),
    y0: Math.max(-0.2 * h, y0 - Math.max(0.06 * bh, 0.7 * head)), y1: Math.min(1.2 * h, y1 + 0.05 * bh),
  };
}

/** How far the pelvis is from the camera, in cm, from the lengths of the bones the model is sure of. */
function bodyDepth(kp, sc, f) {
  const est = [];
  for (const [a, b, len] of BONES) {
    const wgt = Math.min(sc[a], sc[b]);
    if (wgt < 0.35) continue;
    const px = Math.hypot(kp[a * 3] - kp[b * 3], kp[a * 3 + 1] - kp[b * 3 + 1]);
    if (px < 2) continue;
    // a bone pointing at the camera is shorter in the picture: take off the part the depth says is along the view
    const dz = (kp[a * 3 + 2] - kp[b * 3 + 2]) * 100;
    const across = Math.sqrt(Math.max(len * len - dz * dz, 0.3 * len * len));
    const mid = ((kp[a * 3 + 2] + kp[b * 3 + 2]) / 2) * 100;
    est.push({ d: (f * across) / px - mid, wgt });
  }
  if (!est.length) return null;
  // a weighted median: one bone the model has wrong does not move it
  est.sort((p, q) => p.d - q.d);
  let total = 0;
  for (const e of est) total += e.wgt;
  let acc = 0;
  for (const e of est) { acc += e.wgt; if (acc >= total / 2) return Math.max(e.d, 20); }
  return est[est.length - 1].d;
}

/** Which way the head faces, from the ears and nose in 3D: works from behind, where there is no face to fit. */
function headTurn(kp, w, h, f, depth) {
  const P = (i, out) => {
    const d = depth + kp[i * 3 + 2] * 100;
    return out.set(((kp[i * 3] - w / 2) * d) / f, (-(kp[i * 3 + 1] - h / 2) * d) / f, -d);
  };
  const L = P(3, new THREE.Vector3()), R = P(4, new THREE.Vector3()), N = P(0, new THREE.Vector3());
  const quat = new THREE.Quaternion();
  _x.subVectors(L, R);
  if (_x.lengthSq() < 1e-6) return quat;
  _x.normalize();
  _z.copy(N).sub(L.add(R).multiplyScalar(0.5));
  _z.addScaledVector(_x, -_z.dot(_x));
  if (_z.lengthSq() < 1e-6) return quat;
  _z.normalize();
  _y.crossVectors(_z, _x);
  return quat.setFromRotationMatrix(_m.makeBasis(_x, _y, _z)).multiply(Q_NOSE_DIP);
}

/** The face outline in picture pixels, the brows lifted to the hairline. */
function faceOutline(kp) {
  const nose = [kp[(23 + 27) * 3], kp[(23 + 27) * 3 + 1]], chin = [kp[(23 + 8) * 3], kp[(23 + 8) * 3 + 1]];
  const up = [nose[0] - chin[0], nose[1] - chin[1]];
  return OUTLINE.map((i) => {
    const x = kp[(23 + i) * 3], y = kp[(23 + i) * 3 + 1];
    return i >= 17 ? [x + 0.45 * up[0], y + 0.45 * up[1]] : [x, y];
  });
}

/**
 * The person as MediaPipe's pose landmarker would have reported them: 33 joints in the picture (0-1, with a
 * visibility) and in metres round the hips, so HeadTracker._followBody hangs a body on them unchanged.
 *
 * Shoulders and hips the model is unsure of (out of the picture, under a desk) are its guesses, placed anywhere in
 * its crop; MediaPipe's guesses are a plausible body. So those lean toward a body standing under the head, turned
 * as the head is, by as much as the model is unsure of them. Unseen arms and legs are settled later (skeleton.js).
 * @param {{ cx: number, cy: number, size: number, yaw: number }} head the head in the picture, its turn in radians
 */
function asPose(kp, sc, w, h, f, depth, head) {
  const k = kp.slice(), earZ = (kp[3 * 3 + 2] + kp[4 * 3 + 2]) / 2;
  const cm = head.size / 14; // picture pixels per cm at the head: a face is about 14 cm across
  const c = Math.cos(head.yaw), sn = Math.sin(head.yaw);
  const lean = (i, x, y, z) => {
    const seen = THREE.MathUtils.smoothstep(sc[i], 0.25, 0.55);
    k[i * 3] = x + (k[i * 3] - x) * seen;
    k[i * 3 + 1] = y + (k[i * 3 + 1] - y) * seen;
    k[i * 3 + 2] = z + (k[i * 3 + 2] - z) * seen;
  };
  // shoulders 22 cm under the ears and 19 cm to each side; the hips 48 cm under the shoulders, 12 cm to each side
  lean(5, head.cx + 19 * c * cm, head.cy + 22 * cm, earZ + 0.19 * sn);
  lean(6, head.cx - 19 * c * cm, head.cy + 22 * cm, earZ - 0.19 * sn);
  const sx = (k[15] + k[18]) / 2, sy = (k[16] + k[19]) / 2, sz = (k[17] + k[20]) / 2;
  lean(11, sx + 12 * c * cm, sy + 48 * cm, sz + 0.12 * sn);
  lean(12, sx - 12 * c * cm, sy + 48 * cm, sz - 0.12 * sn);

  const lm = [], world = [];
  const hx = (k[11 * 3] + k[12 * 3]) / 2, hy = (k[11 * 3 + 1] + k[12 * 3 + 1]) / 2;
  for (let j = 0; j < 33; j++) {
    const i = MP_FROM_WB[j];
    lm.push({ x: k[i * 3] / w, y: k[i * 3 + 1] / h, visibility: i === 5 || i === 6 || i === 11 || i === 12 ? Math.max(sc[i], 0.5) : sc[i] });
    const d = depth + k[i * 3 + 2] * 100;
    world.push({ x: ((k[i * 3] - hx) * d) / f / 100, y: ((k[i * 3 + 1] - hy) * d) / f / 100, z: k[i * 3 + 2] });
  }
  return { lm, world };
}
