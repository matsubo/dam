import { readFile } from 'node:fs/promises';
import { HttpClient } from '@dam/core/http_client';

export async function loadGeoJson(source: string): Promise<string> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const c = new HttpClient({
      userAgent:
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
      minIntervalMs: 1000,
      maxRetries: 3,
      timeoutMs: 60_000,
    });
    const r = await c.get(source);
    if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${source}`);
    return r.bodyText;
  }
  return readFile(source, 'utf8');
}
