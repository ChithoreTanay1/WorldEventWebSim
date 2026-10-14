/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Relative base so the build works from any static host path (GitHub Pages, Netlify).
export default defineConfig({
  base: './',
  // Three.js is most of the bundle (~150 KB gzipped); one chunk is fine for a single-page game.
  build: { target: 'es2020', chunkSizeWarningLimit: 800 },
  // Full simulated battles and campaigns: give them room on a busy machine (vitest's default is 5 s).
  test: { testTimeout: 30000 },
});
