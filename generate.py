#!/usr/bin/env python3
"""从 IPinfo Lite 生成 RouterOS address-list。

数据源  https://ipinfo.io/data/ipinfo_lite.csv.gz  (免费 token 即可下载)
列      network,country,country_code,continent,continent_code,asn,as_name,as_domain

两个数据坑:
  - network 列可能是裸 IP(单地址),不带 /32 后缀
  - country 列的国家名可能带逗号并加引号,会把后面的列挤位
"""
import argparse
import csv
import gzip
import io
import ipaddress
import json
import shutil
import sys
import tempfile
from pathlib import Path

PROGRESS_EVERY = 500_000


def log(msg):
    print(msg, flush=True)


def die(msg):
    log(f"ERROR: {msg}")
    sys.exit(1)


def parse_row(line):
    """-> (network, country_code, asn) 或 None"""
    f = line.rstrip("\n").split(",")
    if len(f) < 6 or len(f[2]) != 2 or not f[2].isupper():
        try:
            f = next(csv.reader(io.StringIO(line)))
        except StopIteration:
            return None
        if len(f) < 6:
            return None
    return f[0], f[2], f[5]


def to_interval(net):
    """"a.b.c.d/p" 或 "a.b.c.d" -> (start, end) 整数闭区间"""
    ip, _, pfx = net.partition("/")
    a, b, c, d = ip.split(".")
    start = (int(a) << 24) | (int(b) << 16) | (int(c) << 8) | int(d)
    return start, start + (1 << (32 - int(pfx or 32))) - 1


def merge(intervals):
    """排序 + 合并重叠与相邻的区间"""
    out = []
    for s, e in sorted(intervals):
        if out and s <= out[-1][1] + 1:
            if e > out[-1][1]:
                out[-1][1] = e
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def subtract(base, cut):
    """区间集合减法。base 和 cut 都必须已经 merge 过。线性一趟。"""
    out, j = [], 0
    for s, e in base:
        while j < len(cut) and cut[j][1] < s:
            j += 1
        k, cur = j, s
        while k < len(cut) and cut[k][0] <= e:
            cs, ce = cut[k]
            if cs > cur:
                out.append((cur, cs - 1))
            if ce + 1 > cur:
                cur = ce + 1
            if cur > e:
                break
            k += 1
        if cur <= e:
            out.append((cur, e))
    return out


def intersects(a, b):
    """两个已 merge 的区间集合是否相交,相交则返回第一对证据"""
    i = j = 0
    while i < len(a) and j < len(b):
        if a[i][1] < b[j][0]:
            i += 1
        elif b[j][1] < a[i][0]:
            j += 1
        else:
            return (a[i], b[j])
    return None


def to_cidrs(intervals):
    out = []
    for s, e in intervals:
        out += ipaddress.summarize_address_range(
            ipaddress.IPv4Address(s), ipaddress.IPv4Address(e)
        )
    return out


def count_addrs(intervals):
    return sum(e - s + 1 for s, e in intervals)


def read_lite(path, wanted):
    """扫 IPinfo Lite,按 country_code 收区间"""
    per_cc = {cc: [] for cc in wanted}
    rows = skipped = 0
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8", newline="") as fh:
        header = fh.readline()
        if "country_code" not in header:
            die(f"意外的表头,IPinfo Lite 格式可能变了: {header.strip()[:120]}")
        for line in fh:
            rows += 1
            if rows % PROGRESS_EVERY == 0:
                log(f"  ... 已扫 {rows:,} 行")
            r = parse_row(line)
            if r is None:
                skipped += 1
                continue
            net, cc, _asn = r
            if cc not in per_cc or ":" in net:
                continue
            try:
                per_cc[cc].append(to_interval(net))
            except (ValueError, IndexError):
                skipped += 1
    log(f"  扫完 {rows:,} 行,跳过 {skipped} 行无法解析")
    return per_cc, rows


def load_azure(tags_path, regions):
    """取 AzureCloud.<region>。实测它是该区域其他 service tag 的严格超集。"""
    data = json.loads(Path(tags_path).read_text(encoding="utf-8"))
    by_name = {v["name"]: v for v in data["values"]}
    out = []
    for region in regions:
        name = f"AzureCloud.{region}"
        if name not in by_name:
            die(f"service tag 里没有 {name}(区域名拼错?)")
        pfx = [p for p in by_name[name]["properties"]["addressPrefixes"] if ":" not in p]
        if not pfx:
            die(f"{name} 没有 IPv4 前缀")
        out += [to_interval(p) for p in pfx]
        log(f"  {name}: {len(pfx)} 个 IPv4 前缀")
    return merge(out)


def write_txt(out_dir, list_name, cidrs):
    with (out_dir / f"{list_name}.txt").open("w", encoding="utf-8", newline="\n") as fh:
        for n in cidrs:
            fh.write(f"{n}\n")


def write_rsc(out_dir, list_name, cidrs):
    with (out_dir / f"{list_name}.rsc").open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(f'/log info "Import {list_name} ipv4 cidr list..."\n')
        fh.write(
            "/ip firewall address-list remove "
            f"[/ip firewall address-list find list={list_name}]\n"
        )
        fh.write("/ip firewall address-list\n")
        for n in cidrs:
            fh.write(f":do {{add address={n} list={list_name}}} on-error={{}}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lite", required=True, help="ipinfo_lite.csv[.gz] 路径")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--countries", required=True, help="ISO 代码,空格分隔")
    ap.add_argument("--combined", required=True, help="合并列表名")
    ap.add_argument("--azure-tags", help="ServiceTags_Public_*.json 路径")
    ap.add_argument("--azure-regions", default="", help="要剔除的 Azure 区域,空格分隔")
    ap.add_argument("--exclude-cidr", default="", help="额外剔除的网段,空格分隔")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    wanted = args.countries.upper().split()
    if not wanted:
        die("--countries 为空")
    regions = args.azure_regions.split()

    log(f"目标地区: {' '.join(wanted)}")
    log(f"读取 {args.lite}")
    per_cc, _ = read_lite(args.lite, wanted)

    for cc in wanted:
        if not per_cc[cc]:
            die(f"{cc} 零命中,放弃(ISO 代码写错,或数据源格式变了)")
    merged = {cc: merge(v) for cc, v in per_cc.items()}

    # 不变量:同一个地址只能属于一个地区。源数据若有重叠行,后面的剔除和
    # 合并就都不可信了,所以这里硬检查而不是假设。
    for i, a in enumerate(wanted):
        for b in wanted[i + 1:]:
            hit = intersects(merged[a], merged[b])
            if hit:
                die(f"{a} 与 {b} 区间重叠 {hit},源数据不满足互斥假设")

    # ---- 剔除集合 ----
    cut = []
    if regions:
        if not args.azure_tags:
            die("指定了 --azure-regions 但没给 --azure-tags")
        log(f"剔除 Azure 区域: {' '.join(regions)}")
        cut += load_azure(args.azure_tags, regions)
    manual = args.exclude_cidr.split()
    if manual:
        # 只打条数不打原文:公开仓库的 Actions 日志是公开的,而这里通常放的是
        # 隧道端点 IP。
        log(f"剔除手工网段: {len(manual)} 条")
        for c in manual:
            try:
                n = ipaddress.ip_network(c, strict=False)
            except ValueError:
                die(f"--exclude-cidr 第 {manual.index(c) + 1} 项不是合法网段")
            if n.version != 4:
                die(f"--exclude-cidr 第 {manual.index(c) + 1} 项不是 IPv4")
            cut.append((int(n.network_address), int(n.broadcast_address)))
    cut = merge(cut)
    if cut:
        log(f"剔除集合: {len(cut)} 个区间 / {count_addrs(cut):,} 个地址")

    final = {}
    for cc in wanted:
        before = merged[cc]
        after = subtract(before, cut) if cut else before
        if not after:
            die(f"{cc} 剔除后为空,放弃")
        final[cc] = after
        gone = count_addrs(before) - count_addrs(after)
        log(f"  {cc}: {count_addrs(before):,} -> {count_addrs(after):,} 个地址"
            f"(剔掉 {gone:,})")

    combined = merge([iv for cc in wanted for iv in final[cc]])

    # 后置断言:剔除集合绝不能和任何一份输出列表相交
    for cc in wanted:
        hit = intersects(final[cc], cut)
        if hit:
            die(f"{cc} 列表仍与剔除集合相交: {hit}")
    hit = intersects(combined, cut)
    if hit:
        die(f"合并列表仍与剔除集合相交: {hit}")

    # ---- 落盘:先写暂存目录,全部通过再搬进 out_dir ----
    # 中途失败留下半成品的话,Actions 的 git add -A 会把它提交上去,
    # 路由器 import 时就拿一份不完整的列表覆盖了现有的 address-list。
    stage = Path(tempfile.mkdtemp())
    try:
        written = []
        for cc in wanted:
            cidrs = to_cidrs(final[cc])
            name = f"{cc}_CIDR_V4"
            write_txt(stage, name, cidrs)
            write_rsc(stage, name, cidrs)
            written.append((name, len(cidrs)))
        cidrs = to_cidrs(combined)
        write_txt(stage, args.combined, cidrs)
        write_rsc(stage, args.combined, cidrs)
        written.append((args.combined, len(cidrs)))

        for name, _ in written:
            for ext in (".txt", ".rsc"):
                shutil.copy2(stage / f"{name}{ext}", out_dir / f"{name}{ext}")
    finally:
        shutil.rmtree(stage, ignore_errors=True)

    log("")
    for name, n in written:
        log(f"  -> {name}.rsc / .txt  ({n} 条)")
    log("Update Success!")


if __name__ == "__main__":
    main()
