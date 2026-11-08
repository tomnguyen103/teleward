import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { createTelewardApiMiddleware } from './src/server/apiServer.ts';

export default defineConfig({
  plugins: [
    preact(),
    tailwindcss(),
    {
      name: 'teleward-api-middleware',
      configureServer(server) {
        server.middlewares.use(createTelewardApiMiddleware());
      },
      configurePreviewServer(server) {
        server.middlewares.use(createTelewardApiMiddleware());
      },
    },
  ],
  test: {
    environment: 'jsdom',
    globals: false,
    pool: 'threads',
    fileParallelism: false,
    include: ['tests/**/*.test.{ts,tsx}'],
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});

