import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false, target: 'es2020' },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
});
