import { expect, test } from '@playwright/test';

test('/watersheds renders a sortable-ish table of watersheds', async ({ page }) => {
  await page.goto('/watersheds');
  await expect(page.getByRole('heading', { name: '水系一覧' })).toBeVisible();
  const firstWatershedLink = page.locator('table tbody tr a').first();
  await expect(firstWatershedLink).toBeVisible();
});

test('/watersheds/[slug] aggregates dam count and capacity', async ({ page }) => {
  await page.goto('/watersheds');
  // Click the first watershed link in the table — lets the browser handle
  // URL-encoding for slugs that may contain kanji.
  const firstLink = page.locator('table tbody tr a').first();
  await expect(firstLink).toBeVisible();
  await firstLink.click();
  await expect(page).toHaveURL(/\/watersheds\/[^/]+$/);
  // ダム数 is unique to the stat block; 総貯水容量 also appears as the
  // table column header below, so anchor on the stat-block label class.
  await expect(page.getByText('ダム数', { exact: true })).toBeVisible();
  await expect(
    page.locator('div.text-xs.text-muted').filter({ hasText: '総貯水容量' }),
  ).toBeVisible();
});

test('/prefectures/13 (Tokyo) lists Tokyo dams', async ({ page }) => {
  await page.goto('/prefectures/13');
  await expect(page.getByRole('heading', { name: '東京都のダム' })).toBeVisible();
});
