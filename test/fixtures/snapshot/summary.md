# Search Console snapshot

**Property:** sc&#45;domain&#58;example&#46;com
**Requested interval:** (omitted) to (omitted)
**Effective interval:** 2026-07-30 to 2026-08-28
**Status:** partial

**Warning:** Search Console reports incomplete data beginning 2026-08-25.

## Adjustments

- start: defaulted-to-29-days-before-yesterday ((omitted) → 2026-07-30)
- end: defaulted-to-yesterday ((omitted) → 2026-08-28)

## Totals

| Clicks | Impressions | CTR | Average position |
| ---: | ---: | ---: | ---: |
| 9 | 80 | 11.25% | 2.25 |

For rows with zero impressions, CTR is 0.00% and average position is —. Metrics beyond the finite numeric range are shown as —.

## Query disclosure and page completeness

Search Console can suppress query-bearing rows for privacy. `page-query.json` is a disclosed subset for query research, not a complete account of page performance. Page clicks, page CTR, top pages, and page-level metrics come from the independent page-only dataset in `pages.json`; missing page-query clicks do not mean that a page received zero clicks.

| Measure | Clicks | Impressions |
| --- | ---: | ---: |
| Property total | 9 | 80 |
| Page-only rows | 9 | 80 |
| Page-query rows | 5 | 40 |

| Page-query disclosure relative to page-only rows | Value |
| --- | ---: |
| Click disclosure | 55.56% |
| Impression disclosure | 50.00% |

Disclosure totals use sums of clicks and impressions. CTR and position are not averaged across rows.

## Top queries

| Query | Clicks | Impressions | CTR | Average position |
| --- | ---: | ---: | ---: | ---: |
| alpha | 5 | 40 | 12.50% | 3.50 |
|  | 0 | 0 | 0.00% | — |

## Top pages

| Page | Clicks | Impressions | CTR | Average position |
| --- | ---: | ---: | ---: | ---: |
| https&#58;&#47;&#47;example&#46;com&#47;a&#124;pipe<br>next | 7 | 50 | 14.00% | 1.50 |
| https&#58;&#47;&#47;example&#46;com&#47;b | 2 | 30 | 6.67% | 5.00 |

## Devices

| Device | Clicks | Impressions | CTR | Average position |
| --- | ---: | ---: | ---: | ---: |
| DESKTOP | 10 | 100 | 10.00% | 2.00 |
| MOBILE | 5 | 100 | 5.00% | 3.00 |

## Countries

| Country | Clicks | Impressions | CTR | Average position |
| --- | ---: | ---: | ---: | ---: |
| can | 3 | 50 | 6.00% | 2.00 |
| usa | 2 | 50 | 4.00% | 4.00 |

## Dataset rows

| Dataset | Rows |
| --- | ---: |
| page-query.json | 3 |
| pages.json | 2 |
| devices.json | 2 |
| countries.json | 2 |
| totals.json | 1 |

Search Console may return only top rows; pagination does not guarantee exhaustive data.
