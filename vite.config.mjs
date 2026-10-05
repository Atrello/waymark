import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

/*
 * The browser app lives in web/ and builds to dist/, which the Express server (server.js) serves.
 * `npm run dev` runs Vite's dev server alongside Express and passes /api and /logout through to it.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = env.PORT || 3000;
  const target = `http://127.0.0.1:${port}`;
  const appOrigin = new URL(env.APP_URL || `http://localhost:${port}`).origin;
  const toServer = {
    target,
    // Sign-in only accepts requests from the app's own address (APP_URL), so present that origin to Express.
    configure: (proxy) => proxy.on('proxyReq', (req) => { if (req.getHeader('origin')) req.setHeader('origin', appOrigin); }),
  };

  return {
    root: 'web',
    plugins: [
      svelte(),
      { // /login is a page of its own (Express serves it at /login too)
        name: 'waymark-login-route',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === '/login' || req.url.startsWith('/login?')) req.url = '/login.html';
            next();
          });
        },
      },
    ],
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          app: resolve('web/index.html'),
          login: resolve('web/login.html'),
          mapPicker: resolve('web/map-picker.html'),
          routeMap: resolve('web/route-map.html'),
        },
      },
    },
    server: {
      proxy: { '/api': toServer, '/logout': toServer },
    },
  };
});
