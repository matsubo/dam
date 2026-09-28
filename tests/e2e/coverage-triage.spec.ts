import { expect, type Page, test } from '@playwright/test';

// The 未取得ダムの内訳 section of /coverage against /api/v1/coverage: the page
// must show the same triage the API reports, and each state must be present.
// On a fresh database tests/e2e/fixtures/seed.ts provides them: ryumon-40
// listed by a provider that publishes no value for it, one station with a
// cited not-dam reason, and no recorded provider list at all, so every
// enumerable provider is still pending.

interface PendingScanSource {
  sourceId: string;
  label: string;
  _links: { web: { href: string } };
}

interface CoverageBody {
  summary: {
    publishedNoData: number;
    notDamStations: number;
    sourcesPendingScan: number;
    pendingScanSources: PendingScanSource[];
  };
  items: { slug: string; status: string }[];
}

async function coverageApi(page: Page): Promise<CoverageBody> {
  const res = await page.request.get('/api/v1/coverage');
  expect(res.status()).toBe(200);
  return (await res.json()) as CoverageBody;
}

function triageSection(page: Page) {
  return page.locator('section', {
    has: page.getByRole('heading', { level: 2, name: '未取得ダムの内訳' }),
  });
}

test('/coverage counts dams whose providers publish no value', async ({ page }) => {
  const api = await coverageApi(page);
  const noData = api.items.filter((i) => i.status === 'published_no_data');
  expect(noData.length).toBeGreaterThan(0);
  expect(api.summary.publishedNoData).toBe(noData.length);

  await page.goto('/coverage');
  const card = triageSection(page).getByText('提供元に値なし', { exact: true }).locator('..');
  await expect(card).toContainText('調査対象外・欠測・落水');
  const value = card.locator(':scope > div').nth(1);
  await expect(value).toHaveText(api.summary.publishedNoData.toLocaleString('ja-JP'));
});

test('/coverage states how many unmatched stations are known not to be dams', async ({ page }) => {
  const api = await coverageApi(page);
  expect(api.summary.notDamStations).toBeGreaterThan(0);

  await page.goto('/coverage');
  const text = await triageSection(page).innerText();
  const m = text.match(/ダムではないと確認済みの\s*([\d,]+)\s*件は除く/);
  expect(m?.[1]?.replace(/,/g, '')).toBe(String(api.summary.notDamStations));
});

test('/coverage lists each pending-scan provider, linked to its source page', async ({ page }) => {
  const { summary } = await coverageApi(page);
  const pending = summary.pendingScanSources;
  expect(pending.length).toBeGreaterThan(0);
  expect(summary.sourcesPendingScan).toBe(pending.length);

  await page.goto('/coverage');
  const section = triageSection(page);
  await expect(section).toContainText(`残り ${pending.length} 件（下記）が未記録です`);

  const links = section.getByRole('listitem').getByRole('link');
  await expect(links).toHaveText(pending.map((p) => p.label));
  const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(hrefs).toEqual(pending.map((p) => p._links.web.href));

  const first = pending[0];
  if (!first) throw new Error('unreachable: pending is non-empty');
  await links.first().click();
  await expect(page).toHaveURL(first._links.web.href);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(first.label);
});
