# RouterOS CN IP List

CN ip list script generator for MikroTik RouterOS

[![Get Geolite2 ipv4](https://github.com/heiybb/GeoLite2_CN_ROS/actions/workflows/main.yml/badge.svg?branch=main)](https://github.com/heiybb/GeoLite2_CN_ROS/actions/workflows/main.yml)

## ROS

```
/tool fetch url="https://raw.githubusercontent.com/heiybb/GeoLite2_CN_ROS/main/CN_CIDR_V4.rsc" dst-path=CN_CIDR_V4.rsc;

/import file-name=CN_CIDR_V4.rsc;
```
