import { expect, test } from '@playwright/test';

test('/dams renders a paginated table with at least one dam link', async ({ page }) => {
  await page.goto('/dams');
  await expect(page.getByRole('heading', { name: 'ダム一覧' })).toBeVisible();
  const firstRow = page.locator('table tbody tr').first();
  await expect(firstRow).toBeVisible();
  const damLink = firstRow.getByRole('link').first();
  await expect(damLink).toHaveAttribute('href', /^\/dams\/[^/]+$/);
});

test('/dams/[slug] shows latest stat block + chart container + structured data', async ({
  page,
  request,
}) => {
  // Discover any real dam slug via the API.
  const list = await request.get('/api/v1/dams?pageSize=1');
  expect(list.ok()).toBeTruthy();
  const body = (await list.json()) as { items: { slug: string }[] };
  const slug = body.items[0]?.slug;
  expect(slug).toBeTruthy();

  await page.goto(`/dams/${slug}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The heading-stat block has unique labels; the nearby-dam cards repeat
  // 「総貯水容量」 inline so we anchor on the exact label and 堤高.
  await expect(page.getByText('総貯水容量', { exact: true })).toBeVisible();
  await expect(page.getByText('堤高', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '推移グラフ' })).toBeVisible();

  // Structured data — expect at least one schema.org Place JSON-LD on the page.
  const allLd = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(allLd.some((s) => /"@type"\s*:\s*"Place"/.test(s))).toBe(true);
});

test('/dams/does-not-exist shows the 404 page', async ({ page }) => {
  const response = await page.goto('/dams/totally-nonexistent-slug-xyz');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'ページが見つかりません' })).toBeVisible();
});
