/**
 * Interfaz de Telemetría — Receptor de datos del robot en tiempo real
 * Implementado por: FoxgloveAdapter, WebSocketTelemetry
 */
export class ITelemetry {
    /**
     * Suscribe a actualizaciones de posición.
     * @param {Function} callback — ({x, y, theta, timestamp}) => void
     * @returns {Function} unsubscribe
     */
    onPosition(callback) {
        throw new Error('onPosition() debe ser implementado');
    }

    /**
     * Suscribe a datos de batería.
     * @param {Function} callback — ({nivel, voltaje, timestamp}) => void
     * @returns {Function} unsubscribe
     */
    onBattery(callback) {
        throw new Error('onBattery() debe ser implementado');
    }

    /**
     * Suscribe a estado de navegación.
     * @param {Function} callback — ({estado, progreso, ruta}) => void
     * @returns {Function} unsubscribe
     */
    onNavigation(callback) {
        throw new Error('onNavigation() debe ser implementado');
    }

    /**
     * Suscribe a obstáculos detectados por LiDAR.
     * @param {Function} callback — ({distancia, angulo, timestamp}) => void
     * @returns {Function} unsubscribe
     */
    onLidar(callback) {
        throw new Error('onLidar() debe ser implementado');
    }

    /**
     * Obtiene snapshot completo del estado actual.
     * @returns {Promise<Object>}
     */
    async getSnapshot() {
        throw new Error('getSnapshot() debe ser implementado');
    }
}
