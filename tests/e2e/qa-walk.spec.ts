/**
 * Smoke walk over every public page. Captures console errors, failed
 * network requests, and a screenshot per page so we can eyeball the
 * design.
 */
import { type ConsoleMessage, expect, test } from '@playwright/test';

interface QaPage {
  name: string;
  path: string;
  /** Redoc keeps a blob: download URL pending forever, so networkidle never fires there. */
  waitUntil?: 'load' | 'networkidle';
}

const PAGES: QaPage[] = [
  { name: 'home', path: '/' },
  { name: 'dams-list', path: '/dams' },
  { name: 'dams-list-pref10', path: '/dams?pref=10' },
  { name: 'dam-detail-kurobe', path: '/dams/dam-1102-16' },
  { name: 'dam-detail-yamba', path: '/dams/yamba-10' }, // may not exist; safe-fail
  { name: 'watersheds-list', path: '/watersheds' },
  { name: 'watershed-detail-tone', path: '/watersheds/watershed-利根川' },
  { name: 'prefecture-tokyo', path: '/prefectures/13' },
  { name: 'prefecture-toyama', path: '/prefectures/16' },
  { name: 'map', path: '/map' },
  { name: 'sources', path: '/sources' },
  { name: 'api-docs', path: '/api/docs', waitUntil: 'load' },
];

for (const p of PAGES) {
  test(`QA: ${p.name} (${p.path})`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    const failedRequests: string[] = [];
    page.on('requestfailed', (req) =>
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`),
    );
    const httpErrors: string[] = [];
    page.on('response', (res) => {
      if (res.status() >= 400 && res.url().includes('/api/v1/')) {
        httpErrors.push(`${res.status()} ${res.url()}`);
      }
    });

    const response = await page.goto(p.path, { waitUntil: p.waitUntil ?? 'networkidle' });
    await page.waitForTimeout(800); // settle any client-side fetches
    const status = response?.status() ?? 0;

    // Capture artifacts unconditionally for the QA walk.
    await page.screenshot({
      path: `test-results/qa-${p.name}.png`,
      fullPage: true,
    });

    // Suppress noisy known issues so the report focuses on real problems.
    const noiseRx = /(Download the React DevTools|Next\.js Dev Tools|hot-update|favicon)/i;
    const meaningfulConsoleErrors = consoleErrors.filter((e) => !noiseRx.test(e));
    const meaningfulFailedReqs = failedRequests.filter((r) => !noiseRx.test(r));

    const findings: string[] = [];
    if (status >= 500) findings.push(`HTTP ${status}`);
    if (meaningfulConsoleErrors.length)
      findings.push(`console.error: ${meaningfulConsoleErrors.join(' | ')}`);
    if (meaningfulFailedReqs.length)
      findings.push(`request failed: ${meaningfulFailedReqs.join(' | ')}`);
    if (httpErrors.length) findings.push(`api 4xx/5xx: ${httpErrors.join(' | ')}`);

    if (findings.length > 0) {
      console.log(`[${p.name}] ${findings.join(' ; ')}`);
    }
    // Don't fail the test on console noise — this is a QA pass, not a gate.
    expect(status, `${p.path} returned ${status}`).toBeLessThan(500);
  });
}
