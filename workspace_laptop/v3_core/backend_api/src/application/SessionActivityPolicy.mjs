/**
 * Política común para proteger mutaciones y transporte de audio de sesiones
 * que ya no representan una atención activa.
 */

export const STALE_SESSION_STATUSES = Object.freeze([
    'closed',
    'expired',
    'completing',
]);

export function isStaleSession(session) {
    return Boolean(session && STALE_SESSION_STATUSES.includes(session.session_status));
}
