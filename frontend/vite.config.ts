import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Vite 6 checks the Host header on every request and refuses anything that
      // isn't localhost/127.0.0.1 by default â a teammate hitting this through a
      // forwarded port presents a different host and gets blocked outright, even
      // though the socket itself is reachable (--host=0.0.0.0 in package.json's
      // dev script already takes care of that part).
      allowedHosts: true as const,
    },
  };
});
