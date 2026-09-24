/**
 * TurnManager — Gestor de turnos conversacionales, barge-in y TTS obsoleto.
 *
 * Controla:
 * - Cuándo puede hablar Uchino proactivamente
 * - Detección de barge-in (usuario interrumpe TTS)
 * - Cancelación de TTS obsoleto
 * - Cooldown entre mensajes proactivos
 *
 * @module application/TurnManager
 */

export class TurnManager {
    /**
     * @param {object} options
     * @param {number} [options.proactiveCooldownMs=5000] - Cooldown mínimo entre mensajes proactivos
     * @param {number} [options.bargeInGraceMs=300] - Tiempo de gracia antes de considerar barge-in
     * @param {object} [options.logger]
     */
    constructor({
        proactiveCooldownMs = 5000,
        bargeInGraceMs = 300,
        logger = null,
    } = {}) {
        this._proactiveCooldownMs = proactiveCooldownMs;
        this._bargeInGraceMs = bargeInGraceMs;
        this._logger = logger || { log: () => {}, warn: () => {}, error: () => {} };

        // Estado del turno actual
        this._state = {
            user_speaking: false,
            user_speaking_since: null,
            asr_final_pending: false,
            llm_processing: false,
            tts_active: false,
            tts_started_at: null,
            tts_message_key: null,
            tts_session_id: null,
            last_proactive_at: null,
            last_user_utterance_at: null,
            current_session_id: null,
        };
    }

    get snapshot() { return { ...this._state }; }
    get canUserSpeak() { return true; } // El usuario siempre puede hablar
    get isTtsActive() { return this._state.tts_active; }
    get canProactiveSpeak() {
        if (this._state.user_speaking) return false;
        if (this._state.asr_final_pending) return false;
        if (this._state.llm_processing) return false;
        if (this._state.tts_active) return false;
        if (this._state.last_proactive_at) {
            const elapsed = Date.now() - this._state.last_proactive_at;
            if (elapsed < this._proactiveCooldownMs) return false;
        }
        return true;
    }

    // ── Eventos del usuario ───────────────────────────────────────────────

    /**
     * El usuario empieza a hablar.
     */
    userStartedSpeaking({ sessionId = null } = {}) {
        this._state.user_speaking = true;
        this._state.user_speaking_since = Date.now();
        this._state.last_user_utterance_at = Date.now();
        if (sessionId) this._state.current_session_id = sessionId;

        // Si TTS estaba activo, detectar barge-in
        if (this._state.tts_active) {
            const ttsElapsed = Date.now() - (this._state.tts_started_at || 0);
            if (ttsElapsed > this._bargeInGraceMs) {
                this._logger.log('[TurnManager] Barge-in detectado: usuario interrumpe TTS');
                return {
                    bargeIn: true,
                    ttsMessageKey: this._state.tts_message_key,
                    ttsSessionId: this._state.tts_session_id,
                    action: 'CANCEL_TTS',
                };
            }
        }
        return { bargeIn: false };
    }

    /**
     * El usuario dejó de hablar (fin de utterance).
     */
    userStoppedSpeaking() {
        this._state.user_speaking = false;
        this._state.user_speaking_since = null;
    }

    // ── Pipeline de procesamiento ─────────────────────────────────────────

    /**
     * ASR tiene texto final pendiente de procesar.
     */
    asrFinalReceived() {
        this._state.asr_final_pending = true;
    }

    /**
     * ASR final fue consumido por el pipeline.
     */
    asrFinalConsumed() {
        this._state.asr_final_pending = false;
    }

    /**
     * LLM está procesando.
     */
    llmProcessingStarted() {
        this._state.llm_processing = true;
    }

    /**
     * LLM terminó de procesar.
     */
    llmProcessingFinished() {
        this._state.llm_processing = false;
    }

    // ── TTS ────────────────────────────────────────────────────────────────

    /**
     * TTS comenzó a reproducir. Registra el mensaje para detección de obsolescencia.
     */
    ttsStarted({ messageKey, sessionId } = {}) {
        this._state.tts_active = true;
        this._state.tts_started_at = Date.now();
        this._state.tts_message_key = messageKey || null;
        this._state.tts_session_id = sessionId || null;
    }

    /**
     * TTS terminó de reproducir naturalmente.
     */
    ttsFinished() {
        this._state.tts_active = false;
        this._state.tts_started_at = null;
        this._state.tts_message_key = null;
    }

    /**
     * Cancela TTS activo (por barge-in o mensaje obsoleto).
     */
    cancelTts({ reason = 'barge_in' } = {}) {
        const wasActive = this._state.tts_active;
        const messageKey = this._state.tts_message_key;
        this._state.tts_active = false;
        this._state.tts_started_at = null;
        this._state.tts_message_key = null;
        this._logger.log(`[TurnManager] TTS cancelado (${reason})`);
        return {
            wasActive,
            cancelledMessageKey: messageKey,
            reason,
        };
    }

    // ── Mensajes proactivos ───────────────────────────────────────────────

    /**
     * Registra que se emitió un mensaje proactivo.
     */
    proactiveMessageSent() {
        this._state.last_proactive_at = Date.now();
    }

    // ── Verificación de obsolescencia ──────────────────────────────────────

    /**
     * Verifica si un mensaje TTS o proactivo debe considerarse obsoleto.
     * @param {string} messageKey - Clave del mensaje
     * @param {string} sessionId - Sesión para la que se generó
     * @returns {boolean}
     */
    isMessageStale({ messageKey, sessionId, expiresAt }) {
        // Mensaje expirado por tiempo
        if (expiresAt && new Date(expiresAt) < new Date()) return true;

        // Mensaje de una sesión que ya no es la actual
        if (sessionId && this._state.current_session_id
            && sessionId !== this._state.current_session_id) return true;

        return false;
    }

    /**
     * Determina si un mensaje de movimiento debe cancelarse porque
     * el robot ya cambió de estado.
     * Ej: "Voy a cocina" ya no es relevante si el robot ya está en cocina.
     */
    isMovementMessageStale({ messageKey, currentRobotState }) {
        const movementMessages = {
            going_to_kitchen: ['going_to_kitchen'],
            picking_up: ['going_to_kitchen', 'picking_up'],
            going_to_table: ['going_to_table', 'picking_up'],
            delivering: ['going_to_table', 'delivering'],
            returning: ['returning', 'delivering'],
        };

        if (!messageKey || !currentRobotState) return false;
        const staleFor = movementMessages[messageKey];
        if (!staleFor) return false;
        return !staleFor.includes(currentRobotState);
    }

    // ── Reset ──────────────────────────────────────────────────────────────

    reset() {
        this._state = {
            user_speaking: false,
            user_speaking_since: null,
            asr_final_pending: false,
            llm_processing: false,
            tts_active: false,
            tts_started_at: null,
            tts_message_key: null,
            tts_session_id: null,
            last_proactive_at: null,
            last_user_utterance_at: null,
            current_session_id: this._state.current_session_id,
        };
    }
}
