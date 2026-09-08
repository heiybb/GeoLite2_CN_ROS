# GeoLite2_CN_ROS 改造计划:支持 CN / HK / SG 多地区列表

工作目录:`D:\WizardProject\GeoLite2_CN_ROS`

---

## 0. 背景

抓包发现 QQ 文件上传的中转服务器 `129.226.107.115`(腾讯云国际站,AS132203)**没有被现有的 `CN_CIDR_V4` 列表命中**,导致策略路由走错线路,RTT 高达 280 ms。

根因:现有 `update.sh` 只用 `grep ',1814991,'` 抓中国的 geoname_id。而 GeoLite2 把 `129.226.0.0/16` 标注为境外(新加坡/香港),所以天然收不进来。同类漏网的还有 `43.155.x`、`43.156.x`、`43.173.x`、`43.174.x` —— 全是腾讯的海外池。

## 1. 目标

1. 让 `update.sh` 支持任意多个国家/地区,首批 `CN HK SG`。
2. 不再硬编码 geoname_id 魔数,改为从 `GeoLite2-Country-Locations-en.csv` 按 ISO 代码反查。
3. 支持按「注册国家」匹配,捞出腾讯/阿里这类注册在中国、机器放海外的段。
4. 同时输出**分地区独立列表**和**合并列表**,让路由策略可以区别对待。
5. 保持向后兼容:`CN_CIDR_V4.rsc` 文件名和格式不变,路由器上现有的 `/import` 语句不用动。

## 2. 前置检查

- [ ] `git status` 干净,当前在 `main` 分支且已 `git pull`
- [ ] 确认仓库 Settings → Secrets 里 `GEOLITE2_LICENSE_KEY` 还有效(MaxMind 的 key 会过期)
- [ ] 记录改动前 `CN_CIDR_V4.txt` 的行数(基线,当前约 8529 条),用于事后对比
- [ ] 备份:`copy update.sh update.sh.bak`(或直接靠 git,不额外备份也行)

## 3. 改动清单

### 3.1 重写 `update.sh`(主改动)

参考实现见本文档**附录 A**,可直接采用。核心要求:

| 项 | 要求 |
|---|---|
| 配置方式 | 顶部配置区,`COUNTRIES="CN HK SG"` 空格分隔 ISO 代码,支持环境变量覆盖 |
| ID 解析 | 读 `GeoLite2-Country-Locations-en.csv` 建 `geoname_id → ISO` 映射,禁止硬编码 `1814991` |
| 注册国家匹配 | 开关 `MATCH_REGISTERED`(默认 1)。同时看 `geoname_id`(第 2 列)和 `registered_country_geoname_id`(第 3 列) |
| 归属判定 | 优先用实际落地国;落地国为空或不在目标集合、但注册国在目标集合时,归到注册国 |
| 输出 | 每个 ISO 一份 `{ISO}_CIDR_V4.txt` + `.rsc`,外加合并的 `CN_HK_SG_CIDR_V4.txt` + `.rsc` |
| 容错 | 匹配结果为空时 `exit 1`,不要生成空列表把路由器上的列表清掉 |
| 清理 | 去掉原脚本末尾多余的 `echo "}"`(历史遗留,RouterOS 导入时是多余的) |

**注意 CSV 列序**(GeoLite2-Country-Blocks-IPv4.csv):

```
network, geoname_id, registered_country_geoname_id, represented_country_geoname_id,
is_anonymous_proxy, is_satellite_provider, is_anycast
```

`GeoLite2-Country-Locations-en.csv` 里 ISO 代码在**第 5 列**(`country_iso_code`),注意国家名可能带引号(如 `"Hong Kong"`),解析时要去引号。

### 3.2 新增 `.gitattributes`

Windows 下编辑 shell 脚本,Git 可能转成 CRLF,Actions 的 Ubuntu runner 跑 `bash update.sh` 会报 `$'\r': command not found`。

```
*.sh text eol=lf
```

加完后如果文件已经是 CRLF,需要 `git add --renormalize .` 让它重新规范化。

### 3.3 更新 `README.md`

补上新增的三个 `.rsc` 的 fetch/import 示例,并说明分地区列表和合并列表的区别、各自适合什么场景。

### 3.4 GitHub Actions —— **不需要改**

现有 `.github/workflows/main.yml` 用的是 `git add -A`,新生成的文件会自动被提交。确认一下即可,不要动。

## 4. 验证

### 4.1 离线单元测试(不消耗 MaxMind 配额,优先做这个)

造一份最小的仿真 CSV,覆盖所有分支。**必须包含**下面这几种样本:

| 样本 | 落地国 | 注册国 | 期望结果 |
|---|---|---|---|
| `1.0.1.0/24` | CN | CN | 进 CN 列表 |
| `129.226.96.0/19` | SG | CN | 进 SG 列表(只勾 CN 时应进 CN 列表) |
| `43.174.220.0/22` | HK | HK | 进 HK 列表 |
| `1.2.3.0/24` | 空 | CN | 进 CN 列表(测空值回退) |
| `5.6.7.0/24` | JP | US | 全部排除 |
| `8.8.8.0/24` | US | US | 全部排除 |

把脚本里下载和解压那几行临时跳过,指向仿真目录跑一遍,检查四份 `.rsc` 的内容和条目数。

### 4.2 真实数据验证

用真 key 跑一次完整流程,然后检查:

```bash
# 关键验收点:上传服务器 IP 必须被命中
python3 - <<'EOF'
import ipaddress
for f in ['CN_CIDR_V4.txt','HK_CIDR_V4.txt','SG_CIDR_V4.txt','CN_HK_SG_CIDR_V4.txt']:
    nets=[ipaddress.ip_network(l.strip()) for l in open(f) if l.strip()]
    for ip in ['129.226.107.115','183.47.102.211','43.173.131.185',
               '43.174.220.28','43.155.124.138','43.156.222.210']:
        a=ipaddress.ip_address(ip)
        hit=[str(n) for n in nets if a in n]
        if hit: print(f'{f:24} {ip:18} -> {hit}')
EOF
```

### 4.3 验收标准

- [ ] `129.226.107.115` 出现在 `CN_HK_SG_CIDR_V4.txt` 中(**这是本次改造的核心目标**)
- [ ] `CN_CIDR_V4.txt` 条目数与改造前基线相比无明显缩水(±5% 以内,只增不减更好)
- [ ] 三份分地区列表两两之间无重复网段
- [ ] 每份 `.rsc` 的前三行结构正确:`/log info` → `address-list remove` → `/ip firewall address-list`
- [ ] `.rsc` 末尾没有多余的 `}` 行
- [ ] `bash -n update.sh` 语法检查通过
- [ ] 文件是 LF 换行(`file update.sh` 不应显示 CRLF)

## 5. 提交与发布

```bash
git add -A
git commit -m "Support CN/HK/SG regions, resolve ISO codes from Locations CSV"
git push
```

推送后到 Actions 页面手动触发一次 **Get Geolite2 ipv4** 的 `Run workflow`,确认:

- workflow 绿灯通过
- bot 提交里出现了 `HK_CIDR_V4.rsc`、`SG_CIDR_V4.rsc`、`CN_HK_SG_CIDR_V4.rsc`
- `CN_CIDR_V4.rsc` 的 diff 只有内容更新,格式没变

## 6. 本次范围之外(路由器侧,做完再说)

改完仓库**先别急着上路由器**。有两件事要想清楚:

**条目数会涨。** CN 现在 8529 条,加 HK + SG 后合并列表大概到 1.3 万条。RouterOS 扛得住,但 hEX 这类 256MB 内存的小设备要留意导入耗时和内存。

**整片 HK + SG 塞进同一条策略,副作用不小。** 新加坡和香港是亚太的云和 CDN 枢纽,AWS ap-southeast-1、Cloudflare、各种 SaaS 的亚太节点全在里面。如果规则是「命中列表 → 走中国优化线路」,这些跟中国无关的服务会被一起拽去绕远路。**建议 CN 走一条策略、HK/SG 单独一条或仅作兜底**,这也是脚本要输出分地区列表的原因。

更外科手术式的替代方案:**按腾讯 ASN(AS132203 / AS45090 / AS132591)单独做一个 address-list**,只有几百条前缀,精准覆盖腾讯国内外全部节点,不误伤 AWS 和 Cloudflare。两种方案可以并存,ASN 列表优先级更高,地区列表兜底。这个可以作为下一个任务。

另外别忘了:**改 CIDR 判定不一定能解决慢的问题。** 先对 `129.226.107.115` 和 `43.174.220.28` 各做一次 `tracert -d` 对比。如果 280 ms 的延迟产生在你自己的隧道/代理入口之前,那改路由有用;如果是腾讯那边落地路由本身烂,改了也救不回来。

---

## 附录 A:参考实现

```bash
#! /bin/bash
set -o pipefail
WORK_DIR=$(cd $(dirname $0); pwd);

# ---- 配置区 ----------------------------------------------------------------
# 要生成的国家/地区,ISO 代码,空格分隔。想再加台湾/澳门/日本就往后加 TW MO JP
COUNTRIES="${COUNTRIES:-CN HK SG}"
# 合并列表的名字(所有地区塞进同一个 address-list,方便一条路由规则搞定)
COMBINED_NAME="${COMBINED_NAME:-CN_HK_SG_CIDR_V4}"
# 1 = 同时按「注册国家」匹配(能捞到腾讯/阿里注册在中国但落地海外的段)
MATCH_REGISTERED="${MATCH_REGISTERED:-1}"
# ---------------------------------------------------------------------------

if [ ! -d "$WORK_DIR/tmp" ];then
  mkdir $WORK_DIR/tmp
fi

IPURL="https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country-CSV&license_key=${GEOLITE2_LICENSE_KEY}&suffix=zip"
GEO_ZIP=/tmp/geolite2.zip

/usr/bin/curl --retry 5 --retry-delay 3600 --connect-timeout 10 --max-time 60 -sL "$IPURL" > $GEO_ZIP
if [ `file $GEO_ZIP | grep Zip | wc -l` = "0" ]
then
    echo "Fail to fetch GeoIP database file."
    exit 1
fi

cd /tmp
rm -rf GeoLite2-Country-CSV_*
unzip -o -q $GEO_ZIP
BLOCKS=$(ls -d /tmp/GeoLite2-Country-CSV_*/GeoLite2-Country-Blocks-IPv4.csv | head -1)
LOCATIONS=$(ls -d /tmp/GeoLite2-Country-CSV_*/GeoLite2-Country-Locations-en.csv | head -1)
cd - >/dev/null

# 用 Locations 表把 ISO 代码翻译成 geoname_id,不再硬编码 1814991 这种魔数
awk -v want="$COUNTRIES" -v use_reg="$MATCH_REGISTERED" -F',' '
  NR==FNR {
    if (FNR>1) { gsub(/"/,""); id2iso[$1]=$5 }
    next
  }
  FNR==1 {
    n=split(want, a, " ");
    for (i=1;i<=n;i++) wanted[a[i]]=1;
    next
  }
  {
    iso = id2iso[$2];                                   # 实际归属地
    if (iso == "" && use_reg=="1") iso = id2iso[$3];    # 无归属地时退回注册国家
    if (use_reg=="1" && !(iso in wanted) && (id2iso[$3] in wanted)) iso = id2iso[$3];
    if (iso in wanted) print iso"\t"$1;
  }
' "$LOCATIONS" "$BLOCKS" > /tmp/geo_selected.tsv

if [ ! -s /tmp/geo_selected.tsv ]; then
    echo "No CIDR matched, abort."
    exit 1
fi

# 生成一个 .rsc:$1=address-list 名称  $2=网段清单文件
gen_rsc() {
    local list_name="$1"
    local src="$2"
    local out="$WORK_DIR/${list_name}.rsc"
    cat > "$out" << EOF
/log info "Import ${list_name} ipv4 cidr list..."
/ip firewall address-list remove [/ip firewall address-list find list=${list_name}]
/ip firewall address-list
EOF
    awk -v ln="$list_name" '{ printf(":do {add address=%s list=%s} on-error={}\n", $0, ln) }' "$src" >> "$out"
    echo "  -> ${list_name}.rsc ($(wc -l < "$src") 条)"
}

# 1) 每个地区一份独立列表(CN_CIDR_V4 / HK_CIDR_V4 / SG_CIDR_V4)
for iso in $COUNTRIES; do
    awk -v c="$iso" -F'\t' '$1==c {print $2}' /tmp/geo_selected.tsv > "$WORK_DIR/${iso}_CIDR_V4.txt"
    gen_rsc "${iso}_CIDR_V4" "$WORK_DIR/${iso}_CIDR_V4.txt"
done

# 2) 再来一份合并的
cut -f2 /tmp/geo_selected.tsv | sort -u > "$WORK_DIR/${COMBINED_NAME}.txt"
gen_rsc "$COMBINED_NAME" "$WORK_DIR/${COMBINED_NAME}.txt"

echo "Update Success!"
```

**已知坑位:**

- `gen_rsc()` 里三个变量必须分三行 `local` 声明。写成 `local a="$1" b="$2" c="$WORK_DIR/${a}.rsc"` 时 `$a` 在同一条语句里展开为空,会生成一个叫 `.rsc` 的文件 —— 这个坑我踩过了。
- `awk` 用了 `NR==FNR` 双文件模式,`LOCATIONS` 必须排在 `BLOCKS` 前面传入。
- MaxMind 的 zip 解压出来的目录名带日期(`GeoLite2-Country-CSV_20260908`),所以用 `ls -d ... | head -1` 取路径,不要写死。
