# Dam data platform

Japanese reservoir data gathered from many public providers, linked to one master list of dams, and shown as each dam's current state and history.

## Sources

**Provider**:
An organization that publishes dam data: a prefecture, an MLIT office, a water utility, a land improvement district.
_Avoid_: upstream, publisher

**Source**:
One feed from a provider that we read, identified by a stable source id. One provider may have several sources.
_Avoid_: adapter, task, feed id

**Source priority**:
The rank that decides which source wins when several hold an observation for the same dam and time.

**Trusted source**:
A source whose 貯水率 is the dam manager's own figure against the pool it is managed by, so it is preferred over a rate we derive ourselves.
_Avoid_: native-rate source

**Retired source**:
A source we no longer read, kept so its historical observations stay attributed and visible.
_Avoid_: deleted source, disabled source

## What a source publishes

**Universe**:
Everything a source publishes at one scan, whether or not we can link it to a dam or read a value from it.
_Avoid_: catalogue, station list, published dams

**Universe entry**:
One dam or station in a universe, in exactly one of three states: has values, provider-marked empty, or unreadable.

**Provider-marked empty**:
A universe entry the provider itself shows as carrying no value (調査対象外, "---" in every column, a page with no readings).
_Avoid_: no data, missing

**Unreadable**:
A universe entry we could not read a value from. It may be our own reading that broke, so it says nothing about what the provider publishes.
_Avoid_: no data, missing, empty

## Readings

**Observation**:
One source's values for one dam at one time.
_Avoid_: row, record, data point

**Value**:
An observation that carries at least one of 貯水量, 貯水率, 流入量, 放流量, 水位, 雨量. An observation with none of them is not data, whatever its timestamp.
_Avoid_: real data, has data

**Reading**:
The single observation that stands for a dam at a moment. Every view of that dam at that moment (dam page, 平年比, map, 水系, 全国) shows the same reading.
_Avoid_: latest row, newest row, display observation

**Daily value**:
The single observation that stands for a dam on one day in its history: the day's newest observation that carries a value. Unlike a reading, it never prefers a source for being fresh.
_Avoid_: daily reading, last value

**Effective capacity**:
The denominator of a dam's 貯水率: the capacity implied by a trusted source's own rate when there is one, otherwise the master 有効貯水容量. Every 貯水率, for a dam, a 水系 or the whole country, divides by it.
_Avoid_: active capacity (when meaning the denominator)

## Coverage

**Coverage status**:
Why a dam does or does not have data, as one of: covered, published_not_ingested, published_no_data, not_published, unknown.
_Avoid_: data status, availability

**Coverage triage**:
Assigning every dam its coverage status from the universes and the values we hold, as one consistent snapshot.
_Avoid_: classification, coverage check
