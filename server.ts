import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getServerConfig, isApiKeyConfigured } from './server/config/env';
import { createPlacesRouter } from './server/routes/placesRoutes';
import { createStreetViewRouter } from './server/routes/streetViewRoutes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function createAppServer() {
  const app = express();
  const config = getServerConfig();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/config', (_req, res) => {
    res.json({
      apiConfigured: isApiKeyConfigured(),
      environment: config.nodeEnv,
    });
  });

  app.use('/api/streetview', createStreetViewRouter());
  app.use('/api/places', createPlacesRouter());

  if (config.nodeEnv === 'production') {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  return app;
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  const config = getServerConfig();
  createAppServer()
    .then((app) => {
      app.listen(config.port, '0.0.0.0', () => {
        console.log(
          `Real Street View Drive server listening on http://0.0.0.0:${config.port}`,
        );
      });
    })
    .catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}
