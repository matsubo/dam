import { hal } from '../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

const SOURCES = [
  { id: 'ndi-w01', description: 'NLNI W01 dam dataset', schedule: 'monthly', last_fetched_at: null },
  {
    id: 'ndi-w07',
    description: 'NLNI W07 watershed boundaries',
    schedule: 'monthly',
    last_fetched_at: null,
  },
  {
    id: 'damnet',
    description: 'Dam Almanac (damnet.or.jp)',
    schedule: 'monthly',
    last_fetched_at: null,
  },
  {
    id: 'kasenbosai',
    description: 'Kasen-Bosai realtime',
    schedule: 'hourly',
    last_fetched_at: null,
  },
  {
    id: 'suimon',
    description: 'Suimon-Suishitsu DB',
    schedule: 'on-demand',
    last_fetched_at: null,
  },
];

export async function GET() {
  return hal({ sources: SOURCES }, { self: { href: '/api/v1/sources' } });
}
