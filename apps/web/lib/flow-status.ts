// Plain-language water-balance status from a dam's latest 流入量 / 放流量.
// Ordinary visitors read raw m³/s numbers with no sense of what they mean;
// comparing inflow vs outflow tells them whether the reservoir is filling or
// being drawn down — the intuition behind "ダム放流".

export type FlowTone = 'fill' | 'drain' | 'balanced';

export interface FlowStatus {
  tone: FlowTone;
  label: string;
}

// Flows within ±this fraction of each other read as "balanced" — sensor noise
// and normal run-of-river operation shouldn't be dramatised as filling/draining.
const BALANCE_TOLERANCE = 0.15;

export function flowStatus(
  inflowM3s: number | null | undefined,
  outflowM3s: number | null | undefined,
): FlowStatus | null {
  if (inflowM3s == null || outflowM3s == null) return null;
  if (!Number.isFinite(inflowM3s) || !Number.isFinite(outflowM3s)) return null;

  // Both ~0: the dam is idle, not draining.
  if (inflowM3s <= 0 && outflowM3s <= 0)
    return { tone: 'balanced', label: '流入・放流ともほぼなし' };
  // Water leaving with ~no inflow → drawing down.
  if (inflowM3s <= 0) return { tone: 'drain', label: '放流が流入を上回る（水位低下傾向）' };

  // Ratio of outflow to inflow; ±BALANCE_TOLERANCE around parity is "balanced".
  const ratio = outflowM3s / inflowM3s;
  if (ratio > 1 + BALANCE_TOLERANCE)
    return { tone: 'drain', label: '放流が流入を上回る（水位低下傾向）' };
  if (ratio < 1 / (1 + BALANCE_TOLERANCE))
    return { tone: 'fill', label: '流入が放流を上回る（水位上昇傾向）' };
  return { tone: 'balanced', label: '流入と放流がほぼ均衡' };
}
