import { expect, test } from '@playwright/test';

test('home page renders the headline and link to /dams', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('日本のダム');
  await expect(page.getByRole('link', { name: /すべてのダムを見る/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /日本のダム地図/ })).toBeVisible();
});

test('nav links route to the right pages', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'ダム', exact: true }).click();
  await expect(page).toHaveURL(/\/dams$/);
  await expect(page.getByRole('heading', { name: 'ダム一覧' })).toBeVisible();
});
