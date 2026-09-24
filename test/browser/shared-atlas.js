import { Text, SlugAtlas } from 'three-text/vector/core';
import { createSlugGLSLMesh } from 'three-text/vector';
import { WebGLRenderer, Scene, Color, OrthographicCamera } from 'three';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function compare(a, b, context) {
  let changed = 0;
  let maxDelta = 0;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) changed++;
    maxDelta = Math.max(maxDelta, Math.abs(a[index] - b[index]));
  }
  check(
    changed === 0,
    `${context}: ${changed} changed channels, max delta ${maxDelta}`
  );
}

async function main() {
  const renderer = new WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true
  });
  renderer.setSize(1200, 800);
  document.body.append(renderer.domElement);
  const camera = new OrthographicCamera(-1, 69, 1, -25, 0.1, 100);
  camera.position.z = 10;
  const gl = renderer.getContext();
  const draw = (scene) => {
    renderer.render(scene, camera);
    const pixels = new Uint8Array(1200 * 800 * 4);
    gl.readPixels(0, 0, 1200, 800, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    check(gl.getError() === 0, 'WebGL error');
    check(
      pixels.some((value, index) => index % 4 !== 3 && value < 200),
      'No text rendered'
    );
    return pixels;
  };
  Text.setHarfBuzzBuffer(await (await fetch('/hb.wasm')).arrayBuffer());
  const { fonts } = await (await fetch('/config.json')).json();
  const reports = [];
  let preview;
  for (const { name, url } of fonts) {
    const font = await (await fetch(url)).arrayBuffer();
    const atlas = new SlugAtlas();
    const a = new Scene();
    const b = new Scene();
    a.background = b.background = new Color('white');
    const standalone = [];
    const shared = [];
    for (let index = 0; index < 200; index++) {
      const options = {
        text: `BEDROOM ${index + 1}`,
        font,
        size: 1,
        layout: { hyphenate: false }
      };
      for (const [scene, items, vectorOptions] of [
        [a, standalone, undefined],
        [b, shared, { atlas }]
      ]) {
        const result = await Text.create(options, vectorOptions);
        const adapter = createSlugGLSLMesh(result.gpuData, {
          color: { r: 0, g: 0, b: 0 }
        });
        adapter.mesh.position.set(
          (index % 10) * 7,
          -Math.floor(index / 10) * 1.25,
          0
        );
        scene.add(adapter.mesh);
        items.push({ result, adapter });
      }
    }
    const reference = draw(a);
    check(
      renderer.info.memory.textures === 400,
      'Expected 400 standalone GPU textures'
    );
    compare(reference, draw(b), `${name}: shared vs standalone`);
    check(
      renderer.info.memory.textures === 402,
      'Expected only two additional atlas GPU textures'
    );

    for (const items of [standalone, shared]) {
      for (const { adapter } of items) adapter.mesh.rotation.z = 0.15;
    }
    camera.zoom = 1.5;
    camera.updateProjectionMatrix();
    compare(draw(a), draw(b), `${name}: rotated and zoomed`);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    for (const { adapter } of shared) adapter.mesh.rotation.z = 0;
    for (const { adapter, result } of standalone) {
      a.remove(adapter.mesh);
      adapter.dispose();
      result.dispose();
    }
    check(
      renderer.info.memory.textures === 2,
      'Standalone disposal must retain shared textures'
    );
    const initial = atlas.getStats();

    // Grow after the first GPU upload, including texture-height changes.
    for (let size = 2; size <= 6; size++) {
      const extra = await Text.create(
        {
          text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
          font,
          size
        },
        { atlas }
      );
      extra.dispose();
    }
    check(
      atlas.getStats().textureBytes > initial.textureBytes,
      'Atlas did not grow'
    );
    compare(reference, draw(b), `${name}: existing labels after atlas growth`);
    check(renderer.info.memory.textures === 2, 'Growth leaked GPU textures');

    shared[0].adapter.setColor(0.1, 0.3, 0.7);
    const colored = draw(b);
    check(
      colored.some(
        (value, index) => index % 4 === 2 && value > colored[index - 2] + 40
      ),
      'setColor has no effect'
    );
    shared[0].adapter.setColor(0, 0, 0);
    compare(reference, draw(b), `${name}: color reset`);
    preview = document.createElement('canvas');
    preview.width = 1200;
    preview.height = 800;
    preview.getContext('2d').drawImage(renderer.domElement, 0, 0);

    for (const { result, adapter } of shared.slice(0, -1)) {
      b.remove(adapter.mesh);
      adapter.dispose();
      adapter.dispose();
      result.dispose();
    }
    draw(b);
    check(
      renderer.info.memory.textures === 2,
      'Disposing siblings freed the surviving mesh textures'
    );
    const last = shared[shared.length - 1];
    b.remove(last.adapter.mesh);
    last.adapter.dispose();
    last.result.dispose();
    check(
      renderer.info.memory.textures === 0,
      'Last disposal leaked GPU textures'
    );
    check(renderer.info.memory.geometries === 0, 'Disposal leaked geometry');

    // Reuse a retained CPU atlas after every GPU lease has been released.
    const revived = await Text.create(
      { text: 'BEDROOM 200', font, size: 1 },
      { atlas }
    );
    const mesh = createSlugGLSLMesh(revived.gpuData, {
      color: { r: 0, g: 0, b: 0 }
    });
    b.add(mesh.mesh);
    draw(b);
    check(
      renderer.info.memory.textures === 2,
      'Atlas reuse did not recreate textures'
    );
    b.remove(mesh.mesh);
    mesh.dispose();
    revived.dispose();
    check(renderer.info.memory.textures === 0, 'Atlas reuse leaked textures');
    reports.push({
      font: name,
      initial,
      afterGrowth: atlas.getStats(),
      sharedTextureObjects: 2,
      standaloneTextureObjects: 400,
      pixelDifferences: 0,
      leakedTextures: renderer.info.memory.textures
    });
  }
  document.getElementById('status').textContent =
    'PASS: shared/standalone pixels match, growth and disposal verified';
  renderer.domElement.replaceWith(preview);
  renderer.dispose();
  window.atlasProof = { reports, glError: gl.getError() };
}
main().catch((error) => {
  console.error(error);
  window.atlasError = String(error);
  document.getElementById('status').textContent = String(error);
});
