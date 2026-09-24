import {
    deriveSafetyContext,
    findConfiguredModifier,
    menuQuery,
    normalizeSafetyMenuItem,
    normalizeSafetyText,
    sanitizeSpeechText,
} from './Fase5Safety.mjs';

function json(value, fallback) {
    return value === undefined || value === null ? fallback : value;
}

export class Fase5SafetyService {
    constructor({ pgPool = null, notify = null, logger = console } = {}) {
        this.pgPool = pgPool;
        this.notify = notify;
        this.logger = logger;
    }

    derive(items, menu, session) {
        return deriveSafetyContext(
            items,
            menu,
            session?.declared_allergies || [],
            session?.dietary_restrictions || [],
        );
    }

    resolveModifier(menuItem, request) {
        return findConfiguredModifier(normalizeSafetyMenuItem(menuItem), request);
    }

    query(menu, options) {
        return menuQuery(menu, options);
    }

    speech(text) {
        return sanitizeSpeechText(text);
    }

    async record({
        event,
        sessionId = null,
        orderId = null,
        itemId = null,
        productId = null,
        mesa = null,
        actor = 'user',
        previousState = {},
        nextState = {},
        source = 'asr',
        metadata = {},
    } = {}) {
        if (!event) throw new Error('event es obligatorio');
        const payload = {
            event,
            session_id: sessionId,
            order_id: orderId,
            item_id: itemId,
            product_id: productId,
            mesa,
            timestamp: new Date().toISOString(),
            actor,
            previous_state: json(previousState, {}),
            next_state: json(nextState, {}),
            source,
            metadata: json(metadata, {}),
        };
        if (this.pgPool) {
            await this.pgPool.query(
                `INSERT INTO pedido_eventos
                 (event, session_id, order_id, item_id, product_id, mesa, timestamp, actor,
                  previous_state, next_state, source, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb)`,
                [
                    payload.event, payload.session_id, payload.order_id, payload.item_id, payload.product_id,
                    payload.mesa, payload.timestamp, payload.actor, JSON.stringify(payload.previous_state),
                    JSON.stringify(payload.next_state), payload.source, JSON.stringify(payload.metadata),
                ],
            );
        }
        this.notify?.({ type: 'order_safety_event', event: payload });
        return payload;
    }

    async listEvents({ orderId = null, sessionId = null, limit = 100 } = {}) {
        if (!this.pgPool) return [];
        const values = [];
        const clauses = [];
        if (orderId) { values.push(orderId); clauses.push(`order_id = $${values.length}`); }
        if (sessionId) { values.push(sessionId); clauses.push(`session_id = $${values.length}`); }
        const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
        values.push(safeLimit);
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const result = await this.pgPool.query(
            `SELECT * FROM pedido_eventos ${where} ORDER BY timestamp DESC LIMIT $${values.length}`,
            values,
        );
        return result.rows;
    }

    async listSafetyOrders(pedidoRepo, { limit = 100 } = {}) {
        const result = await pedidoRepo.findAll({}, { orderBy: 'timestamp DESC', limit: Math.min(500, Math.max(1, Number(limit) || 100)) });
        return (result.data || []).filter(order => (
            order.requires_special_confirmation
            || order.declared_allergies?.length
            || order.allergy_conflicts?.length
            || order.special_warning
        ));
    }

    describeQuery(queryResult) {
        if (['safe_options', 'ingredient_exclusion'].includes(queryResult.type)) {
            const details = queryResult.items?.map(item => item.nombre).join(', ');
            const unknown = queryResult.unknown_items?.length
                ? ` No incluyo ${queryResult.unknown_items.map(item => item.nombre).join(', ')} porque su ficha está incompleta.`
                : '';
            if (queryResult.type === 'safe_options') {
                return `${details ? `Según los ingredientes registrados, las opciones sin ${queryResult.allergen} registrado son: ${details}.` : `No encontré una opción confirmada sin ${queryResult.allergen} registrado.`}${unknown} No puedo garantizar ausencia de contaminación cruzada.`;
            }
            return `${details ? `Según la información registrada, no aparece ${queryResult.ingredient} en: ${details}.` : `No encontré productos confirmados sin ${queryResult.ingredient} registrado.`}${unknown}`;
        }
        if (queryResult.type === 'restriction' && !queryResult.items?.length) {
            return `No encontré opciones marcadas como ${queryResult.restriction} en el menú real. No asumiré compatibilidad sin información configurada.`;
        }
        if (!queryResult.items?.length) return 'No tengo productos registrados que coincidan con esa consulta.';
        if (queryResult.type === 'ingredients') {
            const details = queryResult.items.map(item => {
                const ingredients = item.ingredientes.length ? item.ingredientes.join(', ') : 'ingredientes no registrados';
                return `${item.nombre}: ${ingredients}`;
            });
            return `${details.join('. ')}. ${queryResult.complete ? '' : 'La información de alguna ficha está incompleta.'}`.trim();
        }
        if (queryResult.type === 'allergen') {
            const details = queryResult.items.map(item => item.nombre).join(', ');
            return `El registro relaciona ${queryResult.allergen} con: ${details}. No puedo garantizar ausencia de contaminación cruzada.`;
        }
        if (queryResult.type === 'restriction') {
            const details = queryResult.items.map(item => item.nombre).join(', ');
            return `Según las restricciones configuradas, estas opciones están marcadas como ${queryResult.restriction}: ${details}. No puedo garantizar ausencia de contaminación cruzada.`;
        }
        return queryResult.items.map(item => item.nombre).join(', ');
    }

    matchesAllergen(value, allergen) {
        const left = normalizeSafetyText(value);
        const right = normalizeSafetyText(allergen);
        return left === right || left.includes(right) || right.includes(left);
    }
}
