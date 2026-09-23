/// <reference types="vitest/config" />
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

// FIX: __dirname is not available in ES modules. This is the modern replacement.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
    return {
      server: {
        // Honor PORT (e.g. assigned by the preview harness); default 3000.
        port: Number(process.env.PORT) || 3000,
        // Localhost only: 0.0.0.0 exposed the dev server (with its path-
        // traversal advisories) to the whole LAN for no benefit.
        host: 'localhost',
      },
      plugins: [react()],
      resolve: {
        alias: {
          // FIX: __dirname is not available in ES modules. Use import.meta.url to derive it.
          '@': path.resolve(__dirname, '.'),
        }
      },
      test: {
        environment: 'happy-dom',
        setupFiles: ['./tests/setup.ts'],
        include: ['tests/**/*.test.{ts,tsx}'],
      }
    };
});