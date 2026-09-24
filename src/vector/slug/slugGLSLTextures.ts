// @ts-ignore - three is a peer dependency
import * as THREE from 'three';
import type { SlugGPUData, SlugSharedTextures } from './types';

interface TexturePair {
  curve: THREE.DataTexture;
  band: THREE.DataTexture;
}

interface SharedEntry {
  pair: TexturePair;
  version: number;
  references: number;
}

const sharedEntries = new WeakMap<SlugSharedTextures, SharedEntry>();

function createTextures(
  data: Pick<SlugGPUData, 'curveTexture' | 'bandTexture'>
): TexturePair {
  const curve = new THREE.DataTexture(
    data.curveTexture.data,
    data.curveTexture.width,
    data.curveTexture.height,
    THREE.RGBAFormat,
    THREE.FloatType
  );
  const band = new THREE.DataTexture(
    data.bandTexture.data,
    data.bandTexture.width,
    data.bandTexture.height,
    THREE.RGBAIntegerFormat,
    THREE.UnsignedIntType
  );
  band.internalFormat = 'RGBA32UI';
  for (const texture of [curve, band]) {
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
  }
  return { curve, band };
}

function disposeTextures(pair: TexturePair): void {
  pair.curve.dispose();
  pair.band.dispose();
}

export function acquireSlugGLSLTextures(data: SlugGPUData): {
  sync(): TexturePair;
  release(): void;
} {
  const shared = data.sharedTextures;
  let entry = shared ? sharedEntries.get(shared) : undefined;
  if (!entry) {
    entry = {
      pair: createTextures(shared ?? data),
      version: shared?.version ?? 0,
      references: 0
    };
    if (shared) {
      sharedEntries.set(shared, entry);
    }
  }
  const resource = entry;
  resource.references++;
  let released = false;
  return {
    sync() {
      if (released) {
        throw new Error('Slug texture lease has been released');
      }
      if (shared && resource.version !== shared.version) {
        // Texture dimensions can grow. Replace the pair rather than resizing a
        // live WebGL texture; every mesh refreshes its uniforms before drawing.
        const next = createTextures(shared);
        disposeTextures(resource.pair);
        resource.pair = next;
        resource.version = shared.version;
      }
      return resource.pair;
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      resource.references--;
      if (resource.references === 0) {
        disposeTextures(resource.pair);
        if (shared) {
          sharedEntries.delete(shared);
        }
      }
    }
  };
}
