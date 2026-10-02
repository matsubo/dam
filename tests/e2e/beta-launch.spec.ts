import { expect, test } from '@playwright/test';

// Guards for the public β: what the site promises (licence, stage, safety
// notice) has to match the 利用規約 and the roadmap.

test('no page offers commercial use — the NDI-derived data is 非商用', async ({ page }) => {
  // /legal/terms: "非商用目的に限り … 商用目的での利用はできません". The hero
  // badge, API band and footer used to say 商用利用可 / 研究・防災・教育・商用.
  await page.goto('/');
  const body = page.locator('body');
  await expect(body).not.toContainText('商用利用可');
  await expect(body).not.toContainText('・商用');
  await expect(page.locator('footer')).toContainText('非商用');
});

test('the header and footer label the service as β', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner').getByRole('link', { name: /β/ })).toBeVisible();
  await expect(page.locator('footer')).toContainText('beta');
});

test('/roadmap marks ベータ as the current stage', async ({ page }) => {
  await page.goto('/roadmap');
  await expect(page.locator('main, body').first()).toContainText('本サービスは現在ベータ段階です');
});

test('the OpenAPI description states the β stage', async ({ request }) => {
  const doc = await (await request.get('/api/v1/openapi.json')).json();
  expect(doc.info.description).toContain('ベータ段階');
  expect(doc.info.description).not.toContain('アルファ');
});

test('a dam page warns against using the values for evacuation decisions', async ({ page }) => {
  await page.goto('/dams/amagase-26');
  await expect(page.getByRole('note', { name: '防災判断についての注意' })).toBeVisible();
});

test('every response carries the baseline security headers', async ({ request }) => {
  const res = await request.get('/');
  expect(res.headers()['x-frame-options']).toBe('DENY');
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
});

test('/favicon.ico resolves for crawlers that ignore <link rel=icon>', async ({ request }) => {
  const res = await request.get('/favicon.ico');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^image\//);
});

test('the sitemap lists the legal pages and the API docs', async ({ request }) => {
  const xml = await (await request.get('/sitemap.xml')).text();
  for (const path of ['/legal/terms', '/legal/privacy', '/api/docs']) {
    expect(xml).toContain(`${path}</loc>`);
  }
});
