#! /bin/bash
set -o pipefail
WORK_DIR=$(cd "$(dirname "$0")" && pwd)

# ---- 配置区 ----------------------------------------------------------------
# 要生成的国家/地区,ISO 代码,空格分隔。想再加台湾/澳门/日本就往后加 TW MO JP
COUNTRIES="${COUNTRIES:-CN HK SG}"
# 合并列表的名字(所有地区塞进同一个 address-list,方便一条路由规则搞定)
COMBINED_NAME="${COMBINED_NAME:-CN_HK_SG_CIDR_V4}"
# 1 = 同时按「注册国家」匹配(能捞到腾讯/阿里注册在中国但落地海外的段)
MATCH_REGISTERED="${MATCH_REGISTERED:-1}"
# 离线自测用:指向一个已解压的 GeoLite2-Country-CSV 目录,设了就跳过下载
GEOLITE2_CSV_DIR="${GEOLITE2_CSV_DIR:-}"
# ---------------------------------------------------------------------------

# CSV 里的 ISO 代码是大写,统一规格化,免得传了小写导致全都匹配不上
COUNTRIES=$(echo "$COUNTRIES" | tr '[:lower:]' '[:upper:]')

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
SELECTED="$STAGE/geo_selected.tsv"

if [ -n "$GEOLITE2_CSV_DIR" ]; then
    BLOCKS="$GEOLITE2_CSV_DIR/GeoLite2-Country-Blocks-IPv4.csv"
    LOCATIONS="$GEOLITE2_CSV_DIR/GeoLite2-Country-Locations-en.csv"
    echo "Using local CSV dir: $GEOLITE2_CSV_DIR"
else
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
    # 解压出来的目录名带日期(GeoLite2-Country-CSV_20260908),不能写死
    BLOCKS=$(ls -d /tmp/GeoLite2-Country-CSV_*/GeoLite2-Country-Blocks-IPv4.csv | head -1)
    LOCATIONS=$(ls -d /tmp/GeoLite2-Country-CSV_*/GeoLite2-Country-Locations-en.csv | head -1)
    cd - >/dev/null
fi

for f in "$BLOCKS" "$LOCATIONS"; do
    if [ ! -s "$f" ]; then
        echo "Missing or empty CSV: $f"
        exit 1
    fi
done

# 用 Locations 表把 ISO 代码翻译成 geoname_id,不再硬编码 1814991 这种魔数。
# awk 双文件模式:LOCATIONS 必须排在 BLOCKS 前面传入,否则 id2iso 是空的。
# Blocks 列序: network, geoname_id, registered_country_geoname_id,
#              represented_country_geoname_id, is_anonymous_proxy,
#              is_satellite_provider, is_anycast
awk -v want="$COUNTRIES" -v use_reg="$MATCH_REGISTERED" -F',' '
  BEGIN {
    n = split(want, a, " ");
    for (i = 1; i <= n; i++) wanted[a[i]] = 1;
  }
  # 第一个文件:建 geoname_id -> ISO 映射。国家名可能带引号("Hong Kong"),先去掉
  NR==FNR {
    if (FNR > 1) { gsub(/"/, ""); id2iso[$1] = $5 }
    next
  }
  FNR==1 { next }                                       # 跳过 Blocks 表头
  {
    iso = id2iso[$2];                                   # 实际落地地区
    reg = id2iso[$3];                                   # 注册地区
    if (iso == "" && use_reg == "1") iso = reg;         # 落地地区为空时退回注册地区
    if (use_reg == "1" && !(iso in wanted) && (reg in wanted)) iso = reg;
    if (iso in wanted) print iso "\t" $1;
  }
' "$LOCATIONS" "$BLOCKS" > "$SELECTED"

if [ ! -s "$SELECTED" ]; then
    echo "No CIDR matched, abort."
    exit 1
fi

# 生成一个 .rsc:$1=address-list 名称  $2=网段清单文件
# 三个变量必须分三行 local:写成一行时同语句里的 $list_name 还没赋值,展开成空
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

# 先全部算到暂存目录并检查。任一地区为空就整体放弃,不留半成品在仓库里 ——
# 空列表被 Actions 提交上去,路由器 import 时会把原来的 address-list 清空。
for iso in $COUNTRIES; do
    awk -v c="$iso" -F'\t' '$1==c {print $2}' "$SELECTED" > "$STAGE/${iso}_CIDR_V4.txt"
    if [ ! -s "$STAGE/${iso}_CIDR_V4.txt" ]; then
        echo "No CIDR matched for ${iso}, abort."
        exit 1
    fi
done
# Blocks 表里网段本来就唯一且按数值升序,去重保序即可,不要 sort 打乱顺序
cut -f2 "$SELECTED" | awk '!seen[$0]++' > "$STAGE/${COMBINED_NAME}.txt"

# 检查全过了,再落盘
for iso in $COUNTRIES; do
    cp "$STAGE/${iso}_CIDR_V4.txt" "$WORK_DIR/${iso}_CIDR_V4.txt"
    gen_rsc "${iso}_CIDR_V4" "$WORK_DIR/${iso}_CIDR_V4.txt"
done
cp "$STAGE/${COMBINED_NAME}.txt" "$WORK_DIR/${COMBINED_NAME}.txt"
gen_rsc "$COMBINED_NAME" "$WORK_DIR/${COMBINED_NAME}.txt"

echo "Update Success!"
