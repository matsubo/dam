import { expect, test } from '@playwright/test';

// Regression for #21: `kind` used to mean "has a W07 boundary" (463 一級).
// Now it is the 河川法 classification from the 水系域コード + W05 区間種別.

test('/dams watershed filter groups 一級 and 二級 correctly', async ({ page }) => {
  await page.goto('/dams');
  const select = page.locator('select[name="watershed"]');
  const firstClass = select.locator('optgroup[label="一級水系"] option');
  const secondClass = select.locator('optgroup[label="二級水系"] option');
  await expect(firstClass.filter({ hasText: /^利根川/ })).toHaveCount(1);
  await expect(secondClass.filter({ hasText: /^堤川/ })).toHaveCount(1);
  await expect(firstClass.filter({ hasText: /^堤川/ })).toHaveCount(0);
  // 109 一級水系 exist; only those with W01 dams are listed, never more than that.
  expect(await firstClass.count()).toBeLessThanOrEqual(109);
});

test('/watersheds lists 一級 systems first and shows the 102/458/84 split', async ({ page }) => {
  await page.goto('/watersheds');
  await expect(
    page.getByText(/マスタ全体は 644 水系（一級 102 · 二級 458 · その他 84）/),
  ).toBeVisible();
  const kindCells = page.locator('table tbody tr td:nth-child(2)');
  await expect(kindCells.first()).toHaveText('一級');
  const tsutsumi = page.locator('table tbody tr', { hasText: '堤川' }).first();
  await expect(tsutsumi.locator('td').nth(1)).toHaveText('二級');
});

test('/watersheds/堤川 is labelled 二級水系', async ({ page }) => {
  await page.goto('/watersheds/堤川');
  await expect(page.getByText('二級水系', { exact: true })).toBeVisible();
});

test('/api/v1/watersheds exposes kind and ndiCode', async ({ request }) => {
  const detail = await request.get('/api/v1/watersheds/堤川');
  expect(detail.status()).toBe(200);
  expect(await detail.json()).toMatchObject({ kind: 'second', ndiCode: '020036' });

  const tone = await request.get('/api/v1/watersheds/利根川');
  expect(await tone.json()).toMatchObject({ kind: 'first', ndiCode: '830303' });

  const list = await request.get('/api/v1/watersheds?kind=second&pageSize=500');
  const body = (await list.json()) as { items: { name: string; kind: string }[] };
  expect(body.items.some((w) => w.name === '堤川')).toBe(true);
  expect(body.items.every((w) => w.kind === 'second')).toBe(true);
});
