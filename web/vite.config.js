import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';

// base matches the GitHub Pages project URL; the singlefile plugin inlines
// all JS/CSS into dist/index.html so the built page still opens offline
// from a local double-click (no module fetches, no CORS on file://).
export default defineConfig({
  base: '/hanzi-skeleton/',
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    target: 'es2020',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
