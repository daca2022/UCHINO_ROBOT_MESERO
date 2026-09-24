/**
 * Policy helpers for requests that may originate from Robot or Admin.
 *
 * The Robot contract remains public for voice/tablet requests. Admin-labelled
 * order writes must pass through the Admin JWT middleware regardless of casing
 * or incidental whitespace in the client value.
 */
export function isAdminOrderMode(body = {}) {
    return ['mode', 'modo'].some((field) => String(body?.[field] ?? '').trim().toLowerCase() === 'admin');
}

const CLOSED_SESSION_STATUSES = new Set(['closed', 'expired', 'completing']);
const CUSTOMER_DRAFT_STATUSES = new Set(['draft', 'pending_confirmation', 'provisional']);

function normalizeBoundTable(value) {
    const raw = String(value ?? '').trim().toUpperCase().replace(/^MESA\s*/u, '').replace(/^M(?=\d)/u, '');
    return /^([1-9]|1[0-2])$/u.test(raw) ? `M${Number(raw)}` : null;
}

/**
 * Binds a customer order write to the backend-owned attention session.
 * The caller may omit table/visit fields, but it may not choose values that
 * belong to another session or visit. Admin writes use the separate JWT path.
 */
export function bindCustomerOrderToSession(body = {}, session = null) {
    if (!session?.session_id || !session.session_access_token) {
        return { ok: false, code: 'SESSION_ACCESS_REQUIRED', message: 'Token de sesión requerido.' };
    }
    if (CLOSED_SESSION_STATUSES.has(String(session.session_status || '').toLowerCase())) {
        return { ok: false, code: 'STALE_SESSION', message: 'La sesión ya no está activa.' };
    }
    if (['confirmed', 'completed'].includes(String(session.state || '').toLowerCase())) {
        return { ok: false, code: 'ORDER_LOCKED', message: 'La sesión ya tiene un pedido confirmado.' };
    }

    const sessionMesa = normalizeBoundTable(session.mesa || session.assignment?.mesa);
    if (!sessionMesa) {
        return { ok: false, code: 'MISSING_TABLE', message: 'La sesión no tiene una mesa asociada.' };
    }

    const requestedTable = body.table_id ?? body.mesa;
    if (requestedTable !== undefined && requestedTable !== null && String(requestedTable).trim() !== '') {
        const normalizedRequested = normalizeBoundTable(requestedTable);
        if (normalizedRequested !== sessionMesa) {
            return { ok: false, code: 'SESSION_TABLE_MISMATCH', message: 'La mesa no coincide con la sesión activa.' };
        }
    }

    const requestedVisit = body.visit_id === undefined || body.visit_id === null || body.visit_id === ''
        ? null
        : String(body.visit_id).trim();
    const sessionVisit = session.visit_id ? String(session.visit_id).trim() : null;
    if (requestedVisit && requestedVisit !== sessionVisit) {
        return { ok: false, code: 'SESSION_VISIT_MISMATCH', message: 'La visita no coincide con la sesión activa.' };
    }

    const requestedStatus = String(body.status ?? body.estado ?? '').trim().toLowerCase();
    if (requestedStatus && !CUSTOMER_DRAFT_STATUSES.has(requestedStatus)) {
        return { ok: false, code: 'CUSTOMER_STATUS_FORBIDDEN', message: 'El estado del pedido lo determina el flujo de confirmación.' };
    }
    if ((body.additional_order === true || String(body.order_kind || '').trim().toLowerCase() === 'additional') && !sessionVisit) {
        return { ok: false, code: 'VISIT_REQUIRED', message: 'Un pedido adicional requiere una visita activa vinculada.' };
    }

    return {
        ok: true,
        body: {
            ...body,
            session_id: session.session_id,
            mesa: sessionMesa,
            table_id: sessionMesa,
            // Customer writes can only create/edit a draft. Confirmation and
            // kitchen transitions are owned by their dedicated backend flows.
            status: 'draft',
            estado: 'provisional',
            ...(sessionVisit ? { visit_id: sessionVisit } : {}),
        },
    };
}
