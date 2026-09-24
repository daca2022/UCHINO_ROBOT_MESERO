/**
 * HybridVoiceRouter — Enrutador híbrido centralizado reglas + LLM.
 *
 * Cada turno de voz se clasifica en una de seis familias (CRITICAL_MUTATION,
 * STRUCTURED_QUERY, SOCIAL_CONVERSATION, CRITICAL_AMBIGUITY, OPERATIONAL_COMMAND,
 * UNKNOWN_NON_CRITICAL). La decisión de enrutamiento es única por turno y
 * centralizada aquí, no dispersa en múltiples archivos.
 *
 * REGLAS DETERMINÍSTICAS → precios, productos, cantidades, confirmaciones,
 *   alergias, modificadores, sesiones, visitas, mesas y pedidos.
 *
 * LLM → conversación, personalidad, razonamiento verbal, explicaciones,
 *   lenguaje natural, preguntas generales y reparación conversacional.
 *
 * @module application/HybridVoiceRouter
 */

import { classifyIntent, Intent, InteractionMode } from './IntentClassifier.mjs';

// ── Familias de enrutamiento ──────────────────────────────────────────────
export const RouteFamily = Object.freeze({
    CRITICAL_MUTATION: 'CRITICAL_MUTATION',
    STRUCTURED_QUERY: 'STRUCTURED_QUERY',
    SOCIAL_CONVERSATION: 'SOCIAL_CONVERSATION',
    CRITICAL_AMBIGUITY: 'CRITICAL_AMBIGUITY',
    OPERATIONAL_COMMAND: 'OPERATIONAL_COMMAND',
    UNKNOWN_NON_CRITICAL: 'UNKNOWN_NON_CRITICAL',
});

// ── Mapeo de intenciones a familias ───────────────────────────────────────
const INTENT_FAMILY_MAP = Object.freeze({
    // A. CRITICAL_MUTATION — mutan el pedido, la mesa o la sesión
    [Intent.ADD_PRODUCT]: RouteFamily.CRITICAL_MUTATION,
    [Intent.REMOVE_PRODUCT]: RouteFamily.CRITICAL_MUTATION,
    [Intent.CHANGE_QUANTITY]: RouteFamily.CRITICAL_MUTATION,
    [Intent.INCREMENT_QUANTITY]: RouteFamily.CRITICAL_MUTATION,
    [Intent.DECREMENT_QUANTITY]: RouteFamily.CRITICAL_MUTATION,
    [Intent.REPLACE_PRODUCT]: RouteFamily.CRITICAL_MUTATION,
    [Intent.ADD_ITEM_MODIFIER]: RouteFamily.CRITICAL_MUTATION,
    [Intent.REMOVE_ITEM_MODIFIER]: RouteFamily.CRITICAL_MUTATION,
    [Intent.REPLACE_ITEM_MODIFIER]: RouteFamily.CRITICAL_MUTATION,
    [Intent.ADD_ITEM_NOTE]: RouteFamily.CRITICAL_MUTATION,
    [Intent.REMOVE_ITEM_NOTE]: RouteFamily.CRITICAL_MUTATION,
    [Intent.REPLACE_ITEM_NOTE]: RouteFamily.CRITICAL_MUTATION,
    [Intent.DECLARE_ALLERGY]: RouteFamily.CRITICAL_MUTATION,
    [Intent.REMOVE_ALLERGY]: RouteFamily.CRITICAL_MUTATION,
    [Intent.DECLARE_DIETARY_RESTRICTION]: RouteFamily.CRITICAL_MUTATION,
    [Intent.CONFIRM_ORDER]: RouteFamily.CRITICAL_MUTATION,
    [Intent.CANCEL_ORDER]: RouteFamily.CRITICAL_MUTATION,
    [Intent.CHANGE_TABLE]: RouteFamily.CRITICAL_MUTATION,
    [Intent.START_ADDITIONAL_ORDER]: RouteFamily.CRITICAL_MUTATION,
    [Intent.FINISH_CONVERSATION]: RouteFamily.CRITICAL_MUTATION,
    [Intent.SELECT_INTERACTION_MODE]: RouteFamily.CRITICAL_MUTATION,
    [Intent.CHANGE_INTERACTION_MODE]: RouteFamily.CRITICAL_MUTATION,
    [Intent.REQUEST_HUMAN_WAITER]: RouteFamily.CRITICAL_MUTATION,
    [Intent.REPEAT_PRODUCT]: RouteFamily.CRITICAL_MUTATION,

    // B. STRUCTURED_QUERY — consultas de solo lectura con datos reales
    [Intent.CONSULT_MENU]: RouteFamily.STRUCTURED_QUERY,
    [Intent.SHOW_CATEGORY]: RouteFamily.STRUCTURED_QUERY,
    [Intent.CONSULT_ORDER]: RouteFamily.STRUCTURED_QUERY,
    [Intent.QUERY_INGREDIENTS]: RouteFamily.STRUCTURED_QUERY,
    [Intent.QUERY_ALLERGENS]: RouteFamily.STRUCTURED_QUERY,
    [Intent.QUERY_DIETARY_OPTIONS]: RouteFamily.STRUCTURED_QUERY,
    [Intent.QUERY_MODIFIER_OPTIONS]: RouteFamily.STRUCTURED_QUERY,
    [Intent.QUERY_PRODUCT_DETAILS]: RouteFamily.STRUCTURED_QUERY,
    [Intent.QUERY_PRICE]: RouteFamily.STRUCTURED_QUERY,
    [Intent.QUERY_AVAILABILITY]: RouteFamily.STRUCTURED_QUERY,
    [Intent.QUERY_POPULAR_PRODUCTS]: RouteFamily.STRUCTURED_QUERY,
    [Intent.QUERY_AFFORDABLE_PRODUCTS]: RouteFamily.STRUCTURED_QUERY,
    [Intent.QUERY_RECOMMENDATION]: RouteFamily.STRUCTURED_QUERY,
    [Intent.COMPARE_PRODUCTS]: RouteFamily.STRUCTURED_QUERY,
    [Intent.SELECT_VISIBLE_PRODUCT]: RouteFamily.STRUCTURED_QUERY,
    [Intent.RETURN_TO_MENU]: RouteFamily.STRUCTURED_QUERY,
    [Intent.CLEAR_MENU_FILTER]: RouteFamily.STRUCTURED_QUERY,
    [Intent.SEARCH_PRODUCT]: RouteFamily.STRUCTURED_QUERY,
    [Intent.LIST_PRODUCTS]: RouteFamily.STRUCTURED_QUERY,
    [Intent.IDENTIFY_CUSTOMER]: RouteFamily.STRUCTURED_QUERY,

    // C. SOCIAL_CONVERSATION — pasa directo al LLM
    [Intent.SOCIAL_CONVERSATION]: RouteFamily.SOCIAL_CONVERSATION,

    // D. CRITICAL_AMBIGUITY — no mutar, pedir aclaración
    [Intent.REQUEST_CLARIFICATION]: RouteFamily.CRITICAL_AMBIGUITY,

    // E. OPERATIONAL_COMMAND — comandos del personal
    // (Los comandos operacionales se clasifican en IntentClassifier con
    //  require_staff_auth, o se rechazan si el cliente los dice.)
});

// Commandos operacionales que siempre requieren autorización de personal
const OPERATIONAL_COMMAND_PATTERNS = [
    /\b(?:ve a la mesa|ir a la mesa|dirigete a la mesa|anda a la mesa)\s*(?:M|mesa\s*)?(\d{1,2})\b/iu,
    /\b(?:atiende la mesa|atender la mesa)\s*(?:M|mesa\s*)?(\d{1,2})\b/iu,
    /\b(?:cancela la asignacion|cancelar asignacion|libera el robot|liberar robot)\b/iu,
    /\b(?:regresa al punto de espera|vuelve a la base|regresar a la base)\b/iu,
    /\b(?:detente|detener|pausa|pausar)\b/iu,
    /\b(?:continua|continuar|sigue|seguir|reanuda|reanudar)\b/iu,
];

/**
 * Determina si un texto contiene un comando operacional que requiere
 * autorización de personal.
 */
function detectOperationalCommand(text) {
    if (!text) return null;
    for (const pattern of OPERATIONAL_COMMAND_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
            return {
                type: 'operational',
                mesa: match[1] ? `M${Number(match[1])}` : null,
                pattern: pattern.source.slice(0, 60),
            };
        }
    }
    return null;
}

// ── Clasificación de nivel de riesgo ──────────────────────────────────────
export const RiskLevel = Object.freeze({
    NONE: 'none',             // sin riesgo
    LOW: 'low',               // consulta de solo lectura
    MEDIUM: 'medium',         // mutación con validación
    HIGH: 'high',             // mutación que afecta seguridad alimentaria
    CRITICAL: 'critical',     // confirmación, cancelación, cambio de mesa
});

function assessRisk(intent, classification) {
    if (INTENT_FAMILY_MAP[intent] === RouteFamily.SOCIAL_CONVERSATION) return RiskLevel.NONE;
    if (INTENT_FAMILY_MAP[intent] === RouteFamily.STRUCTURED_QUERY) return RiskLevel.LOW;
    if (intent === Intent.CONFIRM_ORDER || intent === Intent.CANCEL_ORDER
        || intent === Intent.CHANGE_TABLE) return RiskLevel.CRITICAL;
    if (intent === Intent.DECLARE_ALLERGY || intent === Intent.DECLARE_DIETARY_RESTRICTION
        || intent === Intent.ADD_ITEM_MODIFIER) return RiskLevel.HIGH;
    if (INTENT_FAMILY_MAP[intent] === RouteFamily.CRITICAL_MUTATION) return RiskLevel.MEDIUM;
    if (INTENT_FAMILY_MAP[intent] === RouteFamily.CRITICAL_AMBIGUITY) return RiskLevel.MEDIUM;
    return RiskLevel.NONE;
}

/**
 * Clasifica un turno de voz en su familia de enrutamiento, con metadata
 * adicional para el pipeline downstream.
 *
 * @param {object} params
 * @param {string} params.text - Texto transcrito del usuario
 * @param {Array} params.menu - Menú actual
 * @param {Array} params.draftItems - Items en el draft
 * @param {string} params.state - Estado de sesión actual
 * @param {string} params.interactionMode - Modo de interacción
 * @param {string} params.lastProduct - Último producto referenciado
 * @param {boolean} params.isStaffMode - Si el modo staff está activo
 * @param {object} params.robotState - Estado físico del robot
 * @returns {object} { family, intent, classification, risk, operationalCommand, shouldRouteToLlm, requiresDeterministic }
 */
export function routeVoiceTurn({
    text,
    menu = [],
    draftItems = [],
    state = 'idle',
    interactionMode = null,
    lastProduct = null,
    isStaffMode = false,
    robotState = null,
}) {
    // 1. Detectar comandos operacionales (antes del classifier normal)
    const operationalCommand = detectOperationalCommand(text);

    // 2. Clasificar la intención usando el classifier existente
    const classification = classifyIntent({
        text,
        menu,
        draftItems,
        state,
        interactionMode,
        lastProduct,
    });

    const { intent, confidence } = classification;

    // 3. Si es comando operacional detectado
    if (operationalCommand) {
        // Solo procesar si está en modo staff
        if (!isStaffMode) {
            return {
                family: RouteFamily.OPERATIONAL_COMMAND,
                intent,
                classification,
                risk: RiskLevel.CRITICAL,
                operationalCommand,
                shouldRouteToLlm: true,
                requiresDeterministic: false,
                requiresStaffAuth: true,
                decision: 'BLOCKED_NO_STAFF_AUTH',
                reason: 'Operational commands require staff authorization',
            };
        }
        return {
            family: RouteFamily.OPERATIONAL_COMMAND,
            intent,
            classification,
            risk: RiskLevel.CRITICAL,
            operationalCommand,
            shouldRouteToLlm: false,
            requiresDeterministic: true,
            requiresStaffAuth: false,
            decision: 'OPERATIONAL_ALLOWED',
        };
    }

    // 4. Determinar la familia
    const family = INTENT_FAMILY_MAP[intent] || RouteFamily.UNKNOWN_NON_CRITICAL;

    // 5. Evaluar riesgo
    const risk = assessRisk(intent, classification);

    // 6. Decidir enrutamiento
    const shouldRouteToLlm = family === RouteFamily.SOCIAL_CONVERSATION
        || family === RouteFamily.UNKNOWN_NON_CRITICAL
        || family === RouteFamily.CRITICAL_AMBIGUITY;

    const requiresDeterministic = family === RouteFamily.CRITICAL_MUTATION
        || family === RouteFamily.STRUCTURED_QUERY
        || family === RouteFamily.OPERATIONAL_COMMAND;

    // 7. Verificar si el robot está en movimiento (no debe mutar pedidos nuevos)
    const robotIsInMotion = robotState && [
        'navigating_to_table', 'going_to_kitchen', 'picking_up',
        'going_to_table', 'delivering', 'returning',
    ].includes(robotState.state);

    if (robotIsInMotion && family === RouteFamily.CRITICAL_MUTATION
        && intent !== Intent.CONFIRM_ORDER) {
        return {
            family,
            intent,
            classification,
            risk,
            operationalCommand: null,
            shouldRouteToLlm: true,
            requiresDeterministic: false,
            robotIsInMotion: true,
            decision: 'BLOCKED_ROBOT_IN_MOTION',
            reason: 'El robot está en movimiento y no puede procesar nuevos pedidos.',
        };
    }

    return {
        family,
        intent,
        classification,
        risk,
        operationalCommand: null,
        shouldRouteToLlm,
        requiresDeterministic,
        robotIsInMotion,
        decision: shouldRouteToLlm ? 'ROUTE_TO_LLM' : 'ROUTE_TO_DETERMINISTIC',
    };
}

/**
 * Construye el contexto para enviar al LLM en una conversación social.
 * No incluye datos que permitan mutar el pedido.
 *
 * @param {object} params
 * @returns {object} Contexto seguro para el LLM
 */
export function buildSocialLlmContext({
    sessionId,
    mesa,
    interactionMode,
    draftItems = [],
    orderState,
    robotState,
    menu = [],
    history = [],
}) {
    return {
        session_id: sessionId,
        mesa,
        interaction_mode: interactionMode,
        has_draft: draftItems.length > 0,
        draft_summary: draftItems.length > 0
            ? draftItems.map(i => `${i.cantidad || 1}x ${i.nombre}`).join(', ')
            : null,
        order_state: orderState,
        robot_state: robotState?.state || 'available',
        menu_summary: menu.length > 0
            ? `${menu.length} productos disponibles en ${[...new Set(menu.map(m => m.categoria).filter(Boolean))].join(', ')}`
            : 'Menú no disponible',
        // NO incluimos: precios exactos, ingredientes, IDs de productos,
        // ni información que permita al LLM intentar mutar datos.
    };
}

/**
 * Construye el resultado de verbalización post-regla para enviar al LLM
 * y generar una respuesta natural.
 */
export function buildDeterministicResultForVerbalization({
    operation,
    success,
    product,
    quantity,
    total,
    mesa,
    error,
    warning,
    notes,
}) {
    return {
        source: 'deterministic',
        operation,
        success,
        product: product || null,
        quantity: quantity || null,
        total: total || null,
        mesa: mesa || null,
        error: error || null,
        warning: warning || null,
        notes: notes || null,
    };
}
