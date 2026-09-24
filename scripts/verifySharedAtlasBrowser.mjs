import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, sep, basename, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({
  options: {
    package: { type: 'string', default: '.' },
    three: { type: 'string', default: 'node_modules/three' },
    font: { type: 'string', multiple: true },
    profile: { type: 'boolean', default: false }
  }
});
const fonts = values.font ?? [
  'examples/fonts/NimbusSanL-Reg.woff',
  'examples/fonts/Merriweather-VariableFont_opsz,wdth,wght.woff'
];
const roots = {
  '/package/': resolve(values.package),
  '/three/': resolve(values.three),
  '/test/': resolve('test/browser')
};
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(
      new URL(req.url, 'http://localhost').pathname
    );
    if (path === '/config.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          fonts: fonts.map((font, index) => ({
            name: basename(font),
            url: `/font/${index}`
          }))
        })
      );
      return;
    }
    let file;
    if (/^\/font\/\d+$/.test(path)) {
      file = resolve(fonts[Number(path.slice(6))]);
    } else if (path === '/hb.wasm') {
      file = resolve('node_modules/harfbuzzjs/hb.wasm');
    } else {
      const prefix = Object.keys(roots).find((prefix) =>
        path.startsWith(prefix)
      );
      if (!prefix) {
        res.writeHead(404).end();
        return;
      }
      file = resolve(roots[prefix], path.slice(prefix.length));
      if (!file.startsWith(roots[prefix] + sep)) {
        res.writeHead(403).end();
        return;
      }
    }
    const mime = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.wasm': 'application/wasm'
    };
    res.setHeader(
      'Content-Type',
      mime[extname(file)] ?? 'application/octet-stream'
    );
    res.end(await readFile(file));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 }
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(
    `http://127.0.0.1:${server.address().port}/test/${values.profile ? 'profile.html' : 'shared-atlas.html'}`
  );
  await page.waitForFunction(() => window.atlasProof || window.atlasError, {
    timeout: 120000
  });
  const result = await page.evaluate(() => ({
    result: window.atlasProof,
    error: window.atlasError
  }));
  assert.deepEqual(errors, []);
  assert.equal(result.error, undefined);
  await mkdir('test-artifacts', { recursive: true });
  if (!values.profile) {
    await page.screenshot({ path: 'test-artifacts/shared-slug.png' });
  }
  console.log(JSON.stringify(result.result, null, 2));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
