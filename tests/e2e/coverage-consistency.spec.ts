import { type Page, expect, test } from '@playwright/test';

// The home page, /stats and /coverage each quote 全国貯水率 and カバレッジ.
// They used to compute them independently and disagreed in production
// (全国貯水率 40.9 % on the home page vs 19.1 % on /stats, 2026-09-10).
// All three now read repo/storage_totals + repo/coverage; this spec is the
// end-to-end guard that they still agree.

// Note: the home page memoises its stats for 5 minutes (unstable_cache, which
// Next persists under .next/cache). After changing fixture data locally, clear
// that directory before running this spec or the home page will still serve
// the pre-seed numbers.
async function bodyText(page: Page, path: string): Promise<string> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return page.locator('body').innerText();
}

/** "全国貯水率 … 40.0 %" → 40.0 */
function nationalRate(text: string): number {
  const m = text.match(/全国貯水率[\s\S]{0,60}?([\d.]+)\s*%/);
  if (!m?.[1]) throw new Error(`no 全国貯水率 in page text: ${text.slice(0, 200)}`);
  return Number(m[1]);
}

/** Both pages spell the cohort out as "実測のある N 基". */
function cohortSize(text: string): number {
  const m = text.match(/実測のある\s*([\d,]+)\s*基/);
  if (!m?.[1]) throw new Error('no cohort size in page text');
  return Number(m[1].replace(/,/g, ''));
}

test('全国貯水率 agrees between the home page and /stats', async ({ page }) => {
  const home = await bodyText(page, '/');
  const stats = await bodyText(page, '/stats');

  expect(nationalRate(stats)).toBeCloseTo(nationalRate(home), 1);
  expect(cohortSize(stats)).toBe(cohortSize(home));
});

test('貯水率カバレッジ agrees between the home page and /coverage', async ({ page }) => {
  // "直近 30 日に貯水率データあり: 1 基 / 河川管理ダム 5 基（高さ 15 m 以上）"
  const home = (await bodyText(page, '/')).match(
    /貯水率データあり:\s*([\d,]+)\s*基\s*\/\s*河川管理ダム\s*([\d,]+)\s*基/,
  );
  // "貯水率取得 (直近 30 日) … 20.00% … 1 / 5 基"
  const coverage = (await bodyText(page, '/coverage')).match(
    /貯水率取得 \(直近 30 日\)[\s\S]{0,80}?([\d,]+)\s*\/\s*([\d,]+)\s*基/,
  );

  expect(home).not.toBeNull();
  expect(coverage).not.toBeNull();
  expect(coverage?.[1]).toBe(home?.[1]);
  expect(coverage?.[2]).toBe(home?.[2]);
});

test('/coverage labels the two coverage metrics so they cannot be confused', async ({ page }) => {
  await page.goto('/coverage');
  await expect(page.getByText('水位・雨量だけの提供元も含みます')).toBeVisible();
  await expect(page.getByText(/分母は河川管理ダム/)).toBeVisible();
});
