import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Text, SlugAtlas } from '../src/vector/core';
import type { VectorTextResult } from '../src/vector/core';

function buffer(path: string): ArrayBuffer {
  const bytes = readFileSync(new URL(path, import.meta.url));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );
}

const font = buffer('../examples/fonts/NimbusSanL-Reg.woff');
beforeAll(async () => {
  Text.setHarfBuzzBuffer(buffer('../node_modules/harfbuzzjs/hb.wasm'));
  await Text.init();
});

describe('shared atlas with real fonts', () => {
  it('shares across 200 labels without changing layout or geometry', async () => {
    const atlas = new SlugAtlas();
    const results: VectorTextResult[] = [];
    for (let index = 1; index <= 200; index++) {
      const options = {
        text: `BEDROOM ${index}`,
        font,
        size: 1,
        layout: { hyphenate: false }
      };
      const shared = await Text.create(options, { atlas });
      const standalone = await Text.create(options);
      expect(shared.planeBounds).toEqual(standalone.planeBounds);
      expect(shared.glyphs).toEqual(standalone.glyphs);
      expect(shared.gpuData.indices).toEqual(standalone.gpuData.indices);
      // Glyph addresses differ, but quad positions and local shader coordinates must agree.
      for (
        let offset = 0;
        offset < shared.gpuData.vertices.length;
        offset += 20
      ) {
        expect(shared.gpuData.vertices.slice(offset, offset + 6)).toEqual(
          standalone.gpuData.vertices.slice(offset, offset + 6)
        );
      }
      results.push(shared);
      standalone.dispose();
    }
    expect(atlas.getStats().glyphCount).toBe(16);
    expect(atlas.getStats().textureBytes).toBeLessThan(1024 * 1024);
    expect(
      new Set(results.map((result) => result.gpuData.curveTexture)).size
    ).toBe(1);
    expect(
      new Set(results.map((result) => result.gpuData.bandTexture)).size
    ).toBe(1);
    for (const result of results) result.dispose();
  });

  it('separates sizes and preserves the atlas through updates and sibling disposal', async () => {
    const atlas = new SlugAtlas();
    const a = await Text.create({ text: 'A', font, size: 1 }, { atlas });
    const b = await Text.create({ text: 'A', font, size: 2 }, { atlas });
    expect(atlas.getStats().glyphCount).toBe(2);
    const updated = await a.update({ text: 'AB' });
    expect(updated.gpuData.sharedTextures).toBe(b.gpuData.sharedTextures);
    expect(atlas.getStats().glyphCount).toBe(3);
    updated.dispose();
    const again = await b.update({ text: 'ABC' });
    expect(again.gpuData.shapeCount).toBe(3);
    expect(atlas.getStats().glyphCount).toBe(5);
    again.dispose();
  });

  it('does not alias glyph IDs from different fonts or variation instances', async () => {
    const atlas = new SlugAtlas();
    const variable = buffer(
      '../examples/fonts/Merriweather-VariableFont_opsz,wdth,wght.woff'
    );
    const a = await Text.create({ text: 'A', font, size: 1 }, { atlas });
    const b = await Text.create(
      { text: 'A', font: variable, size: 1, fontVariations: { wght: 400 } },
      { atlas }
    );
    const c = await Text.create(
      { text: 'A', font: variable, size: 1, fontVariations: { wght: 900 } },
      { atlas }
    );
    expect(atlas.getStats().glyphCount).toBe(3);
    const d = await Text.create(
      { text: 'A', font: variable, size: 1, fontVariations: { wght: 400 } },
      { atlas }
    );
    expect(atlas.getStats().glyphCount).toBe(3);
    for (const result of [a, b, c, d]) result.dispose();
  });
});
