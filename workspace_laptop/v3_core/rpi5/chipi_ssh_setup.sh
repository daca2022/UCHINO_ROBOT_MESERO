#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  chipi_ssh_setup.sh — Autorizar nueva laptop para conectar a RPi5
#  Genera clave SSH y la copia a la RPi5. Solo necesita la contraseña UNA VEZ.
#  Uso: bash chipi_ssh_setup.sh
# ═══════════════════════════════════════════════════════════════════

RPI5_IP="192.168.1.213"
RPI5_USER="chipi"
RPI5_PASS="${RPI5_PASS:-}"
KEY_FILE="$HOME/.ssh/id_ed25519_chipi"
SSH_CONFIG="$HOME/.ssh/config"

RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[1;33m'
BLU='\033[0;34m'
NC='\033[0m'
BOLD='\033[1m'

ok()   { echo -e "${GRN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }
warn() { echo -e "${YLW}⚠️  $1${NC}"; }
info() { echo -e "${BLU}ℹ️  $1${NC}"; }

echo ""
echo -e "${BOLD}🔑 Setup SSH sin contraseña — Robot Mesero Uchino${NC}"
echo -e "   Laptop: $(hostname) → RPi5: $RPI5_IP"
echo ""

# ──────────────────────────────────────────────────────
# 1. Verificar conectividad
# ──────────────────────────────────────────────────────
echo "[1/4] Verificando conectividad con RPi5..."
if ! ping -c 2 -W 3 "$RPI5_IP" &>/dev/null; then
    fail "No hay conexión con $RPI5_IP. Ejecuta primero: bash chipi_diag.sh"
fi
ok "RPi5 alcanzable"

# ──────────────────────────────────────────────────────
# 2. Generar clave SSH
# ──────────────────────────────────────────────────────
echo ""
echo "[2/4] Generando clave SSH ed25519..."

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

if [ -f "$KEY_FILE" ]; then
    warn "Clave ya existe: $KEY_FILE"
    info "Usando clave existente (no se sobreescribe)"
else
    ssh-keygen -t ed25519 -C "chipi-robot-$(hostname)-$(date +%Y%m%d)" \
               -f "$KEY_FILE" -N "" -q
    ok "Clave generada: $KEY_FILE"
fi

# ──────────────────────────────────────────────────────
# 3. Copiar clave pública a RPi5
# ──────────────────────────────────────────────────────
echo ""
echo "[3/4] Copiando clave pública a RPi5..."
info "Se usará la contraseña '$RPI5_PASS' por ÚLTIMA vez..."
echo ""

# Limpiar posible entrada vieja en known_hosts para evitar conflicto
ssh-keygen -R "$RPI5_IP" &>/dev/null

if command -v sshpass &>/dev/null; then
    sshpass -p "$RPI5_PASS" ssh-copy-id \
        -i "${KEY_FILE}.pub" \
        -o StrictHostKeyChecking=accept-new \
        "${RPI5_USER}@${RPI5_IP}"
    COPY_STATUS=$?
else
    warn "sshpass no instalado — se pedirá contraseña manualmente"
    ssh-copy-id \
        -i "${KEY_FILE}.pub" \
        -o StrictHostKeyChecking=accept-new \
        "${RPI5_USER}@${RPI5_IP}"
    COPY_STATUS=$?
fi

if [ $COPY_STATUS -eq 0 ]; then
    ok "Clave pública instalada en RPi5 exitosamente"
else
    fail "Error copiando clave. Verifica contraseña y conectividad."
fi

# ──────────────────────────────────────────────────────
# 4. Configurar ~/.ssh/config
# ──────────────────────────────────────────────────────
echo ""
echo "[4/4] Configurando ~/.ssh/config..."

# Verificar si ya existe el bloque
if grep -q "Host chipi-robot" "$SSH_CONFIG" 2>/dev/null; then
    warn "Alias 'chipi-robot' ya existe en $SSH_CONFIG — no se modifica"
else
    cat >> "$SSH_CONFIG" << EOF

# ── Robot Mesero Uchino (RPi5) ──────────────────────
Host chipi-robot
    HostName $RPI5_IP
    User $RPI5_USER
    IdentityFile $KEY_FILE
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ConnectTimeout 10
    StrictHostKeyChecking accept-new
EOF
    chmod 600 "$SSH_CONFIG"
    ok "Alias 'chipi-robot' agregado a $SSH_CONFIG"
fi

# ──────────────────────────────────────────────────────
# Verificación final
# ──────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════${NC}"
echo -e "${BOLD}🧪 Verificación final...${NC}"
echo ""

if ssh -i "$KEY_FILE" \
       -o ConnectTimeout=8 \
       -o BatchMode=yes \
       "${RPI5_USER}@${RPI5_IP}" \
       "echo '¡Conexión exitosa desde: '\$(hostname -s)' → '\$(hostname)' !' && uname -a" 2>/dev/null; then
    echo ""
    ok "¡SSH sin contraseña funciona perfectamente!"
    echo ""
    echo -e "${BOLD}Desde ahora puedes conectarte con:${NC}"
    echo ""
    echo -e "  ${GRN}ssh chipi-robot${NC}"
    echo ""
    echo -e "${BOLD}Comandos útiles:${NC}"
    echo "  ssh chipi-robot 'ros2 topic list'"
    echo "  ssh chipi-robot 'ros2 doctor'"
    echo "  ssh chipi-robot 'ip a show wlan0'"
    echo "  ssh chipi-robot 'bash ~/chipi_workspace_pln/v3_core/rpi5/start_ros2.sh'"
else
    warn "La conexión SSH con clave aún falla. Intenta manualmente:"
    echo "  ssh -v -i $KEY_FILE ${RPI5_USER}@${RPI5_IP}"
fi

echo ""
