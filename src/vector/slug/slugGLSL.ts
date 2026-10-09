// Slug adapter using Three.js RawShaderMaterial (GLSL)
// Works with any Three.js renderer (WebGL or WebGPU via transpilation)
//
// Supports GLSL animation injection and native Uint32 band textures
// No vertex dilation; may clip at sub-pixel edges under extreme zoom

// @ts-ignore - three is a peer dependency
import * as THREE from 'three';

import type { SlugGPUData } from './types';
import { unpackSlugVertices } from './unpackVertices';
import { fragmentShaderGLSL300 } from './shaderStrings';
import { acquireSlugGLSLTextures } from './slugGLSLTextures';

// Three.js GLSL3 mode prepends #version 300 es, so strip it from the raw shader
const fragShader = fragmentShaderGLSL300.replace(
  /^#version\s+300\s+es\s*\n/,
  ''
);

export interface SlugGLSLMeshOptions {
  color?: { r: number; g: number; b: number };
  /** Outline diameter in the same coordinates as the text size. */
  outlineWidth?: number;
  outlineColor?: { r: number; g: number; b: number };
  /** Additional GLSL 300 ES declarations and main-body code for application materials. */
  fragmentDeclarations?: string;
  fragmentBody?: string;
  /** Runs on the outline pass, before the fill pass draws over all glyphs. */
  outlineFragmentBody?: string;
  // GLSL preamble injected before main(): uniforms, helpers, etc
  animationDeclarations?: string;
  // GLSL body injected inside main(), must write `outPos` (vec3)
  animationBody?: string;
  // Initial values for animation uniforms declared in animationDeclarations
  uniforms?: Record<string, THREE.IUniform>;
  // Enable rotated RGSS-4 adaptive supersampling (4 samples per pixel)
  adaptiveSupersampling?: boolean;
}

export interface SlugGLSLMesh {
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
  setOffset(x: number, y: number, z?: number): void;
  setColor(r: number, g: number, b: number): void;
  dispose(): void;
}

function buildVertexShader(options?: SlugGLSLMeshOptions): string {
  const decl = options?.animationDeclarations ?? '';
  const body = options?.animationBody ?? 'vec3 outPos = position;';

  return `precision highp float;
precision highp int;

in vec3 position;
in vec2 slugTexcoord;
in vec4 slugBanding;
in vec4 slugGlyph;
in vec4 slugColor;
in vec3 glyphCenter;
in float glyphIndex;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float time;
uniform vec4 u_color;
${decl}

out vec2 v_texcoord;
flat out vec4 v_banding;
flat out ivec4 v_glyph;
out vec4 v_color;

void main() {
    v_texcoord = slugTexcoord;
    v_banding = slugBanding;
    v_glyph = ivec4(slugGlyph);
    v_color = slugColor * u_color;

    ${body}

    gl_Position = projectionMatrix * modelViewMatrix * vec4(outPos, 1.0);
}
`;
}

export function createSlugGLSLMesh(
  gpuData: SlugGPUData,
  options?: SlugGLSLMeshOptions
): SlugGLSLMesh {
  const outlineWidth = options?.outlineWidth ?? 0;
  if (!Number.isFinite(outlineWidth) || outlineWidth < 0) {
    throw new RangeError('Slug outlineWidth must be finite and nonnegative');
  }
  const attrs = unpackSlugVertices(gpuData);
  if (outlineWidth > 0) {
    const radius = outlineWidth / 2;
    for (let index = 0; index < attrs.positions.length / 3; index++) {
      const corner = index % 4;
      const x = corner === 0 || corner === 3 ? -radius : radius;
      const y = corner < 2 ? -radius : radius;
      attrs.positions[index * 3] += x;
      attrs.positions[index * 3 + 1] += y;
      attrs.texcoords[index * 2] += x;
      attrs.texcoords[index * 2 + 1] += y;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(attrs.positions, 3)
  );
  geo.setAttribute(
    'slugTexcoord',
    new THREE.Float32BufferAttribute(attrs.texcoords, 2)
  );
  geo.setAttribute(
    'slugBanding',
    new THREE.Float32BufferAttribute(attrs.bandings, 4)
  );
  geo.setAttribute(
    'slugGlyph',
    new THREE.Float32BufferAttribute(attrs.glyphData, 4)
  );
  geo.setAttribute(
    'slugColor',
    new THREE.Float32BufferAttribute(attrs.colors, 4)
  );
  geo.setAttribute(
    'glyphCenter',
    new THREE.Float32BufferAttribute(attrs.glyphCenters, 3)
  );
  geo.setAttribute(
    'glyphIndex',
    new THREE.Float32BufferAttribute(attrs.glyphIndices, 1)
  );
  geo.setIndex(new THREE.BufferAttribute(gpuData.indices, 1));

  const textures = acquireSlugGLSLTextures(gpuData);
  const pair = textures.sync();

  const col = options?.color ?? { r: 1, g: 1, b: 1 };
  const outlineColor = options?.outlineColor ?? col;
  const colorUniform = new THREE.Vector4(col.r, col.g, col.b, 1.0);

  const uniforms: Record<string, THREE.IUniform> = {
    curveTexture: { value: pair.curve },
    bandTexture: { value: pair.band },
    time: { value: 0 },
    u_color: { value: colorUniform },
    u_outlineRadius: { value: outlineWidth / 2 },
    u_outlineColor: {
      value: new THREE.Color().setRGB(
        outlineColor.r,
        outlineColor.g,
        outlineColor.b
      )
    },
    ...options?.uniforms
  };

  function makeMaterial(outline: boolean): THREE.RawShaderMaterial {
    const fragmentBody = outline
      ? `if (coverage >= 1.0) discard;
        float outer = coverage;
        for (int sampleIndex = 0; sampleIndex < 8; sampleIndex++) {
            float angle = float(sampleIndex) * 0.7853981633974483;
            outer = max(outer, SlugRender(v_texcoord + u_outlineRadius * vec2(cos(angle), sin(angle)), v_banding, v_glyph));
        }
        outColor = vec4(u_outlineColor.rgb * (outer - coverage), outer - coverage);
        if (outColor.a <= 0.0) discard;
        ${options?.outlineFragmentBody ?? ''}`
      : `outColor = fillColor;
        if (outColor.a <= 0.0) discard;
        ${options?.fragmentBody ?? ''}`;
    const frag = `${options?.adaptiveSupersampling ? '#define SLUG_ADAPTIVE_SUPERSAMPLE\n' : ''}
${fragShader
  .replace(
    'void main() {',
    `${options?.fragmentDeclarations ?? ''}\nvoid main() {`
  )
  .replace(
    '    outColor = v_color * coverage;',
    `    vec4 fillColor = v_color * coverage;\n    ${fragmentBody}`
  )}`;
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms,
      vertexShader: buildVertexShader(options),
      fragmentShader: frag,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
  }

  const fillMaterial = makeMaterial(false);
  let outlineMaterial: THREE.RawShaderMaterial | undefined;
  if (outlineWidth > 0) {
    outlineMaterial = makeMaterial(true);
    // Draw every outline before any fill; a later glyph's stroke must not cover
    // the face of an earlier glyph in the same text mesh.
    geo.addGroup(0, gpuData.indices.length, 0);
    geo.addGroup(0, gpuData.indices.length, 1);
  }
  const mesh = new THREE.Mesh(
    geo,
    outlineMaterial ? [outlineMaterial, fillMaterial] : fillMaterial
  );
  mesh.onBeforeRender = () => {
    const pair = textures.sync();
    uniforms.curveTexture.value = pair.curve;
    uniforms.bandTexture.value = pair.band;
  };
  let disposed = false;

  return {
    mesh,
    uniforms,
    setOffset(x: number, y: number, z = 0) {
      mesh.position.set(x, y, z);
    },
    setColor(r: number, g: number, b: number) {
      colorUniform.set(r, g, b, 1.0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      geo.dispose();
      outlineMaterial?.dispose();
      fillMaterial.dispose();
      textures.release();
    }
  };
}
