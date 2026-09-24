import { packSlugData } from './SlugPacker';
import type { SlugGPUData, SlugShape, SlugSharedTextures } from './types';

export interface SlugAtlasOptions {
  maxGlyphs?: number;
  maxTextureBytes?: number;
}

/** Append-only glyph storage. Share one atlas across labels with the same lifetime. */
export class SlugAtlas {
  private readonly shapes: SlugShape[] = [];
  private readonly indicesByKey = new Map<string | number, number>();
  private packed: SlugGPUData = packSlugData([]);
  private readonly maxGlyphs: number;
  private readonly maxTextureBytes: number;
  readonly textures: SlugSharedTextures = {
    curveTexture: this.packed.curveTexture,
    bandTexture: this.packed.bandTexture,
    version: 0
  };

  constructor(options: SlugAtlasOptions = {}) {
    this.maxGlyphs = options.maxGlyphs ?? 4096;
    this.maxTextureBytes = options.maxTextureBytes ?? 16 * 1024 * 1024;
    if (
      !Number.isInteger(this.maxGlyphs) ||
      this.maxGlyphs < 1 ||
      this.maxGlyphs > 16384
    ) {
      throw new RangeError('SlugAtlas maxGlyphs must be between 1 and 16384');
    }
    if (
      !Number.isFinite(this.maxTextureBytes) ||
      this.maxTextureBytes < 128 * 1024
    ) {
      throw new RangeError(
        'SlugAtlas maxTextureBytes must be at least 128 KiB'
      );
    }
  }

  getStats(): { glyphCount: number; textureBytes: number; version: number } {
    return {
      glyphCount: this.shapes.length,
      textureBytes:
        this.textures.curveTexture.data.byteLength +
        this.textures.bandTexture.data.byteLength,
      version: this.textures.version
    };
  }

  /** Keys must include font identity, variation and scale; equal keys mean identical local curves. */
  pack(shapes: SlugShape[]): SlugGPUData {
    if (shapes.length > 16384) {
      throw new RangeError('Slug text exceeds the 16-bit quad index limit');
    }
    const additions = new Map<string | number, SlugShape>();
    for (const shape of shapes) {
      if (shape.key === undefined) {
        throw new Error('Shared Slug shapes require a key');
      }
      if (!this.indicesByKey.has(shape.key) && !additions.has(shape.key)) {
        additions.set(shape.key, shape);
      }
    }
    if (this.shapes.length + additions.size > this.maxGlyphs) {
      throw new RangeError(
        'SlugAtlas glyph budget exceeded; use another atlas'
      );
    }
    if (additions.size > 0) {
      const nextShapes = [...this.shapes, ...additions.values()];
      const next = packSlugData(nextShapes);
      if (
        next.curveTexture.data.byteLength + next.bandTexture.data.byteLength >
        this.maxTextureBytes
      ) {
        throw new RangeError(
          'SlugAtlas texture budget exceeded; use another atlas'
        );
      }
      // Appending preserves both curve and band addresses. Never evict or reorder
      // entries: existing meshes hold those addresses in their vertex attributes.
      for (const [key, shape] of additions) {
        this.indicesByKey.set(key, this.shapes.length);
        this.shapes.push(shape);
      }
      this.packed = next;
      Object.assign(this.textures.curveTexture, next.curveTexture);
      Object.assign(this.textures.bandTexture, next.bandTexture);
      this.textures.version++;
    }

    const vertices = new Float32Array(shapes.length * 80);
    const indices = new Uint16Array(shapes.length * 6);
    for (let index = 0; index < shapes.length; index++) {
      const shape = shapes[index];
      const packedIndex = this.indicesByKey.get(shape.key as string | number);
      if (packedIndex === undefined) {
        throw new Error('Missing shared Slug glyph');
      }
      vertices.set(
        this.packed.vertices.subarray(packedIndex * 80, (packedIndex + 1) * 80),
        index * 80
      );
      const [minX, minY, maxX, maxY] = shape.bounds;
      for (let corner = 0; corner < 4; corner++) {
        const offset = index * 80 + corner * 20;
        vertices[offset] = corner === 0 || corner === 3 ? minX : maxX;
        vertices[offset + 1] = corner < 2 ? minY : maxY;
      }
      const base = index * 4;
      indices.set(
        [base, base + 1, base + 2, base, base + 2, base + 3],
        index * 6
      );
    }
    return {
      curveTexture: this.textures.curveTexture,
      bandTexture: this.textures.bandTexture,
      vertices,
      indices,
      shapeCount: shapes.length,
      sharedTextures: this.textures
    };
  }
}
