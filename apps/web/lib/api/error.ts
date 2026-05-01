import { NextResponse } from 'next/server';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function asProblem(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json(
      { type: 'about:blank', title: err.message, status: err.status },
      { status: err.status, headers: { 'content-type': 'application/problem+json' } },
    );
  }
  console.error(err);
  return NextResponse.json(
    { type: 'about:blank', title: 'Internal Server Error', status: 500 },
    { status: 500, headers: { 'content-type': 'application/problem+json' } },
  );
}
