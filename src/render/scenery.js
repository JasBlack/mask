// The simulated places a character can stand in, instead of the real picture: a sky, a floor, a horizon.
// Nothing of the camera's picture is in them. Sizes are centimetres, like the bodies.
import * as THREE from 'three';

// each look: the sky from the top down to the horizon, the floor, and whether the floor carries the dot grid
export const STAGES = {
  void: { name: 'void', sky: [[1, 0x0b0b0c], [0.3, 0x121116], [0, 0x1f1830]], floor: 0x121314, grid: 0x3a3b40, shadow: 0.55 },
  studio: { name: 'studio', sky: [[1, 0xbfbfbb], [0.25, 0xdcdcd8], [0, 0xe9e9e5]], floor: 0xdedcd8, grid: 0, shadow: 0.3 },
  dusk: { name: 'dusk', sky: [[1, 0x0f0e13], [0.5, 0x3b1a86], [0.18, 0x922cff], [0.06, 0xc855f5], [0, 0x3dfea0]], floor: 0x0f0e13, grid: 0x6a3fd0, shadow: 0.6 },
};

function dotGrid(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.beginPath(); g.arc(32, 32, 3, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5000 / 24, 5000 / 24); // a dot every 24 cm
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function blob() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(0,0,0,1)'); r.addColorStop(0.6, 'rgba(0,0,0,0.45)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class Scenery {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.look = null;
    this.fog = new THREE.Fog(0x000000, 700, 2600);
    /** A picture all the way round (2:1), used in place of the sky when one has been dropped in. */
    this.panorama = null;

    this.dome = new THREE.Mesh(new THREE.SphereGeometry(3200, 48, 24), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, toneMapped: false, depthWrite: false }));
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(2500, 72), new THREE.MeshBasicMaterial({ toneMapped: false }));
    this.floor.rotation.x = -Math.PI / 2;
    this.dots = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }));
    this.dots.rotation.x = -Math.PI / 2;
    this.dots.position.y = 0.2;
    this.group.add(this.dome, this.floor, this.dots);
    this.shadowMap = blob();
    this.camera = new THREE.PerspectiveCamera(36, 1, 10, 9000);
    this.camera.position.set(0, 108, 372);
    this.camera.lookAt(0, 92, 0);
    this.set('void');
  }

  /** A soft shadow to lie under one figure. */
  shadow() {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.shadowMap, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.5 }));
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.6;
    m.renderOrder = 1;
    return m;
  }

  /** @param {keyof typeof STAGES} look */
  set(look) {
    const s = STAGES[look] ?? STAGES.void;
    this.look = s;
    // paint the dome from the horizon up; below the horizon it is the horizon's colour
    const p = this.dome.geometry.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const stops = [...s.sky].sort((a, b) => a[0] - b[0]).map(([at, hex]) => [at, new THREE.Color(hex)]);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const up = Math.max(0, p.getY(i) / 3200);
      let k = 0;
      while (k < stops.length - 2 && up > stops[k + 1][0]) k++;
      const [a0, c0] = stops[k], [a1, c1] = stops[k + 1];
      c.copy(c0).lerp(c1, THREE.MathUtils.clamp((up - a0) / (a1 - a0), 0, 1));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    this.dome.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.floor.material.color.setHex(s.floor);
    this.dots.visible = !!s.grid;
    if (s.grid) {
      this.dots.material.map?.dispose();
      this.dots.material.map = dotGrid(s.grid);
      this.dots.material.needsUpdate = true;
    }
    this.fog.color.copy(stops[0][1]);
    this.shadowStrength = s.shadow;
  }

  /** What the scene's background should be while the stage is showing. */
  get background() {
    return this.panorama;
  }

  /** @param {THREE.Texture | null} texture a picture all the way round, or null to go back to the built-in sky */
  setPanorama(texture) {
    this.panorama?.dispose();
    this.panorama = texture;
    if (texture) {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.SRGBColorSpace;
    }
    this.dome.visible = this.floor.visible = !texture;
    this.dots.visible = !texture && !!this.look.grid;
  }
}
