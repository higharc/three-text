import { Text, SlugAtlas } from 'three-text/vector/core';
import { createSlugGLSLMesh } from 'three-text/vector';
import { WebGLRenderer, Scene, Color, OrthographicCamera } from 'three';

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(renderer, scene, camera, extension) {
  const gl = renderer.getContext();
  for (let index = 0; index < 12; index++) renderer.render(scene, camera);
  const gpu = [];
  const cpuSubmit = [];
  for (let index = 0; index < 32; index++) {
    const query = extension ? gl.createQuery() : null;
    if (query) gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
    const start = performance.now();
    renderer.render(scene, camera);
    cpuSubmit.push(performance.now() - start);
    if (query) {
      gl.endQuery(extension.TIME_ELAPSED_EXT);
      const deadline = performance.now() + 15000;
      while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        if (performance.now() > deadline)
          throw new Error('GPU query timed out');
        await new Promise((done) => setTimeout(done, 2));
      }
      if (gl.getParameter(extension.GPU_DISJOINT_EXT))
        throw new Error('GPU timing disjoint');
      gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(query);
    }
  }
  return {
    gpuMedianMs: gpu.length ? median(gpu) : null,
    cpuSubmitMedianMs: median(cpuSubmit),
    samples: gpu.length,
    draws: renderer.info.render.calls
  };
}

async function main() {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setSize(1200, 800);
  renderer.setPixelRatio(1);
  document.body.append(renderer.domElement);
  const camera = new OrthographicCamera(-1, 69, 1, -25, 0.1, 100);
  camera.position.z = 10;
  const gl = renderer.getContext();
  const extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  Text.setHarfBuzzBuffer(await (await fetch('/hb.wasm')).arrayBuffer());
  const fontUrl = (await (await fetch('/config.json')).json()).fonts[0].url;
  const font = await (await fetch(fontUrl)).arrayBuffer();
  const atlas = new SlugAtlas();
  const results = [];
  for (const outlineWidth of [0, 0.05]) {
    const scene = new Scene();
    scene.background = new Color('white');
    const resources = [];
    for (let index = 0; index < 200; index++) {
      const result = await Text.create(
        {
          text: `BEDROOM ${index + 1}`,
          font,
          size: 1,
          layout: { hyphenate: false }
        },
        { atlas }
      );
      const adapter = createSlugGLSLMesh(result.gpuData, {
        color: { r: 0, g: 0, b: 0 },
        outlineWidth,
        outlineColor: { r: 0, g: 0, b: 0 }
      });
      adapter.mesh.position.set(
        (index % 10) * 7,
        -Math.floor(index / 10) * 1.25,
        0
      );
      scene.add(adapter.mesh);
      resources.push({ result, adapter });
    }
    results.push({
      outlineWidth,
      ...(await measure(renderer, scene, camera, extension))
    });
    for (const { result, adapter } of resources) {
      scene.remove(adapter.mesh);
      adapter.dispose();
      result.dispose();
    }
  }
  window.atlasProof = {
    renderer: gl.getParameter(gl.RENDERER),
    timingExtension: Boolean(extension),
    viewport: [1200, 800],
    labels: 200,
    warmupFrames: 12,
    measuredFrames: 32,
    results,
    glError: gl.getError()
  };
  renderer.dispose();
}
main().catch((error) => {
  console.error(error);
  window.atlasError = String(error);
});
