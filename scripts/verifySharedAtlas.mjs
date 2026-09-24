import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fontBytes = readFileSync(
  process.argv[2] ??
    new URL('../examples/fonts/NimbusSanL-Reg.woff', import.meta.url)
);
const font = fontBytes.buffer.slice(
  fontBytes.byteOffset,
  fontBytes.byteOffset + fontBytes.byteLength
);
const wasmBytes = readFileSync(require.resolve('harfbuzzjs/hb.wasm'));
const wasm = wasmBytes.buffer.slice(
  wasmBytes.byteOffset,
  wasmBytes.byteOffset + wasmBytes.byteLength
);

for (const format of ['esm', 'cjs']) {
  const { Text, SlugAtlas } =
    format === 'esm'
      ? await import('three-text/vector/core')
      : require('three-text/vector/core');
  const { createSlugGLSLMesh } =
    format === 'esm'
      ? await import('three-text/vector')
      : require('three-text/vector');
  Text.setHarfBuzzBuffer(wasm);
  await Text.init();
  const atlas = new SlugAtlas();
  const shared = [];
  const standalone = [];
  for (let index = 1; index <= 200; index++) {
    const options = {
      text: `BEDROOM ${index}`,
      font,
      size: 1,
      layout: { hyphenate: false }
    };
    const a = await Text.create(options, { atlas });
    const b = await Text.create(options);
    assert.deepEqual(a.planeBounds, b.planeBounds);
    assert.deepEqual(a.glyphs, b.glyphs);
    shared.push({ result: a, adapter: createSlugGLSLMesh(a.gpuData) });
    standalone.push({ result: b, adapter: createSlugGLSLMesh(b.gpuData) });
  }
  for (const [mode, items] of [
    ['standalone', standalone],
    ['shared', shared]
  ]) {
    const textures = new Set();
    let geometryBytes = 0;
    let vertices = 0;
    for (const { adapter } of items) {
      adapter.mesh.onBeforeRender();
      textures.add(adapter.uniforms.curveTexture.value);
      textures.add(adapter.uniforms.bandTexture.value);
      const geometry = adapter.mesh.geometry;
      for (const attribute of Object.values(geometry.attributes))
        geometryBytes += attribute.array.byteLength;
      geometryBytes += geometry.index.array.byteLength;
      vertices += geometry.getAttribute('position').count;
    }
    assert.equal(textures.size, mode === 'shared' ? 2 : 400);
    const textureBytes = [...textures].reduce(
      (sum, texture) => sum + texture.image.data.byteLength,
      0
    );
    console.log(
      JSON.stringify({
        format,
        mode,
        labels: items.length,
        vertices,
        geometryBytes,
        textures: textures.size,
        textureBytes
      })
    );
    for (const { result, adapter } of items) {
      adapter.dispose();
      result.dispose();
    }
  }
  assert.equal(atlas.getStats().glyphCount, 16);
  console.log(JSON.stringify({ format, atlas: atlas.getStats() }));
}
