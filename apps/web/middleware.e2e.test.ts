import { describe, expect, test } from 'bun:test';

// Minimal HTTP-level smoke tests against the locally-running Next dev server.
// They assert on real network behaviour (Link header, /well-known endpoints,
// markdown negotiation, legacy-watershed redirect) which is the only place
// the middleware effects are observable. They auto-skip when the server isn't
// up so CI can run the rest of the suite in isolation.

const BASE = process.env.DAM_TEST_BASE_URL ?? 'http://localhost:3030';

async function isServerUp(): Promise<boolean> {
  try {
    const r = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

describe('agent affordances (live HTTP)', () => {
  test('robots.txt has Content Signals + AI bot allow blocks', async () => {
    if (!(await isServerUp())) return;
    const r = await fetch(`${BASE}/robots.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
    const body = await r.text();
    expect(body).toMatch(/Content-Signal/);
    expect(body).toMatch(/User-agent: GPTBot/);
    expect(body).toMatch(/Sitemap:/);
  });

  test('/.well-known/api-catalog returns linkset+json', async () => {
    if (!(await isServerUp())) return;
    const r = await fetch(`${BASE}/.well-known/api-catalog`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/linkset\+json/);
    const body = (await r.json()) as { linkset: unknown[] };
    expect(Array.isArray(body.linkset)).toBe(true);
    expect(body.linkset.length).toBeGreaterThan(0);
  });

  test('/.well-known/agent-skills lists at least the dam endpoints', async () => {
    if (!(await isServerUp())) return;
    const r = await fetch(`${BASE}/.well-known/agent-skills`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { skills: { id: string }[] };
    const ids = body.skills.map((s) => s.id);
    expect(ids).toContain('list_dams');
    expect(ids).toContain('get_dam_observations');
  });

  test('/llms.txt returns markdown', async () => {
    if (!(await isServerUp())) return;
    const r = await fetch(`${BASE}/llms.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/markdown/);
    const body = await r.text();
    expect(body).toMatch(/^# /);
  });

  test('Site-wide Link header advertises agent affordances', async () => {
    if (!(await isServerUp())) return;
    const r = await fetch(`${BASE}/sources`);
    const link = r.headers.get('link') ?? '';
    expect(link).toMatch(/rel="api-catalog"/);
    expect(link).toMatch(/rel="agent-skills"/);
    expect(link).toMatch(/rel="service-desc"/);
  });

  test('Markdown content negotiation rewrites to /md/index', async () => {
    if (!(await isServerUp())) return;
    const r = await fetch(BASE, { headers: { Accept: 'text/markdown' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/markdown/);
    const body = await r.text();
    expect(body).toMatch(/Dam Data Japan/);
  });

  test('Legacy watershed slug 308 → canonical', async () => {
    if (!(await isServerUp())) return;
    const r = await fetch(`${BASE}/watersheds/watershed-%E8%B3%80%E8%8C%82%E5%B7%9D`, {
      redirect: 'manual',
    });
    expect(r.status).toBe(308);
    const loc = r.headers.get('location') ?? '';
    expect(loc).toMatch(/\/watersheds\/(?:watershed-)?%E8%B3%80%E8%8C%82%E5%B7%9D$/);
    expect(loc).not.toMatch(/watershed-(?=%)/);
  });
});
