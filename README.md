# Mask Layer

Cover yourself in any video or live feed with a tracked 3D mask or a whole character, so you can publish real
footage without showing who you are. It runs entirely in the browser: the video never leaves your computer.

One of the JAS.BLACK tools, at [mask.jas.black](https://mask.jas.black).

## Use it

Everything is on one screen: what goes in and out on the left, the picture in the middle, the fine controls on
the right.

On the left:

- **Source.** `open video`, or drop a video anywhere on the page, or start the `camera`. `mirror` flips the
  picture left to right (on for a camera, off for a video).
- **Character.** Pick one, and `head` (a mask on the head) or `whole body` (a figure from head to foot, strung
  between your own joints so it has your height and reach). Drop a `.glb` on the page to add your own: a head
  model becomes a mask; a rigged character (Mixamo, VRM, Ready Player Me, and most humanoid skeletons) moves with
  your whole body (Meshy's auto-rigged "biped" files included). Your own characters are remembered in this
  browser. `show character` off leaves only the cover.
- **Scene.** `camera` keeps the real picture, with the character over you. `stage` puts the character in a
  simulated place (`void`, `studio`, `dusk`), and nothing of the real picture is shown. Drop a 360 picture (2:1)
  on the page to stand in that instead.
- **Cover.** What hides the real person under the character: `pixels`, `erase`, `paint`, `blur` or `none`. It
  covers all of a head: hair, beard, a bald scalp, ears, the back of the head in profile. In whole-body mode it
  covers the whole person. `erase` paints in the place as it looks with nobody there, learned as the video runs,
  so it needs a camera that stays put. `hide picture if a head is lost` hides everything whenever a head that was
  just there cannot be found.
- **Save.** `export video` writes the file again with the character on every frame and carries the sound over
  (turn `keep sound` off if your voice matters). `record` saves the picture as you see it, without sound. Both
  write MP4 (H.264) at a constant frame rate.

On the right:

- **Fit.** Size, place, turn and stretch of a head mask, remembered per mask. Right-click a slider to put it
  back. `fit by points` shows three pins where your own eyes and mouth sit behind the mask; drag each onto that
  part of the mask and it is resized and moved to match. `head outline` draws a wire head, to see whether the mask
  encloses it.
- **Body.** How thick the whole-body figure is, or how big a rigged character is.
- **Tracking.** How far the cover reaches, how many people to cover (four unless you choose), the tracking
  engine (see below), and the tracking points.
- **Picture.** A look for the whole picture.

The lights by the title: `live` is a source running; `lock` is green while the face is tracked and violet while
the mask is following the head from the body (in profile, or turned away); `rec` is recording. The green line
under the picture says the same in words.

Keys: `Space` pause, `E` export, `R` record, `B` whole body, `V` stage, `M` mirror, `F` full screen. `guide` in
the top bar is the short version of this section; the key beside it switches light and dark.

## Two tracking engines

`mediapipe` is the one the tool started with: a face mesh (478 points and 52 expressions), a separate body
tracker, and a closer look at small faces. It is small (about 30 MB) and quick, also without a graphics card. Its
weak point is the turn to profile: the face mesh gives up, the body tracker takes over, and the hand-over between
two trackers is where it can jump.

`rtmw3d` is one model for the whole person. A person detector (RTMDet) finds everybody in the picture, facing the
camera or not, and RTMW3D reads 133 points from each: body, feet, 68 face points and both hands, with depth. Face
and body come from the same look at the same person, so there is no hand-over and nobody is counted twice, and
the face points are still placed in profile, where the head stays locked. The head's turn and place are fitted to
the face points; expressions are read from their shape (eyes, brows, mouth), rougher than MediaPipe's. It is a 235
MB download the first time it is chosen (the browser keeps it), and it wants a graphics card through WebGPU
(Chrome, Edge; Safari 26): on the processor alone it manages about one frame every two seconds. The segmenter
that finds hair and skin for the cover is MediaPipe's in both.

Switch between them under Tracking and compare on the same video; the choice is remembered.

## How the cover finds a whole head

A face tracker only knows a face: hair, a beard, a bald scalp and the back of the head are not part of it. So
the cover is three things at once, and each covers what the others miss:

1. **Every pixel labelled hair or face skin.** A segmentation model labels each pixel of the picture as hair,
   face skin, body skin, clothes or background. The cover takes all the hair and face skin, and the skin touching
   them, then widens it a little. This is not tied to the tracked people: anyone whose hair or face it sees is
   covered. In whole-body mode it takes every pixel of a person.
2. **A solid head where the tracked head is.** A skull and jaw in 3D, turned and placed as the head is, and drawn
   where they fall in the picture. It covers a head the model mislabels, and the back of the head in profile.
3. **The face and the body's limbs**, outlined from the tracker's own points.

## Why the mask does not flicker off

Filter apps lose the face when you turn, and for the frames it takes to find you again the mask is gone. Five
things prevent that here.

1. **A frame is never shown before its mask.** Each video frame is copied once. The tracker reads that copy and
   the picture is composed from that same copy. If tracking is slow the picture is late, but it is never a frame
   ahead of its mask. Export goes further: it decodes the file one frame at a time and waits for each, so a slow
   computer only makes the export take longer.
2. **A second tracker takes over when the face cannot be read.** In profile or turned away there is no face mesh
   to find. The body-pose tracker still knows where the nose, ears and shoulders are, and the mask follows those
   (the `lock` light turns violet).
3. **Small faces are looked at again, enlarged.** The face tracker cannot see a face much smaller than a fifth
   of the frame. For every head it has not locked, the app crops in on that head and runs the face mesh on the
   enlarged crop, so a face across a room still gets a full lock, with expression.
4. **Losing track is not a reason to remove a mask.** With no evidence at all the mask coasts briefly on its last
   velocity and then stays where it was. A head is let go when it was last seen leaving the picture, or when the
   body tracker reports the picture empty of people; otherwise it is kept.
5. **When it is blind, it hides everything.** With `hide picture if a head is lost` on (the default), any
   frame in which a head that was just there cannot be located is pixelated from edge to edge, and it stays that
   way for as long as anybody is still in the picture, because "not detected" is not "not there". With it off,
   a lost head keeps its mask and a widening patch for 1.5 s and is then let go.

The masks are also closed shells larger than a real head, so there is no angle from which the wearer shows past
the edge.

### What it cannot promise

- A face that has never been detected cannot be covered. Someone only a few pixels tall in the distance, entering
  at the very edge of the frame, or in near darkness may be visible for the frames before either tracker picks
  them up. In testing, people walking in from the far end of a corridor were uncovered until their heads were
  about 10 pixels across.
- More than one person works best when faces are visible: the body tracker tends to follow one body at a time,
  so two people who both turn away at once will often trip the whole-picture hide.
- Someone blurred by fast movement right at the edge of the frame can be missed by all three covers for a few
  frames. With `hide picture if a head is lost` on, those frames are hidden whole; with it off, they may show.
- In full profile the face tracker reports the head turned only about 60 degrees, so a head mask looks three
  quarters on. The cover still takes the whole head.
- It hides the head. Voice, body, clothes, tattoos, the room and the file's metadata still identify people. Turn
  `keep sound` off if your voice matters.
- **Watch every export through once before publishing it.** The note under Save says after an export on how
  many frames the mask fell back to body tracking or the picture was hidden; those are the places to look.

## Making masks

A mask is a 3D model of a head in `.glb` format. Three levels, each building on the last:

| | What you make | What you get |
|---|---|---|
| 1 | A head model, closed, a little larger than a real head | Follows the head at every angle. Enough to hide a face. |
| 2 | The same, with shape keys named like Apple's ARKit face shapes | It blinks, talks and frowns with you. |
| 3 | The same, with an idle animation in the file | Hair, tentacles and so on move on their own (the first animation in the file loops). |

A flat picture wrapped onto the face (the classic "face paint" filter) is deliberately not offered: it keeps the
shape of your face and disappears in profile, so it does not hide anyone.

### From a character sheet to a mask

1. **Head-only views.** Image-to-3D tools want the head large and square-on: front, side and back, neutral
   expression, plain background, at least 1024 px. A full-body turnaround leaves the head too small. An image-edit
   model can produce these from one good render of the head.
2. **Image to 3D.** Hunyuan3D, Tripo, Meshy and Rodin all take one or several views and return a textured mesh.
3. **Clean up in Blender.**
   - Keep the head (and beard, horns, hair); cut below the chin. Close any holes: what is open shows the wearer.
   - Face it down the +Y axis in Blender's front view (so it faces +Z in the exported glTF), upright.
   - Aim for under 100,000 triangles and 2K textures; it is drawn every frame.
   - Size does not matter: on import the model is scaled to head size, and Fit does the rest.
4. **Expressions (optional).** Add shape keys with these exact names; the tracker reports the same 52 and any
   that are missing are simply not animated. The ones that carry most of a performance:
   `eyeBlinkLeft`, `eyeBlinkRight`, `jawOpen`, `browDownLeft`, `browDownRight`, `browInnerUp`,
   `browOuterUpLeft`, `browOuterUpRight`, `mouthSmileLeft`, `mouthSmileRight`, `mouthFunnel`, `mouthPucker`,
   `eyeSquintLeft`, `eyeSquintRight`, `eyeWideLeft`, `eyeWideRight`.
   Left and right are the wearer's. `eyeBlink_L`, `EyeBlinkLeft` and `blendShape1.eyeBlink_L` are all understood.
   An expression sheet is the sculpting reference: each drawn expression is a mix of a few of these shapes.
5. **Export** as glTF Binary (`.glb`) with shape keys included, and drop the file on the page.

### Built-in masks

They are generated in code (`src/masks/`), in the same head space an imported model lands in, and are the place
to look for how a mask is driven by expression.

- **Iridescent Satyr** (`satyr.js`): a procedural stand-in for the character sheet, until the sculpt exists.
- **Chrome Helm** (`helm.js`): the simplest closed cover.
- **Paper Bag** (`bag.js`): a drawn face that blinks and talks.

## Run it yourself

```bash
npm install
```

```bash
npm run dev
```

Then open `http://localhost:5420` in Chrome or Edge. `npm install` also copies the tracker's runtime out of
`node_modules` and downloads its model files into `public/`, once: MediaPipe's three (about 30 MB) and the
`rtmw3d` engine's two (about 235 MB). `npm run build` writes the
static site to `dist/`. The camera needs `https://` or `localhost`.

## Publish it

It is a static site with no server side. Published, it still does all its work in the visitor's browser: the
page, the tracker and the models are downloaded once (about 45 MB, then cached; the `rtmw3d` engine another 235
MB, only if it is chosen), and no video goes back.

Every push to `main` is built and published by `.github/workflows/pages.yml`. The repository needs, once:

1. Settings, Pages, Source "GitHub Actions". Custom domain `mask.jas.black`, and once the certificate is issued,
   Enforce HTTPS (the camera needs it).
2. At the DNS host for `jas.black`: a `CNAME` record for `mask` pointing at `jasblack.github.io`.

For the card on jas.black, `design/` has the 1920 x 1008 card, the picture on it, a short loop of the mask
turning, and the entry for the card generator.

`CLAUDE.md` has the rest: the stack, where everything is, the tests, what is and is not verified.

MIT licence. Fonts: Archivo and IBM Plex Mono, SIL Open Font License (`public/LICENSES/`). The `rtmw3d` engine's
models are OpenMMLab's RTMDet and RTMW3D (Apache-2.0), as ONNX exports by bukuroo and RabbitDaisuke on Hugging
Face; they run on ONNX Runtime Web (MIT).
