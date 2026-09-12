import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/web',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {target: API_ORIGIN, changeOrigin: false},
      '/ws': {target: API_ORIGIN, ws: true, changeOrigin: false},
    },
  },
});
