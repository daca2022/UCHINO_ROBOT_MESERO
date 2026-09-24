/**
 * Servicio de Recorrido — Navegación y estados del robot mesero
 * Reemplaza tab_recorrido de Node-RED.
 */

export class RecorridoService {
    constructor({ robotCommand, telemetry, logger = console }) {
        this.robot = robotCommand;
        this.telemetry = telemetry;
        this.logger = logger;
        this.rutaActual = null;
        this.historial = [];
    }

    /**
     * Inicia un recorrido completo: cocina → mesa → base.
     */
    async iniciarRecorrido(pedidoId, mesaDestino) {
        this.rutaActual = {
            pedidoId,
            mesa: mesaDestino,
            etapas: ['cocina', 'utensilios', 'bebidas', mesaDestino, 'base'],
            etapaActual: 0,
            inicio: new Date().toISOString(),
        };

        this.logger.log('[RecorridoService] Recorrido iniciado:', pedidoId, '→', mesaDestino);
        return this._avanzarEtapa();
    }

    /**
     * Avanza a la siguiente etapa del recorrido.
     */
    async avanzar() {
        if (!this.rutaActual) throw new Error('No hay recorrido activo');
        if (this.rutaActual.etapaActual >= this.rutaActual.etapas.length - 1) {
            throw new Error('Recorrido ya completado');
        }
        this.rutaActual.etapaActual++;
        return this._avanzarEtapa();
    }

    /**
     * Obtiene el estado actual del recorrido.
     */
    obtenerEstado() {
        if (!this.rutaActual) return { activo: false };
        const etapa = this.rutaActual.etapas[this.rutaActual.etapaActual];
        const completado = this.rutaActual.etapaActual / (this.rutaActual.etapas.length - 1);
        return {
            activo: true,
            pedidoId: this.rutaActual.pedidoId,
            etapaActual: etapa,
            etapaIndex: this.rutaActual.etapaActual,
            totalEtapas: this.rutaActual.etapas.length,
            progreso: Math.round(completado * 100),
            inicio: this.rutaActual.inicio,
        };
    }

    /**
     * Cancela el recorrido actual y regresa a base.
     */
    async cancelar() {
        if (!this.rutaActual) return { cancelado: false, razon: 'No había recorrido activo' };

        this.logger.log('[RecorridoService] Recorrido cancelado, regresando a base');
        await this.robot.goTo('BASE');
        this._archivarRecorrido('cancelado');
        this.rutaActual = null;
        return { cancelado: true };
    }

    /**
     * Obtiene historial de recorridos completados.
     */
    obtenerHistorial(limit = 10) {
        return this.historial.slice(-limit);
    }

    // ── Privado ───────────────────────────────────────────────────
    async _avanzarEtapa() {
        const destino = this.rutaActual.etapas[this.rutaActual.etapaActual];
        this.logger.log('[RecorridoService] Yendo a:', destino);

        // En simulación o con ROS2 real
        try {
            await this.robot.goTo(destino.toUpperCase());
            this._notificarProgreso();
            return this.obtenerEstado();
        } catch (err) {
            this.logger.error('[RecorridoService] Error navegando a', destino, err.message);
            throw err;
        }
    }

    _notificarProgreso() {
        const estado = this.obtenerEstado();
        // TODO: emitir por WebSocket a /ws/monitor
        this.logger.log('[RecorridoService] Progreso:', estado.progreso + '%');
    }

    _archivarRecorrido(resultado) {
        this.historial.push({
            ...this.rutaActual,
            fin: new Date().toISOString(),
            resultado,
        });
        if (this.historial.length > 50) {
            this.historial = this.historial.slice(-50);
        }
    }
}
