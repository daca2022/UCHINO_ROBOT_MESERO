/**
 * OrderSessionManager.mjs — FASE 4: Gestión de Estado por Sesión de Pedido Oral
 *
 * Mantiene el estado de cada sesión de pedido por voz:
 *   IDLE → AWAITING_CONFIRMATION → SENT_TO_KITCHEN
 *
 * Reglas:
 * - Cada sesión tiene su propio estado, mesa, active_order_id.
 * - La confirmación es determinística (no depende del LLM).
 * - Sesiones aisladas: una no afecta a otra.
 */

import { randomUUID } from 'node:crypto';
import { itemVariantKey, normalizeSafetyMenuItem } from './Fase5Safety.mjs';

// Estados de sesión
export const SessionState = Object.freeze({
    IDLE: 'idle',
    CHOOSING_INTERACTION_MODE: 'choosing_interaction_mode',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    EDITING_ORDER: 'editing_order',
    AWAITING_CLARIFICATION: 'awaiting_clarification',
    AWAITING_CONFIRMATION: 'awaiting_confirmation',
    CONFIRMED: 'confirmed',
    HUMAN_WAITER_REQUESTED: 'human_waiter_requested',
    COMPLETED: 'completed',
});

const INTERACTION_MODES = new Set(['voice', 'screen', 'human_waiter']);

// Patrones de confirmación determinística
// El usuario puede decir: "sí", "sí confirma", "confirma", "confirmar", "ok", "dale", "ya",
// "listo", "sale", "sí pues", "está bien", "bien", "sí, confirma", etc.
const CONFIRM_PATTERNS = [
    /^(si|sis|yes|ok|okey|okay|dale|ya|listo|sale|hecho|confirma|confirmar|simón|orale|dale pues|sale pues|ya pues|esta bien|bien|de una|al toque|adelante|procede|confirmo|si confirma|correcto)$/i,
];

// Patrones de cancelación
const CANCEL_PATTERNS = [
    /^(no|cancelar|cancela|para|deten|mejor no|nunca|olvidalo|dejalo)$/i,
];

const RESET_PATTERNS = [
    /\bcancela todo\b/i,
    /\bnuevo pedido\b/i,
];

const CHANGE_PATTERN = /\b(?:cambia|cambiar|reemplaza|reemplazar|sustituye|sustituir)\b(.+?)\b(?:por|a)\b(.+)/i;

/**
 * Estado visual del menú por sesión (Fase 6 cierre correctivo).
 * El backend conserva este estado para que:
 *   - "Agrega esa" resuelva inequívocamente cuando hay un solo highlight
 *   - "Agrega el primero" / "el segundo" / "el postre que mostraste"
 *     resuelvan contra la lista visible
 *   - la voz siga funcionando con interaction_mode=screen sin perder
 *     la mesa, el carrito o el modo.
 *
 * El frontend recibe este estado vía /ws/ui (menu_navigation) y lo
 * refleja en /robot; el backend lo usa para resolver referencias
 * inequívocas a "ese/esa/primero/segundo" con mutación permitida.
 */
export function emptyMenuState() {
    return {
        active_category: null,        // 'plato' | 'bebida' | 'postre' | null (catálogo completo)
        visible_product_ids: [],       // orden estable de la vista actual
        highlighted_product_id: null,  // producto destacado por voz (1 si highlight)
        menu_filters: {
            max_price: null,
            vegetarian: false,
            vegan: false,
            allergen: null,
            available: true,
            query: null,
        },
        last_navigation: null,         // { action, category, product_ids, ... } emitido más reciente
        last_navigation_at: null,      // ISO timestamp
    };
}

export function normalizeMenuFilters(input = {}) {
    const base = emptyMenuState().menu_filters;
    const out = { ...base, ...(input || {}) };
    if (out.max_price !== null && out.max_price !== undefined) {
        const n = Number(out.max_price);
        out.max_price = Number.isFinite(n) ? n : null;
    }
    out.vegetarian = Boolean(out.vegetarian);
    out.vegan = Boolean(out.vegan);
    out.available = out.available !== false;
    if (out.allergen != null) out.allergen = String(out.allergen).trim().toLowerCase() || null;
    if (out.query != null) out.query = String(out.query).trim() || null;
    return out;
}

export function normalizeMenuState(input = {}) {
    const base = emptyMenuState();
    const out = { ...base, ...(input || {}) };
    out.active_category = ['plato', 'bebida', 'postre'].includes(out.active_category) ? out.active_category : null;
    out.visible_product_ids = Array.isArray(out.visible_product_ids) ? out.visible_product_ids.map(String) : [];
    out.highlighted_product_id = out.highlighted_product_id ? String(out.highlighted_product_id) : null;
    out.menu_filters = normalizeMenuFilters(out.menu_filters);
    return out;
}

export function normalizeMesa(value) {
    if (value === null || value === undefined || value === '') return null;
    const raw = String(value).trim().toUpperCase()
        .replace(/^MESA\s*/u, '')
        .replace(/^M(?=\d)/u, '');
    if (!/^\d{1,2}$/u.test(raw)) throw new Error(`Mesa inválida: ${value}`);
    const number = Number(raw);
    if (number < 1 || number > 12) throw new Error(`Mesa inválida: ${value}`);
    return `M${number}`;
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[¿?¡!.,;:()[\]{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function itemKey(value) {
    return normalizeText(value);
}

function cloneItems(items = []) {
    return items.map(item => ({ ...item }));
}

function canonicalAlias(value) {
    const normalized = normalizeText(value);
    const aliases = {
        'suspiro a la limena': 'suspiro limeno',
        'suspiro de la limena': 'suspiro limeno',
        'suspiro limeña': 'suspiro limeno',
        'lomo saltado': 'lomo saltado',
    };
    return aliases[normalized] || normalized;
}

// Producto real de la cafetería de UTEC
const MENU_REAL = [
    { nombre: 'Café pasado',        precio: 5.00,  categoria: 'bebidas' },
    { nombre: 'Americano',          precio: 6.00,  categoria: 'bebidas' },
    { nombre: 'Expreso',            precio: 5.00,  categoria: 'bebidas' },
    { nombre: 'Capuchino',          precio: 7.00,  categoria: 'bebidas' },
    { nombre: 'Empanada de pollo',  precio: 4.00,  categoria: 'comidas' },
    { nombre: 'Empanada de queso',  precio: 4.00,  categoria: 'comidas' },
    { nombre: 'Sánguche de pollo',  precio: 8.00,  categoria: 'comidas' },
    { nombre: 'Sánguche de jamón',  precio: 7.00,  categoria: 'comidas' },
    { nombre: 'Sánguche de palta',  precio: 6.00,  categoria: 'comidas' },
    { nombre: 'Jugo de naranja',    precio: 5.00,  categoria: 'bebidas' },
    { nombre: 'Jugo de maracuyá',   precio: 5.00,  categoria: 'bebidas' },
    { nombre: 'Jugo de fresa',      precio: 6.00,  categoria: 'bebidas' },
    { nombre: 'Tres leches',        precio: 7.00,  categoria: 'postres' },
    { nombre: 'Suspiro limeño',     precio: 6.00,  categoria: 'postres' },
    { nombre: 'Alfajor',            precio: 3.00,  categoria: 'postres' },
    { nombre: 'Chicha morada',      precio: 4.00,  categoria: 'bebidas' },
    { nombre: 'Inca Kola',          precio: 3.00,  categoria: 'bebidas' },
    { nombre: 'Agua mineral',       precio: 2.00,  categoria: 'bebidas' },
    { nombre: 'Lomo saltado',       precio: 14.00, categoria: 'comidas' },
    { nombre: 'Ceviche',            precio: 12.00, categoria: 'comidas' },
    { nombre: 'Tallarines verdes',  precio: 10.00, categoria: 'comidas' },
];

export class OrderSessionManager {
    constructor({ memoryService, menu = null } = {}) {
        /** @type {Map<string, {session_id: string, mesa: string|null, client_id: string|null, state: string, active_order_id: string|null, draft_items: Array, turn_id: number, presentation_shown: boolean}>} */
        this._sessions = new Map();
        this._menu = menu || [...MENU_REAL];
        this._memoryService = memoryService;
        this._menuSource = menu ? 'param' : 'hardcoded';
    }

    async refreshMenu() {
        if (!this._memoryService?.obtenerMenu) return;
        try {
            if (this._memoryService?.cache?.del) {
                await this._memoryService.cache.del('menu:del_dia').catch(() => {});
            }
            const items = await this._memoryService.obtenerMenu();
            if (Array.isArray(items) && items.length > 0) {
                this._menu = items.map(i => ({
                    ...normalizeSafetyMenuItem(i),
                    precio: Number(i.precio),
                }));
                this._menuSource = 'db';
                console.log(`[OrderSessionManager] Menú refrescado: ${this._menu.length} items desde DB`);
            }
        } catch (err) {
            console.warn('[OrderSessionManager] No se pudo recargar menú desde DB:', err.message);
        }
    }

    getMenuSource() {
        return this._menuSource;
    }

    /**
     * Obtiene o crea un estado de sesión.
     */
    getOrCreate(sessionId, { mesa, clientId, interactionMode, visitId, robotId, guestCount, profileId, memoryConsent } = {}) {
        if (!sessionId) throw new Error('session_id es obligatorio');

        const normalizedMesa = mesa ? normalizeMesa(mesa) : null;
        const normalizedGuestCount = guestCount === null || guestCount === undefined || guestCount === ''
            ? null
            : Number(guestCount);
        if (normalizedGuestCount !== null
            && (!Number.isInteger(normalizedGuestCount) || normalizedGuestCount < 1)) {
            const error = new Error('guest_count debe ser un entero positivo.');
            error.code = 'INVALID_GUEST_COUNT';
            throw error;
        }

        if (!this._sessions.has(sessionId)) {
            this._sessions.set(sessionId, {
                session_id: sessionId,
                mesa: normalizedMesa,
                client_id: clientId || null,
                profile_id: profileId || null,
                memory_consent: memoryConsent || null,
                state: SessionState.IDLE,
                interaction_mode: null,
                active_order_id: null,
                draft_items: [],
                turn_id: 0,
                presentation_shown: false,
                last_product_name: null,
                last_intent: null,
                last_response: null,
                last_turn_id: null,
                last_turn_result: null,
                consecutive_ambiguities: 0,
                clarification_count: 0,
                declared_allergies: [],
                dietary_restrictions: [],
                allergy_conflicts: [],
                incomplete_information: [],
                special_warning: '',
                requires_special_confirmation: false,
                special_confirmation: {},
                menu_state: emptyMenuState(),
                created_at: new Date().toISOString(),
                // Fase 7: ciclo de vida de la sesión separado del
                // OrderSessionManager clásico. La sesión pasa por
                // initializing → active → (completed|closed|expired).
                session_status: 'initializing', // initializing|active|closed|expired
                robot_id: robotId || null,
                assignment: null,              // { robot_id, mesa, status, assigned_at }
                closed_at: null,
                close_reason: null,
                last_activity_at: new Date().toISOString(),
                recovered_from_session_id: null, // Fase 7: para idempotencia de recover
                visit_id: visitId || null,
                guest_count: normalizedGuestCount,
            });
        }

        const session = this._sessions.get(sessionId);

        if (clientId) session.client_id = clientId;
        if (profileId) session.profile_id = profileId;
        if (memoryConsent) session.memory_consent = memoryConsent;
        if (visitId) session.visit_id = visitId;
        if (robotId) session.robot_id = robotId;
        if (normalizedGuestCount !== null) session.guest_count = normalizedGuestCount;
        if (interactionMode) this.setInteractionMode(sessionId, interactionMode);
        if (normalizedMesa && !session.mesa && session.state !== SessionState.CONFIRMED && session.state !== SessionState.COMPLETED) {
            session.mesa = normalizedMesa;
        }

        return session;
    }

    setMemoryProfile(sessionId, { profileId = null, consent = null } = {}) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            const error = new Error('La memoria de una sesión cerrada no puede cambiarse.');
            error.code = 'SESSION_LOCKED';
            throw error;
        }
        session.profile_id = profileId || null;
        session.memory_consent = consent || (profileId ? 'temporary' : null);
        return session;
    }

    setGuestCount(sessionId, guestCount) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            const error = new Error('El tamaño del grupo no puede cambiar después de confirmar el pedido.');
            error.code = 'ORDER_LOCKED';
            throw error;
        }
        const count = Number(guestCount);
        if (!Number.isInteger(count) || count < 1) {
            const error = new Error('guest_count debe ser un entero positivo.');
            error.code = 'INVALID_GUEST_COUNT';
            throw error;
        }
        session.guest_count = count;
        session.last_activity_at = new Date().toISOString();
        return session;
    }

    /**
     * Obtiene una sesión existente. Retorna null si no existe.
     */
    get(sessionId) {
        return this._sessions.get(sessionId) || null;
    }

    /**
     * Incrementa turn_id y retorna el nuevo valor.
     */
    nextTurn(sessionId) {
        const session = this.get(sessionId);
        if (!session) return 1;
        session.turn_id = (session.turn_id || 0) + 1;
        return session.turn_id;
    }

    setState(sessionId, state) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if (!Object.values(SessionState).includes(state)) {
            throw new Error(`Estado de sesión inválido: ${state}`);
        }
        session.state = state;
        return session;
    }

    setInteractionMode(sessionId, mode) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if (!INTERACTION_MODES.has(mode)) {
            const error = new Error(`Modo de interacción inválido: ${mode}`);
            error.code = 'INVALID_INTERACTION_MODE';
            throw error;
        }
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            if (session.interaction_mode === mode) return session;
            const error = new Error('El modo no puede cambiar después de confirmar el pedido');
            error.code = 'ORDER_LOCKED';
            throw error;
        }
        session.interaction_mode = mode;
        if (mode === 'human_waiter') session.state = SessionState.HUMAN_WAITER_REQUESTED;
        else if (session.state === SessionState.CHOOSING_INTERACTION_MODE || session.state === SessionState.HUMAN_WAITER_REQUESTED) {
            session.state = session.draft_items.length > 0 ? SessionState.AWAITING_CONFIRMATION : SessionState.IDLE;
        }
        return session;
    }

    getMenuState(sessionId) {
        const session = this.get(sessionId);
        if (!session) return emptyMenuState();
        return session.menu_state || emptyMenuState();
    }

    setMenuState(sessionId, partial = {}) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        const current = session.menu_state || emptyMenuState();
        const merged = normalizeMenuState({ ...current, ...partial });
        session.menu_state = merged;
        return merged;
    }

    updateMenuNavigation(sessionId, { action, category, product_ids, highlight_product_id, filters } = {}) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        const current = session.menu_state || emptyMenuState();
        const resetCategory = action === 'show_menu' || action === 'return_to_menu' || action === 'clear_filter';
        // Canoniza la categoría aceptada: singular o plural → ['plato','bebida','postre'].
        let canonCategory = null;
        if (category) {
            const c = String(category).toLowerCase();
            if (['plato', 'platos', 'comida', 'comidas'].includes(c)) canonCategory = 'plato';
            else if (['bebida', 'bebidas'].includes(c)) canonCategory = 'bebida';
            else if (['postre', 'postres'].includes(c)) canonCategory = 'postre';
            else canonCategory = c;
        }
        // Política de filtros:
        //   - show_menu / return_to_menu / clear_filter → reset a vacío
        //   - cualquier otra acción con `filters` definido → merge sobre actuales
        //   - sin `filters` → mantener
        let nextFilters = current.menu_filters;
        if (resetCategory) nextFilters = normalizeMenuFilters({});
        else if (filters && typeof filters === 'object') {
            nextFilters = normalizeMenuFilters({ ...current.menu_filters, ...filters });
        }
        const next = normalizeMenuState({
            ...current,
            active_category: resetCategory
                ? null
                : (canonCategory !== null ? canonCategory : (category || current.active_category)),
            visible_product_ids: Array.isArray(product_ids) ? product_ids.map(String) : current.visible_product_ids,
            highlighted_product_id: highlight_product_id
                ? String(highlight_product_id)
                : (action === 'highlight_product' ? current.highlighted_product_id : null),
            menu_filters: nextFilters,
            last_navigation: {
                action: action || (current.last_navigation && current.last_navigation.action) || null,
                category: category || null,
                product_ids: Array.isArray(product_ids) ? product_ids.map(String) : (current.last_navigation && current.last_navigation.product_ids) || [],
                highlight_product_id: highlight_product_id ? String(highlight_product_id) : null,
                filters: filters || (current.last_navigation && current.last_navigation.filters) || {},
                timestamp: new Date().toISOString(),
            },
            last_navigation_at: new Date().toISOString(),
        });
        session.menu_state = next;
        return next;
    }

    clearMenuFilters(sessionId) {
        return this.updateMenuNavigation(sessionId, { action: 'clear_filter', filters: {} });
    }

    recordConversation(sessionId, { intent = null, response = null, productName = null, ambiguous = false } = {}) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        session.last_intent = intent;
        if (response !== null) session.last_response = response;
        if (productName) session.last_product_name = productName;
        session.consecutive_ambiguities = ambiguous ? (session.consecutive_ambiguities || 0) + 1 : 0;
        if (ambiguous) session.clarification_count = (session.clarification_count || 0) + 1;
        return session;
    }

    updateMesa(sessionId, mesa) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        const normalizedMesa = normalizeMesa(mesa);
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)
            && session.mesa !== normalizedMesa) {
            const error = new Error('La mesa no puede cambiar después de confirmar el pedido');
            error.code = 'TABLE_LOCKED';
            throw error;
        }
        session.mesa = normalizedMesa;
        return session;
    }

    setDraftItems(sessionId, items = []) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            const error = new Error('El pedido ya fue confirmado y no se puede modificar');
            error.code = 'ORDER_LOCKED';
            throw error;
        }
        session.draft_items = cloneItems(items);
        session.state = session.draft_items.length > 0
            ? SessionState.AWAITING_CONFIRMATION
            : SessionState.IDLE;
        return session;
    }

    markPresentationShown(sessionId) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        const shouldPresent = !session.presentation_shown;
        session.presentation_shown = true;
        return shouldPresent;
    }

    /**
     * Asigna un active_order_id y conserva el draft canónico en la sesión.
     */
    setOrderDraft(sessionId, orderId, items = []) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            throw new Error(`No se puede modificar una sesión ${session.state}`);
        }
        session.active_order_id = orderId;
        session.draft_items = cloneItems(items);
        session.state = SessionState.AWAITING_CONFIRMATION;
        return session;
    }

    /**
     * Reclama la transición de confirmación antes de tocar la base de datos.
     * Una segunda petición ve CONFIRMED y no vuelve a enviar a cocina.
     */
    beginConfirmation(sessionId) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            return { session, alreadyConfirmed: true };
        }
        if (session.state !== SessionState.AWAITING_CONFIRMATION) {
            throw new Error(`No se puede confirmar: sesión ${sessionId} está en estado ${session.state}`);
        }
        if (!session.active_order_id) {
            throw new Error(`No se puede confirmar: sesión ${sessionId} no tiene pedido activo`);
        }
        session.state = SessionState.CONFIRMED;
        return { session, alreadyConfirmed: false };
    }

    confirmOrder(sessionId) {
        const result = this.beginConfirmation(sessionId);
        return result.session;
    }

    rollbackConfirmation(sessionId) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if (session.state === SessionState.CONFIRMED) {
            session.state = SessionState.AWAITING_CONFIRMATION;
        }
        return session;
    }

    completeSession(sessionId) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if (session.state !== SessionState.CONFIRMED && session.state !== SessionState.COMPLETED) {
            throw new Error(`No se puede completar una sesión en estado ${session.state}`);
        }
        session.state = SessionState.COMPLETED;
        return session;
    }

    resetForNewOrder(sessionId) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        session.active_order_id = null;
        session.draft_items = [];
        session.state = SessionState.IDLE;
        session.last_product_name = null;
        session.last_intent = null;
        session.last_response = null;
        session.last_turn_id = null;
        session.last_turn_result = null;
        session.consecutive_ambiguities = 0;
        session.clarification_count = 0;
        session.declared_allergies = [];
        session.dietary_restrictions = [];
        session.allergy_conflicts = [];
        session.incomplete_information = [];
        session.special_warning = '';
        session.requires_special_confirmation = false;
        session.special_confirmation = {};
        // Fase 7: también limpia el modo de interacción, el menu_state
        // y los metadatos de asignación de mesa para que la siguiente
        // atención no herede contexto de la anterior.
        session.interaction_mode = null;
        session.menu_state = emptyMenuState();
        session.assignment = null;
        session.closed_at = null;
        session.close_reason = null;
        session.session_status = 'initializing';
        return session;
    }

    /**
     * Fase 7: cierra completamente la sesión actual. El pedido
     * confirmado se conserva en PostgreSQL. El robot queda disponible
     * para atender otra mesa. Esta operación es idempotente.
     */
    closeSessionCompletely(sessionId, { reason = 'admin_closed', preserveActiveOrder = true } = {}) {
        const session = this.get(sessionId);
        if (!session) return null;
        // No se borra el pedido confirmado ni se altera active_order_id si
        // se pidió preservar.
        session.state = SessionState.COMPLETED;
        session.session_status = 'closed';
        session.closed_at = new Date().toISOString();
        session.close_reason = reason;
        // Fase 7: libera la asignación del robot.
        const robotId = session.assignment?.robot_id || null;
        session.assignment = null;
        return { session, robotId, preservedOrderId: preserveActiveOrder ? session.active_order_id : null };
    }

    /**
     * Fase 7: devuelve la sesión activa (en estado active o initializing)
     * asignada a un robot_id. Si el robot ya tiene sesión activa, devuelve null.
     */
    getActiveSessionForRobot(robotId) {
        if (!robotId) return null;
        for (const session of this._sessions.values()) {
            if (session.assignment?.robot_id === robotId
                && session.session_status !== 'closed'
                && session.session_status !== 'expired') {
                return session;
            }
        }
        return null;
    }

    /**
     * Fase 7: lista todas las sesiones activas (no cerradas ni expiradas).
     */
    listActiveSessions() {
        const out = [];
        for (const session of this._sessions.values()) {
            if (session.session_status !== 'closed' && session.session_status !== 'expired') {
                out.push(session);
            }
        }
        return out;
    }

    /**
     * Fase 7: marca una sesión como expirada por timeout de inactividad.
     * El pedido confirmado se conserva; el draft pendiente se cancela.
     */
    expireSession(sessionId, { reason = 'inactivity_timeout' } = {}) {
        const session = this.get(sessionId);
        if (!session) return null;
        if (session.session_status === 'closed' || session.session_status === 'expired') return session;
        session.session_status = 'expired';
        session.state = SessionState.COMPLETED;
        session.closed_at = new Date().toISOString();
        session.close_reason = reason;
        session.assignment = null;
        return session;
    }

    /**
     * Cancela únicamente un draft. Un pedido confirmado no se toca.
     */
    cancelOrder(sessionId) {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            return session;
        }
        session.active_order_id = null;
        session.draft_items = [];
        session.last_turn_id = null;
        session.last_turn_result = null;
        session.state = SessionState.IDLE;
        session.declared_allergies = [];
        session.dietary_restrictions = [];
        session.allergy_conflicts = [];
        session.incomplete_information = [];
        session.special_warning = '';
        session.requires_special_confirmation = false;
        session.special_confirmation = {};
        return session;
    }

    getTurnResult(sessionId, turnId) {
        const session = this.get(sessionId);
        if (!session || turnId === null || turnId === undefined) return null;
        if (String(session.last_turn_id) !== String(turnId) || !session.last_turn_result) return null;
        return JSON.parse(JSON.stringify(session.last_turn_result));
    }

    saveTurnResult(sessionId, turnId, result) {
        const session = this.get(sessionId);
        if (!session || turnId === null || turnId === undefined || !result || typeof result !== 'object') return;
        session.last_turn_id = String(turnId);
        session.last_turn_result = JSON.parse(JSON.stringify(result));
    }

    /**
     * Verifica si el texto del usuario coincide con un patrón de confirmación.
     * Solo válido si la sesión está en AWAITING_CONFIRMATION.
     */
    isConfirmPhrase(text, sessionId) {
        const session = this.get(sessionId);
        if (!session || session.state !== SessionState.AWAITING_CONFIRMATION) {
            return false;
        }
        return this.isConfirmationPhrase(text);
    }

    isConfirmationPhrase(text) {
        const cleaned = normalizeText(text);
        return CONFIRM_PATTERNS.some(p => p.test(cleaned));
    }

    /**
     * Verifica si el texto del usuario coincide con un patrón de cancelación.
     */
    isCancelPhrase(text) {
        const cleaned = normalizeText(text);
        return CANCEL_PATTERNS.some(p => p.test(cleaned));
    }

    isResetPhrase(text) {
        const cleaned = normalizeText(text);
        return RESET_PATTERNS.some(p => p.test(cleaned));
    }

    getDraftAction(text) {
        const cleaned = normalizeText(text);
        if (this.isResetPhrase(cleaned)) return 'reset';
        if (CHANGE_PATTERN.test(cleaned)) return 'change';
        if (/\b(?:quita|quitar|elimina|eliminar|retira|retirar)\b/i.test(cleaned)) return 'remove';
        if (/\b(?:agrega|agregar|anade|añade|tambien quiero|también quiero|suma|otro|otra)\b/i.test(cleaned)) return 'add';
        return 'add';
    }

    resolveMenuItem(nombre) {
        const requested = canonicalAlias(nombre);
        if (!requested) return null;
        const exact = this._menu.find(item => canonicalAlias(item.nombre) === requested);
        if (exact) return exact;
        return this._menu.find(item => {
            const candidate = itemKey(item.nombre);
            return requested.includes(candidate) || candidate.includes(requested);
        }) || null;
    }

    findMenuItemsInText(text) {
        const cleaned = normalizeText(text);
        return this._menu
            .slice()
            .sort((a, b) => itemKey(b.nombre).length - itemKey(a.nombre).length)
            .filter(item => {
                const names = [item.nombre];
                if (canonicalAlias(item.nombre) === 'suspiro limeno') {
                    names.push('suspiro a la limeña', 'suspiro de la limeña');
                }
                return names.some(name => cleaned.includes(itemKey(name)));
            })
            .filter((item, index, items) => items.findIndex(other => itemKey(other.nombre) === itemKey(item.nombre)) === index);
    }

    _mergeItems(items) {
        const merged = [];
        const byVariant = new Map();
        for (const item of items) {
            const key = itemVariantKey(item);
            if (!key) continue;
            const current = byVariant.get(key);
            if (current) {
                current.cantidad += item.cantidad || 1;
                continue;
            }
            const normalized = { ...item, cantidad: Math.max(1, Number(item.cantidad) || 1) };
            byVariant.set(key, normalized);
            merged.push(normalized);
        }
        return merged;
    }

    _changeSegments(text) {
        const match = normalizeText(text).match(CHANGE_PATTERN);
        if (!match) return null;
        return { before: match[1], after: match[2] };
    }

    /**
     * Fusiona el turno actual con el draft de la sesión.
     * Solo `cancela todo` y `nuevo pedido` limpian el carrito completo.
     */
    mergeDraftItems(sessionId, incomingItems = [], text = '') {
        const session = this.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            const error = new Error('El pedido ya fue confirmado y no se puede modificar');
            error.code = 'ORDER_LOCKED';
            throw error;
        }

        const validation = this.validateProducts(incomingItems);
        if (validation.invalid_modifiers?.length) {
            const error = new Error('Hay modificadores que no están configurados para el producto');
            error.code = 'MODIFIER_NOT_CONFIGURED';
            error.validation = validation;
            throw error;
        }
        const { validos } = validation;
        const action = this.getDraftAction(text);
        const current = cloneItems(session.draft_items || []);
        let nextItems = current;

        if (action === 'reset') {
            nextItems = [];
        } else if (action === 'remove') {
            const namesToRemove = this.findMenuItemsInText(text).map(item => itemKey(item.nombre));
            const fallbackNames = validos.map(item => itemKey(item.nombre));
            const names = new Set(namesToRemove.length > 0 ? namesToRemove : fallbackNames);
            nextItems = current.filter(item => !names.has(itemKey(item.nombre)));
        } else if (action === 'change') {
            const segments = this._changeSegments(text);
            const namesToRemove = segments
                ? this.findMenuItemsInText(segments.before).map(item => itemKey(item.nombre))
                : [];
            const menuItemsToAdd = segments ? this.findMenuItemsInText(segments.after) : [];
            const namesToAdd = menuItemsToAdd.map(item => itemKey(item.nombre));
            const additions = namesToAdd.length > 0
                ? this.validateProducts(menuItemsToAdd.map(item => ({ nombre: item.nombre, cantidad: 1 }))).validos
                : validos;
            nextItems = this._mergeItems([
                ...current.filter(item => !namesToRemove.includes(itemKey(item.nombre))),
                ...additions,
            ]);
        } else {
            nextItems = this._mergeItems([...current, ...validos]);
        }

        session.draft_items = cloneItems(nextItems);
        session.state = nextItems.length > 0 ? SessionState.AWAITING_CONFIRMATION : SessionState.IDLE;
        return {
            order_id: session.active_order_id,
            items: cloneItems(nextItems),
            action,
            total: this.calculateTotal(nextItems),
        };
    }

    calculateTotal(items = []) {
        return Number(items.reduce((sum, item) => {
            const menuItem = normalizeSafetyMenuItem(this.resolveMenuItem(item.nombre) || {});
            const price = Number(menuItem.precio ?? item.precio ?? 0);
            const options = new Map(menuItem.modificadores_disponibles.map(modifier => [
                String(modifier.id || modifier.nombre), modifier,
            ]));
            const modifierTotal = (item.modificaciones || []).reduce((modifierSum, modifier) => {
                const configured = options.get(String(modifier.id || modifier.nombre));
                return modifierSum + Number(configured?.precio_adicional || 0);
            }, 0);
            return sum + (price + modifierTotal) * (Math.max(1, Number(item.cantidad) || 1));
        }, 0).toFixed(2));
    }

    getDraftItems(sessionId) {
        const session = this.get(sessionId);
        return session ? cloneItems(session.draft_items || []) : [];
    }

    /**
     * Valida que los productos del function call existan en el menú real.
     * Devuelve { validos, invalidos, agotados }.
     */
    validateProducts(platos) {
        const validos = [];
        const invalidos = [];
        const agotados = [];
        const invalid_modifiers = [];

        for (const plato of platos || []) {
            const menuItem = this.resolveMenuItem(plato.nombre);
            if (!menuItem) {
                invalidos.push(plato.nombre);
                continue;
            }
            if (menuItem.disponible === false) {
                agotados.push(menuItem.nombre);
                continue;
            }
            const modifications = Array.isArray(plato.modificaciones) ? plato.modificaciones : [];
            const configured = normalizeSafetyMenuItem(menuItem);
            const validModifications = modifications.map(modifier => configured.modificadores_disponibles.find(option => (
                String(option.id || option.nombre) === String(modifier.id || modifier.nombre)
            ))).filter(Boolean);
            const invalidModifiers = modifications.filter(modifier => !configured.modificadores_disponibles.some(option => (
                String(option.id || option.nombre) === String(modifier.id || modifier.nombre)
            )));
            if (invalidModifiers.length) invalid_modifiers.push({ producto: menuItem.nombre, modificadores: invalidModifiers });
            validos.push({
                item_id: plato.item_id || randomUUID(),
                ...(plato.line_id ? { line_id: plato.line_id } : {}),
                product_id: menuItem.id,
                nombre: menuItem.nombre,
                cantidad: Math.max(1, Number(plato.cantidad) || 1),
                precio: Number(menuItem.precio),
                categoria: menuItem.categoria,
                ...(menuItem.id ? { id: menuItem.id } : {}),
                modificaciones: validModifications,
                observaciones: Array.isArray(plato.observaciones) ? [...plato.observaciones] : [],
                requiere_confirmacion_especial: Boolean(plato.requiere_confirmacion_especial
                    || validModifications.some(modifier => modifier.requiere_confirmacion_especial)),
                ...(invalidModifiers.length ? { invalid_modifiers: invalidModifiers } : {}),
            });
        }

        return { validos, invalidos, agotados, invalid_modifiers };
    }

    /**
     * Retorna el menú real completo.
     */
    getMenu() {
        return [...this._menu];
    }

    /**
     * Obtiene precio de un producto del menú por nombre exacto.
     */
    getProductPrice(nombre) {
        const item = this.resolveMenuItem(nombre);
        return item ? Number(item.precio) : null;
    }

    /**
     * Retorna info de la sesión para debugging.
     */
    getSessionInfo(sessionId) {
        return this.get(sessionId);
    }

    /**
     * Retorna resumen de todas las sesiones activas.
     */
    getAllSessions() {
        const result = [];
        for (const [id, session] of this._sessions) {
            result.push({
                session_id: id,
                mesa: session.mesa,
                robot_id: session.robot_id || session.assignment?.robot_id || null,
                client_id: session.client_id,
                has_memory_profile: Boolean(session.profile_id),
                memory_consent: session.memory_consent || null,
                state: session.state,
                session_status: session.session_status,
                active_order_id: session.active_order_id,
                visit_id: session.visit_id || null,
                guest_count: session.guest_count || null,
                turn_id: session.turn_id,
                interaction_mode: session.interaction_mode,
                draft_items: cloneItems(session.draft_items || []),
                presentation_shown: session.presentation_shown,
                consecutive_ambiguities: session.consecutive_ambiguities,
                declared_allergies: [...(session.declared_allergies || [])],
                dietary_restrictions: [...(session.dietary_restrictions || [])],
                allergy_conflicts: [...(session.allergy_conflicts || [])],
                special_warning: session.special_warning || '',
                requires_special_confirmation: Boolean(session.requires_special_confirmation),
                created_at: session.created_at,
                closed_at: session.closed_at,
                close_reason: session.close_reason,
                last_activity_at: session.last_activity_at,
            });
        }
        return result;
    }

    /**
     * Limpia sesiones antiguas (mayores a 30 min).
     */
    cleanup(maxAgeMs = 30 * 60 * 1000) {
        const now = Date.now();
        for (const [id, session] of this._sessions) {
            const age = now - new Date(session.created_at).getTime();
            if (age > maxAgeMs) {
                this._sessions.delete(id);
            }
        }
    }
}
