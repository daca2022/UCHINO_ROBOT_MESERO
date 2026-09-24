#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  chipi_diag.sh — Diagnóstico de conectividad hacia RPi5 Chipi
#  Correr en la SEGUNDA LAPTOP (la que no puede conectar)
#  Uso: bash chipi_diag.sh
# ═══════════════════════════════════════════════════════════════════

RPI5_IP="192.168.1.213"
RPI5_USER="chipi"
RPI5_PASS="${RPI5_PASS:-}"
EXPECTED_NET="192.168.1."
EXPECTED_SSID="robot_mesero_5G"

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[1;33m'
BLU='\033[0;34m'
NC='\033[0m'
BOLD='\033[1m'

ok()   { echo -e "${GRN}  ✅ $1${NC}"; }
fail() { echo -e "${RED}  ❌ $1${NC}"; }
warn() { echo -e "${YLW}  ⚠️  $1${NC}"; }
info() { echo -e "${BLU}  ℹ️  $1${NC}"; }
sep()  { echo -e "\n${BOLD}════════════════════════════════════════${NC}"; }

echo ""
echo -e "${BOLD}🔍 Diagnóstico de Conectividad — Robot Mesero Uchino${NC}"
echo -e "   RPi5 objetivo: ${RPI5_IP}"
echo -e "   $(date)"

# ──────────────────────────────────────────────────────
sep
echo -e "${BOLD}[1/5] Estado de red local${NC}"
# ──────────────────────────────────────────────────────

MY_SSID=$(iwgetid -r 2>/dev/null || nmcli -t -f active,ssid dev wifi 2>/dev/null | grep '^yes' | cut -d':' -f2 || echo "desconocido")
MY_IPS=$(hostname -I 2>/dev/null)

echo "  SSID actual:   $MY_SSID"
echo "  IPs locales:   $MY_IPS"

if echo "$MY_IPS" | grep -q "$EXPECTED_NET"; then
    ok "Estás en la subred 192.168.1.x — correcto"
    SAME_SUBNET=true
else
    fail "NO estás en la subred 192.168.1.x"
    warn "Tu IP es: $MY_IPS"
    warn "Necesitas conectarte a la red WiFi: $EXPECTED_SSID"
    SAME_SUBNET=false
fi

if [ "$MY_SSID" = "$EXPECTED_SSID" ]; then
    ok "Conectado al SSID correcto: $EXPECTED_SSID"
else
    warn "SSID actual ($MY_SSID) ≠ esperado ($EXPECTED_SSID)"
    info "Si el ping funciona, el router puede rutear entre SSIDs (ok)"
fi

# ──────────────────────────────────────────────────────
sep
echo -e "${BOLD}[2/5] Reachability (ping)${NC}"
# ──────────────────────────────────────────────────────

if ping -c 3 -W 2 "$RPI5_IP" &>/dev/null; then
    RTT=$(ping -c 3 -W 2 "$RPI5_IP" 2>/dev/null | tail -1 | awk -F '/' '{print $5}')
    ok "Ping a $RPI5_IP exitoso (RTT avg: ${RTT}ms)"
    PING_OK=true
else
    fail "Ping a $RPI5_IP FALLÓ"
    echo ""
    echo -e "  ${RED}Posibles causas:${NC}"
    echo "    1. No estás en la misma red → Conectar a $EXPECTED_SSID"
    echo "    2. AP Isolation activado en el router → Desactivar en config router"
    echo "    3. RPi5 apagada o wlan0 caído"
    PING_OK=false
fi

# ──────────────────────────────────────────────────────
sep
echo -e "${BOLD}[3/5] Puerto SSH (22) accesible${NC}"
# ──────────────────────────────────────────────────────

if $PING_OK; then
    if nc -zw3 "$RPI5_IP" 22 2>/dev/null; then
        ok "Puerto 22 (SSH) abierto en $RPI5_IP"
        SSH_PORT_OK=true
    else
        fail "Puerto 22 CERRADO o bloqueado en $RPI5_IP"
        warn "UFW puede estar bloqueando esta IP"
        info "Desde tu laptop principal, ejecuta:"
        echo "    sshpass -p '$RPI5_PASS' ssh $RPI5_USER@$RPI5_IP 'sudo ufw allow from 192.168.1.0/24 to any port 22'"
        SSH_PORT_OK=false
    fi
else
    warn "Saltando test de puerto (ping falló)"
    SSH_PORT_OK=false
fi

# ──────────────────────────────────────────────────────
sep
echo -e "${BOLD}[4/5] Herramientas SSH instaladas${NC}"
# ──────────────────────────────────────────────────────

if command -v ssh &>/dev/null; then
    ok "ssh instalado: $(ssh -V 2>&1)"
else
    fail "ssh NO instalado → sudo apt install openssh-client"
fi

if command -v sshpass &>/dev/null; then
    ok "sshpass instalado"
else
    fail "sshpass NO instalado"
    warn "Instalar con: sudo apt install sshpass -y"
fi

if command -v nc &>/dev/null; then
    ok "netcat instalado"
else
    warn "netcat no instalado (menor importancia) → sudo apt install netcat-openbsd"
fi

# ──────────────────────────────────────────────────────
sep
echo -e "${BOLD}[5/5] Verificar known_hosts (conflicto de claves)${NC}"
# ──────────────────────────────────────────────────────

if grep -q "$RPI5_IP" ~/.ssh/known_hosts 2>/dev/null; then
    warn "Existe entrada para $RPI5_IP en ~/.ssh/known_hosts"
    info "Si SSH falla con 'Host key changed', ejecuta:"
    echo "    ssh-keygen -R $RPI5_IP"
else
    ok "No hay entradas previas conflictivas en known_hosts"
fi

# ──────────────────────────────────────────────────────
sep
echo -e "${BOLD}📊 RESUMEN${NC}"
# ──────────────────────────────────────────────────────

if $PING_OK && $SSH_PORT_OK; then
    echo ""
    ok "RED OK — Prueba SSH directamente:"
    echo ""
    echo -e "  ${BOLD}# Sin sshpass:${NC}"
    echo "  ssh ${RPI5_USER}@${RPI5_IP}"
    echo "  # Contraseña: $RPI5_PASS"
    echo ""
    echo -e "  ${BOLD}# Con sshpass:${NC}"
    echo "  sshpass -p '$RPI5_PASS' ssh ${RPI5_USER}@${RPI5_IP}"
    echo ""
    echo -e "  ${BOLD}# Para conectar sin contraseña (recomendado):${NC}"
    echo "  bash chipi_ssh_setup.sh"
else
    echo ""
    fail "HAY PROBLEMAS DE RED — revisa los ❌ arriba"
    if ! $PING_OK; then
        echo ""
        echo -e "  ${BOLD}Acción prioritaria:${NC}"
        if ! echo "$MY_IPS" | grep -q "$EXPECTED_NET"; then
            echo "  → Conectar esta laptop a la red WiFi: $EXPECTED_SSID"
            echo "    Contraseña WiFi: definida en v3_core/.env como WIFI_PASSWORD"
        else
            echo "  → Verificar AP Isolation en el router"
            echo "  → Verificar que la RPi5 esté encendida"
        fi
    fi
fi

echo ""
echo "══════════════════════════════════════════"
echo ""
