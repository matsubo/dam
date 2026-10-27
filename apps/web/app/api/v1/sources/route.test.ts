import { describe, expect, test } from 'bun:test';
import { GET as openapi } from '../openapi.json/route.ts';
import { GET as detail } from './[id]/route.ts';
import { GET as list } from './route.ts';

// The OpenAPI document once described `items[].sourceId` while the route
// served `sources[].source_id`. Both routes are checked against the
// published schema, so the two cannot drift apart again.

interface Schema {
  required?: string[];
  properties?: Record<string, unknown>;
  allOf?: Schema[];
}
const doc = (await (await openapi()).json()) as { components: { schemas: Record<string, Schema> } };
const schemas = doc.components.schemas;
const summary = schemas.SourceSummary as Schema;

function expectMatches(body: Record<string, unknown>, schema: Schema, extra: string[] = []) {
  const keys = Object.keys(body).filter((k) => !extra.includes(k));
  expect(keys.sort()).toEqual(Object.keys(schema.properties ?? {}).sort());
  for (const k of schema.required ?? []) expect(body).toHaveProperty(k);
}

describe('/api/v1/sources', () => {
  test('every item has exactly the documented SourceSummary fields', async () => {
    const body = (await (await list()).json()) as { items: Record<string, unknown>[] };
    expect(Object.keys(body).sort()).toEqual(['_links', 'items']);
    expect(body.items.length).toBeGreaterThan(100);
    for (const item of body.items) expectMatches(item, summary);
  });

  test('the detail is the summary plus its dams', async () => {
    const res = await detail(new Request('http://x/api/v1/sources/ndi'), {
      params: Promise.resolve({ id: 'ndi' }),
    });
    expect(res.status).toBe(200);
    expectMatches((await res.json()) as Record<string, unknown>, summary, ['dams', '_links']);
  });

  test('an undeclared id is 404', async () => {
    const res = await detail(new Request('http://x/api/v1/sources/nope'), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(res.status).toBe(404);
  });
});
