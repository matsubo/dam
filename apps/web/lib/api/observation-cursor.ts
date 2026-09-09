import type { ObservationCursor } from '@dam/db/repo/observations';

// The cross-dam observation feed pages on the (observed_at, dam_id, source_id)
// tuple, so its cursor can't be the plain bigint that /api/v1/dams uses.
// Base64url keeps the token opaque — clients follow `_links.next` rather than
// building one, which leaves us free to change the tuple later.
const SEP = '|';

export function encodeObservationCursor(c: ObservationCursor): string {
  const raw = [c.observedAt.toISOString(), c.damId.toString(), c.sourceId].join(SEP);
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeObservationCursor(token: string): ObservationCursor | null {
  if (token === '') return null;
  const raw = Buffer.from(token, 'base64url').toString('utf8');
  // source_id is last so it may legitimately contain the separator.
  const [at, damId, ...rest] = raw.split(SEP);
  if (at === undefined || damId === undefined || rest.length === 0) return null;
  const observedAt = new Date(at);
  if (Number.isNaN(observedAt.valueOf())) return null;
  if (!/^[0-9]+$/.test(damId)) return null;
  const sourceId = rest.join(SEP);
  if (sourceId === '') return null;
  return { observedAt, damId: BigInt(damId), sourceId };
}
