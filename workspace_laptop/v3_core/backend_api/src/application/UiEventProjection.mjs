import { projectPublicKitchenOrder } from './TableVisitService.mjs';

const ALWAYS_PRIVATE_FIELDS = new Set(['session_access_token', 'robot_bootstrap_token', 'robot_connection_token']);

const PUBLIC_PRIVATE_FIELDS = new Set([
    'session_access_token',
    'visit_id',
    'visitId',
    'profile_id',
    'profileId',
    'declared_allergies',
    'dietary_restrictions',
    'allergy_conflicts',
    'special_warning',
    'requires_special_confirmation',
    'special_confirmation',
]);

const TEXT_FIELDS = new Set(['notes', 'notas', 'text', 'display_text', 'speech_text']);

/**
 * The audio lab is also reachable from a public browser surface. Keep its
 * initial/realtime projection useful for connection state without exposing
 * microphone telemetry, hardware state, network addresses or transcript
 * content before an Admin JWT has been accepted.
 */
export function projectPublicAudioLabSnapshot(snapshot = {}) {
    return {
        conversation_state: snapshot.conversation_state || 'IDLE',
        esp32: {
            connected: Boolean(snapshot.esp32?.connected),
        },
        tts: {
            chunks: Number(snapshot.tts?.chunks) || 0,
            bytes: Number(snapshot.tts?.bytes) || 0,
            durationMs: Number(snapshot.tts?.durationMs) || 0,
        },
        uplink: {
            pcmFrames: Number(snapshot.uplink?.pcmFrames) || 0,
            pcmBytes: Number(snapshot.uplink?.pcmBytes) || 0,
        },
        events: [],
    };
}

function projectPublicAudioLabEvent(event = {}) {
    return {
        id: event.id || null,
        name: event.name || 'audio_lab_event',
        at: event.at || null,
        detail: {},
    };
}

function redactText(value) {
    return String(value ?? '')
        .replace(/\b(?:session(?:_id)?|visit(?:_id)?|sesi[oó]n|visita)\s*[:=]\s*[A-Za-z0-9_-]+/giu, match => match.replace(/[:=].*$/u, ': [redacted]'))
        .slice(0, 2000);
}

function clonePublic(value, key = null) {
    if (PUBLIC_PRIVATE_FIELDS.has(key)) return undefined;
    if (typeof value === 'string') return TEXT_FIELDS.has(key) ? redactText(value) : value;
    if (Array.isArray(value)) return value.map(item => clonePublic(item, null)).filter(item => item !== undefined);
    if (!value || typeof value !== 'object') return value;

    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
        const projected = clonePublic(childValue, childKey);
        if (projected !== undefined) output[childKey] = projected;
    }
    return output;
}

function cloneAdmin(value, key = null) {
    if (ALWAYS_PRIVATE_FIELDS.has(key)) return undefined;
    if (Array.isArray(value)) return value.map(item => cloneAdmin(item, null)).filter(item => item !== undefined);
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) {
        const projected = cloneAdmin(childValue, childKey);
        if (projected !== undefined) output[childKey] = projected;
    }
    return output;
}

/**
 * Projects UI events by audience. Public browser clients can keep the
 * existing realtime behavior, but never receive visit, profile, allergy or
 * session access-token fields. Admin-authenticated clients retain operational
 * order details while access tokens remain prohibited everywhere.
 */
export function projectUiEvent(data, { role = 'public' } = {}) {
    if (!data || typeof data !== 'object') return data;
    const source = { ...data };
    if (source.type === 'audio_lab_metrics' && role !== 'admin') {
        source.snapshot = projectPublicAudioLabSnapshot(source.snapshot);
    }
    if (source.type === 'audio_lab_event' && role !== 'admin') {
        source.event = projectPublicAudioLabEvent(source.event);
    }
    if (role === 'admin' && source.pedido && ['nuevo_pedido', 'pedido_actualizado', 'pedido_listo'].includes(source.type)) {
        source.pedido = {
            ...source.pedido,
            ...projectPublicKitchenOrder(source.pedido),
        };
        // Restore operational safety fields for Admin/KDS only. The generic
        // clone still removes the access token if one ever appears nested.
        for (const field of [
            'visit_id',
            'declared_allergies',
            'dietary_restrictions',
            'allergy_conflicts',
            'special_warning',
            'requires_special_confirmation',
        ]) {
            if (Object.hasOwn(source.pedido, field)) source.pedido[field] = data.pedido[field];
        }
    }
    return role === 'admin' ? cloneAdmin(source) : clonePublic(source);
}
