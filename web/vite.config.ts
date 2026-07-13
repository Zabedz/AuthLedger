import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev, mirroring the single-origin CloudFront topology.
    proxy: {
      '/api': `http://localhost:${process.env.PORT ?? '8000'}`,
    },
  },
});
