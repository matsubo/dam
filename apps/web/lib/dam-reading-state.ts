// What every view of one dam shows in place of "the reading": the page, its
// metadata, its Markdown twin and its share card. One decision, so a dam no
// provider publishes (提供元なし) cannot show an old mudam reading in one view
// and "no data" in another.

import { type DamCoverageRow, triageDam } from '@dam/db/repo/coverage';
import {
  type CanonicalTwin,
  canonicalTwin,
  type LatestObservation,
  latestObservation,
} from '@dam/db/repo/dams';
import { displayRate } from './rate-basis.ts';

export type DamReadingState =
  /** The dam's reading (docs/adr/0002), its 貯水率 and that rate's denominator. */
  | {
      readonly kind: 'reading';
      readonly latest: LatestObservation;
      /** Volume ÷ capacityM3, capped at 100 %; null without either. */
      readonly rate: number | null;
      /** The effective capacity the rate divides by (GLOSSARY). */
      readonly capacityM3: number | null;
    }
  /** No reading here: the （元）/（再） twin carries this facility's readings. */
  | { readonly kind: 'twin'; readonly twin: CanonicalTwin }
  /** 提供元なし: nobody publishes it, so no reading is shown even if old rows exist. */
  | { readonly kind: 'not_published' }
  /** Nothing to show; the coverage status says why. */
  | { readonly kind: 'none' };

/** reading > twin > 提供元なし > nothing, the order the dam views have always used. */
export function damReadingState(
  latest: LatestObservation | null,
  status: DamCoverageRow['status'],
  twin: CanonicalTwin | null,
): DamReadingState {
  if (latest && status !== 'not_published') {
    const capacityM3 = latest.effectiveActiveCapacityM3
      ? Number(latest.effectiveActiveCapacityM3)
      : null;
    const volume = latest.storageVolumeM3 ? Number(latest.storageVolumeM3) : null;
    return { kind: 'reading', latest, rate: displayRate(capacityM3, volume), capacityM3 };
  }
  if (twin) return { kind: 'twin', twin };
  return status === 'not_published' ? { kind: 'not_published' } : { kind: 'none' };
}

export interface DamReading {
  readonly state: DamReadingState;
  /** The triage row (status, publishers) the views explain a missing reading with. */
  readonly triage: DamCoverageRow | null;
}

/** The state for one dam; the twin is looked up only when there is no reading. */
export async function loadDamReading(damId: bigint): Promise<DamReading> {
  const [latest, triage] = await Promise.all([latestObservation(damId), triageDam(damId)]);
  const twin = latest ? null : await canonicalTwin(damId);
  return { state: damReadingState(latest, triage?.status ?? 'unknown', twin), triage };
}
