// A jointed body made in code, to go under any head mask: an artist's lay figure in the mask's own material.
// It is not a fixed figure posed like the wearer. Every part is strung between the wearer's own joints, so it has
// their proportions and, drawn with the tracking camera, lies exactly over them: which is what covers a body.
import * as THREE from 'three';
import { J, mid, settle } from './skeleton.js';

// [from, to, radius at from, radius at to], radii in shoulder widths
const LIMBS = [
  [J.shoulderL, J.elbowL, 0.18, 0.148], [J.elbowL, J.wristL, 0.142, 0.108],
  [J.shoulderR, J.elbowR, 0.18, 0.148], [J.elbowR, J.wristR, 0.142, 0.108],
  [J.hipL, J.kneeL, 0.235, 0.17], [J.kneeL, J.ankleL, 0.165, 0.115],
  [J.hipR, J.kneeR, 0.235, 0.17], [J.kneeR, J.ankleR, 0.165, 0.115],
  [J.heelL, J.toeL, 0.12, 0.1], [J.heelR, J.toeR, 0.12, 0.1],
  ['handL0', 'handL1', 0.105, 0.12], ['handR0', 'handR1', 0.105, 0.12],
  ['neck0', 'neck1', 0.16, 0.15],
];

const STYLES = {
  // the satyr's skin: a soft thin-film sheen over periwinkle
  pearl: () => new THREE.MeshPhysicalMaterial({ color: 0x6f76e6, roughness: 0.2, metalness: 0.12, clearcoat: 1, clearcoatRoughness: 0.12, iridescence: 1, iridescenceIOR: 1.55, iridescenceThicknessRange: [220, 640], envMapIntensity: 1.05 }),
  chrome: () => new THREE.MeshStandardMaterial({ color: 0xd6daea, metalness: 1, roughness: 0.1, envMapIntensity: 1.3 }),
  paper: () => new THREE.MeshStandardMaterial({ color: 0xb98f5c, roughness: 0.92, metalness: 0, flatShading: true }),
};

const Y = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();
const _x = new THREE.Vector3();
const _up = new THREE.Vector3();
const _z = new THREE.Vector3();
const _o = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();

/**
 * @param {'pearl' | 'chrome' | 'paper'} style
 * @returns {{ object: THREE.Group, update: (body: object, opts?: { build?: number }) => { hips: THREE.Vector3, ground: number, S: number }, dispose: () => void }}
 */
export function createPuppet(style = 'pearl') {
  const boxy = style === 'paper';
  const material = (STYLES[style] ?? STYLES.pearl)();
  const root = new THREE.Group();
  const made = [];
  const geo = (g) => { made.push(g); return g; };

  // a limb is a tube from one joint to the next, with a ball at each end so joints stay closed as they bend
  const ball = geo(boxy ? new THREE.BoxGeometry(1.7, 1.7, 1.7) : new THREE.SphereGeometry(1, 18, 12));
  const limbs = LIMBS.map(([a, b, ra, rb]) => {
    const tube = geo(boxy ? new THREE.BoxGeometry(2, 1, 2) : new THREE.CylinderGeometry(rb / ra, 1, 1, 18, 1, true));
    tube.translate(0, 0.5, 0);
    const mesh = new THREE.Mesh(tube, material);
    const end0 = new THREE.Mesh(ball, material), end1 = new THREE.Mesh(ball, material);
    root.add(mesh, end0, end1);
    return { a, b, ra, rb, mesh, end0, end1 };
  });

  // the trunk: a barrel from hips to shoulders, wider at the top, with a rounded yoke and pelvis
  const barrel = geo(boxy ? new THREE.BoxGeometry(2, 1, 2) : new THREE.CylinderGeometry(1, 1, 1, 32, 10, false));
  barrel.translate(0, 0.5, 0);
  if (!boxy) {
    // a waist: full at the hips, in at the middle, widest across the chest, rounding in to the shoulders
    const profile = [[0, 0.8], [0.14, 0.86], [0.42, 0.74], [0.78, 1], [0.93, 0.96], [1, 0.8]];
    const bp = barrel.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      const y = bp.getY(i);
      let k = 0;
      while (k < profile.length - 2 && y > profile[k + 1][0]) k++;
      const [y0, r0] = profile[k], [y1, r1] = profile[k + 1];
      const t = THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1);
      const r = r0 + (r1 - r0) * t * t * (3 - 2 * t);
      bp.setX(i, bp.getX(i) * r); bp.setZ(i, bp.getZ(i) * r);
    }
    barrel.computeVertexNormals();
  }
  const trunk = new THREE.Mesh(barrel, material);
  trunk.matrixAutoUpdate = false;
  const yoke = new THREE.Mesh(ball, material), pelvis = new THREE.Mesh(ball, material);
  yoke.matrixAutoUpdate = false;
  pelvis.matrixAutoUpdate = false;
  root.add(trunk, yoke, pelvis);
  for (const o of root.children) o.frustumCulled = false;

  const joints = Array.from({ length: 33 }, () => new THREE.Vector3());
  const extra = { handL0: new THREE.Vector3(), handL1: new THREE.Vector3(), handR0: new THREE.Vector3(), handR1: new THREE.Vector3(), neck0: new THREE.Vector3(), neck1: new THREE.Vector3() };
  const at = (k) => (typeof k === 'number' ? joints[k] : extra[k]);
  const hips = new THREE.Vector3();
  let size = 0;

  function update(body, { build = 1 } = {}) {
    const { S: measured } = settle(body, joints);
    // the width everything is sized by changes slowly: a body does not breathe in and out with the tracker's noise
    size = size ? size + (measured - size) * 0.08 : measured;
    const S = size * build;

    // hands run from the wrist past the knuckles; the neck from between the shoulders to between the ears
    for (const [w, i, p, k0, k1] of [[J.wristL, J.indexL, J.pinkyL, 'handL0', 'handL1'], [J.wristR, J.indexR, J.pinkyR, 'handR0', 'handR1']]) {
      mid(joints[i], joints[p], _d).sub(joints[w]);
      const len = Math.max(_d.length(), 1e-3);
      extra[k0].copy(joints[w]);
      extra[k1].copy(joints[w]).addScaledVector(_d, Math.min(1.7, (0.42 * S) / len));
    }
    const sh = mid(joints[J.shoulderL], joints[J.shoulderR]);
    const hp = mid(joints[J.hipL], joints[J.hipR]);
    _up.subVectors(sh, hp);
    const torso = Math.max(_up.length(), 1e-3);
    _up.divideScalar(torso);
    extra.neck0.copy(sh).addScaledVector(_up, 0.05 * S);
    mid(joints[J.earL], joints[J.earR], extra.neck1);

    for (const l of limbs) {
      const a = at(l.a), b = at(l.b);
      _d.subVectors(b, a);
      const len = Math.max(_d.length(), 1e-3);
      l.mesh.position.copy(a);
      l.mesh.quaternion.setFromUnitVectors(Y, _d.divideScalar(len));
      l.mesh.scale.set(l.ra * S, len, l.ra * S);
      l.end0.position.copy(a); l.end0.scale.setScalar(l.ra * S); l.end0.quaternion.copy(l.mesh.quaternion);
      l.end1.position.copy(b); l.end1.scale.setScalar(l.rb * S); l.end1.quaternion.copy(l.mesh.quaternion);
    }

    // the trunk's own axes: across the shoulders and hips, up the spine, out of the chest
    _x.subVectors(joints[J.shoulderL], joints[J.shoulderR]).add(_d.subVectors(joints[J.hipL], joints[J.hipR]));
    _x.addScaledVector(_up, -_x.dot(_up)).normalize();
    _z.crossVectors(_x, _up).normalize();
    const wide = 0.54 * S, deep = 0.33 * S;
    const place = (mesh, origin, width, height, depth) => {
      mesh.matrix.makeBasis(_ax.copy(_x).multiplyScalar(width), _ay.copy(_up).multiplyScalar(height), _az.copy(_z).multiplyScalar(depth)).setPosition(origin);
      mesh.matrixWorldNeedsUpdate = true;
    };
    place(trunk, _o.copy(hp).addScaledVector(_up, -0.16 * S), wide, torso + 0.2 * S, deep);
    place(yoke, _o.copy(sh).addScaledVector(_up, 0.02 * S), wide * 0.8, 0.2 * S, deep * 0.8);
    place(pelvis, _o.copy(hp).addScaledVector(_up, -0.14 * S), wide * 0.8, 0.28 * S, deep * 0.82);
    // where the hips and the ground under the feet are, for standing the figure on a stage
    hips.copy(hp);
    const ground = Math.min(joints[J.heelL].y, joints[J.heelR].y, joints[J.toeL].y, joints[J.toeR].y) - 0.12 * S;
    return { hips, ground, S };
  }

  return {
    object: root,
    update,
    dispose() { for (const g of made) g.dispose(); material.dispose(); },
  };
}
