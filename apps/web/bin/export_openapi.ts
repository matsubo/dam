// Write the OpenAPI document served at /api/v1/openapi.json to a file, so a
// GitHub Release can carry the exact spec of that version as an asset.
//
//   bun run apps/web/bin/export_openapi.ts <out.json>
//
// The route is force-static and needs no database, so calling its handler
// directly yields the same bytes the site serves.
import { GET } from '../app/api/v1/openapi.json/route.ts';

type OpenApiSpec = { openapi: string; info: { version: string } };

export async function readOpenApiSpec(): Promise<OpenApiSpec> {
  const res = await GET();
  return (await res.json()) as OpenApiSpec;
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: bun run apps/web/bin/export_openapi.ts <out.json>');
    process.exit(1);
  }
  const spec = await readOpenApiSpec();
  await Bun.write(out, `${JSON.stringify(spec, null, 2)}\n`);
  console.log(`wrote OpenAPI ${spec.info.version} to ${out}`);
}
