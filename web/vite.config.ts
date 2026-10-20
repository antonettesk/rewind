import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const api = process.env.REWIND_API_ORIGIN ?? 'http://127.0.0.1:4747';

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  // assetsInlineLimit 0: never inline fonts/images as data: URIs, so the CSP can stay strict (font-src 'self').
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: 600, assetsInlineLimit: 0 },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/api': api, '/mcp': { target: api, changeOrigin: true } },
  },
});
