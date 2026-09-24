import { QwenAdapter } from '../adapters/QwenAdapter.mjs';
import { FallbackManager } from './FallbackManager.mjs';
import { createDefaultProviders, createVisionProvider } from '../config/providers.mjs';

const HEALTH_CHECK_INTERVAL_MS = 30000;
const FALLBACK_SWITCH_LOG = '[LlmOrchestrator]';

export class LlmOrchestrator {
    constructor(primaryProvider, { functionHandlers = {}, onEmotion = null, logger = console, fallbackProvider = null } = {}) {
        this.primary = primaryProvider;
        this.fallback = fallbackProvider;
        this.active = primaryProvider;
        this.handlers = functionHandlers;
        this.onEmotion = onEmotion;
        this.logger = logger;
        this.history = [];
        this.onFallback = false;
        this._healthTimer = null;
        this._systemPrompt = '';
        this._metrics = {
            total_calls: 0,
            fallback_count: 0,
            total_latency_ms: 0,
            errors: 0,
            last_call: null,
            provider: primaryProvider?.getModelInfo?.().name || 'unknown',
        };
    }

    async init(systemPrompt) {
        this._systemPrompt = systemPrompt || '';
        await this.active.initSession(this._systemPrompt);
        this.logger.log(`${FALLBACK_SWITCH_LOG} Sesión iniciada con`, this.active.getModelInfo().name);
    }

    /**
     * Recarga el system prompt en el proveedor activo sin reiniciar el resto.
     * Pensado para que Admin pueda cambiar personalidad en runtime.
     *
     * @param {string} [newSystemPrompt] - Si se omite, reutiliza this._systemPrompt.
     */
    async reloadPersonalidad(newSystemPrompt) {
        if (newSystemPrompt !== undefined) {
            this._systemPrompt = newSystemPrompt;
        }
        if (!this._systemPrompt) {
            this.logger.warn(`${FALLBACK_SWITCH_LOG} reloadPersonalidad sin system prompt definido`);
            return;
        }
        await this.active.initSession(this._systemPrompt);
        this.logger.log(`${FALLBACK_SWITCH_LOG} Personalidad recargada`);
    }

    static async fromDefaults({ functionHandlers = {}, onEmotion = null, logger = console } = {}) {
        const providers = createDefaultProviders();
        const fallbackManager = new FallbackManager({
            providers,
            circuitBreaker: { failureThreshold: 5, resetTimeout: 30000 },
            retry: { maxRetries: 3, baseDelay: 1000 },
        });
        for (const p of providers) {
            await p.instance.initSession().catch(() => {});
        }
        const orchestrator = new LlmOrchestrator(providers[0].instance, {
            functionHandlers,
            onEmotion,
            logger,
            fallbackProvider: providers[1].instance,
        });
        orchestrator._fallbackManager = fallbackManager;
        orchestrator._providers = providers;
        fallbackManager.startHealthChecks();
        return orchestrator;
    }

    getActiveProvider() {
        if (this._fallbackManager) {
            return this._fallbackManager.getActiveProvider();
        }
        return { name: this.active.getModelInfo().name };
    }

    getProviderStatus() {
        if (this._fallbackManager) {
            return this._fallbackManager.getProviderStatus();
        }
        return [{ name: this.active.getModelInfo().name, status: 'unknown' }];
    }

    listProviders() {
        if (this._providers?.length) {
            const activeName = this.getActiveProvider()?.name;
            return this._providers.map((provider) => ({
                name: provider.name,
                active: provider.name === activeName,
                priority: provider.priority,
                model: provider.instance?.getModelInfo?.()?.name || provider.name,
            }));
        }
        const info = this.active?.getModelInfo?.();
        return [{
            name: info?.name || 'unknown',
            active: true,
            priority: 1,
            model: info?.name || 'unknown',
        }];
    }

    async switchProvider(name) {
        const providerEntry = this._providers?.find((provider) => provider.name === name);
        if (!providerEntry) {
            throw new Error(`Proveedor LLM desconocido: ${name}`);
        }
        if (this._fallbackManager?.setActiveProvider) {
            this._fallbackManager.setActiveProvider(name);
        }
        this.active = providerEntry.instance;
        this.onFallback = providerEntry.instance !== this.primary;
        await this.active.initSession(this._systemPrompt);
        this._metrics.provider = name;
        this.logger.log(`${FALLBACK_SWITCH_LOG} Provider activo cambiado por Admin: ${name}`);
        return {
            name,
            model: this.active.getModelInfo?.()?.name || name,
            active: true,
        };
    }

    getMetrics() {
        const total = this._metrics.total_calls;
        return {
            provider: this._metrics.provider,
            total_calls: total,
            fallback_count: this._metrics.fallback_count,
            avg_latency_ms: total > 0 ? Math.round(this._metrics.total_latency_ms / total) : 0,
            errors: this._metrics.errors,
            last_call: this._metrics.last_call,
        };
    }

    async processAudio(pcm16, sampleRate = 24000) {
        try {
            return await this._withFallback(
                () => this.active.sendText('[Audio recibido - modo texto]', this.history),
                null
            );
        } catch (err) {
            return this._handleError(err);
        }
    }

    async processText(text) {
        try {
            const response = await this._withFallback(
                () => this.active.sendText(text, this.history),
                null
            );
            this._appendHistory('user', text);
            return this._processResponse(response);
        } catch (err) {
            return this._handleError(err);
        }
    }

    async processTextStream(text, onSentence) {
        if (!this.active._chatStream) {
            this.logger.warn('[Stream] Adapter does not support streaming, falling back to non-streaming');
            const response = await this.processText(text);
            if (onSentence) onSentence(response.text, true);
            return response;
        }
        try {
            const voicePrompt = 'Eres Uchino, un robot mesero de una cafetería peruana. Habla en español peruano natural, usando jerga como causa, pata, pe, al toque. Sé breve (máximo 2 oraciones). Solo responde conversacionalmente.';
            // Para voz, usar el provider de menor latencia (evita deepseek-v4-flash que hace reasoning 5-10s)
            const originalActive = this.active;
            const fastProvider = this._providers?.find(p => p.name?.includes('llama') || p.name?.includes('qwen-9b-ollama'))?.instance;
            const useProvider = fastProvider || this.active;
            useProvider.messages = [
                { role: 'system', content: voicePrompt },
                { role: 'user', content: text },
            ];
            // Voice mode: deshabilitar tools para que el LLM devuelva texto conversacional
            // (con tools, llama-3.1-8b y deepseek-v4-flash prefieren llamar funciones en vez de responder texto)
            const originalTools = useProvider.tools;
            useProvider.tools = [];
            useProvider._voiceMode = true;
            this._appendHistory('user', text);

            let lastSentLength = 0;
            const pendingCallbacks = [];
            const fullText = await useProvider._chatStream((currentText, isFinal) => {
                if (onSentence && currentText.length > lastSentLength) {
                    let searchFrom = lastSentLength;
                    let match;
                    const sentenceEndRe = /[.!?¡¿]\s/g;
                    sentenceEndRe.lastIndex = searchFrom;
                    while ((match = sentenceEndRe.exec(currentText)) !== null) {
                        const endIdx = match.index + 2;
                        // Solo la NUEVA oración, no la acumulación completa
                        const newSentence = currentText.slice(lastSentLength, endIdx).trim();
                        if (newSentence.length > 3) {
                            pendingCallbacks.push(Promise.resolve(onSentence(newSentence, false)));
                            lastSentLength = endIdx;
                        }
                        searchFrom = endIdx;
                    }
                    if (isFinal && lastSentLength < currentText.length) {
                        const rem = currentText.slice(lastSentLength).trim();
                        if (rem.length > 0) pendingCallbacks.push(Promise.resolve(onSentence(rem, true)));
                    }
                }
            });
            useProvider.tools = originalTools;
            useProvider._voiceMode = false;
            this.active = originalActive;
            // Retornar promesas para que el caller decida cuándo esperar (paralelismo real)
            return { text: fullText, audio: null, pendingCallbacks };
        } catch (err) {
            this.logger.warn(`[Stream] Failed: ${err.message}, falling back to non-streaming`);
            return await this.processText(text);
        }
    }

    async processWithMessages(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            throw new Error('processWithMessages requires a non-empty messages array');
        }
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const userText = lastUser ? lastUser.content : '';
        try {
            this.active.messages = messages;
            const response = await this._withFallback(
                () => this.active._chat(),
                null
            );
            this._appendHistory('user', userText);
            return this._processResponse(response);
        } catch (err) {
            return this._handleError(err);
        }
    }

    async processImage(image, prompt) {
        try {
            // Cascade: (1) Qwen3 VL 8B describe la imagen, (2) DeepSeek V4 Flash refina la respuesta
            if (!this._visionProvider) {
                this._visionProvider = createVisionProvider();
                await this._visionProvider.initSession().catch(() => {});
            }
            this.logger.log('[Vision] Paso 1: Qwen3 VL 8B describe la imagen...');
            const visionDesc = await this._visionProvider.sendImage(image, prompt);

            this.logger.log('[Vision] Paso 2: DeepSeek V4 Flash refina la respuesta...');
            const refinePrompt = `El usuario envió una imagen. Un modelo de visión la describió así: "${visionDesc}". El usuario dijo: "${prompt}". Responde al usuario considerando el contexto visual.`;
            const response = await this.active.sendText(refinePrompt, this.history);
            this._appendHistory('user', `[Imagen: ${prompt}]`);
            return this._processResponse(response);
        } catch (err) {
            this.logger.warn(`[Vision] Cascade failed: ${err.message}, fallback a texto simple`);
            return this._handleError(err);
        }
    }

    async shutdown() {
        await this.active.closeSession();
        if (this._healthTimer) {
            clearInterval(this._healthTimer);
            this._healthTimer = null;
        }
        if (this._fallbackManager) {
            this._fallbackManager.stopHealthChecks();
        }
        this.history = [];
        this.logger.log(`${FALLBACK_SWITCH_LOG} Sesión cerrada`);
    }

    async _withFallback(primaryFn, fallbackFn) {
        const startedAt = Date.now();
        const startProvider = this._activeProviderName();
        if (this._fallbackManager) {
            try {
                const result = await this._fallbackManager.executeWithFallback((provider) => {
                    this.active = provider.instance || provider;
                    return primaryFn();
                });
                this._recordMetric(startedAt, startProvider);
                return result;
            } catch (err) {
                this._recordMetric(startedAt, startProvider, err);
                throw err;
            }
        }
        try {
            const result = await primaryFn();
            this._recordMetric(startedAt, startProvider);
            return result;
        } catch (err) {
            if (!this.fallback) {
                this._recordMetric(startedAt, startProvider, err);
                throw err;
            }
            if (!this.onFallback) {
                this.logger.warn(`${FALLBACK_SWITCH_LOG} Error en ${this.active.getModelInfo().name}, cambiando a fallback:`, err.message);
                this._switchToFallback();
            }
            const fn = fallbackFn || (() => this.active.sendText('[Fallback activo]', this.history));
            try {
                const result = await fn();
                this._recordMetric(startedAt, startProvider);
                return result;
            } catch (fallbackErr) {
                this._recordMetric(startedAt, startProvider, fallbackErr);
                throw fallbackErr;
            }
        }
    }

    _activeProviderName() {
        if (this._fallbackManager) {
            return this._fallbackManager.getActiveProvider()?.name || this.active?.getModelInfo?.().name || 'unknown';
        }
        return this.active?.getModelInfo?.().name || 'unknown';
    }

    _recordMetric(startedAt, startProvider, err = null) {
        const provider = this._activeProviderName();
        this._metrics.total_calls += 1;
        this._metrics.total_latency_ms += Date.now() - startedAt;
        this._metrics.provider = provider;
        if (startProvider && provider !== startProvider) {
            this._metrics.fallback_count += 1;
        }
        if (err) {
            this._metrics.errors += 1;
        }
        this._metrics.last_call = new Date().toISOString();
    }

    _switchToFallback() {
        this.onFallback = true;
        this.active = this.fallback;
        this.active.initSession(this._systemPrompt).catch(() => {});
        this.logger.warn(`${FALLBACK_SWITCH_LOG} → Fallback activo: ${this.active.getModelInfo().name}`);
        this._startHealthCheck();
    }

    _switchToPrimary() {
        this.onFallback = false;
        this.active = this.primary;
        if (this._healthTimer) {
            clearInterval(this._healthTimer);
            this._healthTimer = null;
        }
        this.active.initSession(this._systemPrompt).catch(() => {});
        this.logger.log(`${FALLBACK_SWITCH_LOG} → Restaurado a primario: ${this.active.getModelInfo().name}`);
    }

    _startHealthCheck() {
        if (this._healthTimer) clearInterval(this._healthTimer);
        this._healthTimer = setInterval(async () => {
            try {
                const testResult = await this.primary.sendText('Responde exactamente: OK', []);
                if (testResult.text && testResult.text.trim().length > 0) {
                    this.logger.log(`${FALLBACK_SWITCH_LOG} Health check OK — primario responde`);
                    this._switchToPrimary();
                }
            } catch {
                this.logger.log(`${FALLBACK_SWITCH_LOG} Health check — primario aún no disponible`);
            }
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    _handleError(err) {
        this.logger.error(`${FALLBACK_SWITCH_LOG} Error crítico:`, err.message);
        return {
            text: 'Lo siento, estoy teniendo problemas para conectarme. Por favor, intenta de nuevo en un momento.',
            audio: null,
            actions: [],
        };
    }

    _processResponse(response) {
        const actions = [];

        if (response.functionCalls?.length > 0) {
            for (const call of response.functionCalls) {
                const result = this._executeFunction(call);
                actions.push({ name: call.name, args: call.args, result });
            }
        }

        const emotionCall = response.functionCalls?.find(c => c.name === 'expresar_emocion');
        if (emotionCall && this.onEmotion) {
            this.onEmotion(emotionCall.args.emocion, emotionCall.args.mensaje);
        }

        if (response.text) {
            this._appendHistory('model', response.text);
        }

        return {
            text: response.text,
            audio: response.audio,
            actions,
        };
    }

    _executeFunction(call) {
        const handler = this.handlers[call.name];
        if (!handler) {
            this.logger.warn(`${FALLBACK_SWITCH_LOG} No hay handler para: ${call.name}`);
            return { error: `Función no implementada: ${call.name}` };
        }
        try {
            return handler(call.args);
        } catch (err) {
            this.logger.error(`${FALLBACK_SWITCH_LOG} Error en ${call.name}:`, err.message);
            return { error: err.message };
        }
    }

    _appendHistory(role, content) {
        this.history.push({ role, content });
        if (this.history.length > 20) {
            this.history = this.history.slice(-20);
        }
    }
}
