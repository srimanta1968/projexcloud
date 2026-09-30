#!/usr/bin/env bash
#
# Opens the voice media plane (VA·E1 · TK-4454) on an EC2 security group:
#   SIP 5060/udp+tcp, 5061/tcp (TLS)  -> each carrier's SIGNALING ranges only
#   SIP RTP range/udp                 -> each carrier's MEDIA ranges only
#   WebRTC 7881/tcp + UDP range       -> anywhere (browsers; media is DTLS-SRTP)
# 443 (nginx -> LiveKit signaling) is assumed open already for the portals.
#
# Ranges come from packages/sdk-voice-agent/carrier-signaling.json — the same file
# sdk-voice-agent uses for each LiveKit inbound trunk's allowed_addresses, so the network and
# application allow-lists cannot drift. Idempotent: rules that already exist are skipped.
#
# Usage: scripts/setup/voice-security-group.sh <security-group-id> [carrier ...]
#   carriers default to every carrier in the JSON. DRY_RUN=1 prints the rules only.
#   Port ranges follow .env.prod (SIP_RTP_PORT_*, LIVEKIT_UDP_PORT_*) when present.
set -euo pipefail
cd "$(dirname "$0")/../.."

SG="${1:?usage: $0 <security-group-id> [carrier ...]}"
shift || true
JSON=packages/sdk-voice-agent/carrier-signaling.json
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

envval() { [ -f .env.prod ] || return 0; sed -n "s/^$1=\([0-9]*\).*/\1/p" .env.prod | tail -1; }
jqr() { jq -r "$@" | tr -d '\r'; }
RTP_START="$(envval SIP_RTP_PORT_START)"; RTP_START="${RTP_START:-10000}"
RTP_END="$(envval SIP_RTP_PORT_END)"; RTP_END="${RTP_END:-10199}"
WEB_START="$(envval LIVEKIT_UDP_PORT_START)"; WEB_START="${WEB_START:-50000}"
WEB_END="$(envval LIVEKIT_UDP_PORT_END)"; WEB_END="${WEB_END:-50199}"

if [ "$#" -gt 0 ]; then CARRIERS=("$@"); else mapfile -t CARRIERS < <(jqr 'keys[] | select(startswith("_") | not)' "$JSON"); fi

rule() { # proto from to cidr description
  local proto="$1" from="$2" to="$3" cidr="$4" desc="$5" kind=CidrIp
  [[ "$cidr" == *:* ]] && kind=CidrIpv6
  local ranges="[{$kind=$cidr,Description=\"$desc\"}]"
  [ "$kind" = CidrIpv6 ] && ranges="Ipv6Ranges=$ranges" || ranges="IpRanges=$ranges"
  echo "  $proto $from-$to <- $cidr ($desc)"
  [ "${DRY_RUN:-0}" = 1 ] && return 0
  aws ec2 authorize-security-group-ingress --group-id "$SG" \
    --ip-permissions "IpProtocol=$proto,FromPort=$from,ToPort=$to,$ranges" >/dev/null 2>&1 \
    || echo "    (exists or refused — check with: aws ec2 describe-security-groups --group-ids $SG)"
}

for c in "${CARRIERS[@]}"; do
  echo "[voice-sg] $c signaling"
  for cidr in $(jqr --arg c "$c" '.[$c].signaling[]? // empty' "$JSON"); do
    rule udp 5060 5060 "$cidr" "$c SIP"
    rule tcp 5060 5061 "$cidr" "$c SIP/TLS"
  done
  echo "[voice-sg] $c media"
  for cidr in $(jqr --arg c "$c" '.[$c].media[]? // empty' "$JSON"); do
    rule udp "$RTP_START" "$RTP_END" "$cidr" "$c RTP"
  done
done

echo "[voice-sg] WebRTC (browsers, voice-runtime)"
rule tcp 7881 7881 0.0.0.0/0 "LiveKit ICE-TCP"
rule udp "$WEB_START" "$WEB_END" 0.0.0.0/0 "LiveKit WebRTC"
echo "[voice-sg] done"
