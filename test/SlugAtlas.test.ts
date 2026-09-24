import { describe, expect, it } from 'vitest';
import { SlugAtlas } from '../src/vector/slug/SlugAtlas';
import { packSlugData } from '../src/vector/slug/SlugPacker';
import { acquireSlugGLSLTextures } from '../src/vector/slug/slugGLSLTextures';
import { createSlugGLSLMesh } from '../src/vector/slug/slugGLSL';
import type { SlugShape } from '../src/vector/slug/types';

function triangle(key: string, x = 0): SlugShape {
  return {
    key,
    bounds: [x, 0, x + 1, 1],
    curves: [
      { p1: [x, 0], p2: [x + 0.5, 0], p3: [x + 1, 0] },
      { p1: [x + 1, 0], p2: [x + 0.5, 0.5], p3: [x, 1] },
      { p1: [x, 1], p2: [x, 0.5], p3: [x, 0] }
    ]
  };
}

describe('shared Slug atlas', () => {
  it('shares glyph data across independently placed labels', () => {
    const atlas = new SlugAtlas();
    const first = atlas.pack([triangle('a')]);
    const next = atlas.pack([triangle('a', 10), triangle('a', 20)]);
    const standalone = packSlugData([triangle('a', 10), triangle('a', 20)]);
    expect(next.vertices).toEqual(standalone.vertices);
    expect(next.indices).toEqual(standalone.indices);
    expect(next.curveTexture).toBe(first.curveTexture);
    expect(next.bandTexture).toBe(first.bandTexture);
    expect(atlas.getStats()).toEqual({
      glyphCount: 1,
      textureBytes: 131072,
      version: 1
    });
  });

  it('keeps existing addresses and vertices stable when textures grow', () => {
    const atlas = new SlugAtlas();
    const first = atlas.pack([triangle('a')]);
    const vertices = first.vertices.slice();
    const curves = first.curveTexture.data.slice(0, 24);
    const headers = first.bandTexture.data.slice(0, 128);
    atlas.pack(
      Array.from({ length: 200 }, (_, index) => triangle(`new-${index}`))
    );
    expect(first.bandTexture.height).toBeGreaterThan(1);
    expect(first.vertices).toEqual(vertices);
    expect(first.curveTexture.data.slice(0, 24)).toEqual(curves);
    expect(first.bandTexture.data.slice(0, 128)).toEqual(headers);
    expect(atlas.pack([triangle('a')]).vertices).toEqual(vertices);
  });

  it('fails atomically when a glyph or byte budget is exhausted', () => {
    for (const atlas of [
      new SlugAtlas({ maxGlyphs: 1 }),
      new SlugAtlas({ maxTextureBytes: 131072 })
    ]) {
      const first = atlas.pack([triangle('a')]);
      const stats = atlas.getStats();
      const curves = first.curveTexture.data;
      expect(() =>
        atlas.pack(
          Array.from({ length: 200 }, (_, index) => triangle(`new-${index}`))
        )
      ).toThrow(/budget/);
      expect(atlas.getStats()).toEqual(stats);
      expect(first.curveTexture.data).toBe(curves);
      expect(atlas.pack([triangle('a')]).vertices).toEqual(first.vertices);
    }
  });

  it('rejects unkeyed shapes and oversized index buffers', () => {
    const atlas = new SlugAtlas();
    expect(() => atlas.pack([{ ...triangle('a'), key: undefined }])).toThrow(
      /key/
    );
    expect(() => atlas.pack(new Array(16385).fill(triangle('a')))).toThrow(
      /index limit/
    );
    expect(atlas.pack([]).shapeCount).toBe(0);
  });

  it('shares GPU textures, replaces them on growth and releases the last reference', () => {
    const atlas = new SlugAtlas();
    const first = acquireSlugGLSLTextures(atlas.pack([triangle('a')]));
    const second = acquireSlugGLSLTextures(atlas.pack([triangle('a', 5)]));
    const old = first.sync();
    expect(second.sync()).toBe(old);
    let oldDisposals = 0;
    old.curve.addEventListener('dispose', () => oldDisposals++);
    old.band.addEventListener('dispose', () => oldDisposals++);
    atlas.pack(
      Array.from({ length: 200 }, (_, index) => triangle(`new-${index}`))
    );
    const grown = second.sync();
    expect(grown).not.toBe(old);
    expect(first.sync()).toBe(grown);
    expect(oldDisposals).toBe(2);
    let grownDisposals = 0;
    grown.curve.addEventListener('dispose', () => grownDisposals++);
    grown.band.addEventListener('dispose', () => grownDisposals++);
    first.release();
    first.release();
    expect(grownDisposals).toBe(0);
    expect(second.sync()).toBe(grown);
    second.release();
    expect(grownDisposals).toBe(2);
    const revived = acquireSlugGLSLTextures(atlas.pack([triangle('a')]));
    expect(revived.sync()).not.toBe(grown);
    revived.release();
  });

  it('keeps separate atlases independent and supports GLSL color and disposal', () => {
    const a = createSlugGLSLMesh(new SlugAtlas().pack([triangle('a')]), {
      color: { r: 0.2, g: 0.3, b: 0.4 }
    });
    const b = createSlugGLSLMesh(new SlugAtlas().pack([triangle('a')]));
    expect(a.uniforms.curveTexture.value).not.toBe(
      b.uniforms.curveTexture.value
    );
    a.setColor(1, 0, 0);
    expect(a.uniforms.u_color.value.toArray()).toEqual([1, 0, 0, 1]);
    const material = a.mesh.material as import('three').RawShaderMaterial;
    expect(material.vertexShader).toContain('slugColor * u_color');
    expect(material.premultipliedAlpha).toBe(true);
    a.dispose();
    a.dispose();
    b.dispose();
  });

  it('expands outlined quads without changing atlas coordinates or allocating stroke geometry', () => {
    const data = new SlugAtlas().pack([triangle('a')]);
    const plain = createSlugGLSLMesh(data);
    const stroke = createSlugGLSLMesh(data, {
      outlineWidth: 0.2,
      outlineColor: { r: 1, g: 0, b: 0 },
      fragmentDeclarations: 'uniform float custom;',
      fragmentBody: 'outColor.rgb *= custom;',
      uniforms: { custom: { value: 0.5 } }
    });
    expect(stroke.mesh.geometry.getAttribute('position').count).toBe(
      plain.mesh.geometry.getAttribute('position').count
    );
    expect(stroke.mesh.geometry.boundingBox).toBeNull();
    expect(stroke.mesh.geometry.getAttribute('position').getX(0)).toBeCloseTo(
      -0.1
    );
    expect(
      stroke.mesh.geometry.getAttribute('slugTexcoord').getX(0)
    ).toBeCloseTo(-0.1);
    expect(stroke.uniforms.u_outlineRadius.value).toBeCloseTo(0.1);
    expect(stroke.uniforms.custom.value).toBe(0.5);
    const material = stroke.mesh.material as import('three').RawShaderMaterial;
    expect(material.fragmentShader).toContain('uniform float custom;');
    expect(material.fragmentShader).toContain('outColor.rgb *= custom;');
    expect(material.fragmentShader).toContain('outer - coverage');
    plain.dispose();
    stroke.dispose();
    expect(() => createSlugGLSLMesh(data, { outlineWidth: -1 })).toThrow(
      RangeError
    );
  });
});
