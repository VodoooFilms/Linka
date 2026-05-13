export function registerSystemRoutes(app, options) {
  const {
    faviconPath,
    webIconPath,
    getStatus,
    getHermesEvents,
    getHermesSuggestions,
  } = options;

  app.get('/favicon.ico', (_req, res) => {
    res.sendFile(faviconPath);
  });

  app.get('/icon.png', (_req, res) => {
    res.sendFile(webIconPath);
  });

  app.get('/apple-touch-icon.png', (_req, res) => {
    res.sendFile(webIconPath);
  });

  app.get('/api/status', (_req, res) => {
    res.json(getStatus());
  });

  app.get('/hermes/events', getHermesEvents);
  app.get('/hermes/suggest', getHermesSuggestions);
}
