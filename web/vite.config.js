import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: env.VITE_BASE || '/',
    plugins: [react()],
    build: { chunkSizeWarningLimit: 1000 }, // onnxruntime-web is ~700 KB of JS by itself
    // Don't pre-bundle onnxruntime-web in dev: pre-bundling moves its JS into
    // node_modules/.vite/deps without the .wasm next to it, so the runtime fetches
    // index.html instead of WebAssembly ("doesn't start with '\0asm'").
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    server: { host: true }, // reachable from a phone on the same Wi-Fi
    test: { environment: 'node', testTimeout: 30000 },
  };
});
