import { type LinksInput, buildLinks } from '@dam/core/hateoas';
import { NextResponse } from 'next/server';

export function hal<T extends object>(body: T, links: LinksInput): NextResponse {
  return NextResponse.json(
    { ...body, _links: buildLinks(links) },
    { headers: { 'content-type': 'application/hal+json' } },
  );
}
