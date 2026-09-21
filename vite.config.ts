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
      // The OAuth endpoints live on the API, but `/consent` is a screen in this SPA, so
      // the whole authorization flow has to run against one origin in dev too — without
      // these the redirect out of `/oauth/authorize` would land on a port with no app.
      '/oauth': {target: API_ORIGIN, changeOrigin: false},
      '/.well-known': {target: API_ORIGIN, changeOrigin: false},
      // And the MCP endpoint with them: an agent connects to `http://localhost:5173/mcp`
      // in dev, so the resource, the metadata and the consent screen share this origin.
      '/mcp': {target: API_ORIGIN, changeOrigin: false},
    },
  },
});
