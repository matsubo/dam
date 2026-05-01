import { NextResponse } from 'next/server';

export const dynamic = 'force-static';

export async function GET() {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'Dam Data Platform API', version: '1.0.0' },
    servers: [{ url: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000' }],
    components: {
      securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
    },
    security: [{ ApiKey: [] }],
    paths: {
      '/api/v1/healthz': {
        get: { summary: 'Health check', responses: { '200': { description: 'OK' } } },
      },
      '/api/v1/sources': {
        get: { summary: 'Data sources', responses: { '200': { description: 'OK' } } },
      },
      '/api/v1/dams': {
        get: {
          summary: 'List dams',
          parameters: [
            { in: 'query', name: 'pref', schema: { type: 'string', pattern: '^[0-9]{2}$' } },
            { in: 'query', name: 'watershed', schema: { type: 'string' } },
            { in: 'query', name: 'manager', schema: { type: 'string' } },
            { in: 'query', name: 'cursor', schema: { type: 'string' } },
            { in: 'query', name: 'pageSize', schema: { type: 'integer' } },
          ],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/dams/{slug}': {
        get: {
          summary: 'Dam detail',
          parameters: [{ in: 'path', name: 'slug', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/dams/{slug}/observations': {
        get: {
          summary: 'Time series',
          parameters: [
            { in: 'path', name: 'slug', required: true, schema: { type: 'string' } },
            {
              in: 'query',
              name: 'from',
              required: true,
              schema: { type: 'string', format: 'date-time' },
            },
            {
              in: 'query',
              name: 'to',
              required: true,
              schema: { type: 'string', format: 'date-time' },
            },
            {
              in: 'query',
              name: 'interval',
              required: true,
              schema: { type: 'string', enum: ['hourly', 'daily', 'monthly'] },
            },
          ],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/watersheds': {
        get: { summary: 'List watersheds', responses: { '200': { description: 'OK' } } },
      },
      '/api/v1/watersheds/{slug}': {
        get: {
          summary: 'Watershed detail',
          parameters: [{ in: 'path', name: 'slug', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/watersheds/{slug}/dams': {
        get: {
          summary: 'Dams in watershed',
          parameters: [{ in: 'path', name: 'slug', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/watersheds/{slug}/aggregate': {
        get: {
          summary: 'Watershed aggregate',
          parameters: [{ in: 'path', name: 'slug', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/prefectures/{code}/dams': {
        get: {
          summary: 'Dams in prefecture',
          parameters: [
            {
              in: 'path',
              name: 'code',
              required: true,
              schema: { type: 'string', pattern: '^[0-9]{2}$' },
            },
          ],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/api/v1/watershed': {
        get: {
          summary: 'Watershed at point',
          parameters: [
            { in: 'query', name: 'lat', required: true, schema: { type: 'number' } },
            { in: 'query', name: 'lng', required: true, schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  };
  return NextResponse.json(spec, { headers: { 'cache-control': 'public, max-age=300' } });
}
