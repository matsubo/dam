import { expect, test } from '@playwright/test';

// The contributor-recruitment page and the entry points that lead to it.
// Assertions stay structural (headings, links, landmark sections) — the live
// figures on the page come from the database, and the E2E database is a
// six-dam fixture, so asserting on numbers here would test the fixture.

test('/contribute renders the recruitment page', async ({ page }) => {
  const r = await page.goto('/contribute');
  expect(r?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('開発者募集');
});

test('/contribute states the terms: unpaid, public repo, licence', async ({ page }) => {
  await page.goto('/contribute');
  const body = page.locator('main');
  await expect(body).toContainText('無償');
  await expect(body).toContainText('公開リポジトリ');
  await expect(body).toContainText('PolyForm Shield');
  await expect(body).not.toContainText('プライベート');
});

test('/contribute links to GitHub Sponsors for donations', async ({ page }) => {
  await page.goto('/contribute');
  const sponsor = page.locator('a[href^="https://github.com/sponsors/"]').first();
  await expect(sponsor).toBeVisible();
});

test('/contribute routes both applications and questions to Discord', async ({ page }) => {
  await page.goto('/contribute');
  const apply = page.locator('#apply');
  await expect(apply).toBeVisible();
  await expect(apply).toContainText('応募');
  await expect(apply).toContainText('相談');
  await expect(apply.locator('a[href^="https://discord.gg/"]').first()).toBeVisible();
});

test('/contribute links reporters straight to the public issue tracker', async ({ page }) => {
  await page.goto('/contribute');
  await expect(
    page.locator('main a[href="https://github.com/matsubo/dam/issues"]').first(),
  ).toBeVisible();
});

test('/legal/terms names the actual code licence', async ({ page }) => {
  await page.goto('/legal/terms');
  const body = page.locator('main');
  await expect(body).toContainText('PolyForm Shield');
  await expect(body).not.toContainText('MIT');
});

test('/contribute carries the permanent contributor credits section', async ({ page }) => {
  await page.goto('/contribute');
  await expect(page.locator('#contributors')).toBeVisible();
  await expect(page.locator('#contributors')).toContainText('コントリビューター');
});

test('/contribute documents the software stack', async ({ page }) => {
  await page.goto('/contribute');
  const stack = page.locator('#stack');
  await expect(stack).toBeVisible();
  await expect(stack).toContainText('Next.js');
  await expect(stack).toContainText('TimescaleDB');
  await expect(stack).toContainText('graphile-worker');
});

test('the site footer links to /contribute from every page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('footer a[href="/contribute"]').first()).toBeVisible();
});

test('developer-facing pages funnel to /contribute', async ({ page }) => {
  for (const path of ['/coverage', '/roadmap', '/sources']) {
    await page.goto(path);
    await expect(
      page.locator(`main a[href="/contribute"]`).first(),
      `${path} should link to /contribute`,
    ).toBeVisible();
  }
});

test('/llms.txt points agents at the recruitment page', async ({ request }) => {
  const r = await request.get('/llms.txt');
  expect(r.status()).toBe(200);
  expect(await r.text()).toContain('/contribute');
});
