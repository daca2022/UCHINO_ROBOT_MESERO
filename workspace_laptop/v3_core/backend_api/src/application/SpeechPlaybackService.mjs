import { randomUUID } from 'node:crypto';
import { sanitizeForSpeech } from './SpeechTextSanitizer.mjs';

/**
 * Orquesta sanitización, cola local y ciclo de vida de voz. El reproductor
 * concreto sigue siendo intercambiable; esta capa evita que cada ruta invente
 * su propia limpieza o reproduzca una respuesta de una sesión anterior.
 */
export class SpeechPlaybackService {
    constructor({ player, notify = () => {}, logger = console, isSessionActive = () => true } = {}) {
        this.player = player;
        this.notify = notify;
        this.logger = logger;
        this.isSessionActive = isSessionActive;
        this.generation = 0;
        this.current = null;
        this.items = new Map();
        this.history = new Map();

        player?.on?.('playback_started', event => this._onPlayerEvent('tts_segment_started', event));
        player?.on?.('playback_completed', event => this._onPlayerEvent('tts_segment_completed', event));
        player?.on?.('playback_failed', event => this._onPlayerEvent('tts_failed', event));
        player?.on?.('cancelled', event => this._onPlayerEvent('tts_interrupted', event));
    }

    prepare(input, options = {}) {
        const startedAt = Date.now();
        this._emit('speech_sanitization_started', {
            input_length: String(input?.text || input?.response_text || input || '').length,
            source: options.source || 'unknown',
            session_id: options.sessionId || null,
            order_id: options.orderId || null,
        });
        const result = sanitizeForSpeech(input, options);
        const durationMs = Date.now() - startedAt;
        const metadata = {
            ...result.metadata,
            duration_ms: durationMs,
            source: options.source || null,
        };
        const prepared = { ...result, metadata };
        this._rememberPrepared(prepared, options);
        this._emit('speech_sanitization_completed', {
            session_id: options.sessionId || null,
            order_id: options.orderId || null,
            input_length: result.metadata.input_length,
            output_length: result.metadata.output_length,
            segment_count: result.segments.length,
            duration_ms: durationMs,
            source: options.source || 'unknown',
            result: result.speechText ? 'ok' : 'empty',
            display_text: result.displayText,
            speech_text: result.speechText,
            speech_segments: result.segments,
            sanitization: metadata,
        });
        if (result.metadata.markdown_removed) this._emit('markdown_removed', { source: options.source || 'unknown' });
        if (result.metadata.currency_normalized) this._emit('currency_normalized', { source: options.source || 'unknown' });
        if (result.segments.length > 1) this._emit('speech_segmented', { segment_count: result.segments.length, source: options.source || 'unknown' });
        return prepared;
    }

    speak(input, options = {}) {
        const prepared = options.sanitized ? input : this.prepare(input, options);
        const sessionId = options.sessionId || null;
        if (sessionId && !options.allowClosedSession && !this.isSessionActive(sessionId)) {
            this._emit('stale_tts_rejected', {
                session_id: sessionId,
                source: options.source || 'unknown',
                reason: 'session_not_active',
            });
            return { prepared, ids: [], rejected: true };
        }
        if (!prepared.speechText || prepared.segments.length === 0 || !this.player?.isReady) {
            return { prepared, ids: [], rejected: false };
        }

        this.cancel({ reason: 'replaced', silent: true });
        const generation = ++this.generation;
        const context = {
            id: randomUUID(),
            generation,
            sessionId,
            orderId: options.orderId || null,
            visitId: options.visitId || null,
            mesa: options.mesa || null,
            source: options.source || 'unknown',
            segments: prepared.segments,
            speechText: prepared.speechText,
            displayText: prepared.displayText,
            metadata: prepared.metadata,
        };
        this.current = context;
        this._rememberPrepared(prepared, context);
        const ids = [];
        prepared.segments.forEach((segment, segmentIndex) => {
            const id = randomUUID();
            this.items.set(id, {
                ...context,
                id,
                queueId: context.id,
                segmentIndex,
                segmentCount: prepared.segments.length,
            });
            const spokenId = this.player.speak(segment, { id, emotion: options.emotion || 'feliz' });
            if (spokenId) ids.push(spokenId);
            else this.items.delete(id);
        });
        this._emit('tts_queue_created', {
            session_id: sessionId,
            order_id: context.orderId,
            visit_id: context.visitId,
            mesa: context.mesa,
            segment_count: prepared.segments.length,
            queue_id: context.id,
            generation,
            source: context.source,
        });
        return { prepared, ids, rejected: false, queueId: context.id, generation };
    }

    repeat(prepared, options = {}) {
        this._emit('speech_repeated', { session_id: options.sessionId || null, source: options.source || 'ui' });
        return this.speak(prepared, { ...options, sanitized: true });
    }

    repeatLast(sessionId, options = {}) {
        const entry = sessionId ? this.history.get(sessionId) : null;
        if (!entry) {
            return { prepared: null, ids: [], rejected: false, missing: true };
        }
        return this.repeat(entry.prepared, {
            ...entry.options,
            ...options,
            sessionId,
            source: options.source || 'ui_repeat',
        });
    }

    clearSession(sessionId) {
        if (sessionId) this.history.delete(sessionId);
    }

    _rememberPrepared(prepared, options = {}) {
        const sessionId = options.sessionId || options.session_id || null;
        if (!sessionId || !prepared?.speechText) return;
        this.history.set(sessionId, {
            prepared,
            options: {
                sessionId,
                orderId: options.orderId || options.order_id || null,
                visitId: options.visitId || options.visit_id || null,
                mesa: options.mesa || null,
                source: options.source || 'unknown',
                emotion: options.emotion || 'feliz',
            },
        });
        while (this.history.size > 20) {
            this.history.delete(this.history.keys().next().value);
        }
    }

    cancel({ reason = 'interrupted', sessionId = null, silent = false } = {}) {
        if (!silent) {
            this._emit('tts_interrupted', { session_id: sessionId, reason });
        }
        this.generation += 1;
        this.current = null;
        this.items.clear();
        this.player?.cancel?.();
    }

    diagnostics() {
        return {
            generation: this.generation,
            current: this.current ? {
                session_id: this.current.sessionId,
                order_id: this.current.orderId,
                mesa: this.current.mesa,
                source: this.current.source,
                segment_count: this.current.segments.length,
                speech_text: this.current.speechText,
                display_text: this.current.displayText,
                sanitization: this.current.metadata,
            } : null,
            pending_segments: this.items.size,
            history_entries: this.history.size,
            ready: Boolean(this.player?.isReady),
            speaking: Boolean(this.player?.isSpeaking),
        };
    }

    _onPlayerEvent(type, event = {}) {
        const item = this.items.get(event.id);
        if (!item || item.generation !== this.generation) {
            if (event.id) this._emit('stale_tts_rejected', { segment_id: event.id, reason: 'generation_changed' });
            return;
        }
        if (type === 'tts_segment_completed' || type === 'tts_failed' || type === 'tts_interrupted') {
            this.items.delete(event.id);
        }
        this._emit(type, {
            segment_id: event.id,
            session_id: item.sessionId,
            order_id: item.orderId,
            visit_id: item.visitId,
            mesa: item.mesa,
            segment_index: item.segmentIndex,
            segment_count: item.segmentCount,
            queue_id: item.queueId || item.id,
            source: item.source,
            duration_ms: event.duration_ms || null,
            error: event.error || null,
        });
    }

    _emit(name, detail = {}) {
        const event = {
            event: name,
            timestamp: new Date().toISOString(),
            ...detail,
        };
        try {
            this.notify({ type: 'speech_tts_event', ...event });
        } catch (error) {
            this.logger.warn?.(`[SpeechPlayback] notify failed: ${error.message}`);
        }
        return event;
    }
}
