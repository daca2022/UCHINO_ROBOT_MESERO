/**
 * Interfaz de Comando Robot — Abstracción de ROS2 para evitar acoplamiento
 * Implementado por: FoxgloveAdapter, RoslibAdapter, WebSocketAdapter
 */
export class IRobotCommand {
    /**
     * Envía el robot a una posición de mesa.
     * @param {string} destino — 'cocina', 'mesa_1', 'entrada', etc.
     * @returns {Promise<{success: boolean, etaSeconds: number}>}
     */
    async goTo(destino) {
        throw new Error('goTo() debe ser implementado');
    }

    /**
     * Detiene el robot inmediatamente.
     * @returns {Promise<void>}
     */
    async stop() {
        throw new Error('stop() debe ser implementado');
    }

    /**
     * Activa/desactiva el brazo mecánico.
     * @param {string} accion — 'entregar', 'recoger', 'reposo'
     * @returns {Promise<boolean>}
     */
    async actuarBrazo(accion) {
        throw new Error('actuarBrazo() debe ser implementado');
    }

    /**
     * Establece velocidad lineal y angular.
     * @param {number} v — m/s
     * @param {number} w — rad/s
     * @returns {Promise<void>}
     */
    async setVelocity(v, w) {
        throw new Error('setVelocity() debe ser implementado');
    }

    /**
     * Obtiene el estado actual del robot.
     * @returns {Promise<{posicion: {x,y,theta}, bateria: number, estado: string}>}
     */
    async getState() {
        throw new Error('getState() debe ser implementado');
    }
}
