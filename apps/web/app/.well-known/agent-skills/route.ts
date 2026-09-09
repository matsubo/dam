// Agent Skills index. There's no single ratified spec yet — we follow the
// emerging convention of a JSON list of self-describing "skills" (named
// operations) keyed off an OpenAPI-style endpoint. Agents that don't know
// the format can still parse `actions[].endpoint` and `actions[].method`
// to discover what's callable.

export const dynamic = 'force-static';
export const revalidate = 3600;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://dam.teraren.com';

interface Skill {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  method: 'GET' | 'POST';
  inputs?: Array<{ name: string; in: 'query' | 'path'; required?: boolean; description: string }>;
  output_format: 'application/hal+json' | 'application/problem+json' | 'text/csv';
  example_url?: string;
}

const SKILLS: Skill[] = [
  {
    id: 'list_dams',
    name: 'List dams',
    description:
      'List all dams with capacity, location, manager. Supports filtering by prefecture, watershed slug, or manager.',
    endpoint: `${SITE_URL}/api/v1/dams`,
    method: 'GET',
    inputs: [
      { name: 'pref_code', in: 'query', description: 'JIS prefecture code 01-47' },
      { name: 'watershed_slug', in: 'query', description: 'Watershed slug (e.g. yodogawa)' },
      { name: 'manager', in: 'query', description: 'Manager name (e.g. 国土交通省)' },
      { name: 'cursor', in: 'query', description: 'Pagination cursor (id of last seen dam)' },
    ],
    output_format: 'application/hal+json',
    example_url: `${SITE_URL}/api/v1/dams?pref_code=14`,
  },
  {
    id: 'get_dam',
    name: 'Get dam detail',
    description:
      'Single dam record including capacity (total / active / effective / flood), purpose, type, height, location, and links to its observation series.',
    endpoint: `${SITE_URL}/api/v1/dams/{slug}`,
    method: 'GET',
    inputs: [
      { name: 'slug', in: 'path', required: true, description: 'Dam slug (e.g. doushi-14)' },
    ],
    output_format: 'application/hal+json',
    example_url: `${SITE_URL}/api/v1/dams/doushi-14`,
  },
  {
    id: 'get_dam_observations',
    name: 'Get dam observation time-series',
    description:
      'Hourly / daily / monthly storage volume, inflow, outflow, and water level for a dam. Uses 利水容量 (active capacity) as the storage_rate denominator.',
    endpoint: `${SITE_URL}/api/v1/dams/{slug}/observations`,
    method: 'GET',
    inputs: [
      { name: 'slug', in: 'path', required: true, description: 'Dam slug' },
      { name: 'from', in: 'query', required: true, description: 'ISO 8601 start timestamp' },
      { name: 'to', in: 'query', required: true, description: 'ISO 8601 end timestamp' },
      {
        name: 'interval',
        in: 'query',
        required: true,
        description: "'hourly', 'daily', or 'monthly'",
      },
      { name: 'format', in: 'query', description: "'json' (default) or 'csv'" },
    ],
    output_format: 'application/hal+json',
    example_url: `${SITE_URL}/api/v1/dams/doushi-14/observations?from=2026-01-01T00:00:00Z&to=2026-05-01T00:00:00Z&interval=daily`,
  },
  {
    id: 'list_observations',
    name: 'List observations across all dams',
    description:
      'Cross-dam feed of raw hourly measurements for a time window, ordered by (observed_at, dam_id, source_id) and keyset-paginated. Built for sync/ingest clients that want every dam at once rather than one series at a time. Returns measured values only.',
    endpoint: `${SITE_URL}/api/v1/observations`,
    method: 'GET',
    inputs: [
      { name: 'from', in: 'query', required: true, description: 'ISO 8601 start timestamp' },
      {
        name: 'to',
        in: 'query',
        required: true,
        description: 'ISO 8601 end timestamp (exclusive)',
      },
      {
        name: 'cursor',
        in: 'query',
        description: 'Opaque pagination cursor — follow _links.next rather than building it',
      },
      { name: 'pageSize', in: 'query', description: '1-1000, default 100' },
    ],
    output_format: 'application/hal+json',
    example_url: `${SITE_URL}/api/v1/observations?from=2026-05-01T00:00:00Z&to=2026-05-02T00:00:00Z`,
  },
  {
    id: 'list_watersheds',
    name: 'List watersheds',
    description:
      "List 一級水系 / 二級水系 / その他, each with attached dam count. Pagination supported via 'cursor'.",
    endpoint: `${SITE_URL}/api/v1/watersheds`,
    method: 'GET',
    inputs: [
      { name: 'kind', in: 'query', description: "'first', 'second', or omit for all" },
      { name: 'cursor', in: 'query', description: 'Pagination cursor' },
    ],
    output_format: 'application/hal+json',
    example_url: `${SITE_URL}/api/v1/watersheds?kind=first`,
  },
  {
    id: 'get_watershed_observations',
    name: 'Get watershed-aggregated observation series',
    description:
      'Sum of storage volume across all dams in a watershed with the same time-axis options as the per-dam endpoint.',
    endpoint: `${SITE_URL}/api/v1/watersheds/{slug}/observations`,
    method: 'GET',
    inputs: [
      { name: 'slug', in: 'path', required: true, description: 'Watershed slug' },
      { name: 'from', in: 'query', required: true, description: 'ISO 8601 start' },
      { name: 'to', in: 'query', required: true, description: 'ISO 8601 end' },
      { name: 'interval', in: 'query', required: true, description: 'hourly|daily|monthly' },
      { name: 'format', in: 'query', description: 'json|csv' },
    ],
    output_format: 'application/hal+json',
  },
];

export function GET(): Response {
  const body = {
    schema_version: '1',
    name: 'Dam Data Japan',
    description:
      'Open data API for Japanese reservoir master metadata + historical storage / inflow / outflow time-series at 1-hour grain. Realtime values are not republished — defer to 川の防災情報 (river.go.jp) for live readings.',
    contact: 'https://discord.gg/UbWqspWbAk',
    auth: {
      type: 'bearer',
      description:
        'Issue a key at /account/keys via Google sign-in. Send as `Authorization: Bearer <key>`.',
      instructions_url: `${SITE_URL}/account/keys`,
    },
    rate_limits: { per_minute: 600, per_day: 100000 },
    documentation_url: `${SITE_URL}/api/docs`,
    openapi_url: `${SITE_URL}/api/v1/openapi.json`,
    api_catalog_url: `${SITE_URL}/.well-known/api-catalog`,
    skills: SKILLS,
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
}
