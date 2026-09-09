#! /bin/bash
set -o pipefail
WORK_DIR=$(cd "$(dirname "$0")" && pwd)

# ---- 配置区 ----------------------------------------------------------------
# 要生成的地区,ISO 代码,空格分隔。想再加台湾/澳门/日本就往后加 TW MO JP
COUNTRIES="${COUNTRIES:-CN HK SG}"
# 合并列表的名字(所有地区塞进同一个 address-list,一条路由规则搞定)
COMBINED_NAME="${COMBINED_NAME:-CN_HK_SG_CIDR_V4}"
#
# 要从所有列表里剔除的 Azure 区域(微软 service tag 的区域名,空格分隔)。
# 隧道出口所在的那个区域必须在这里:隧道的外层包本身就要经你的 ISP 打到出口
# 机器,所以对同区域的目标,走隧道不可能快过直连,只会白付一份 Azure 出网流量。
EXCLUDE_AZURE_REGIONS="${EXCLUDE_AZURE_REGIONS:-southeastasia}"
#
# 额外手工剔除的网段,空格分隔。WireGuard 端点那个 /32 放这里 ——
# 它必须独立于上面的 Azure 剔除声明一次:微软那份文件哪天抓不到,
# Azure 剔除就整体失效,而端点一旦进了列表,隧道会自己把自己封死。
EXCLUDE_CIDR="${EXCLUDE_CIDR:-}"
#
# 离线自测:指向已下好的文件,设了就跳过对应的下载
IPINFO_LITE_FILE="${IPINFO_LITE_FILE:-}"
AZURE_TAGS_FILE="${AZURE_TAGS_FILE:-}"
# ---------------------------------------------------------------------------

MS_DL_PAGE="https://www.microsoft.com/en-us/download/details.aspx?id=56519"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# ---- 1. IPinfo Lite -------------------------------------------------------
# 免费 token 只能下 ipinfo_lite.*;location/asn/privacy 那几个会返回 401。
# 下数据库不消耗 API 调用配额。
if [ -n "$IPINFO_LITE_FILE" ]; then
    LITE="$IPINFO_LITE_FILE"
    echo "使用本地 IPinfo Lite: $LITE"
else
    if [ -z "$IPINFO_TOKEN" ]; then
        echo "IPINFO_TOKEN 未设置,无法下载 IPinfo Lite。"
        exit 1
    fi
    LITE="$STAGE/ipinfo_lite.csv.gz"
    echo "下载 IPinfo Lite ..."
    curl --retry 3 --retry-delay 10 --connect-timeout 15 --max-time 600 \
        -sSL "https://ipinfo.io/data/ipinfo_lite.csv.gz?token=${IPINFO_TOKEN}" > "$LITE"
    if [ "$(file "$LITE" | grep -c gzip)" = "0" ]; then
        echo "下载到的不是 gzip,内容是: $(head -c 200 "$LITE")"
        exit 1
    fi
    echo "  $(stat -c %s "$LITE" 2>/dev/null || wc -c < "$LITE") bytes"
fi

# ---- 2. Azure service tags ------------------------------------------------
# 文件名带发布日期(ServiceTags_Public_20260907.json),每周变,不能写死。
# 先从下载页抓当前链接;抓不到就按日期往前回溯。
AZURE_JSON=""
if [ -n "$EXCLUDE_AZURE_REGIONS" ]; then
    if [ -n "$AZURE_TAGS_FILE" ]; then
        AZURE_JSON="$AZURE_TAGS_FILE"
        echo "使用本地 Azure service tags: $AZURE_JSON"
    else
        AZURE_JSON="$STAGE/servicetags.json"
        url=$(curl -sSL --connect-timeout 15 --max-time 90 "$MS_DL_PAGE" \
              | grep -oE 'https://[^"'"'"' ]*ServiceTags_Public_[0-9]{8}\.json' \
              | sort -u | tail -1)
        if [ -n "$url" ]; then
            echo "从下载页拿到: $url"
        else
            echo "下载页抓不到链接,按日期回溯 ..."
            base="https://download.microsoft.com/download/7/1/d/71d86715-5596-4529-9b13-da13a5de5b63"
            for i in $(seq 0 20); do
                d=$(date -u -d "-${i} days" +%Y%m%d 2>/dev/null) || break
                try="$base/ServiceTags_Public_${d}.json"
                if [ "$(curl -sSL -o /dev/null -r 0-0 -w '%{http_code}' \
                        --connect-timeout 10 --max-time 30 "$try")" = "206" ]; then
                    url="$try"
                    echo "  命中 $d"
                    break
                fi
            done
        fi
        if [ -z "$url" ]; then
            # 这里不能降级成"跳过剔除":那样生成的列表会把隧道端点包进去。
            echo "拿不到 Azure service tags,放弃(不生成会把出口区域包进去的列表)。"
            exit 1
        fi
        curl --retry 3 --retry-delay 5 --connect-timeout 15 --max-time 180 \
            -sSL "$url" > "$AZURE_JSON"
        if ! python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$AZURE_JSON" \
             >/dev/null 2>&1; then
            echo "下载到的 service tags 不是合法 JSON。"
            exit 1
        fi
    fi
fi

# ---- 3. 生成 --------------------------------------------------------------
set -- --lite "$LITE" \
       --out-dir "$WORK_DIR" \
       --countries "$COUNTRIES" \
       --combined "$COMBINED_NAME"
[ -n "$AZURE_JSON" ] && set -- "$@" --azure-tags "$AZURE_JSON"
[ -n "$EXCLUDE_AZURE_REGIONS" ] && set -- "$@" --azure-regions "$EXCLUDE_AZURE_REGIONS"
[ -n "$EXCLUDE_CIDR" ] && set -- "$@" --exclude-cidr "$EXCLUDE_CIDR"

python3 "$WORK_DIR/generate.py" "$@"
