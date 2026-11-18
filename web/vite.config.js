import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function listFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

/** Emits dist/sw.js from src/sw.template.js with the full precache list (every built
 * asset + every file in public/) and a version hash of their contents. */
function fallguardServiceWorker() {
  return {
    name: 'fallguard-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const publicFiles = listFiles('public').map((p) => relative('public', p).split('\\').join('/'));
      const files = ['./', ...Object.keys(bundle), ...publicFiles].filter((f) => !f.endsWith('.map'));
      const hash = createHash('sha256');
      for (const [name, out] of Object.entries(bundle)) hash.update(name).update(out.type === 'chunk' ? out.code : out.source);
      for (const f of publicFiles) hash.update(f).update(readFileSync(join('public', f)));
      const src = readFileSync('src/sw.template.js', 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('/*__PRECACHE__*/[]', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: env.VITE_BASE || '/',
    plugins: [react(), fallguardServiceWorker()],
    build: { chunkSizeWarningLimit: 1000 }, // onnxruntime-web is ~700 KB of JS by itself
    // Don't pre-bundle onnxruntime-web in dev: pre-bundling moves its JS into
    // node_modules/.vite/deps without the .wasm next to it, so the runtime fetches
    // index.html instead of WebAssembly ("doesn't start with '\0asm'").
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    server: { host: true }, // reachable from a phone on the same Wi-Fi
    test: { environment: 'node', testTimeout: 30000 },
  };
});
