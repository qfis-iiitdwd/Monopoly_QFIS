import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Two separate apps from one build: the player app (/) and the admin page (/admin/).
// The build lands in ../public/app, which the Express server serves. In development,
// `npm run dev` proxies /api to the backend (BACKEND, default http://localhost:3000).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../public/app'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        player: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin/index.html'),
      },
    },
  },
  server: {
    proxy: { '/api': { target: process.env.BACKEND || 'http://localhost:3000', changeOrigin: false } },
  },
});
