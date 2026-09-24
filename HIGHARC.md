# Higharc fork: shared Slug textures

Fork: https://github.com/higharc/three-text

Based on upstream 0.6.5. This adds an opt-in shared atlas to the vector core and
the Three.js **GLSL/WebGL2** adapter. Mesh rendering and default vector calls
retain their existing APIs. The TSL and raw WebGL/WebGPU adapters do not manage
shared-atlas updates; use `createSlugGLSLMesh` with shared results.

## Usage

```ts
import { Text, SlugAtlas } from 'three-text/vector/core';
import { createSlugGLSLMesh } from 'three-text/vector';

const atlas = new SlugAtlas(); // own this at sheet/scene scope
const first = await Text.create({ text: 'BEDROOM 1', font, size: 1 }, { atlas });
const second = await Text.create({ text: 'BEDROOM 2', font, size: 1 }, { atlas });
const a = createSlugGLSLMesh(first.gpuData, { color: { r: 0, g: 0, b: 0 } });
const b = createSlugGLSLMesh(second.gpuData, { color: { r: 0, g: 0, b: 0 } });
scene.add(a.mesh, b.mesh);
console.log(atlas.getStats());

// Remove the mesh from its scene before disposing it.
scene.remove(a.mesh);
a.dispose(); // b still owns the shared GPU textures
first.dispose();
scene.remove(b.mesh);
b.dispose(); // last mesh releases the GPU textures
second.dispose();
```

`Text.update()` preserves the atlas. To display an update, replace and dispose
the old mesh adapter as usual. The atlas keys include font identity, variation
instance, scale and glyph ID. Different sizes currently have separate entries;
positions, label strings and colors do not. Font buffers should be reused rather
than fetched separately for each label.

## Ownership and limits

- The atlas is append-only. Existing geometry keeps valid curve/band addresses
  when new glyphs arrive. Only new glyphs are curve/band packed on a cache miss;
  existing texture rows are copied when the arrays grow. Hits only assemble label
  quads. Chunked GPU texture updates are a possible further optimization.
- GPU texture pairs are shared by mesh adapters and reference-counted. Updates
  are coalesced until a mesh is created or rendered. Each mesh refreshes its
  texture uniforms in `onBeforeRender`; preserve that callback when extending it.
- Atlas growth replaces GPU textures rather than resizing a live WebGL texture.
  Label geometry remains independent for transforms, picking and visibility.
- Defaults: 4,096 unique glyph/size/variation entries and 16 MiB of texture data.
  `maxGlyphs` and `maxTextureBytes` are configurable. Exceeding either throws
  before changing the atlas; start a new atlas/page rather than evicting entries
  still referenced by live geometry. A label supports at most 16,384 quads.
- There is no global atlas or CPU eviction. Drop the atlas and text results with
  the sheet; their CPU data is garbage-collected. Disposing all adapters frees
  GPU resources even if the CPU atlas is retained for reuse.
- Sharing reduces storage and uploads, not draw calls or per-pixel curve work.
  Outlines use eight offset evaluations of the Slug coverage shader, with
  expanded glyph quads. `outlineWidth` is a diameter in text-space coordinates;
  `outlineColor` and optional `fragmentDeclarations`/`fragmentBody` let an
  application style the fill independently. Do not enable outlines for dense
  sheets before measuring GPU time on the target hardware.
- The GLSL application hook runs after premultiplied fill/stroke coverage is
  computed. It can access `fillColor` and `outColor`; sampler uniforms can be
  passed through `uniforms`. Avoid writing RGB outside the covered glyph since
  transparent pixels are discarded before the hook. Higharc's adapter is in
  `product/packages/gfx/threeTextVectorMaterial.ts`.

## Build and test

From a sibling checkout such as `~/src/higharc/three-text`:

```sh
npm ci
npm test
npx tsc --noEmit
npm run test:build
npm run test:artifact
npx playwright install chromium
npm run test:browser
npm run profile:gpu -- --font ../product/apps/web/public/static/fonts/Arial/ARIALN.TTF
npm pack --pack-destination ../product/packages/custom
```

`test:build` runs the Rollup build and checks its outputs. `test:artifact` exercises
the built public ESM and CommonJS exports with real HarfBuzz, compares standalone
and shared layouts, and reports resources for 200 labels. An optional font path
can be supplied: `npm run test:artifact -- /absolute/path/to/font.ttf`.

`test:browser` runs Chromium/WebGL2, compares standalone and shared pixels
including rotation/zoom and atlas growth after upload, and checks actual GPU
texture counts, color changes, final disposal and reuse. It saves a screenshot
under `test-artifacts/`. To test the package installed in Higharc with Higharc's
Three.js and fonts, run from this checkout:

`profile:gpu` uses `EXT_disjoint_timer_query_webgl2` around 32 frames after 12
warmup frames, and reports medians of GPU elapsed and CPU submit times for 200
fill-only and outlined labels at 1200×800. Software SwiftShader timings are
diagnostic; rerun on target hardware for a production cutover decision.

```sh
npm run test:browser -- \
  --package ../product/node_modules/three-text \
  --three ../product/node_modules/three \
  --font ../product/apps/web/public/static/fonts/Arial/ARIALN.TTF \
  --font ../product/apps/web/public/static/fonts/Circular/Circular.otf \
  --font ../product/apps/web/public/static/fonts/Source_Serif_4/SourceSerif4-Regular.ttf.woff
```

For 200 `BEDROOM n` labels in Arial Narrow at size 1, shared textures use 131,072
bytes (16 unique glyphs) instead of 26,214,400 bytes, and two GPU textures instead
of 400. Geometry is 658,416 bytes / 7,568 vertices in both cases. These are
fill-only resource measurements, not GPU frame-time results. Nimbus Sans uses
196,608 shared texture bytes for the same strings; allocation depends on the font.

In `product`, set the root dependency to
`file:packages/custom/three-text-0.6.5-higharc.1.tgz`, run `yarn install`, and stage
the tarball with `git add -f` (the custom-package path is covered by Git LFS).
Keep the package version, fork commit and tarball provenance together when
updating the package. There is no need to publish to the public npm registry.
