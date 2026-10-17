import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Visual simulation: runs the real core in the browser, with no server and no database.
export default defineConfig({
  root: 'packages/simulator/web',
  plugins: [react()],
  server: { port: 5174, fs: { allow: ['../../..'] } },
  build: { outDir: 'dist', emptyOutDir: true },
});
