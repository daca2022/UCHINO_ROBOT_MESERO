#!/bin/bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR=""

for candidate in "$SCRIPT_DIR/../.." "$SCRIPT_DIR/../../.."; do
    candidate="$(CDPATH= cd -- "$candidate" && pwd)"
    if [[ -f "$candidate/AGENTS.md" && -d "$candidate/workspace_laptop" ]]; then
        ROOT_DIR="$candidate"
        break
    fi
done

if [[ -z "$ROOT_DIR" ]]; then
    echo "ERROR: no se pudo detectar la raiz del workspace" >&2
    exit 1
fi
ENV_FILE="$ROOT_DIR/v3_core/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: no existe $ENV_FILE" >&2
    exit 1
fi

set -a
source "$ENV_FILE"
set +a

RPI5_HOST_VALUE="${RPI5_HOST:-}"
RPI5_USER_VALUE="${RPI5_USER:-}"
ROS_DOMAIN_ID_VALUE="${ROS_DOMAIN_ID:-42}"
VISION_CAMERA_TOPIC_VALUE="${VISION_CAMERA_TOPIC:-/camera/image_raw}"

echo "Uchino preflight local"
echo "workspace: $ROOT_DIR"
echo "RPI5_HOST: ${RPI5_HOST_VALUE:-NO_CONFIGURADO}"
echo "RPI5_USER: ${RPI5_USER_VALUE:-NO_CONFIGURADO}"
echo "ROS_DOMAIN_ID: $ROS_DOMAIN_ID_VALUE"
echo "VISION_CAMERA_TOPIC: $VISION_CAMERA_TOPIC_VALUE"
echo

missing=0
if [[ -z "$RPI5_HOST_VALUE" ]]; then
    echo "FALTA: RPI5_HOST en $ENV_FILE" >&2
    missing=1
fi
if [[ -z "$RPI5_USER_VALUE" ]]; then
    echo "FALTA: RPI5_USER en $ENV_FILE" >&2
    missing=1
fi

for cmd in ssh ping curl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "FALTA COMANDO LOCAL: $cmd" >&2
        missing=1
    fi
done

echo "Comandos para ejecutar cuando la RPi5 este encendida:"
echo "  ping -c 3 \"$RPI5_HOST_VALUE\""
echo "  ssh \"$RPI5_USER_VALUE@$RPI5_HOST_VALUE\" 'hostname && ip -4 addr && date'"
echo "  ssh \"$RPI5_USER_VALUE@$RPI5_HOST_VALUE\" 'ls -l /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true'"
echo "  ssh \"$RPI5_USER_VALUE@$RPI5_HOST_VALUE\" 'lsusb | grep -Ei \"logitech|brio|camera\" || true'"
echo "  curl \"http://$RPI5_HOST_VALUE:8765/health\""
echo

if [[ "$missing" -ne 0 ]]; then
    exit 1
fi

echo "Preflight local listo. No se ejecuto conexion remota ni movimiento de motores."
