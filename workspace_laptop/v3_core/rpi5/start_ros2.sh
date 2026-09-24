#!/bin/bash
# ═══════════════════════════════════════════════════════════
# start_ros2.sh — Script de inicio para Raspberry Pi 5
# ═══════════════════════════════════════════════════════════

set -e

echo "🍓 Raspberry Pi 5 — Inicialización ROS2"
echo "════════════════════════════════════════"

# Cargar entorno ROS2
source /opt/ros/jazzy/setup.bash
source ~/ros2_ws_robot_mesero/install/setup.bash

export ROS_DOMAIN_ID=42
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp

echo "[1/3] Iniciando Nav2 + SLAM..."
ros2 launch cafe_bot_nav nav2_slam_launch.py &
NAV2_PID=$!

# TODO: Migrar UDP bridge a v3 o reemplazar con comunicación directa ESP32↔laptop
# Actualmente el ESP32 envía audio WS directo a la laptop (:3005), no vía RPi5
# echo "[2/3] Iniciando UDP Bridge (ESP32 ↔ ROS2)..."
# python3 ~/nodo_red_pln/robot_mesero_final/rpi5/udp_bridge_v3.py &
# UDP_PID=$!

echo "[3/3] Iniciando Foxglove Bridge..."
ros2 launch foxglove_bridge foxglove_bridge_launch.xml port:=8765 &
FOX_PID=$!

echo ""
echo "Servicios activos:"
echo "  Nav2:      PID $NAV2_PID"
echo "  UDP Bridge: PID $UDP_PID"
echo "  Foxglove:   PID $FOX_PID"
echo ""
echo "Para detener: kill $NAV2_PID $UDP_PID $FOX_PID"

wait
