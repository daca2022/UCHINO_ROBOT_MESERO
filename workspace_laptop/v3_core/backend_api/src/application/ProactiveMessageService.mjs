/**
 * ProactiveMessageService — Servicio central de mensajes proactivos de Uchino.
 *
 * Gestiona cuándo y qué dice Uchino automáticamente cuando ocurren eventos
 * operativos (asignación, llegada, entrega, etc.). Cada mensaje es un evento
 * único que no se repite y que puede expirar.
 *
 * Eventos cubiertos:
 *   robot_assigned, arrived_at_table, interaction_mode_required,
 *   waiter_requested, order_item_added, order_confirmed,
 *   sent_to_kitchen, order_ready, going_to_kitchen,
 *   picking_up, going_to_table, arrived_at_table_for_delivery,
 *   delivery_completed, returning, attention_cancelled,
 *   robot_available.
 *
 * @module application/ProactiveMessageService
 */

import { randomUUID } from 'node:crypto';

export const ProactiveEventType = Object.freeze({
    ROBOT_ASSIGNED: 'robot_assigned',
    ARRIVED_AT_TABLE: 'arrived_at_table',
    INTERACTION_MODE_REQUIRED: 'interaction_mode_required',
    WAITER_REQUESTED: 'waiter_requested',
    ORDER_ITEM_ADDED: 'order_item_added',
    ORDER_CONFIRMED: 'order_confirmed',
    SENT_TO_KITCHEN: 'sent_to_kitchen',
    ORDER_READY: 'order_ready',
    GOING_TO_KITCHEN: 'going_to_kitchen',
    PICKING_UP: 'picking_up',
    GOING_TO_TABLE: 'going_to_table',
    ARRIVED_AT_TABLE_DELIVERY: 'arrived_at_table_for_delivery',
    DELIVERY_COMPLETED: 'delivery_completed',
    RETURNING: 'returning',
    ATTENTION_CANCELLED: 'attention_cancelled',
    ROBOT_AVAILABLE: 'robot_available',
});

// Prioridad: más alto = más importante
const EVENT_PRIORITY = Object.freeze({
    [ProactiveEventType.ROBOT_ASSIGNED]: 10,
    [ProactiveEventType.ARRIVED_AT_TABLE]: 10,
    [ProactiveEventType.INTERACTION_MODE_REQUIRED]: 8,
    [ProactiveEventType.WAITER_REQUESTED]: 7,
    [ProactiveEventType.ORDER_CONFIRMED]: 6,
    [ProactiveEventType.SENT_TO_KITCHEN]: 6,
    [ProactiveEventType.ORDER_READY]: 8,
    [ProactiveEventType.GOING_TO_KITCHEN]: 5,
    [ProactiveEventType.PICKING_UP]: 5,
    [ProactiveEventType.GOING_TO_TABLE]: 5,
    [ProactiveEventType.ARRIVED_AT_TABLE_DELIVERY]: 8,
    [ProactiveEventType.DELIVERY_COMPLETED]: 7,
    [ProactiveEventType.RETURNING]: 4,
    [ProactiveEventType.ATTENTION_CANCELLED]: 5,
    [ProactiveEventType.ORDER_ITEM_ADDED]: 3,
    [ProactiveEventType.ROBOT_AVAILABLE]: 2,
});

// Mensajes predefinidos por evento (fallback, el LLM puede sobrescribirlos)
const DEFAULT_MESSAGES = Object.freeze({
    [ProactiveEventType.ROBOT_ASSIGNED]: {
        text: 'Me asignaron para atender la mesa {{mesa}}. Ya voy para allá.',
        ttlMs: 30000,
    },
    [ProactiveEventType.ARRIVED_AT_TABLE]: {
        text: 'Hola, bienvenidos. Soy Uchino. Puedo tomar su pedido por voz, pueden usar la pantalla o puedo solicitar la ayuda de un mesero. Seleccionen la opción que prefieran.',
        ttlMs: 60000,
        maxPlays: 1, // Una sola vez por visita
    },
    [ProactiveEventType.INTERACTION_MODE_REQUIRED]: {
        text: '¿Prefieres pedir por voz o usar la pantalla?',
        ttlMs: 30000,
    },
    [ProactiveEventType.WAITER_REQUESTED]: {
        text: 'De acuerdo. Ya solicité la atención de un mesero. Mientras llega, puedes revisar el menú o hacerme alguna pregunta.',
        ttlMs: 60000,
    },
    [ProactiveEventType.ORDER_ITEM_ADDED]: {
        text: 'Agregué {{producto}}.',
        ttlMs: 15000,
    },
    [ProactiveEventType.ORDER_CONFIRMED]: {
        text: 'Pedido confirmado. Lo enviaré a cocina.',
        ttlMs: 30000,
    },
    [ProactiveEventType.SENT_TO_KITCHEN]: {
        text: 'Tu pedido ya está en cocina. Te avisaré cuando esté listo.',
        ttlMs: 30000,
    },
    [ProactiveEventType.ORDER_READY]: {
        text: 'El pedido para la mesa {{mesa}} está listo. Voy a recogerlo.',
        ttlMs: 30000,
    },
    [ProactiveEventType.GOING_TO_KITCHEN]: {
        text: 'Voy a cocina a recoger el pedido.',
        ttlMs: 30000,
    },
    [ProactiveEventType.PICKING_UP]: {
        text: 'Estoy recogiendo el pedido en cocina.',
        ttlMs: 30000,
    },
    [ProactiveEventType.GOING_TO_TABLE]: {
        text: 'Voy en camino a la mesa {{mesa}} con su pedido.',
        ttlMs: 30000,
    },
    [ProactiveEventType.ARRIVED_AT_TABLE_DELIVERY]: {
        text: 'Llegué a la mesa {{mesa}}. Aquí está su pedido.',
        ttlMs: 30000,
    },
    [ProactiveEventType.DELIVERY_COMPLETED]: {
        text: 'Entrega completada. Regreso a mi punto de espera.',
        ttlMs: 30000,
    },
    [ProactiveEventType.RETURNING]: {
        text: 'Regresando. Si necesitan algo, estaré disponible.',
        ttlMs: 30000,
    },
    [ProactiveEventType.ATTENTION_CANCELLED]: {
        text: 'Atención cancelada. La mesa {{mesa}} queda libre.',
        ttlMs: 15000,
    },
    [ProactiveEventType.ROBOT_AVAILABLE]: {
        text: 'Estoy disponible para atender.',
        ttlMs: 15000,
    },
});

export class ProactiveMessageService {
    /**
     * @param {object} options
     * @param {string} options.robotId
     * @param {object} [options.logger]
     */
    constructor({ robotId = 'uchino-01', logger = null } = {}) {
        this._robotId = robotId;
        this._logger = logger || { log: () => {}, warn: () => {} };
        /** @type {Map<string, object>} */
        this._messages = new Map();
        /** @type {Set<string>} keys de mensajes ya emitidos (una sola vez) */
        this._emittedOnce = new Set();
    }

    /**
     * Crea un mensaje proactivo para un evento.
     *
     * @param {string} eventType - Tipo de evento (ProactiveEventType)
     * @param {object} params
     * @param {string} params.sessionId
     * @param {string} [params.visitId]
     * @param {string} [params.orderId]
     * @param {string} [params.mesa]
     * @param {object} [params.vars] - Variables para interpolar en el texto
     * @param {string} [params.customText] - Texto personalizado (si lo provee el LLM)
     * @param {number} [params.ttlMs] - Tiempo de vida en ms
     * @returns {object|null} El mensaje creado o null si ya fue emitido (maxPlays=1)
     */
    createMessage(eventType, {
        sessionId,
        visitId = null,
        orderId = null,
        mesa = null,
        vars = {},
        customText = null,
        ttlMs = null,
    } = {}) {
        const defaults = DEFAULT_MESSAGES[eventType];
        if (!defaults) {
            this._logger.warn(`[ProactiveMessage] Tipo de evento desconocido: ${eventType}`);
            return null;
        }

        // Verificar maxPlays=1 (mensajes que solo se emiten una vez)
        if (defaults.maxPlays === 1) {
            const onceKey = `${eventType}:${visitId || sessionId || 'global'}`;
            if (this._emittedOnce.has(onceKey)) {
                this._logger.log(`[ProactiveMessage] Mensaje una-vez ya emitido: ${onceKey}`);
                return null;
            }
            this._emittedOnce.add(onceKey);
        }

        const messageId = randomUUID();
        const text = customText || this._interpolate(defaults.text, vars);
        const expiresAt = new Date(Date.now() + (ttlMs || defaults.ttlMs)).toISOString();

        const message = {
            event_id: messageId,
            robot_id: this._robotId,
            event_type: eventType,
            session_id: sessionId,
            visit_id: visitId,
            order_id: orderId,
            mesa: mesa || vars.mesa || null,
            priority: EVENT_PRIORITY[eventType] || 5,
            message_key: eventType,
            rendered_text: text,
            created_at: new Date().toISOString(),
            expires_at: expiresAt,
            spoken_at: null,
            status: 'pending', // pending | spoken | expired | cancelled
        };

        this._messages.set(messageId, message);
        this._logger.log(`[ProactiveMessage] Creado: ${eventType} "${text.slice(0, 60)}"`);

        return message;
    }

    /**
     * Marca un mensaje como hablado.
     */
    markSpoken(messageId) {
        const msg = this._messages.get(messageId);
        if (msg) {
            msg.spoken_at = new Date().toISOString();
            msg.status = 'spoken';
        }
    }

    /**
     * Marca un mensaje como cancelado (ej: por barge-in).
     */
    markCancelled(messageId) {
        const msg = this._messages.get(messageId);
        if (msg) {
            msg.status = 'cancelled';
        }
    }

    /**
     * Obtiene mensajes pendientes de hablar, ordenados por prioridad.
     * Solo retorna mensajes no expirados, no hablados.
     */
    getPendingMessages({ sessionId = null, maxResults = 5 } = {}) {
        const now = new Date();
        const pending = [];

        for (const [, msg] of this._messages) {
            if (msg.status !== 'pending') continue;
            if (new Date(msg.expires_at) < now) {
                msg.status = 'expired';
                continue;
            }
            if (sessionId && msg.session_id !== sessionId) continue;
            pending.push(msg);
        }

        // Ordenar por prioridad descendente, luego por antigüedad
        pending.sort((a, b) => b.priority - a.priority
            || new Date(a.created_at) - new Date(b.created_at));

        return pending.slice(0, maxResults);
    }

    /**
     * Limpia mensajes expirados del mapa interno.
     */
    cleanup() {
        const now = new Date();
        let cleaned = 0;
        for (const [id, msg] of this._messages) {
            if (new Date(msg.expires_at) < now) {
                msg.status = 'expired';
                this._messages.delete(id);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this._logger.log(`[ProactiveMessage] Limpiados ${cleaned} mensajes expirados`);
        }
    }

    /**
     * Reinicia el registro de mensajes "una sola vez" (para nueva visita).
     */
    resetOnceForVisit(visitId) {
        const toRemove = [];
        for (const key of this._emittedOnce) {
            if (key.includes(visitId)) toRemove.push(key);
        }
        for (const key of toRemove) {
            this._emittedOnce.delete(key);
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    _interpolate(template, vars) {
        return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
            return vars[key] !== undefined ? String(vars[key]) : `{{${key}}}`;
        });
    }
}
