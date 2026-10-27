// The interface of the ingest run (./run.ts). Terms follow /GLOSSARY.md: a
// scan returns the source's universe, one entry per dam or station the
// provider publishes, each with one of three states.

/** What a source publishes at one scan. */
export interface Scan {
  /** The provider's WHOLE published list, in provider order. */
  readonly entries: readonly Entry[];
  /**
   * The provider prints its own date and publishes less often than every 30
   * days (a monthly survey, a weekly table). The run then records, for every
   * entry it writes, the newest observedAt as the entry's publishedAt.
   */
  readonly dated?: true;
}

/** One universe entry. */
export interface Entry {
  /**
   * The upstream id (else the printed name): the universe key and the stamp
   * in dams.external_ids. Entries sharing a key are merged.
   */
  readonly key: string;
  /** The name as printed. */
  readonly name: string;
  /**
   * Where its master dam is: one prefecture code (also recorded on the
   * entry), several codes (lookup scope only), or null (only a pin or an
   * existing stamp can bind it).
   */
  readonly pref: string | readonly string[] | null;
  readonly lat?: number | null;
  readonly lng?: number | null;
  /** How to find the master dam. Default: the name ladder on `name`. */
  readonly bind?: Bind;
  /**
   * Record the entry but never stamp or write it, with the reason (a dam a
   * better source covers, a row outside an allow-list).
   */
  readonly dontWrite?: string;
  /**
   * What the provider shows, or how to read it once the run knows the dam.
   * A function is called once, in list order, with the bound dam or null;
   * if it throws, the entry is unreadable. An entry is never dropped.
   */
  readonly reading: Reading | ((dam: BoundDam | null) => Reading | Promise<Reading>);
}

/** The three states of a universe entry. The run never infers one. */
export type Reading =
  | { readonly state: 'values'; readonly observations: readonly Observed[] }
  /** The provider's own mark, quoted: 欠測 flags, 調査対象外, "---" in every column. */
  | { readonly state: 'empty'; readonly mark: string }
  /** Why we could not read it: HTTP status, an unrecognised page, an unparsed cell. */
  | { readonly state: 'unreadable'; readonly why: string };

/** One observation's values, before the run adds the dam and the source. */
export interface Observed {
  readonly observedAt: Date;
  readonly storageVolumeM3?: number | null;
  /** 0..1 fraction. */
  readonly storageRate?: number | null;
  readonly inflowM3s?: number | null;
  readonly outflowM3s?: number | null;
  readonly waterLevelM?: number | null;
  readonly rainfallMm?: number | null;
}

export type Bind =
  /** Pinned by NDI id anywhere in the country; beats a stamp. */
  | { readonly ndi: string }
  /**
   * The ladder on `name` (default: the entry's name). `exact` stops before
   * the prefix and contains rungs.
   */
  | { readonly name?: string; readonly exact?: true }
  /** Not one master dam (a combined row, a weir): recorded unresolved. */
  | 'never';

/** What a reading function may use from its dam. */
export interface BoundDam {
  readonly id: bigint;
  readonly name: string;
  readonly totalCapacityM3: number | null;
  readonly activeCapacityM3: number | null;
}

/**
 * `contract`: the scan broke the interface (a task bug; nothing written).
 * `nothing-read`: no entry could be read; the universe is recorded, then the
 * job fails so graphile-worker retries it.
 */
export class IngestRunError extends Error {
  constructor(
    readonly kind: 'contract' | 'nothing-read',
    message: string,
  ) {
    super(message);
    this.name = 'IngestRunError';
  }
}
