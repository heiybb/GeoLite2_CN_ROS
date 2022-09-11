/log info "Import cn ipv4 cidr list..."
/ip firewall address-list remove [/ip firewall address-list find list=CN_CIDR_V4]
/ip firewall address-list
}
