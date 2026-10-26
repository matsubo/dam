import { providerAvailability, triageDams } from '@dam/db/repo/coverage';
import type { DamListItem } from '@dam/db/repo/dams';

/**
 * The `DamListItem` shape every dam-list endpoint returns, `dataProvider`
 * included (/api/v1/dams/{slug} adds coverageStatus and publishedBy).
 */
export async function damListItems(items: DamListItem[]) {
  const triage = await triageDams(items.map((d) => d.id));
  const statusById = new Map(triage.map((t) => [t.damId, t.status]));
  return items.map((d) => ({
    id: d.id.toString(),
    slug: d.slug,
    name: d.name,
    prefCode: d.prefCode,
    manager: d.manager,
    totalCapacityM3: d.totalCapacityM3,
    activeCapacityM3: d.activeCapacityM3,
    location: { lat: d.lat, lng: d.lng },
    watershed: d.watershedSlug ? { slug: d.watershedSlug, name: d.watershedName } : null,
    dataProvider: { availability: providerAvailability(statusById.get(d.id) ?? 'unknown') },
  }));
}
