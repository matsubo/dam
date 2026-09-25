import { expect, test } from '@playwright/test';

// /faq (issue #61). Structural assertions only — the trusted-source list comes
// from source_priorities, which differs between the E2E fixture and prod.

test('/faq renders every question with an anchor', async ({ page }) => {
  const r = await page.goto('/faq');
  expect(r?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('よくある質問');
  for (const id of ['rate-origin', 'source-choice', 'denominator', 'redevelopment']) {
    await expect(page.locator(`section#${id} h2`)).toBeVisible();
  }
});

test('/faq publishes FAQPage structured data', async ({ page }) => {
  await page.goto('/faq');
  const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
  const faq = blocks.map((b) => JSON.parse(b)).find((ld) => ld['@type'] === 'FAQPage');
  expect(faq?.mainEntity.length).toBeGreaterThan(0);
});

test('the footer and /sources link to /faq', async ({ page }) => {
  await page.goto('/sources');
  await expect(page.locator('footer a[href="/faq"]')).toBeVisible();
  await expect(page.locator('main a[href="/faq#source-choice"]')).toBeVisible();
});
