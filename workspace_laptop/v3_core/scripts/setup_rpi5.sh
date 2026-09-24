#!/bin/bash
# 🔧 Setup RPi5 para Robot Mesero v3
# Ejecutar como: ssh chipi@192.168.1.213 'bash -s' < setup_rpi5.sh
set -e

echo "═══════════════════════════════════════"
echo "  🤖 Uchino RPi5 — Setup v3"
echo "═══════════════════════════════════════"

# Dependencias ROS2
echo "📦 Verificando ROS2 Jazzy..."
source /opt/ros/jazzy/setup.bash 2>/dev/null || {
    echo "❌ ROS2 Jazzy no encontrado — instalar primero"
    exit 1
}

# Dependencias Python
echo "📦 Instalando dependencias..."
pip3 install --user websockets opencv-python-headless

# Crear directorio de scripts
mkdir -p ~/chipi_workspace_pln

echo ""
echo "✅ RPi5 preparada para v3"
echo ""
echo "📋 Pasos siguientes:"
echo "  1. Copiar v3_core/rpi5/ a la RPi5:"
echo "     scp -r v3_core/rpi5/* chipi@192.168.1.213:~/chipi_workspace_pln/v3_core/rpi5/"
echo "  2. Copiar systemd service:"
echo "     sudo cp chipi-kiosk.service chipi-camera.service /etc/systemd/system/"
echo "  3. sudo systemctl daemon-reload"
echo "  4. sudo systemctl enable --now chipi-kiosk"
echo ""
echo "  5. Build frontend en laptop y copiar a RPi5:"
echo "     cd frontend_ui && npm run build && scp -r dist/* chipi@192.168.1.213:~/chipi_ui/"
echo ""
echo "🔍 Verificar:"
echo "  - ROS2: ros2 topic list"
echo "  - Cámara RGB Logitech Brio: v4l2-ctl --list-devices"
echo "  - Kiosk: sudo systemctl status chipi-kiosk"
