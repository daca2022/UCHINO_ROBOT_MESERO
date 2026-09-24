#!/bin/bash
# ═══════════════════════════════════════════════════════════
# enable_nat_rpi5.sh — NAT para RPi5 a internet
# ═══════════════════════════════════════════════════════════
# La RPi5 está en la red robot_mesero_5G (192.168.1.x) sin
# internet directo. Este script usa el laptop como gateway
# para darle salida a internet (apt, etc.) a través del
# adaptador USB WiFi (192.168.100.x).
#
# USO:  sudo ./enable_nat_rpi5.sh
# O:    bash enable_nat_rpi5.sh  (pedirá sudo)
# ═══════════════════════════════════════════════════════════

set -Eeuo pipefail

# ── Detectar interfaz de internet ─────────────────────────
# Busca la interfaz con gateway por defecto (la que tiene internet)
WAN_IFACE="$(ip route show default | awk '{print $5}' | head -1)"

if [[ -z "$WAN_IFACE" ]]; then
    echo "ERROR: No se encontró interfaz con internet"
    exit 1
fi

echo "━" "Habilitando NAT para 192.168.1.0/24 → $WAN_IFACE" "━"

# 1. IP forwarding
sysctl -w net.ipv4.ip_forward=1

# 2. NAT (MASQUERADE) para tráfico saliente
iptables -t nat -C POSTROUTING -s 192.168.1.0/24 -o "$WAN_IFACE" -j MASQUERADE 2>/dev/null || \
    iptables -t nat -A POSTROUTING -s 192.168.1.0/24 -o "$WAN_IFACE" -j MASQUERADE

# 3. Permitir forwarding
iptables -C FORWARD -s 192.168.1.0/24 -o "$WAN_IFACE" -j ACCEPT 2>/dev/null || \
    iptables -A FORWARD -s 192.168.1.0/24 -o "$WAN_IFACE" -j ACCEPT

iptables -C FORWARD -d 192.168.1.0/24 -i "$WAN_IFACE" -j ACCEPT 2>/dev/null || \
    iptables -A FORWARD -d 192.168.1.0/24 -i "$WAN_IFACE" -j ACCEPT

# 4. Verificar
echo ""
echo "━" "Verificación" "━"
iptables -t nat -L POSTROUTING -v -n 2>&1 | grep "192.168.1.0/24" || echo "  NAT rule not found (might be OK)"
echo ""
echo "✅ NAT habilitado. La RPi5 (192.168.1.213) debería tener internet ahora."
echo "   Para verificar: ssh chipi@192.168.1.213 'ping -c 1 8.8.8.8'"
