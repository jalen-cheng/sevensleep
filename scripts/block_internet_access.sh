#!/bin/bash
# Blocks WAN access for the Pod, keeps LAN + NTP (and the DNS lookups NTP needs) working, and makes the block survive reboots.
#
# Options (environment variables, remembered for later runs such as the re-block after an update):
#   ALLOW_SENTRY=true      Allow error logs to reach Sentry's ingestion servers (default: blocked)
#   ALLOW_TAILSCALE=true   Allow the Tailscale address range, for remote access through a
#                          tailnet (default: blocked). When Tailscale runs on the Pod itself
#                          (setup_tailscale.sh) this also opens its sign-in servers and the
#                          listed relays, and nothing else.
#
# Usage:
#   sh block_internet_access.sh                 Apply, save and persist the rules
#   sh block_internet_access.sh --print-rules   Only print the rules that would be applied
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/firewall_common.sh"

PRINT_RULES_ONLY=false
if [ "${1:-}" = "--print-rules" ]; then
  PRINT_RULES_ONLY=true
fi

ALLOW_SENTRY=$(resolve_firewall_option ALLOW_SENTRY false)
ALLOW_TAILSCALE=$(resolve_firewall_option ALLOW_TAILSCALE false)

# https://docs.sentry.io/security-legal-pii/security/ip-ranges/#event-ingestion
SENTRY_INGESTION_IPS="35.186.247.156 34.120.195.249 34.36.122.224 34.36.87.148 34.120.62.213 130.211.36.74"
PRIVATE_IPV4_RANGES="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16"
# Link-local, unique-local, and link-scoped multicast (neighbor discovery, which IPv6 needs to
# work at all on the LAN). None of these are routed to the internet.
PRIVATE_IPV6_RANGES="fe80::/10 fd00::/8 ff02::/16"
# Tailscale's CGNAT range. Its IPv6 range (fd7a:115c:a1e0::/48) is already inside fd00::/8.
TAILSCALE_IPV4_RANGE="100.64.0.0/10"
# Tailscale's sign-in and coordination servers, the one range it documents as fixed:
# https://tailscale.com/kb/1082/firewall-ports
TAILSCALE_CONTROL_RANGE="192.200.0.0/24"
TAILSCALE_RELAY_ADDRESSES=""
if [ "$ALLOW_TAILSCALE" = "true" ]; then
  PRIVATE_IPV4_RANGES="$PRIVATE_IPV4_RANGES $TAILSCALE_IPV4_RANGE"
  if [ -f "$TAILSCALE_RELAY_ADDRESSES_FILE" ]; then
    TAILSCALE_ON_POD=true
    # Only plain IPv4 addresses are taken from the file, whatever else it contains
    TAILSCALE_RELAY_ADDRESSES=$(grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' "$TAILSCALE_RELAY_ADDRESSES_FILE" || true)
  fi
fi
TAILSCALE_ON_POD="${TAILSCALE_ON_POD:-false}"

# Prints the rules that let the Pod open a TCP connection to one address and port, and accept
# only the replies. Replies are matched as "not a new connection", so nothing can connect inwards.
allow_outbound_tcp() {
  destination="$1"
  destination_port="$2"
  echo "-A OUTPUT -p tcp -d $destination --dport $destination_port -j ACCEPT"
  echo "-A INPUT -p tcp -s $destination --sport $destination_port ! --syn -j ACCEPT"
}

# Prints the IPv4 ruleset in iptables-restore format. Loading it replaces the whole filter table
# in one step, so re-running this script never duplicates rules or leaves a half-open window.
build_ipv4_rules() {
  echo "*filter"
  echo ":INPUT ACCEPT [0:0]"
  echo ":FORWARD ACCEPT [0:0]"
  echo ":OUTPUT ACCEPT [0:0]"
  # NTP keeps the system clock (and therefore schedules) correct
  echo "-A INPUT -p udp --sport 123 -j ACCEPT"
  echo "-A OUTPUT -p udp --dport 123 -j ACCEPT"
  # DNS, so the time servers above can be looked up by name. Allowed to any resolver: some
  # networks hand out public DNS servers, which the LAN ranges below would not cover.
  for dns_protocol in udp tcp; do
    echo "-A OUTPUT -p $dns_protocol --dport 53 -j ACCEPT"
    # Replies only: without "! --syn" anyone could reach the Pod's open ports by connecting
    # from source port 53. (UDP has no such flag; its replies are matched by port alone.)
    if [ "$dns_protocol" = "tcp" ]; then
      echo "-A INPUT -p tcp --sport 53 ! --syn -j ACCEPT"
    else
      echo "-A INPUT -p udp --sport 53 -j ACCEPT"
    fi
  done
  # DHCP: address requests are broadcast, so the LAN ranges below do not cover them.
  # Without this the Pod could fail to get an address and drop off the network.
  echo "-A OUTPUT -p udp --sport 68 --dport 67 -j ACCEPT"
  echo "-A INPUT -p udp --sport 67 --dport 68 -j ACCEPT"
  # mDNS: lets phones and computers at home find the Pod by name (<hostname>.local, see
  # setup_local_name.sh). The address is link-local multicast, which routers do not forward.
  echo "-A INPUT -p udp -d 224.0.0.251 --dport 5353 -j ACCEPT"
  echo "-A OUTPUT -p udp -d 224.0.0.251 --dport 5353 -j ACCEPT"
  # Loopback lets local services talk to each other
  echo "-A INPUT -i lo -j ACCEPT"
  echo "-A OUTPUT -o lo -j ACCEPT"
  for private_range in $PRIVATE_IPV4_RANGES; do
    echo "-A INPUT -s $private_range -j ACCEPT"
    echo "-A OUTPUT -d $private_range -j ACCEPT"
  done
  if [ "$TAILSCALE_ON_POD" = "true" ]; then
    # Sign-in and coordination (port 80 is tried first, 443 is the fallback), then the relays
    allow_outbound_tcp "$TAILSCALE_CONTROL_RANGE" 80
    allow_outbound_tcp "$TAILSCALE_CONTROL_RANGE" 443
    for relay_address in $TAILSCALE_RELAY_ADDRESSES; do
      allow_outbound_tcp "$relay_address" 443
    done
  fi
  if [ "$ALLOW_SENTRY" = "true" ]; then
    echo "-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
    for sentry_ip in $SENTRY_INGESTION_IPS; do
      echo "-A OUTPUT -d $sentry_ip -j ACCEPT"
    done
  fi
  echo "-A INPUT -j DROP"
  echo "-A OUTPUT -j DROP"
  echo "COMMIT"
}

# Prints the IPv6 ruleset in ip6tables-restore format. With "refuse", a blocked connection is
# answered with a reset instead of silence. The Pod's .local name also gives out its public IPv6
# addresses, which are blocked: a phone or browser that tries one of those first then moves on to
# an address that works at once, instead of waiting for a timeout. Nothing more is let in.
build_ipv6_rules() {
  blocked_connections="${1:-refuse}"
  echo "*filter"
  echo ":INPUT ACCEPT [0:0]"
  echo ":FORWARD ACCEPT [0:0]"
  echo ":OUTPUT ACCEPT [0:0]"
  echo "-A INPUT -p udp --sport 123 -j ACCEPT"
  echo "-A OUTPUT -p udp --dport 123 -j ACCEPT"
  for dns_protocol in udp tcp; do
    echo "-A OUTPUT -p $dns_protocol --dport 53 -j ACCEPT"
    # Replies only: without "! --syn" anyone could reach the Pod's open ports by connecting
    # from source port 53. (UDP has no such flag; its replies are matched by port alone.)
    if [ "$dns_protocol" = "tcp" ]; then
      echo "-A INPUT -p tcp --sport 53 ! --syn -j ACCEPT"
    else
      echo "-A INPUT -p udp --sport 53 -j ACCEPT"
    fi
  done
  echo "-A INPUT -i lo -j ACCEPT"
  echo "-A OUTPUT -o lo -j ACCEPT"
  for private_range in $PRIVATE_IPV6_RANGES; do
    echo "-A INPUT -s $private_range -j ACCEPT"
    echo "-A OUTPUT -d $private_range -j ACCEPT"
  done
  if [ "$blocked_connections" = "refuse" ]; then
    echo "-A INPUT -p tcp -j REJECT --reject-with tcp-reset"
    # The reset itself has to be let out. It carries no data.
    echo "-A OUTPUT -p tcp --tcp-flags RST RST -j ACCEPT"
  fi
  echo "-A INPUT -j DROP"
  echo "-A OUTPUT -j DROP"
  echo "COMMIT"
}

if [ "$PRINT_RULES_ONLY" = "true" ]; then
  echo "# IPv4"
  build_ipv4_rules
  echo "# IPv6"
  build_ipv6_rules
  exit 0
fi

echo "Blocking internet access..."
if [ "$ALLOW_SENTRY" = "true" ]; then
  printf '\033[33m%s\033[0m\n' "Sentry servers are allowed (ALLOW_SENTRY=true)."
  printf '\033[33m%s\033[0m\n' "Nothing is sent unless you have set your own SENTRY_DSN for the server."
  printf '\033[33m%s\033[0m\n' "To block Sentry again, run: 'ALLOW_SENTRY=false sh scripts/block_internet_access.sh'"
else
  echo "Sentry servers are blocked (this version sends no error reports unless you set your own SENTRY_DSN)."
fi

if [ "$ALLOW_TAILSCALE" = "true" ]; then
  echo "Tailscale range $TAILSCALE_IPV4_RANGE is allowed (ALLOW_TAILSCALE=true)."
  if [ "$TAILSCALE_ON_POD" = "true" ]; then
    relay_count=$(echo "$TAILSCALE_RELAY_ADDRESSES" | grep -c . || true)
    echo "Tailscale on the Pod: sign-in range $TAILSCALE_CONTROL_RANGE and $relay_count relay addresses are allowed."
  fi
fi

echo "Updating the timesyncd config"
cat > "$TIMESYNCD_CONFIG" <<EOF
[Time]
NTP=pool.ntp.org 0.pool.ntp.org 1.pool.ntp.org 2.pool.ntp.org 3.pool.ntp.org
FallbackNTP=time1.google.com time2.google.com time3.google.com time4.google.com
RootDistanceMaxSec=5
PollIntervalMinSec=32
PollIntervalMaxSec=2048
EOF
systemctl restart systemd-timesyncd || echo "WARNING: Unable to restart systemd-timesyncd" >&2

# Write the rules files first and load the live rules from them, so what runs now is
# exactly what gets restored at boot.
mkdir -p "$FIREWALL_RULES_DIR"
echo "Configuring IPv4 rules..."
build_ipv4_rules > "$FIREWALL_RULES_V4"
iptables-restore < "$FIREWALL_RULES_V4"

# Best-effort: some Pod images have no IPv6 firewall. Failing here must not stop the script
# before the IPv4 block (already live) is saved and set to come back at boot.
echo "Configuring IPv6 rules..."
build_ipv6_rules refuse > "$FIREWALL_RULES_V6"
if ! ip6tables-restore < "$FIREWALL_RULES_V6"; then
  # A Pod whose kernel cannot send the reset still gets the block, with silence instead
  echo "This Pod cannot refuse blocked IPv6 connections; dropping them silently instead." >&2
  build_ipv6_rules silent > "$FIREWALL_RULES_V6"
  if ! ip6tables-restore < "$FIREWALL_RULES_V6"; then
    echo "WARNING: could not apply the IPv6 rules; IPv4 is blocked, IPv6 is not." >&2
    rm -f "$FIREWALL_RULES_V6"
  fi
fi

save_firewall_option ALLOW_SENTRY "$ALLOW_SENTRY"
save_firewall_option ALLOW_TAILSCALE "$ALLOW_TAILSCALE"

# Restore the rules on every boot
sh "$SCRIPT_DIR/setup_firewall_service.sh"

echo "Blocked WAN internet access successfully!"
