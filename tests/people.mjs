// How many people the tracker follows in each frame of a video with ONE person in it. The answer must be 1 in
// every frame, with the picture never hidden. Two used to happen with a person close to the camera: the same
// person reported twice, a ghost lost, and the whole picture hidden for it.
//   node tests/people.mjs <video> <out folder> [fps=12] [picture every n frames=24] [max frames] [head|body]
// Make a close-up from any clip to test it the way a webcam at a desk sees you, for example:
//   ffmpeg -i clip.mp4 -vf "crop=560:315:104:20,scale=768:432,eq=brightness=-0.12" close.webm
// Needs "npm run build" and "npm run preview" (port 5421).
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const [video, outDir, fps = '12', every = '24', maxFrames = '100000', character = 'body'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:5421/?delegate=cpu');
  await page.waitForFunction(() => window.__maskLayer, null, { timeout: 120000 });
  await page.setInputFiles('#file-input', video);
  await page.waitForFunction(() => window.__maskLayer.state.kind === 'file', null, { timeout: 30000 });
  const r = await page.evaluate(async ({ fps, every, maxFrames, character }) => {
    const { stage, tracker, state } = window.__maskLayer;
    const v = document.getElementById('video'); v.pause(); state.loop++; state.manual = true; tracker.reset(); stage.forget();
    await tracker.setMaxPeople(4);
    tracker.wantBody = character === 'body'; tracker.wantSegments = true; tracker.failClosed = true;
    Object.assign(stage.settings, { character, scene: 'camera', underlay: 'pixelate', strict: true, mirror: false, showMask: true });
    const seek = (t) => new Promise((res) => { v.addEventListener('seeked', res, { once: true }); v.currentTime = t; });
    const w = v.videoWidth, h = v.videoHeight, t0 = performance.now();
    const total = Math.min(maxFrames, Math.floor(v.duration * fps));
    const rows = [], shots = [];
    for (let i = 0; i < total; i++) {
      await seek((i + 0.5) / fps);
      stage.captureFrame(v, w, h);
      const tracks = tracker.update(stage.frame, w, h, t0 + (i * 1000) / fps);
      stage.render(tracks, 1 / fps);
      rows.push({ i, n: tracks.length, states: tracks.map((t) => t.state).join('+'), hidden: stage.report.hidden });
      if (i % every === 0 || tracks.length > 1) if (shots.length < 40) shots.push({ i, n: tracks.length, url: stage.out.toDataURL('image/jpeg', 0.8) });
    }
    return { rows, shots };
  }, { fps: Number(fps), every: Number(every), maxFrames: Number(maxFrames), character });
  for (const s of r.shots) fs.writeFileSync(`${outDir}/f${String(s.i).padStart(4, '0')}-n${s.n}.jpg`, Buffer.from(s.url.split(',')[1], 'base64'));
  const rows = r.rows;
  const hist = {}; for (const x of rows) hist[x.n] = (hist[x.n] || 0) + 1;
  console.log(JSON.stringify({ video: video.split('/').pop(), frames: rows.length, peopleFollowedPerFrame: hist, framesWholePictureHidden: rows.filter((x) => x.hidden).length,
    moreThanOne: rows.filter((x) => x.n > 1).map((x) => `${x.i}:${x.states}`).slice(0, 20) }));
  await browser.close();
})();
