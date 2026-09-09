# RouterOS CN / HK / SG IP List

IPv4 CIDR list generator for MikroTik RouterOS, built from
[IPinfo Lite](https://ipinfo.io/developers/database-download).

[![Update IP CIDR lists](https://github.com/heiybb/GeoLite2_CN_ROS/actions/workflows/main.yml/badge.svg?branch=main)](https://github.com/heiybb/GeoLite2_CN_ROS/actions/workflows/main.yml)

## Lists

| File | address-list | Contents | Entries |
|---|---|---|---|
| `CN_CIDR_V4.rsc` | `CN_CIDR_V4` | Mainland China | ~12,700 |
| `HK_CIDR_V4.rsc` | `HK_CIDR_V4` | Hong Kong | ~25,400 |
| `SG_CIDR_V4.rsc` | `SG_CIDR_V4` | Singapore | ~24,100 |
| `CN_HK_SG_CIDR_V4.rsc` | `CN_HK_SG_CIDR_V4` | All three, merged | ~53,300 |

Each `.rsc` has a matching `.txt` holding the bare CIDR list. Prefixes are
aggregated (adjacent and nested ranges merged) and sorted ascending.

Every address belongs to exactly one region, so the three per-region lists never
overlap and can be imported side by side. The script asserts this on every run.

**Azure Southeast Asia is excluded from all four lists** — see
[Exclusions](#exclusions).

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

Importing a `.rsc` flushes its own address-list first, so re-running is safe.

## Which one to use

The merged list is the drop-in choice for "route this the China-optimised way".
Be aware that HK and SG are APAC cloud and CDN hubs: AWS `ap-southeast-1`,
plenty of SaaS APAC endpoints, and similar traffic that has nothing to do with
China all live in those ranges, and the merged list pulls every bit of it into
the same policy.

Per-region lists let you give CN its own policy and treat HK/SG as a fallback,
or skip them. That is usually the better shape.

## Exclusions

Two independent mechanisms, because they protect against different things.

### `EXCLUDE_AZURE_REGIONS` — whole Azure regions

Defaults to `southeastasia`. **The region your tunnel exit lives in must be
listed here.** A tunnel cannot beat a direct path to a destination inside its own
exit region: the tunnel's outer packets already traverse your ISP to reach the
exit machine, so the best it can do is that same RTT, plus encapsulation and one
extra forwarding hop. Routing that traffic through the tunnel buys nothing and
costs you a round of cloud egress billing.

Ranges come from Microsoft's published
[service tags](https://www.microsoft.com/en-us/download/details.aspx?id=56519).
The filename carries a publication date that changes weekly, so the script
scrapes the download page for the current URL and falls back to walking recent
dates. `AzureCloud.<region>` is used, which is a strict superset of every other
service tag for that region.

If the service tag file cannot be fetched, **the script aborts** rather than
generating lists without the exclusion.

### `EXCLUDE_CIDR` — specific prefixes

Space-separated CIDRs, removed from every list by exact set subtraction (a
covering prefix is split, not dropped whole).

**Put your tunnel endpoint's `/32` here**, even when it already falls inside an
excluded Azure region. The Azure exclusion depends on an external file; this one
depends on nothing. If the endpoint ever lands in a list, the router will route
the tunnel's own outer packets into the tunnel and the link dies.

Set it as a repository secret so GitHub masks it in Actions logs; the script only
ever logs the number of entries, never the values.

One caveat: an excluded `/32` that is *not* inside a larger excluded block leaves
a one-address hole in the published list, and the surrounding split prefixes point
straight at it. Inside an excluded region — the normal case — the whole block is
gone and nothing is visible.

### Also fix this on the router

List-level exclusion is not enough on its own, because the lists regenerate
daily and a data change can silently move a prefix. State the endpoint exception
once, in the routing config, where no data update can touch it:

```
/ip firewall mangle
add chain=prerouting action=accept dst-address=<ENDPOINT_IP> comment="WG endpoint: never into tunnel"
add chain=output     action=accept dst-address=<ENDPOINT_IP> comment="WG endpoint: never into tunnel"
```

Both go **above** the rule that sets the routing mark. Then a belt-and-braces
route, so a packet that somehow gets marked still leaves via the WAN:

```
/ip route
add dst-address=<ENDPOINT_IP>/32 gateway=<WAN_IF_OR_GW> routing-table=<your table> comment="WG endpoint via WAN"
```

## Configuration

`update.sh` reads these environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `IPINFO_TOKEN` | — | IPinfo API token (required). The free tier is enough — database downloads do not consume the API request quota |
| `COUNTRIES` | `CN HK SG` | ISO codes to generate, space separated. Add `TW MO JP` etc. |
| `COMBINED_NAME` | `CN_HK_SG_CIDR_V4` | Name of the merged list |
| `EXCLUDE_AZURE_REGIONS` | `southeastasia` | Azure regions to remove. Empty string disables |
| `EXCLUDE_CIDR` | — | Extra prefixes to remove, space separated |
| `IPINFO_LITE_FILE` | — | Path to an already-downloaded `ipinfo_lite.csv[.gz]`, skips the download. For offline testing |
| `AZURE_TAGS_FILE` | — | Path to an already-downloaded `ServiceTags_Public_*.json`, skips the download |

GitHub Actions reads `IPINFO_TOKEN` and `EXCLUDE_CIDR` from repository secrets.

Only `ipinfo_lite.*` is downloadable on the free tier; `location.csv.gz`,
`asn.csv.gz` and friends return HTTP 401.

## Layout

- `update.sh` — driver: downloads the two data sources, resolves the weekly
  Azure URL, hands off to `generate.py`
- `generate.py` — streams the ~3.4M-row IPinfo CSV, collects integer intervals
  per region, merges, subtracts exclusions, emits CIDRs and the `.rsc` files

Both bail out with a non-zero exit on an empty region, an emptied region, an
unparseable header, a bad exclusion, overlapping source regions, or an exclusion
that survives into the output. Files are written to a staging directory and only
moved into place once every check passes, so a failed run cannot leave a partial
list for Actions to commit.

Local run:

```bash
IPINFO_TOKEN=... bash update.sh
```

## Attribution

IP geolocation and ASN data by [IPinfo](https://ipinfo.io). Check the current
IPinfo Lite licence terms before redistributing derived data.
