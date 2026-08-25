import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  // Every URL the build emits is written relative to the document, so `dist/` can be dropped
  // into any directory of any host — a project page under /repo/, a staging path, a file share
  // — without being rebuilt for it. The two paths the app fetches by hand (the FFmpeg core and
  // the overlay font) go through `publicUrl()` for the same reason.
  base: './',
  build: {
    rollupOptions: {
      output: {
        // No content hashes: this is a single self-contained app served from a directory, and a
        // stable name is what lets that directory be rsynced over, cached by path, or pointed at
        // by hand. The trade is that a redeploy needs cache-busting from the server side —
        // hashed names cannot be re-fetched wrongly, these can.
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  // Worker bundles are emitted by a separate rollup pass and do not inherit `build` above.
  worker: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
