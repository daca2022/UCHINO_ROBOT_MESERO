#!/bin/bash
# ═══════════════════════════════════════════════════════════
# kiosk_start.sh — Surf Browser Kiosk Mode para Robot Mesero
# ═══════════════════════════════════════════════════════════
# Lanza surf (suckless webkit) en modo kiosco apuntando al
# frontend React. Fallback a chromium-browser si existe.
# Diseñado para RPi5 con 7" HDMI touchscreen.
# ═══════════════════════════════════════════════════════════

set -Eeuo pipefail

# ── Configuración ──────────────────────────────────────────
BACKEND_URL="${KIOSK_BACKEND_URL:-http://localhost:3005}"
KIOSK_PATH="${KIOSK_PATH:-/robot}"
KIOSK_URL="${BACKEND_URL}${KIOSK_PATH}"
KIOSK_USER="${KIOSK_USER:-chipi}"
KIOSK_BROWSER="${KIOSK_BROWSER:-}"
REFRESH_INTERVAL="${KIOSK_REFRESH:-3600}"  # segundos entre recargas forzadas

# ── Logging ────────────────────────────────────────────────
log_info()  { echo "[$(date +'%Y-%m-%d %H:%M:%S')] INFO:  $*"; }
log_error() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*"; }

# ── Detectar navegador kiosk ──────────────────────────────
BROWSER=""
if [[ -n "$KIOSK_BROWSER" ]]; then
    if ! command -v "$KIOSK_BROWSER" &>/dev/null; then
        log_error "KIOSK_BROWSER no disponible: $KIOSK_BROWSER"
        exit 1
    fi
    BROWSER="$KIOSK_BROWSER"
    log_info "Navegador fijado: $BROWSER"
elif command -v falkon &>/dev/null; then
    BROWSER="falkon"
    log_info "Navegador: falkon (QtWebEngine)"
elif command -v surf &>/dev/null; then
    BROWSER="surf"
    log_info "Navegador: surf (suckless webkit)"
elif command -v chromium-browser &>/dev/null; then
    BROWSER="chromium-browser"
    log_info "Navegador: chromium-browser"
elif command -v chromium &>/dev/null; then
    BROWSER="chromium"
    log_info "Navegador: chromium"
else
    log_error "No se encontró falkon, surf ni chromium."
    exit 1
fi

# ── Esperar a que el backend esté disponible ───────────────
wait_for_backend() {
    local url="${BACKEND_URL}/api/status"
    local retries=30
    local delay=2

    log_info "Esperando backend en ${BACKEND_URL}..."
    for ((i=1; i<=retries; i++)); do
        if curl -sf "$url" >/dev/null 2>&1; then
            log_info "Backend disponible"
            return 0
        fi
        sleep "$delay"
    done

    log_error "Backend no respondió después de $((retries * delay)) segundos"
    return 1
}

wait_for_backend || {
    log_error "Continuando de todas formas — el frontend mostrará error de conexión"
}

# ── Configurar display ─────────────────────────────────────
export DISPLAY="${DISPLAY:-:0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# ── Esperar a que Xorg esté disponible ─────────────────────
# Xorg se inicia desde .bash_profile (auto-login tty1).
# El servicio espera hasta 30s a que esté listo.
wait_for_x() {
    log_info "Esperando Xorg en :0..."
    for ((i=1; i<=30; i++)); do
        if DISPLAY=:0 xdpyinfo &>/dev/null 2>&1; then
            log_info "Xorg listo en :0"
            return 0
        fi
        sleep 1
    done
    log_error "Xorg no disponible después de 30s"
    return 1
}

wait_for_x || {
    log_error "No hay display — el kiosk no funcionará"
    exit 1
}

# ── Iniciar OpenBox (window manager) ───────────────────────
# Necesario para que surf tenga ventanas con tamaño correcto.
# surf sin WM crea ventanas de 10x10.
log_info "Iniciando OpenBox..."
openbox --config-file ~/.config/openbox/rc.xml --replace &>/dev/null &
sleep 2

# ── Configurar pantalla ────────────────────────────────────
xsetroot -solid '#050510' 2>/dev/null || true
unclutter -idle 0 -root &
xrandr --output DSI-1 --mode 800x480 2>/dev/null || true
xrandr --output HDMI-1 --mode 800x480 2>/dev/null || true

# Crear directorio para surf styles (evita warnings)
mkdir -p ~/.surf/styles
echo '* { margin: 0; padding: 0; }' > ~/.surf/styles/default.css
mkdir -p /run/user/1000/dconf 2>/dev/null || true

# ── Flags según navegador ─────────────────────────────────
BROWSER_FLAGS=()
if [[ "$BROWSER" == "falkon" ]]; then
    # falkon: -f = fullscreen, -i = private browsing, -e = no extensions
    BROWSER_FLAGS=("-f" "-i" "-e")
elif [[ "$BROWSER" == "surf" ]]; then
    # surf: -f = fullscreen (oculta barra de título), -b = no background (transparente)
    BROWSER_FLAGS=("-f")
elif [[ "$BROWSER" == "chromium-browser" || "$BROWSER" == "chromium" ]]; then
    BROWSER_FLAGS=(
        "--kiosk"
        "--no-first-run"
        "--disable-infobars"
        "--disable-session-crashed-bubble"
        "--disable-features=TranslateUI,ChromeWhatsNewUI,OverlayScrollbar"
        "--disable-restore-session-state"
        "--disable-notifications"
        "--disable-popup-blocking"
        "--noerrdialogs"
        "--touch-events=enabled"
        "--fast"
        "--fast-start"
        "--disable-pinch"
        "--overscroll-history-navigation=0"
        "--hide-cursor"
        "--window-size=800,480"
        "--check-for-update-interval=604800"
    )
fi

# ── Monitor de salud del backend (fondo) ───────────────────
# Verifica el backend cada 15s. Si se recupera tras una caída,
# envía SIGHUP a surf para recargar la página.
health_monitor() {
    local health_url="${BACKEND_URL}/api/status"
    local check_interval=15
    local was_up=true
    local initial_check=true

    while true; do
        if curl -sf "$health_url" >/dev/null 2>&1; then
            if [ "$was_up" = false ]; then
                log_info "Backend recuperado — recargando $BROWSER"
                if [[ "$BROWSER" == "falkon" ]]; then
                    pkill -9 falkon 2>/dev/null || true
                elif [[ "$BROWSER" == "surf" ]]; then
                    pkill -HUP surf 2>/dev/null || true
                else
                    pkill -HUP "$BROWSER" 2>/dev/null || true
                fi
            fi
            was_up=true
        else
            if [ "$was_up" = true ] && [ "$initial_check" = false ]; then
                log_error "Backend no responde — $BROWSER mostrará error"
            fi
            was_up=false
        fi
        initial_check=false
        sleep "$check_interval"
    done
}

# Iniciar monitor en background
health_monitor &
HEALTH_PID=$!
log_info "Monitor de salud iniciado (PID ${HEALTH_PID}, cada 15s)"

# ── Bucle de resiliencia (auto-restart on crash) ───────────
log_info "Iniciando kiosk: ${KIOSK_URL}"

RESTART_DELAY=2

while true; do
    log_info "Lanzando ${BROWSER}..."

    if [[ "$BROWSER" == "falkon" ]]; then
        # Falkon
        if [[ "$(id -u)" -eq 0 && -n "$KIOSK_USER" ]]; then
            su -s /bin/bash -c "
                export DISPLAY='${DISPLAY}'
                export QTWEBENGINE_REMOTE_DEBUGGING=9222
                ${BROWSER} ${BROWSER_FLAGS[*]} '${KIOSK_URL}' &
                FALKON_PID=\$!
                sleep 3
                WID=\$(xdotool search --class 'Falkon' 2>/dev/null | tail -1)
                if [ -n \"\$WID\" ]; then
                    xdotool windowsize \$WID 800 480 windowmove \$WID 0 0 2>/dev/null
                fi
                wait \$FALKON_PID
            " "$KIOSK_USER" || true
        else
            export QTWEBENGINE_REMOTE_DEBUGGING=9222
            "${BROWSER}" "${BROWSER_FLAGS[@]}" "${KIOSK_URL}" &
            FALKON_PID=$!
            sleep 3
            WID=$(xdotool search --class 'Falkon' 2>/dev/null | tail -1)
            if [ -n "$WID" ]; then
                xdotool windowsize "$WID" 800 480 windowmove "$WID" 0 0 2>/dev/null
            fi
            wait "$FALKON_PID" || true
        fi
    elif [[ "$BROWSER" == "surf" ]]; then
        # surf: lanzar en background, maximizar con xdotool, esperar
        if [[ "$(id -u)" -eq 0 && -n "$KIOSK_USER" ]]; then
            su -s /bin/bash -c "
                export DISPLAY='${DISPLAY}'
                ${BROWSER} ${BROWSER_FLAGS[*]} '${KIOSK_URL}' &
                SURF_PID=\$!
                sleep 3
                # Maximizar ventana surf (sin WM crea 10x10, openbox + xdotool la expande)
                WID=\$(xdotool search --name 'surf' 2>/dev/null | tail -1)
                if [ -n \"\$WID\" ]; then
                    xdotool windowsize \$WID 800 480 windowmove \$WID 0 0 2>/dev/null
                fi
                wait \$SURF_PID
            " "$KIOSK_USER" || true
        else
            "${BROWSER}" ${BROWSER_FLAGS[@]} "${KIOSK_URL}" &
            SURF_PID=$!
            sleep 3
            WID=$(xdotool search --name 'surf' 2>/dev/null | tail -1)
            if [ -n "$WID" ]; then
                xdotool windowsize "$WID" 800 480 windowmove "$WID" 0 0 2>/dev/null
            fi
            wait "$SURF_PID" || true
        fi
    else
        # Chromium
        if [[ "$(id -u)" -eq 0 && -n "$KIOSK_USER" ]]; then
            su -s /bin/bash -c "
                export DISPLAY='${DISPLAY}'
                export XDG_RUNTIME_DIR='${XDG_RUNTIME_DIR}'
                exec ${BROWSER} ${BROWSER_FLAGS[*]} '${KIOSK_URL}'
            " "$KIOSK_USER" || true
        else
            unclutter -idle 0 -root &
            "${BROWSER}" "${BROWSER_FLAGS[@]}" "${KIOSK_URL}" || true
        fi
    fi

    EXIT_CODE=$?
    log_info "${BROWSER} terminó con código ${EXIT_CODE} — reiniciando en ${RESTART_DELAY}s..."
    sleep "$RESTART_DELAY"
done
