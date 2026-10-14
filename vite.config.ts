/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Relative base so the build works from any static host path (GitHub Pages, Netlify).
export default defineConfig({
  base: './',
  // Three.js is most of the bundle (~220 KB gzipped with the campaign data); one chunk is fine here.
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
  // Full simulated battles and campaigns: give them room on a busy machine (vitest's default is 5 s).
  test: { testTimeout: 30000 },
});
