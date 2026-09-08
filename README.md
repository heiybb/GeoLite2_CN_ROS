# RouterOS CN / HK / SG IP List

IP list script generator for MikroTik RouterOS, built from MaxMind GeoLite2-Country.

[![Get Geolite2 ipv4](https://github.com/heiybb/GeoLite2_CN_ROS/actions/workflows/main.yml/badge.svg?branch=main)](https://github.com/heiybb/GeoLite2_CN_ROS/actions/workflows/main.yml)

## Lists

| File | address-list | Contents |
|---|---|---|
| `CN_CIDR_V4.rsc` | `CN_CIDR_V4` | Mainland China only |
| `HK_CIDR_V4.rsc` | `HK_CIDR_V4` | Hong Kong only |
| `SG_CIDR_V4.rsc` | `SG_CIDR_V4` | Singapore only |
| `CN_HK_SG_CIDR_V4.rsc` | `CN_HK_SG_CIDR_V4` | All three, merged into one list |

Each `.rsc` has a matching `.txt` with the bare CIDR list.

A prefix appears in exactly one of the three per-region lists, so they never overlap
and can be imported side by side.

## ROS

Merged list — one address-list, one routing rule:

```
/tool fetch url="https://raw.githubusercontent.com/heiybb/GeoLite2_CN_ROS/main/CN_HK_SG_CIDR_V4.rsc" dst-path=CN_HK_SG_CIDR_V4.rsc;
/import file-name=CN_HK_SG_CIDR_V4.rsc;
```

Per-region lists — separate policies per region:

```
/tool fetch url="https://raw.githubusercontent.com/heiybb/GeoLite2_CN_ROS/main/CN_CIDR_V4.rsc" dst-path=CN_CIDR_V4.rsc;
/tool fetch url="https://raw.githubusercontent.com/heiybb/GeoLite2_CN_ROS/main/HK_CIDR_V4.rsc" dst-path=HK_CIDR_V4.rsc;
/tool fetch url="https://raw.githubusercontent.com/heiybb/GeoLite2_CN_ROS/main/SG_CIDR_V4.rsc" dst-path=SG_CIDR_V4.rsc;

/import file-name=CN_CIDR_V4.rsc;
/import file-name=HK_CIDR_V4.rsc;
/import file-name=SG_CIDR_V4.rsc;
```

Importing a `.rsc` first flushes its own address-list, so it is safe to re-run.

## Which one to use

The merged list is the drop-in choice if you just want "route this traffic the
China-optimised way". Note that HK and SG are APAC cloud/CDN hubs — AWS
ap-southeast-1, Cloudflare, and plenty of SaaS APAC endpoints live in those
ranges, and the merged list drags all of them into the same policy. The lists are
also large — HK and SG are far more fragmented than CN:

| List | Entries (2026-09-08 database) |
|---|---|
| `CN_CIDR_V4` | ~8,200 |
| `HK_CIDR_V4` | ~14,600 |
| `SG_CIDR_V4` | ~11,500 |
| `CN_HK_SG_CIDR_V4` | ~34,300 |

That is four times the old CN-only list. On a 256MB device (hEX and friends)
watch import time and memory before committing to the merged list.

Per-region lists let you give CN its own policy and treat HK/SG as a fallback, or
skip them entirely. That is usually the better shape.

**If you are upgrading from the old CN-only version, do not keep importing only
`CN_CIDR_V4.rsc`.** The old script matched any block whose *registered* country was
China, which pulled 339 Hong Kong / Singapore prefixes into `CN_CIDR_V4` (289 HK,
50 SG, measured against the 2026-09-05 list). Those prefixes now go to
`HK_CIDR_V4` / `SG_CIDR_V4` instead. They are still in the merged list, but a
CN-only import will no longer see them.

## Configuration

`update.sh` reads these environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `GEOLITE2_LICENSE_KEY` | — | MaxMind license key (required) |
| `COUNTRIES` | `CN HK SG` | ISO codes to generate, space separated. Add `TW MO JP` etc. |
| `COMBINED_NAME` | `CN_HK_SG_CIDR_V4` | Name of the merged list |
| `MATCH_REGISTERED` | `1` | Also match on registered country (see below) |
| `GEOLITE2_CSV_DIR` | — | Point at an already-unzipped GeoLite2-Country-CSV dir to skip the download; for offline testing |

With `MATCH_REGISTERED=1`, a block whose actual location is outside the target set
but whose registered country is inside it gets filed under the registered country.
That is what catches Tencent / Alibaba ranges registered in China but hosted
abroad. Actual location always wins when it is itself in the target set.

Set `MATCH_REGISTERED=0` for strict geographic matching.
