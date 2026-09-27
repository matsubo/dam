import { describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';

// Issue #55 (the attachments of #38): after 0048, the rows still showing
// storageRate ≠ storageVolumeM3 / effectiveActiveCapacityM3 came from sources
// nobody had verified. Each was checked against its live upstream; these
// assertions pin the verdicts so a later migration cannot silently flip them.

async function trusted(sourceId: string): Promise<boolean | null> {
  const [row] = await sql<{ trusted_rate_basis: boolean }[]>`
    SELECT trusted_rate_basis FROM source_priorities WHERE source_id = ${sourceId}
  `;
  return row?.trusted_rate_basis ?? null;
}

describe('trusted_rate_basis after issue #55', () => {
  for (const sourceId of ['skr-hiji-dam', 'qsr-turuta-dam', 'jwa-chikugo', 'kagawa-bousai']) {
    test(`${sourceId} publishes a 利水容量-based rate and is trusted`, async () => {
      expect(await trusted(sourceId)).toBe(true);
    });
  }

  // 貯水率 = 貯水量 / 満水時貯水量, a gross figure 1.5–17 % above 有効貯水容量.
  // Trusting it would put a denominator larger than the static one on the page.
  test('tndam-hyogo divides by 満水時貯水量 and stays untrusted', async () => {
    expect(await trusted('tndam-hyogo')).not.toBe(true);
  });
});

describe('trusted_rate_basis after issue #71', () => {
  // 貯水率（利水）: 川辺 volume/rate = 660 千m³, 大和 204, against annual 有効
  // 2,460 / 721 (0063).
  test('kagoshima-kasen publishes a 利水容量-based rate and is trusted', async () => {
    expect(await trusted('kagoshima-kasen')).toBe(true);
  });
});
