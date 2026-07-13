import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Same-origin in dev and preview, mirroring the single-origin CloudFront
// topology: the SPA and /api answer on one host.
const apiTarget = `http://localhost:${process.env.VITE_API_PORT ?? process.env.PORT ?? '8000'}`;
const proxy = { '/api': apiTarget };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
