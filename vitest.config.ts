import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [
    {
      name: 'shader-strings',
      load(id) {
        if (/\.(glsl|wgsl)$/.test(id)) {
          return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
        }
      }
    }
  ],
  test: {
    environment: 'jsdom', // or 'happy-dom'
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**']
  }
});
