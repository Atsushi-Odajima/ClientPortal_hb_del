import { buildApp } from './app.js';

const app = await buildApp({ startJobs: true });
const { port, host } = app.ctx.cfg;

try {
  await app.listen({ port, host });
  app.log.info(`Client Portal listening on ${host}:${port} (storage=${app.ctx.storage.name}, mail=${app.ctx.cfg.mail.driver})`);
} catch (e) {
  app.log.error(e);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info(`received ${sig}, shutting down`);
    await app.close();
    process.exit(0);
  });
}
