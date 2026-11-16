// A rigged character driven by the tracked body: any humanoid skeleton in a .glb (Mixamo, VRM, Ready Player Me,
// Unreal and Blender style bone names).
//
// Nothing here knows how a particular rig is built. When the model is loaded its rest pose is measured: where each
// bone is, which way each limb points, which way the hips and chest face. Each frame the same things are measured
// on the tracked body, and every bone is turned by the difference. So a rig that rests in a T or an A, faces
// forwards or backwards, or has its bones rolled any which way, comes out the same.
import * as THREE from 'three';
import { J, basis, mid, settle } from './skeleton.js';

const NOISE = new Set(['mixamorig', 'j', 'bip', 'bip01', 'bip001', 'def', 'org', 'bone', 'jnt', 'joint', 'sec', 'c', 'rig', 'cc', 'base', 'character1', 'ctrl']);
const CORE = {
  hips: 'hips', pelvis: 'hips', hip: 'hips',
  spine: 'spine', spine01: 'spine', spine1: 'chest', spine02: 'chest', chest: 'chest',
  spine2: 'upperChest', spine03: 'upperChest', upperchest: 'upperChest',
  neck: 'neck', neck01: 'neck', head: 'head',
  shoulder: 'Shoulder', clavicle: 'Shoulder',
  arm: 'UpperArm', upperarm: 'UpperArm', forearm: 'LowerArm', lowerarm: 'LowerArm', hand: 'Hand',
  upleg: 'UpperLeg', upperleg: 'UpperLeg', thigh: 'UpperLeg', leg: 'LowerLeg', lowerleg: 'LowerLeg', calf: 'LowerLeg', shin: 'LowerLeg',
  foot: 'Foot', toebase: 'Toes', toes: 'Toes', toe: 'Toes', ball: 'Toes',
  handmiddle1: 'Middle', middle1: 'Middle', middle01: 'Middle', middleproximal: 'Middle', fmiddle01: 'Middle',
};

/** "mixamorig:LeftForeArm", "J_Bip_L_LowerArm", "forearm.L", "lowerarm_l" all come out as leftLowerArm. */
function canonical(raw) {
  const words = raw.replace(/^.*[:|]/, '').replace(/^mixamorig\d*/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/).map((s) => s.toLowerCase()).filter(Boolean);
  let side = '';
  const rest = [];
  for (const w of words) {
    if (w === 'left' || w === 'l') side = 'left';
    else if (w === 'right' || w === 'r') side = 'right';
    else if (!NOISE.has(w)) rest.push(w);
  }
  const core = CORE[rest.join('')];
  if (!core) return null;
  if (core[0] === core[0].toUpperCase()) return side ? side + core : null; // a limb needs a side
  return core;
}

const VRM_NAMES = { leftShoulder: 'leftShoulder', rightShoulder: 'rightShoulder', leftMiddleProximal: 'leftMiddle', rightMiddleProximal: 'rightMiddle' };

/**
 * The humanoid bones of a loaded model, by what they are.
 * @returns {Record<string, THREE.Object3D> | null} null when it is not a humanoid skeleton
 */
export async function findHumanoid(gltf) {
  const bones = {};
  // a VRM file says outright which bone is which
  const ext = gltf.parser?.json?.extensions ?? {};
  const listed = ext.VRMC_vrm?.humanoid?.humanBones
    ? Object.entries(ext.VRMC_vrm.humanoid.humanBones).map(([bone, v]) => [bone, v.node])
    : (ext.VRM?.humanoid?.humanBones ?? []).map((v) => [v.bone, v.node]);
  for (const [bone, node] of listed) {
    const key = VRM_NAMES[bone] ?? bone;
    try { bones[key] = await gltf.parser.getDependency('node', node); } catch { /* fall back to names */ }
  }
  gltf.scene.traverse((o) => {
    const key = canonical(o.name || '');
    if (key && !bones[key]) bones[key] = o;
  });
  const need = ['hips', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'];
  return need.every((k) => bones[k]) ? bones : null;
}

const ORDER = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];

// where the base of the skull is in the head tracker's own space (cm): the rig's head bone is hung from it
const SKULL_BASE = new THREE.Vector3(0, -6.5, -3.5);

const _q = new THREE.Quaternion();
const _s = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * @param {THREE.Object3D} object the model, at its rest pose, not yet moved or turned (sized so it is as tall as the wearer)
 * @param {Record<string, THREE.Object3D>} bones from findHumanoid, on this same object
 * @param {(blend: object) => void} [express] sets the face's shape keys
 */
export function createRig(object, bones, express) {
  object.position.set(0, 0, 0);
  object.quaternion.identity();
  object.scale.setScalar(1);
  object.updateMatrixWorld(true);

  const rest = {};
  for (const [key, bone] of Object.entries(bones)) {
    rest[key] = { q: bone.getWorldQuaternion(new THREE.Quaternion()), p: bone.getWorldPosition(new THREE.Vector3()) };
  }
  const restHips = mid(rest.leftUpperLeg.p, rest.rightUpperLeg.p);
  const restShoulders = mid(rest.leftUpperArm.p, rest.rightUpperArm.p);
  // the figure's height as a chain, head to shoulders to hips to knees to ankles: the same length bent or straight
  const chain = (head, sh, hp, kl, kr, al, ar) => head.distanceTo(sh) + sh.distanceTo(hp) + (hp.distanceTo(kl) + kl.distanceTo(al) + hp.distanceTo(kr) + kr.distanceTo(ar)) / 2;
  const restChain = Math.max(1e-6, chain(rest.head?.p ?? rest.neck?.p ?? restShoulders, restShoulders, restHips,
    rest.leftLowerLeg.p, rest.rightLowerLeg.p, rest.leftFoot?.p ?? rest.leftLowerLeg.p, rest.rightFoot?.p ?? rest.rightLowerLeg.p));
  const restUp = new THREE.Vector3().subVectors(restShoulders, restHips);
  const hipsFacing = basis(_v.subVectors(rest.leftUpperLeg.p, rest.rightUpperLeg.p), restUp).invert();
  const chestFacing = basis(_v.subVectors(rest.leftUpperArm.p, rest.rightUpperArm.p), restUp).invert();
  // which way each limb bone points at rest: toward the next joint down the limb
  const dir = (from, to) => (rest[from] && rest[to] ? new THREE.Vector3().subVectors(rest[to].p, rest[from].p).normalize() : null);
  const restDir = {};
  for (const side of ['left', 'right']) {
    restDir[`${side}UpperArm`] = dir(`${side}UpperArm`, `${side}LowerArm`);
    restDir[`${side}LowerArm`] = dir(`${side}LowerArm`, `${side}Hand`);
    restDir[`${side}Hand`] = dir(`${side}Hand`, `${side}Middle`) ?? restDir[`${side}LowerArm`];
    restDir[`${side}UpperLeg`] = dir(`${side}UpperLeg`, `${side}LowerLeg`);
    restDir[`${side}LowerLeg`] = dir(`${side}LowerLeg`, `${side}Foot`);
    restDir[`${side}Foot`] = dir(`${side}Foot`, `${side}Toes`);
  }

  // how far the ankle bone stands above the sole, at rest
  const sole = new THREE.Box3().setFromObject(object).min.y;
  const footHeight = rest.leftFoot && rest.rightFoot ? Math.max(0, Math.min(rest.leftFoot.p.y, rest.rightFoot.p.y) - sole) : 0;
  const hips = new THREE.Vector3();

  const joints = Array.from({ length: 33 }, () => new THREE.Vector3());
  const want = {}; // the turn each bone should have in the world, this frame
  const Dh = new THREE.Quaternion(), Dc = new THREE.Quaternion(), Dhead = new THREE.Quaternion();
  const scratch = Array.from({ length: 8 }, () => new THREE.Quaternion());
  let size = 0;

  const turn = (key, delta) => { if (bones[key]) (want[key] ??= new THREE.Quaternion()).copy(delta).multiply(rest[key].q); };
  /** Turn a limb bone, already carried round by its parent, the rest of the way to where the limb really points. */
  const swing = (key, parent, from, to, out) => {
    out.copy(parent);
    if (bones[key] && restDir[key]) {
      _t.subVectors(to, from);
      if (_t.lengthSq() > 1e-6) {
        _v.copy(restDir[key]).applyQuaternion(parent);
        out.premultiply(_s.setFromUnitVectors(_v, _t.normalize()));
      }
    }
    turn(key, out);
    return out;
  };

  function update(body, { build = 1, track = null } = {}) {
    const { S } = settle(body, joints);
    const p = joints;
    const hp = mid(p[J.hipL], p[J.hipR], _a), sh = mid(p[J.shoulderL], p[J.shoulderR], _b);
    const up = new THREE.Vector3().subVectors(sh, hp);

    // the hips and the chest each face their own way; the spine between them shares the twist out
    Dc.copy(basis(_v.subVectors(p[J.shoulderL], p[J.shoulderR]), up, _q)).multiply(chestFacing);
    if (body.hipsSeen) Dh.copy(basis(_v.subVectors(p[J.hipL], p[J.hipR]), up, _q)).multiply(hipsFacing); else Dh.copy(Dc);
    turn('hips', Dh);
    turn('spine', scratch[0].copy(Dh).slerp(Dc, 0.35));
    turn('chest', scratch[0].copy(Dh).slerp(Dc, 0.7));
    turn('upperChest', Dc);
    // the head turns as the head tracker says: that is the exact one
    if (track) Dhead.copy(track.quat).multiply(chestFacing); else Dhead.copy(Dc);
    turn('neck', scratch[0].copy(Dc).slerp(Dhead, 0.5));
    turn('head', Dhead);

    for (const [side, s, e, w, i, k, hip, knee, ankle, toe] of [
      ['left', J.shoulderL, J.elbowL, J.wristL, J.indexL, J.pinkyL, J.hipL, J.kneeL, J.ankleL, J.toeL],
      ['right', J.shoulderR, J.elbowR, J.wristR, J.indexR, J.pinkyR, J.hipR, J.kneeR, J.ankleR, J.toeR]]) {
      turn(`${side}Shoulder`, Dc);
      const upper = swing(`${side}UpperArm`, Dc, p[s], p[e], scratch[1]);
      const lower = swing(`${side}LowerArm`, upper, p[e], p[w], scratch[2]);
      swing(`${side}Hand`, lower, p[w], mid(p[i], p[k], _v.clone()), scratch[3]);
      const thigh = swing(`${side}UpperLeg`, Dh, p[hip], p[knee], scratch[4]);
      const shin = swing(`${side}LowerLeg`, thigh, p[knee], p[ankle], scratch[5]);
      swing(`${side}Foot`, shin, p[ankle], p[toe], scratch[6]);
    }

    // world turns become each bone's own turn, parents first
    for (const key of ORDER) {
      const bone = bones[key];
      if (!bone || !want[key]) continue;
      bone.parent.getWorldQuaternion(_q);
      bone.quaternion.copy(_q.invert()).multiply(want[key]);
    }

    // size so the figure is as tall as the wearer, slowly; then hang it by its head, where the real head is
    const head = mid(p[J.earL], p[J.earR], _t.clone());
    const measured = (chain(head, sh, hp, p[J.kneeL], p[J.kneeR], p[J.ankleL], p[J.ankleR]) / restChain) * build;
    size = size ? size + (measured - size) * 0.08 : measured;
    object.scale.setScalar(size);
    object.position.set(0, 0, 0);
    object.updateMatrixWorld(true);
    // (read the bone before moving the figure: reading it refreshes the figure's matrix from its new place)
    if (track && bones.head) {
      bones.head.getWorldPosition(_v);
      _t.copy(SKULL_BASE).multiplyScalar(track.scale).applyQuaternion(track.quat).add(track.pos);
      object.position.subVectors(_t, _v);
    } else {
      mid(bones.leftUpperLeg.getWorldPosition(_v), bones.rightUpperLeg.getWorldPosition(_t), _v);
      object.position.subVectors(mid(p[J.hipL], p[J.hipR], _t), _v);
    }
    object.updateMatrixWorld(true);
    if (express && track) express(track.blend);

    // where the figure's hips and the ground under its feet now are, for standing it on a stage
    mid(bones.leftUpperLeg.getWorldPosition(_v), bones.rightUpperLeg.getWorldPosition(_t), hips);
    let ground = hips.y - 2.4 * S;
    if (bones.leftFoot && bones.rightFoot) {
      ground = Math.min(bones.leftFoot.getWorldPosition(_v).y, bones.rightFoot.getWorldPosition(_t).y) - footHeight * size;
    }
    return { hips, ground, S };
  }

  return { object, update, dispose() {} };
}
