// apps/worker/src/tasks/master_refresh_ndi.ts
import { importDams, importWatersheds, loadGeoJson, parseW01, parseW07 } from '@dam/adapters-ndi';
import type { Task } from 'graphile-worker';

const W07_URL = process.env.NDI_W07_URL; // configurable via env
const W01_URL = process.env.NDI_W01_URL;

const task: Task = async (_payload, helpers) => {
  if (!W07_URL || !W01_URL) {
    helpers.logger.error('NDI_W07_URL and NDI_W01_URL must be set');
    return;
  }
  const w07 = await loadGeoJson(W07_URL);
  const ws = await importWatersheds(parseW07(w07));
  helpers.logger.info(`watersheds upserted: ${ws.upserted}`);
  const w01 = await loadGeoJson(W01_URL);
  const dr = await importDams(parseW01(w01));
  helpers.logger.info(`dams upserted: ${dr.upserted}`);
};

export default task;
