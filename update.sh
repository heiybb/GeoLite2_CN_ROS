#! /bin/bash
WORK_DIR=$(cd $(dirname $0); pwd);

if [ ! -d "$WORK_DIR/tmp" ];then
  mkdir $WORK_DIR/tmp
fi

IPURL="https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country-CSV&license_key=${GEOLITE2_LICENSE_KEY}&suffix=zip"

CN_TXT=CN_CIDR_V4.txt
CN_RSC=CN_CIDR_V4.rsc

GEO_ZIP=/tmp/geolite2.zip
CN_IP_LIST=/tmp/chnip.txt

/usr/bin/curl --retry 5 --retry-delay 3600  --connect-timeout 10 --max-time 20 -sL "$IPURL" > $GEO_ZIP
if [ `file $GEO_ZIP | grep Zip | wc -l` = "0" ]
then
    echo "Fail to fetch GeoIP database file."
    exit 1
fi

cd /tmp
rm -rf GeoLite2-Country-CSV_*
unzip $GEO_ZIP
cat GeoLite2-Country-CSV_*/GeoLite2-Country-Blocks-IPv4.csv | grep ',1814991,' | awk -F',' '{print $1}' > $CN_IP_LIST
cd -
cp ${CN_IP_LIST} ${CN_TXT}

#Update RouterOS Script
cat > $WORK_DIR/$CN_RSC << EOF
/log info "Import cn ipv4 cidr list..."
/ip firewall address-list remove [/ip firewall address-list find list=CN_CIDR_V4]
/ip firewall address-list
EOF
cat $WORK_DIR/$CN_TXT | awk '{ printf(":do {add address=%s list=CN_CIDR_V4} on-error={}\n",$0) }' >> $WORK_DIR/$CN_RSC && \
echo "}" >> $WORK_DIR/$CN_RSC

echo "Update Success!"
