/**
 * CircuitBreaker — Patrón de cortocircuito para tolerancia a fallos.
 *
 * Estados:
 *   CLOSED  → todo normal, permite ejecuciones
 *   OPEN    → tras N fallos consecutivos, rechaza ejecuciones
 *   HALF_OPEN → tras resetTimeout, permite 1+N ejecuciones de prueba
 *
 * Transiciones:
 *   CLOSED --(N fallos)--> OPEN
 *   OPEN   --(resetTimeout)--> HALF_OPEN
 *   HALF_OPEN --(éxito)--> CLOSED
 *   HALF_OPEN --(fallo)--> OPEN
 */

export class CircuitBreaker {
    /**
     * @param {object} options
     * @param {number} [options.failureThreshold=5] — Fallos consecutivos para abrir
     * @param {number} [options.resetTimeout=30000] — ms antes de pasar a HALF_OPEN
     * @param {number} [options.halfOpenMaxAttempts=2] — Intentos permitidos en HALF_OPEN
     */
    constructor({ failureThreshold = 5, resetTimeout = 30000, halfOpenMaxAttempts = 2 } = {}) {
        this.failureThreshold = failureThreshold;
        this.resetTimeout = resetTimeout;
        this.halfOpenMaxAttempts = halfOpenMaxAttempts;

        this._state = "CLOSED";
        this.failureCount = 0;
        this._lastFailureTime = null;
        this._halfOpenAttempts = 0;
    }

    /**
     * Indica si se permite ejecutar la operación protegida.
     * @returns {boolean}
     */
    canExecute() {
        if (this._state === "CLOSED") return true;
        if (this._state === "OPEN") {
            // Verificar si ya pasó el resetTimeout
            if (this._lastFailureTime && Date.now() - this._lastFailureTime >= this.resetTimeout) {
                this._state = "HALF_OPEN";
                this._halfOpenAttempts = 0;
                return true;
            }
            return false;
        }
        if (this._state === "HALF_OPEN") {
            return this._halfOpenAttempts < this.halfOpenMaxAttempts;
        }
        return false;
    }

    /**
     * Registra un éxito en la operación protegida.
     */
    recordSuccess() {
        this.failureCount = 0;
        this._lastFailureTime = null;
        if (this._state === "HALF_OPEN") {
            this._state = "CLOSED";
            this._halfOpenAttempts = 0;
        }
    }

    /**
     * Registra un fallo en la operación protegida.
     */
    recordFailure() {
        this.failureCount++;
        this._lastFailureTime = Date.now();

        if (this._state === "HALF_OPEN") {
            this._state = "OPEN";
            this._halfOpenAttempts = 0;
            return;
        }

        if (this._state === "CLOSED" && this.failureCount >= this.failureThreshold) {
            this._state = "OPEN";
        }
    }

    /**
     * Devuelve el estado actual del circuit breaker.
     * @returns {'CLOSED' | 'OPEN' | 'HALF_OPEN'}
     */
    getState() {
        // Si está OPEN, verificar si debe pasar a HALF_OPEN por timeout
        if (this._state === "OPEN") {
            if (this._lastFailureTime && Date.now() - this._lastFailureTime >= this.resetTimeout) {
                this._state = "HALF_OPEN";
                this._halfOpenAttempts = 0;
            }
        }
        return this._state;
    }
}
