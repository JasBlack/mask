// The body as the pose tracker gives it: 33 joints, numbered as MediaPipe numbers them.
// Left and right are the wearer's own.
import * as THREE from 'three';

export const J = {
  nose: 0, earL: 7, earR: 8,
  shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
  pinkyL: 17, pinkyR: 18, indexL: 19, indexR: 20,
  hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28,
  heelL: 29, heelR: 30, toeL: 31, toeR: 32,
};

const _x = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _down = new THREE.Vector3();
const _a = new THREE.Vector3();
const _m = new THREE.Matrix4();
const WORLD_DOWN = new THREE.Vector3(0, -1, 0);

const smooth = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const mid = (a, b, out = new THREE.Vector3()) => out.addVectors(a, b).multiplyScalar(0.5);

/** A rotation whose X runs along `x` and whose Y is as near to `up` as that allows. */
export function basis(x, up, out = new THREE.Quaternion()) {
  _x.copy(x).normalize();
  _up.copy(up).addScaledVector(_x, -up.dot(_x)).normalize();
  _fwd.crossVectors(_x, _up);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _up, _fwd));
}

/**
 * The joints to hang a character on. Mostly the tracked ones; but a leg the tracker cannot see (a desk, the edge
 * of the frame) is only its guess, and a guess twitches. So each leg joint leans toward a plain standing leg by
 * as much as the tracker is unsure of it, and is fully the tracked joint when it is seen.
 * @param {object} body the tracker's body (joints, vis, world, k)
 * @param {THREE.Vector3[]} out 33 vectors to fill
 * @returns {{ S: number, torso: number }} shoulder width and trunk length, cm
 */
export function settle(body, out) {
  const p = body.joints, v = body.vis;
  for (let i = 0; i < 33; i++) out[i].copy(p[i]);
  // shoulder width from the pose model's own figure: it does not shrink when the person turns side on
  const w = body.world;
  const S = Math.max(8, Math.hypot(w[33] - w[36], w[34] - w[37], w[35] - w[38]) * 100 * body.k);
  const sh = mid(p[J.shoulderL], p[J.shoulderR]);
  const hp = mid(p[J.hipL], p[J.hipR]);
  const torso = Math.max(sh.distanceTo(hp), S * 0.9);

  _x.subVectors(p[J.shoulderL], p[J.shoulderR]).normalize();
  _up.subVectors(sh, hp).normalize();
  _fwd.crossVectors(_x, _up).normalize(); // out of the chest
  _down.copy(_up).negate().lerp(WORLD_DOWN, 0.7).normalize();

  for (const [hip, knee, ankle, heel, toe] of [[J.hipL, J.kneeL, J.ankleL, J.heelL, J.toeL], [J.hipR, J.kneeR, J.ankleR, J.heelR, J.toeR]]) {
    const kneeSeen = smooth(0.2, 0.5, Math.min(v[hip], v[knee]));
    const footSeen = smooth(0.2, 0.5, Math.min(v[knee], v[ankle]));
    _a.copy(out[hip]).addScaledVector(_down, 1.2 * S);
    out[knee].lerpVectors(_a, p[knee], kneeSeen);
    _a.copy(out[knee]).addScaledVector(_down, 1.18 * S);
    out[ankle].lerpVectors(_a, p[ankle], footSeen);
    _a.copy(out[ankle]).addScaledVector(_down, 0.2 * S).addScaledVector(_fwd, -0.12 * S);
    out[heel].lerpVectors(_a, p[heel], footSeen);
    _a.copy(out[ankle]).addScaledVector(_down, 0.22 * S).addScaledVector(_fwd, 0.5 * S);
    out[toe].lerpVectors(_a, p[toe], footSeen);
  }
  return { S, torso };
}
