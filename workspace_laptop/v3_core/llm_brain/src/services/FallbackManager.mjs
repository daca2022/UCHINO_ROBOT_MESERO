import { CircuitBreaker } from "./CircuitBreaker.mjs";

/**
 * Error lanzado cuando todos los proveedores han fallado.
 */
export class AllProvidersFailedError extends Error {
    constructor(message = "All providers failed", { errors = [], lastError = null } = {}) {
        super(message);
        this.name = "AllProvidersFailedError";
        this.errors = errors;
        this.lastError = lastError;
    }
}

/**
 * FallbackManager — Orquesta múltiples proveedores LLM con fallback
 * automático, circuit breaker por proveedor, reintentos y health checks.
 *
 * Inspirado en el patrón de LlmOrchestrator pero con:
 *   - N proveedores (no solo primario/fallback)
 *   - Circuit breaker independiente por proveedor
 *   - Reintentos con backoff exponencial
 *   - Health checks periódicos
 */
export class FallbackManager {
    /**
     * @param {object} options
     * @param {Array<{name: string, instance: object, priority: number}>} options.providers
     * @param {{failureThreshold: number, resetTimeout: number}} options.circuitBreaker
     * @param {{maxRetries: number, baseDelay: number}} options.retry
     * @param {number} [options.healthCheckInterval=30000] — ms entre health checks
     */
    constructor({
        providers = [],
        circuitBreaker = { failureThreshold: 5, resetTimeout: 30000 },
        retry = { maxRetries: 2, baseDelay: 500 },
        healthCheckInterval = 30000,
    } = {}) {
        // Ordenar por prioridad ascendente (menor número = mayor prioridad)
        this._providers = [...providers].sort((a, b) => a.priority - b.priority);
        this._circuitBreakerConfig = circuitBreaker;
        this._retryConfig = retry;
        this._healthCheckInterval = healthCheckInterval;

        // Un circuit breaker por proveedor
        this._circuitBreakers = new Map();
        for (const p of this._providers) {
            this._circuitBreakers.set(
                p.name,
                new CircuitBreaker({
                    failureThreshold: circuitBreaker.failureThreshold,
                    resetTimeout: circuitBreaker.resetTimeout,
                    halfOpenMaxAttempts: 2,
                })
            );
        }

        this._activeProvider = this._providers[0] || null;
        this._healthTimer = null;

        // Event hooks (sobrescribibles por el consumidor)
        this.onProviderSwitch = () => {};
        this.onCircuitOpen = () => {};
        this.onCircuitClose = () => {};

        // Auto-iniciar health checks si hay intervalo configurado
        if (this._healthCheckInterval > 0) {
            this.startHealthChecks();
        }
    }

    /**
     * Ejecuta una operación intentando proveedores en orden de prioridad.
     * Salta proveedores con circuit breaker OPEN.
     *
     * @param {function(object): Promise<any>} operation — Recibe el provider instance
     * @returns {Promise<any>}
     * @throws {AllProvidersFailedError}
     */
    async executeWithFallback(operation) {
        const errors = [];
        let lastError = null;

        for (const providerEntry of this._providersForExecution()) {
            const cb = this._circuitBreakers.get(providerEntry.name);

            if (!cb.canExecute()) {
                continue; // Circuito abierto, saltar
            }

            // Intentar con reintentos
            const result = await this._tryProvider(providerEntry, cb, operation);
            if (result.success) {
                // Si cambiamos de proveedor activo, emitir evento
                if (this._activeProvider && this._activeProvider.name !== providerEntry.name) {
                    const from = this._activeProvider.name;
                    const to = providerEntry.name;
                    this._activeProvider = providerEntry;
                    this.onProviderSwitch(from, to);
                } else if (!this._activeProvider) {
                    this._activeProvider = providerEntry;
                }
                return result.value;
            }

            errors.push({ provider: providerEntry.name, error: result.error.message });
            lastError = result.error;
        }

        throw new AllProvidersFailedError("All providers failed", { errors, lastError });
    }

    async _tryProvider(providerEntry, cb, operation) {
        const { maxRetries, baseDelay } = this._retryConfig;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const value = await operation(providerEntry.instance);
                cb.recordSuccess();
                if (cb.getState() === "CLOSED") {
                    this.onCircuitClose(providerEntry.name);
                }
                return { success: true, value };
            } catch (error) {
                cb.recordFailure();

                if (cb.getState() === "OPEN") {
                    this.onCircuitOpen(providerEntry.name);
                }

                if (attempt < maxRetries) {
                    const delay = baseDelay * Math.pow(2, attempt);
                    await new Promise((r) => setTimeout(r, delay));
                } else {
                    return { success: false, error };
                }
            }
        }

        return { success: false, error: new Error("Max retries exceeded") };
    }

    _providersForExecution() {
        if (!this._activeProvider) return this._providers;
        return [
            this._activeProvider,
            ...this._providers.filter((provider) => provider.name !== this._activeProvider.name),
        ];
    }

    /**
     * Devuelve el proveedor actualmente activo.
     * @returns {{name: string, provider: object} | null}
     */
    getActiveProvider() {
        if (!this._activeProvider) return null;
        return {
            name: this._activeProvider.name,
            provider: this._activeProvider.instance,
        };
    }

    setActiveProvider(name) {
        const providerEntry = this._providers.find((provider) => provider.name === name);
        if (!providerEntry) {
            throw new Error(`Proveedor LLM desconocido: ${name}`);
        }
        const previous = this._activeProvider?.name;
        this._activeProvider = providerEntry;
        if (previous && previous !== name) {
            this.onProviderSwitch(previous, name);
        }
        return {
            name: providerEntry.name,
            provider: providerEntry.instance,
        };
    }

    /**
     * Devuelve el estado de todos los proveedores.
     * @returns {Array<{name: string, status: string, circuitBreaker: string}>}
     */
    getProviderStatus() {
        return this._providers.map((p) => {
            const cb = this._circuitBreakers.get(p.name);
            const state = cb.getState();
            let status = "healthy";
            if (state === "OPEN") status = "down";
            else if (state === "HALF_OPEN") status = "degraded";

            return {
                name: p.name,
                status,
                circuitBreaker: state,
            };
        });
    }

    /**
     * Inicia health checks periódicos.
     */
    startHealthChecks() {
        if (this._healthTimer) return;
        if (this._healthCheckInterval <= 0) return;

        this._healthTimer = setInterval(() => {
            this._runHealthChecks();
        }, this._healthCheckInterval);
    }

    /**
     * Detiene health checks periódicos.
     */
    stopHealthChecks() {
        if (this._healthTimer) {
            clearInterval(this._healthTimer);
            this._healthTimer = null;
        }
    }

    async _runHealthChecks() {
        for (const p of this._providers) {
            const cb = this._circuitBreakers.get(p.name);
            const state = cb.getState();

            // Solo pingear si el circuito no está CLOSED (OPEN o HALF_OPEN)
            if (state !== "CLOSED") {
                try {
                    await p.instance.initSession();
                    cb.recordSuccess();
                    if (cb.getState() === "CLOSED") {
                        this.onCircuitClose(p.name);
                    }
                } catch {
                    // Health check falló, el circuit breaker ya tiene el fallo registrado
                    // o lo registrará si se usa canExecute/getState
                }
            }
        }
    }
}
