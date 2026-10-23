import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The production build is a single self-contained HTML file (plant worker inlined),
// so the twin can be opened from disk on the presentation laptop without a server.
export default defineConfig({
  plugins: [viteSingleFile()],
  worker: { format: 'iife' },
  build: { target: 'es2020', chunkSizeWarningLimit: 2500 },
});
