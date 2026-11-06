import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// base matches the GitHub Pages project URL; the singlefile plugin inlines
// all JS/CSS into dist/index.html so the built page still opens offline
// from a local double-click (no module fetches, no CORS on file://).
export default defineConfig({
  base: '/hanzi-skeleton/',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2020',
  },
});
