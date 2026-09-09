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

## Cloudflare Worker

`worker/` holds a second implementation that runs the same pipeline on a
Cloudflare cron trigger and serves the lists from R2, so the router fetches from
the Cloudflare edge instead of `raw.githubusercontent.com`.

It is a port, not a rewrite: `worker/test/compare.mjs` runs the Worker's logic
under node against the same inputs and diffs the result against what
`generate.py` produced. All eight files must come out byte-identical.

```bash
cd worker && npm install
node test/compare.mjs /path/to/ipinfo_lite.csv.gz /path/to/ServiceTags_Public_*.json '<ENDPOINT_IP>/32'
```

### Consistency model

Each run writes to `v/<generation>/…` and only flips the `current.json` pointer
once every file has been written. A run that dies partway through leaves an
orphaned generation that nothing points at, and the router keeps getting the
previous complete generation — it can never import a half-written list and
flush its own address-list. Old generations are pruned to `KEEP_GENERATIONS`,
and they double as the diff history: to see why a list changed, diff two
generations' `.txt`.

`current.json` also carries per-list counts and the delta against the previous
run, and `history.json` keeps the last 90 runs. A list that suddenly loses
several thousand prefixes shows up there.

### Deploy

Needs Workers Paid: a cron trigger on the free plan gets 10 ms of CPU, and this
job uses about 2.4 s. Crons with an interval of an hour or more get 15 minutes.

```bash
cd worker
npm install
npx wrangler login
npx wrangler r2 bucket create cidr-lists
npx wrangler secret put IPINFO_TOKEN
npx wrangler secret put EXCLUDE_CIDR    # your tunnel endpoint, e.g. 203.0.113.7/32
npx wrangler deploy
npx wrangler deploy --dry-run           # config/bundle check, no account needed
```

Then run it once by hand rather than waiting for the cron, and check the result:

```bash
curl https://<your-worker>/status
curl https://<your-worker>/CN_HK_SG_CIDR_V4.rsc | head -3
```

Point the router at it:

```
/tool fetch url="https://<your-worker>/CN_HK_SG_CIDR_V4.rsc" dst-path=CN_HK_SG_CIDR_V4.rsc;
/import file-name=CN_HK_SG_CIDR_V4.rsc;
```

Non-secret settings (`COUNTRIES`, `COMBINED_NAME`, `EXCLUDE_AZURE_REGIONS`,
`KEEP_GENERATIONS`) live in `worker/wrangler.jsonc` under `vars`.

### Why the CSV and not mmdb or parquet

IPinfo publishes the same data as `.mmdb` and `.parquet`. Measured, the CSV is
the smallest download of the four (21.6 MiB, vs 22.7 mmdb, 24.1 parquet, 25.3
json.gz), and it is the only one that streams. MMDB is a lookup structure —
enumerating every prefix in a region means walking its search trie yourself,
which is more code than `split(",")`, and the reader needs the whole file
buffered. Parquet needs a decoder bundled into the Worker and range requests
through a signed redirect. The parse was never the expensive part.

## Layout

- `update.sh` — driver: downloads the two data sources, resolves the weekly
  Azure URL, hands off to `generate.py`
- `generate.py` — streams the ~3.4M-row IPinfo CSV, collects integer intervals
  per region, merges, subtracts exclusions, emits CIDRs and the `.rsc` files
- `worker/src/lib.js` — the same pipeline in JS, no Workers-specific APIs, so it
  can be tested under node. IPv4 is handled as unsigned integer intervals using
  arithmetic, never bitwise: JS coerces `<<` and `&` operands to int32, so
  `128 << 24` is negative and `x & -x` is wrong above 2^31
- `worker/src/index.js` — cron handler, R2 writes, generation pointer, and the
  HTTP handler the router fetches from

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
