import { expect, test } from '@playwright/test';

// #66: the global `a { color }` rule must not override the CTA button text
// colour. Tailwind 4 puts `.btn-*` in `@layer components`, which an unlayered
// `a` rule beats regardless of specificity — the label went primary-on-primary.
const WHITE = 'rgb(255, 255, 255)';

test('home: primary CTA label is white on the primary fill', async ({ page }) => {
  await page.goto('/');
  const cta = page.getByRole('link', { name: 'ダムを探す' });
  await expect(cta).toHaveCSS('color', WHITE);
  const outline = page.getByRole('link', { name: 'API 仕様を見る' });
  const outlineColor = await outline.evaluate((el) => getComputedStyle(el).color);
  const bodyColor = await page.evaluate(() => getComputedStyle(document.body).color);
  expect(outlineColor).toBe(bodyColor);
});

test('contribute: Discord CTA label is white on the primary fill', async ({ page }) => {
  await page.goto('/contribute');
  await expect(page.getByRole('link', { name: /Discord で声をかける/ })).toHaveCSS('color', WHITE);
});
