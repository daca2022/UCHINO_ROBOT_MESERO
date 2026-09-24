import { randomUUID } from 'node:crypto';

export const CONSENT_LEVELS = Object.freeze(['session_only', 'temporary', 'disabled']);
export const RETENTION_POLICIES = Object.freeze(['session_only', '1d', '7d', '30d', 'disabled']);

const RETENTION_MS = Object.freeze({
    '1d': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
});

const MEMORY_TYPES = new Set([
    'name',
    'companion',
    'preference',
    'interaction_mode',
    'allergy',
    'restriction',
    'favorite_product',
    'last_confirmed_order',
]);

const SOURCES = new Set(['user_declared', 'user_confirmed', 'order_confirmed', 'admin']);
const FORGETTABLE_TYPES = new Set(['name', 'companion', 'preference', 'interaction_mode', 'allergy', 'restriction', 'favorite_product', 'last_confirmed_order']);

export function normalizeConsent(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return CONSENT_LEVELS.includes(normalized) ? normalized : null;
}

export function normalizeRetentionPolicy(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === '24h' || normalized === '24_hours' || normalized === '1day') return '1d';
    return RETENTION_POLICIES.includes(normalized) ? normalized : null;
}

export function buildMemoryExpiry({ consent, retentionPolicy, now = new Date() } = {}) {
    if (consent !== 'temporary') return null;
    const ms = RETENTION_MS[normalizeRetentionPolicy(retentionPolicy)];
    return ms ? new Date(new Date(now).getTime() + ms) : null;
}

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function normalizeDisplayName(value) {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    if (!normalized) return null;
    if (normalized.length > 100) {
        const error = new Error('El nombre no puede superar 100 caracteres.');
        error.code = 'INVALID_DISPLAY_NAME';
        throw error;
    }
    return normalized;
}

function sanitizeValue(value) {
    const normalized = typeof value === 'string'
        ? value.trim()
        : clone(value);
    if (normalized === null || normalized === undefined || normalized === '') {
        const error = new Error('La memoria no puede estar vacía.');
        error.code = 'INVALID_MEMORY_VALUE';
        throw error;
    }
    const text = JSON.stringify(normalized);
    if (text.length > 4000) {
        const error = new Error('La memoria supera el tamaño permitido.');
        error.code = 'MEMORY_VALUE_TOO_LARGE';
        throw error;
    }
    if (/audio|transcript|transcripcion|raw_text|segments|waveform/i.test(text)) {
        const error = new Error('No se almacenan audio ni transcripciones completas.');
        error.code = 'SENSITIVE_MEMORY_REJECTED';
        throw error;
    }
    return normalized;
}

function displayValue(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(item => displayValue(item)).filter(Boolean).join(', ');
    if (value && typeof value === 'object') {
        return String(value.label || value.nombre || value.name || value.value || '').trim();
    }
    return String(value || '').trim();
}

function memoryValueKey(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return String(value.preference_type || value.name || value.value || '').trim().toLowerCase();
    }
    return displayValue(value).trim().toLowerCase();
}

function sanitizeOrderMemory(order, now = new Date()) {
    const rawItems = Array.isArray(order?.items || order?.platos) ? (order.items || order.platos) : [];
    const items = rawItems.map(item => ({
        product_id: item.product_id || item.id || null,
        nombre: String(item.nombre || '').slice(0, 120),
        cantidad: Math.max(1, Number(item.cantidad) || 1),
        modificaciones: Array.isArray(item.modificaciones)
            ? item.modificaciones.map(mod => ({ id: mod.id || null, nombre: String(mod.nombre || '').slice(0, 80) }))
            : [],
    }));
    return {
        order_id: String(order?.id || ''),
        mesa: order?.table_id || order?.mesa || null,
        items,
        confirmed_at: order?.timestamp || now.toISOString(),
    };
}

function assertProfileId(profileId) {
    if (!profileId || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(profileId))) {
        const error = new Error('profile_id válido es obligatorio.');
        error.code = 'PROFILE_ID_REQUIRED';
        throw error;
    }
    return String(profileId);
}

function assertSessionId(sessionId) {
    if (!sessionId || String(sessionId).length > 160) {
        const error = new Error('session_id válido es obligatorio.');
        error.code = 'SESSION_ID_REQUIRED';
        throw error;
    }
    return String(sessionId);
}

function profileShape(row) {
    if (!row) return null;
    return {
        profile_id: String(row.profile_id),
        display_name: row.display_name || null,
        identity_confidence: row.identity_confidence === null || row.identity_confidence === undefined ? 1 : Number(row.identity_confidence),
        consent_status: row.consent_status,
        retention_policy: row.retention_policy,
        status: row.status,
        is_test: Boolean(row.is_test),
        created_at: row.created_at,
        updated_at: row.updated_at,
        expires_at: row.expires_at || null,
    };
}

export class TemporaryMemoryService {
    constructor({
        pool = null,
        cache = null,
        vectorStore = null,
        notify = null,
        logger = console,
        now = () => new Date(),
        cleanupIntervalMs = 15 * 60 * 1000,
    } = {}) {
        this.pool = pool;
        this.cache = cache;
        this.vectorStore = vectorStore;
        this.notify = typeof notify === 'function' ? notify : null;
        this.logger = logger;
        this.now = now;
        this._ephemeralProfiles = new Map();
        this._sessionProfiles = new Map();
        this._allergyDecisions = new Map();
        this._profileLocks = new Map();
        this._cleanupTimer = null;
        if (cleanupIntervalMs > 0) {
            this._cleanupTimer = setInterval(() => {
                this.cleanupExpired().catch(error => this.logger.warn?.('[Fase9Memory] cleanup:', error.message));
            }, cleanupIntervalMs);
            this._cleanupTimer.unref?.();
        }
    }

    close() {
        if (this._cleanupTimer) clearInterval(this._cleanupTimer);
        this._cleanupTimer = null;
    }

    async getPolicy() {
        if (!this.pool) return { retention_policy: '1d', updated_at: null, updated_by: null };
        try {
            const result = await this.pool.query('SELECT retention_policy, updated_at, updated_by FROM memory_policy WHERE id = 1');
            return result.rows[0] || { retention_policy: '1d', updated_at: null, updated_by: null };
        } catch (error) {
            this.logger.warn?.('[Fase9Memory] policy read:', error.message);
            return { retention_policy: '1d', updated_at: null, updated_by: null, degraded: true };
        }
    }

    async setPolicy({ retentionPolicy, actor = 'admin' } = {}) {
        const policy = normalizeRetentionPolicy(retentionPolicy);
        if (!policy) {
            const error = new Error('retention_policy inválida.');
            error.code = 'INVALID_RETENTION_POLICY';
            throw error;
        }
        if (!this.pool) return { retention_policy: policy, persisted: false };
        const result = await this.pool.query(
            `INSERT INTO memory_policy (id, retention_policy, updated_at, updated_by)
             VALUES (1, $1, NOW(), $2)
             ON CONFLICT (id) DO UPDATE SET retention_policy = EXCLUDED.retention_policy,
                 updated_at = NOW(), updated_by = EXCLUDED.updated_by
             RETURNING retention_policy, updated_at, updated_by`,
            [policy, String(actor).slice(0, 120)],
        );
        await this._audit({ event: 'retention_changed', source: 'admin', action: 'update', metadata: { retention_policy: policy } });
        this._emit({ action: 'policy_changed', status: 'active' });
        return { ...result.rows[0], persisted: true };
    }

    async createProfile({ sessionId, displayName = null, consent = null, retentionPolicy = null, source = 'user_declared', visitId = null, tableId = null } = {}) {
        const sid = assertSessionId(sessionId);
        const normalizedConsent = normalizeConsent(consent);
        if (!normalizedConsent) {
            const error = new Error('consent inválido.');
            error.code = 'INVALID_CONSENT';
            throw error;
        }
        if (!SOURCES.has(source)) {
            const error = new Error('source de memoria inválido.');
            error.code = 'INVALID_MEMORY_SOURCE';
            throw error;
        }

        // `disabled` is an explicit opt-out, not an ephemeral profile. Do not
        // normalize, return, or bind a name when the user has declined memory.
        if (normalizedConsent === 'disabled') {
            const previousProfileId = this._sessionProfiles.get(sid);
            if (previousProfileId) {
                await this.forget({ sessionId: sid, profileId: previousProfileId, scope: 'all' });
            } else {
                this._allergyDecisions.delete(sid);
            }
            await this._audit({ event: 'memory_disabled', sessionId: sid, visitId, tableId, source, action: 'disable' });
            this._emit({ session_id: sid, action: 'memory_disabled', status: 'disabled' });
            return {
                profile_id: null,
                display_name: null,
                identity_confidence: null,
                consent_status: 'disabled',
                retention_policy: 'disabled',
                status: 'disabled',
                created_at: this.now().toISOString(),
                updated_at: this.now().toISOString(),
                expires_at: null,
                session_id: sid,
                visit_id: null,
                table_id: null,
                entries: [],
                persistent: false,
            };
        }

        const name = normalizeDisplayName(displayName);
        const policy = normalizeRetentionPolicy(retentionPolicy) || (await this.getPolicy()).retention_policy;
        const effectiveConsent = normalizedConsent === 'temporary' && ['disabled', 'session_only'].includes(policy)
            ? (policy === 'disabled' ? 'disabled' : 'session_only')
            : normalizedConsent;

        if (effectiveConsent === 'disabled') {
            return this.createProfile({ sessionId: sid, displayName: null, consent: 'disabled', source, visitId, tableId });
        }

        const existingProfileId = this._sessionProfiles.get(sid);
        if (existingProfileId) {
            const existingProfile = await this._loadProfile(existingProfileId);
            if (existingProfile?.status === 'active' && existingProfile.consent_status === effectiveConsent) {
                return { ...profileShape(existingProfile), persistent: effectiveConsent === 'temporary', reused: true };
            }
        }

        const profileId = randomUUID();
        const expiresAt = buildMemoryExpiry({ consent: effectiveConsent, retentionPolicy: policy, now: this.now() });
        const profile = {
            profile_id: profileId,
            display_name: name,
            identity_confidence: name ? 1 : null,
            consent_status: effectiveConsent,
            retention_policy: effectiveConsent === 'temporary' ? policy : effectiveConsent,
            status: 'active',
            created_at: this.now().toISOString(),
            updated_at: this.now().toISOString(),
            expires_at: expiresAt?.toISOString() || null,
            session_id: sid,
            visit_id: visitId,
            table_id: tableId,
            entries: [],
        };
        if (effectiveConsent === 'temporary') {
            if (!this.pool) {
                const error = new Error('Almacenamiento persistente de memoria no disponible.');
                error.code = 'MEMORY_STORAGE_UNAVAILABLE';
                throw error;
            }
            const result = await this.pool.query(
                `INSERT INTO customer_profiles
                    (profile_id, display_name, identity_source, identity_confidence, consent_status, retention_policy, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING *`,
                [profileId, name, source, name ? 1 : null, effectiveConsent, policy, expiresAt],
            );
            if (name) await this._insertEntry({ profileId, sessionId: sid, memoryType: 'name', value: name, source, visitId, tableId, expiresAt });
            await this._audit({ event: 'profile_created', profileId, sessionId: sid, visitId, tableId, source, action: 'create', expiresAt, metadata: { consent: effectiveConsent } });
            this._sessionProfiles.set(sid, profileId);
            this._emit({ session_id: sid, action: 'profile_created', status: 'active' });
            return { ...profileShape(result.rows[0]), persistent: true };
        }
        this._ephemeralProfiles.set(profileId, profile);
        this._sessionProfiles.set(sid, profileId);
        if (name) profile.entries.push({ memory_id: randomUUID(), memory_type: 'name', value: name, source, created_at: profile.created_at });
        await this._audit({ event: 'profile_created', profileId, sessionId: sid, visitId, tableId, source, action: 'create', metadata: { consent: effectiveConsent } });
        this._emit({ session_id: sid, action: 'profile_created', status: 'active' });
        return { ...profile, entries: undefined, persistent: false };
    }

    async attachProfileToSession({ sessionId, profileId, consent } = {}) {
        const sid = assertSessionId(sessionId);
        const pid = assertProfileId(profileId);
        if (normalizeConsent(consent) !== 'temporary') {
            const error = new Error('La recuperación requiere confirmar memoria temporal.');
            error.code = 'MEMORY_CONSENT_REQUIRED';
            throw error;
        }
        return this._withProfileLock(pid, async () => {
            const existingBinding = [...this._sessionProfiles.entries()].find(([boundSessionId, boundProfileId]) => boundProfileId === pid && boundSessionId !== sid);
            if (existingBinding) {
                await this._audit({ event: 'profile_recovery_rejected', profileId: pid, sessionId: sid, action: 'attach', source: 'user_confirmed', result: 'profile_in_use', metadata: { bound_session: existingBinding[0] } });
                const error = new Error('El perfil ya está vinculado a otra atención activa.');
                error.code = 'PROFILE_IN_USE';
                throw error;
            }
            const profile = await this._loadProfile(pid);
            if (!profile || profile.status !== 'active' || profile.consent_status !== 'temporary') {
                await this._audit({ event: 'profile_recovery_rejected', profileId: pid, sessionId: sid, action: 'attach', source: 'user_confirmed', result: 'rejected' });
                const error = new Error('El perfil no está disponible para recuperación.');
                error.code = 'PROFILE_NOT_RECOVERABLE';
                throw error;
            }
            this._sessionProfiles.set(sid, pid);
            await this._audit({ event: 'profile_recovered', profileId: pid, sessionId: sid, action: 'attach', source: 'user_confirmed' });
            this._emit({ session_id: sid, action: 'profile_recovered', status: 'active' });
            return { ...profileShape(profile), persistent: true, recovered: true };
        });
    }

    getBoundProfileId(sessionId) {
        return this._sessionProfiles.get(String(sessionId)) || null;
    }

    async recoverProfile({ profileId, sessionId } = {}) {
        if (!profileId || !sessionId) return null;
        try {
            const pid = assertProfileId(profileId);
            const sid = assertSessionId(sessionId);
            const profile = await this._loadProfile(pid);
            if (!profile || profile.status !== 'active' || profile.consent_status !== 'temporary') return null;
            this._sessionProfiles.set(sid, pid);
            return { ...profileShape(profile), recovered: true };
        } catch {
            return null;
        }
    }

    // Deliberadamente no existe recuperación por nombre, mesa o client_id.
    async findProfileByName() {
        return null;
    }

    async remember({ sessionId, profileId, memoryType, value, source = 'user_declared', visitId = null, tableId = null } = {}) {
        const sid = assertSessionId(sessionId);
        const pid = assertProfileId(profileId);
        if (!MEMORY_TYPES.has(memoryType)) {
            const error = new Error('memory_type no permitido.');
            error.code = 'INVALID_MEMORY_TYPE';
            throw error;
        }
        if (!SOURCES.has(source)) {
            const error = new Error('source de memoria inválido.');
            error.code = 'INVALID_MEMORY_SOURCE';
            throw error;
        }
        if (this._sessionProfiles.get(sid) !== pid) {
            const error = new Error('El perfil no pertenece a la sesión.');
            error.code = 'PROFILE_SESSION_MISMATCH';
            throw error;
        }
        const safeValue = sanitizeValue(value);
        const profile = await this._loadProfile(pid);
        if (!profile) {
            const error = new Error('Perfil no encontrado.');
            error.code = 'PROFILE_NOT_FOUND';
            throw error;
        }
        if (profile.consent_status === 'disabled') {
            const error = new Error('La memoria está deshabilitada.');
            error.code = 'MEMORY_DISABLED';
            throw error;
        }
        const existingEntries = profile.consent_status === 'session_only'
            ? (profile.entries || [])
            : await this._loadEntries(pid);
        const duplicate = existingEntries.find(entry => entry.memory_type === memoryType && memoryValueKey(entry.value) === memoryValueKey(safeValue));
        if (duplicate) {
            return {
                memory_id: duplicate.memory_id,
                memory_type: duplicate.memory_type,
                value: duplicate.value,
                persistent: profile.consent_status === 'temporary',
                expires_at: duplicate.expires_at || null,
                deduplicated: true,
            };
        }
        if (profile.consent_status === 'session_only') {
            const replaceExisting = ['name', 'interaction_mode'].includes(memoryType);
            profile.entries = replaceExisting
                ? (profile.entries || []).filter(entry => entry.memory_type !== memoryType)
                : (profile.entries || []);
            profile.entries.push({
                memory_id: randomUUID(), memory_type: memoryType, value: safeValue, source,
                session_id: sid, visit_id: visitId, table_id: tableId, created_at: this.now().toISOString(),
            });
            if (memoryType === 'name') profile.display_name = displayValue(safeValue);
            profile.updated_at = this.now().toISOString();
            await this._audit({ event: memoryType === 'name' ? 'identity_updated' : 'memory_recorded', profileId: pid, sessionId: sid, visitId, tableId, memoryType, source, action: 'create' });
            this._emit({ session_id: sid, action: 'memory_recorded', memory_type: memoryType, status: 'active' });
            return { memory_id: profile.entries.at(-1).memory_id, memory_type: memoryType, value: safeValue, persistent: false };
        }
        const policy = profile.retention_policy;
        const expiresAt = buildMemoryExpiry({ consent: 'temporary', retentionPolicy: policy, now: this.now() });
        if (['name', 'interaction_mode'].includes(memoryType)) {
            await this.pool.query('DELETE FROM customer_memory_entries WHERE profile_id = $1 AND memory_type = $2', [pid, memoryType]);
        }
        const entry = await this._insertEntry({ profileId: pid, sessionId: sid, memoryType, value: safeValue, source, visitId, tableId, expiresAt });
        if (memoryType === 'name') {
            await this.pool.query('UPDATE customer_profiles SET display_name = $2, identity_confidence = 1, updated_at = NOW(), last_interaction_at = NOW() WHERE profile_id = $1', [pid, displayValue(safeValue)]);
        } else {
            await this.pool.query('UPDATE customer_profiles SET updated_at = NOW(), last_interaction_at = NOW() WHERE profile_id = $1', [pid]);
        }
        await this._audit({ event: memoryType === 'name' ? 'identity_updated' : 'memory_recorded', profileId: pid, memoryId: entry.memory_id, sessionId: sid, visitId, tableId, memoryType, source, action: 'create', expiresAt });
        if (this.cache?.set && expiresAt) {
            try {
                const seconds = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - this.now().getTime()) / 1000));
                await this.cache.set(`memory:profile:${pid}:${memoryType}:${entry.memory_id}`, JSON.stringify({ memory_id: entry.memory_id, memory_type: memoryType }), { EX: seconds });
            } catch (error) {
                this.logger.warn?.('[Fase9Memory] cache write:', error.message);
            }
        }
        if (this.vectorStore?.add && ['preference', 'favorite_product', 'companion'].includes(memoryType)) {
            await this.vectorStore.add('customer_memory', entry.memory_id, displayValue(safeValue), {
                profile_id: pid, memory_type: memoryType, source, session_id: sid, expires_at: expiresAt?.toISOString() || null,
            });
        }
        this._emit({ session_id: sid, action: 'memory_recorded', memory_type: memoryType, status: 'active' });
        return { memory_id: entry.memory_id, memory_type: memoryType, value: safeValue, persistent: true, expires_at: entry.expires_at || expiresAt?.toISOString() || null };
    }

    async recordLastConfirmedOrder({ sessionId, profileId, order } = {}) {
        if (!order) return null;
        return this.remember({
            sessionId,
            profileId,
            memoryType: 'last_confirmed_order',
            value: sanitizeOrderMemory(order, this.now()),
            source: 'order_confirmed',
            visitId: order.visit_id || null,
            tableId: order.table_id || order.mesa || null,
        });
    }

    async summary({ sessionId, profileId } = {}) {
        const sid = assertSessionId(sessionId);
        if (!profileId) return { profile: null, name: null, companions: [], preferences: [], interaction_mode: null, favorite_products: [], allergies: [], restrictions: [], last_order: null };
        const pid = assertProfileId(profileId);
        const boundProfileId = this._sessionProfiles.get(sid);
        const profile = await this._loadProfile(pid);
        if (boundProfileId && boundProfileId !== pid) {
            await this._audit({ event: 'cross_session_access_blocked', profileId: pid, sessionId: sid, action: 'read', source: 'backend', result: 'rejected' });
            const error = new Error('El perfil no pertenece a la sesión.');
            error.code = 'PROFILE_SESSION_MISMATCH';
            throw error;
        }
        if (!boundProfileId && !profile) return { profile: null, name: null, companions: [], preferences: [], interaction_mode: null, favorite_products: [], allergies: [], restrictions: [], last_order: null };
        if (!boundProfileId && profile) {
            await this._audit({ event: 'cross_session_access_blocked', profileId: pid, sessionId: sid, action: 'read', source: 'backend', result: 'rejected' });
            const error = new Error('El perfil no pertenece a la sesión.');
            error.code = 'PROFILE_SESSION_MISMATCH';
            throw error;
        }
        if (!profile) return { profile: null, name: null, companions: [], preferences: [], interaction_mode: null, favorite_products: [], allergies: [], restrictions: [], last_order: null };
        const entries = profile.consent_status === 'session_only'
            ? (profile.entries || [])
            : await this._loadEntries(pid);
        const active = entries.filter(entry => !entry.expires_at || new Date(entry.expires_at).getTime() > this.now().getTime());
        const values = type => active.filter(entry => entry.memory_type === type).map(entry => displayValue(entry.value)).filter(Boolean);
        const allergyEntries = active.filter(entry => entry.memory_type === 'allergy');
        const allergyDecisions = this._allergyDecisions.get(sid) || new Map();
        const storedLastOrder = active.find(entry => entry.memory_type === 'last_confirmed_order')?.value || null;
        return {
            profile: profileShape(profile),
            name: profile.display_name || values('name')[0] || null,
            companions: values('companion'),
            preferences: values('preference'),
            interaction_mode: values('interaction_mode')[0] || null,
            favorite_products: values('favorite_product'),
            allergies: allergyEntries.map(entry => {
                const value = displayValue(entry.value);
                return { value, requires_reconfirmation: entry.session_id !== sid && !allergyDecisions.has(value.toLowerCase()) };
            }),
            restrictions: values('restriction'),
            last_order: storedLastOrder || await this._findLastConfirmedOrderInPostgres(pid),
        };
    }

    async forget({ sessionId, profileId, scope = 'all' } = {}) {
        const sid = assertSessionId(sessionId);
        const pid = assertProfileId(profileId);
        if (scope !== 'all' && !FORGETTABLE_TYPES.has(scope)) {
            const error = new Error('scope de olvido inválido.');
            error.code = 'INVALID_FORGET_SCOPE';
            throw error;
        }
        const boundProfileId = this._sessionProfiles.get(sid);
        const profile = await this._loadProfile(pid);
        if (boundProfileId && boundProfileId !== pid) {
            await this._audit({ event: 'cross_session_access_blocked', profileId: pid, sessionId: sid, action: 'delete', source: 'backend', result: 'rejected' });
            const error = new Error('El perfil no pertenece a la sesión.');
            error.code = 'PROFILE_SESSION_MISMATCH';
            throw error;
        }
        if (!boundProfileId && !profile && scope === 'all') {
            await this._deleteExternal(pid);
            await this._audit({ event: 'profile_forgotten', profileId: pid, sessionId: sid, action: 'delete', source: 'user_confirmed', result: 'already_absent' });
            return { forgotten: true, scope, profile_id: pid };
        }
        if (!boundProfileId && profile) {
            await this._audit({ event: 'cross_session_access_blocked', profileId: pid, sessionId: sid, action: 'delete', source: 'backend', result: 'rejected' });
            const error = new Error('El perfil no pertenece a la sesión.');
            error.code = 'PROFILE_SESSION_MISMATCH';
            throw error;
        }
        if (scope !== 'all' && !FORGETTABLE_TYPES.has(scope)) {
            const error = new Error('scope de olvido inválido.');
            error.code = 'INVALID_FORGET_SCOPE';
            throw error;
        }
        if (profile?.consent_status === 'session_only') {
            if (scope === 'all') this._ephemeralProfiles.delete(pid);
            else {
                profile.entries = (profile.entries || []).filter(entry => entry.memory_type !== scope);
                if (scope === 'name') profile.display_name = null;
            }
        } else if (this.pool) {
            await this._deleteExternal(pid, scope === 'all' ? null : scope);
            if (scope === 'all') {
                await this.pool.query('DELETE FROM customer_memory_entries WHERE profile_id = $1', [pid]);
                await this.pool.query('DELETE FROM customer_profiles WHERE profile_id = $1', [pid]);
            } else {
                await this.pool.query('DELETE FROM customer_memory_entries WHERE profile_id = $1 AND memory_type = $2', [pid, scope]);
                if (scope === 'name') await this.pool.query('UPDATE customer_profiles SET display_name = NULL, identity_confidence = NULL, updated_at = NOW() WHERE profile_id = $1', [pid]);
            }
        }
        await this._audit({
            event: scope === 'all' ? 'profile_forgotten' : 'memory_forgotten',
            profileId: pid,
            sessionId: sid,
            action: 'delete',
            source: 'user_confirmed',
            memoryType: scope === 'all' ? null : scope,
        });
        if (scope === 'all') {
            this._sessionProfiles.delete(sid);
            this._allergyDecisions.delete(sid);
        }
        this._emit({ session_id: sid, action: 'memory_forgotten', memory_type: scope === 'all' ? null : scope, status: 'forgotten' });
        return { forgotten: true, scope, profile_id: pid };
    }

    async clearSession(sessionId) {
        if (!sessionId) return { cleared: false };
        const pid = this._sessionProfiles.get(String(sessionId));
        if (pid) {
            const profile = this._ephemeralProfiles.get(pid);
            if (profile?.session_id === String(sessionId)) this._ephemeralProfiles.delete(pid);
            this._sessionProfiles.delete(String(sessionId));
            this._allergyDecisions.delete(String(sessionId));
            await this._audit({ event: 'session_memory_cleared', profileId: pid, sessionId: String(sessionId), action: 'delete', source: 'session_close' });
        }
        return { cleared: Boolean(pid) };
    }

    async confirmRecoveredAllergies({ sessionId, profileId, allergies = [] } = {}) {
        const sid = assertSessionId(sessionId);
        const pid = assertProfileId(profileId);
        const boundProfileId = this._sessionProfiles.get(sid);
        if (boundProfileId !== pid) {
            const error = new Error('El perfil no pertenece a la sesión.');
            error.code = 'PROFILE_SESSION_MISMATCH';
            throw error;
        }
        const values = (Array.isArray(allergies) ? allergies : [allergies]).map(displayValue).filter(Boolean);
        const decisions = this._allergyDecisions.get(sid) || new Map();
        for (const value of values) decisions.set(value.toLowerCase(), 'confirmed');
        this._allergyDecisions.set(sid, decisions);
        await this._audit({ event: 'allergy_memory_confirmed', profileId: pid, sessionId: sid, memoryType: 'allergy', source: 'user_confirmed', action: 'confirm', metadata: { count: values.length } });
        return { confirmed: true, allergies: values };
    }

    async rejectRecoveredAllergies({ sessionId, profileId, allergies = [] } = {}) {
        const sid = assertSessionId(sessionId);
        const pid = assertProfileId(profileId);
        const boundProfileId = this._sessionProfiles.get(sid);
        if (boundProfileId !== pid) {
            const error = new Error('El perfil no pertenece a la sesión.');
            error.code = 'PROFILE_SESSION_MISMATCH';
            throw error;
        }
        const values = (Array.isArray(allergies) ? allergies : [allergies]).map(displayValue).filter(Boolean);
        const decisions = this._allergyDecisions.get(sid) || new Map();
        for (const value of values) decisions.set(value.toLowerCase(), 'rejected');
        this._allergyDecisions.set(sid, decisions);
        await this._audit({ event: 'allergy_memory_rejected', profileId: pid, sessionId: sid, memoryType: 'allergy', source: 'user_confirmed', action: 'reject', metadata: { count: values.length } });
        return { rejected: true, allergies: values };
    }

    async getLastConfirmedOrder({ sessionId, profileId } = {}) {
        const result = await this.summary({ sessionId, profileId });
        return result.last_order || null;
    }

    async _findLastConfirmedOrderInPostgres(profileId) {
        if (!this.pool) return null;
        const pid = assertProfileId(profileId);
        const query = await this.pool.query(
            `SELECT id, table_id, mesa, items, platos, timestamp
               FROM pedidos
              WHERE cliente_id = $1
                AND (status IN ('confirmed', 'sent_to_kitchen', 'preparing', 'ready', 'delivery_in_progress', 'delivered')
                     OR estado IN ('confirmado', 'en_preparacion', 'listo', 'entregado'))
              ORDER BY timestamp DESC
              LIMIT 1`,
            [pid],
        );
        const row = query.rows[0];
        if (!row) return null;
        const rawItems = Array.isArray(row.items || row.platos)
            ? (row.items || row.platos)
            : this._parseJson(row.items || row.platos, []);
        return sanitizeOrderMemory({
            id: row.id,
            table_id: row.table_id || row.mesa,
            items: rawItems,
            timestamp: row.timestamp,
        }, this.now());
    }

    async cleanupExpired({ source = 'scheduled', actor = null } = {}) {
        if (!this.pool) {
            const now = this.now().getTime();
            let removed = 0;
            for (const [profileId, profile] of this._ephemeralProfiles) {
                if (profile.expires_at && new Date(profile.expires_at).getTime() <= now) {
                    this._ephemeralProfiles.delete(profileId);
                    removed += 1;
                }
            }
            return { expired: removed, persisted: false };
        }
        const entries = await this.pool.query(`
            SELECT memory_id, profile_id, memory_type
              FROM customer_memory_entries
             WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
        `);
        const profiles = await this.pool.query(`
            SELECT profile_id
              FROM customer_profiles
             WHERE status = 'active'
               AND expires_at IS NOT NULL AND expires_at <= NOW()
        `);
        const expiredProfileIds = new Set(profiles.rows.map(row => String(row.profile_id)));
        const profileIds = new Set([...entries.rows, ...profiles.rows].map(row => String(row.profile_id)));
        for (const profileId of profileIds) {
            const expiredTypes = new Set(entries.rows
                .filter(row => String(row.profile_id) === profileId)
                .map(row => row.memory_type)
                .filter(Boolean));
            if (expiredProfileIds.has(profileId)) {
                await this._deleteExternal(profileId);
            } else {
                for (const memoryType of expiredTypes) await this._deleteExternal(profileId, memoryType);
            }
            if (expiredProfileIds.has(profileId)) {
                await this.pool.query('DELETE FROM customer_memory_entries WHERE profile_id = $1', [profileId]);
            } else if (expiredTypes.size) {
                await this.pool.query(`
                    DELETE FROM customer_memory_entries
                     WHERE profile_id = $1
                       AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
                `, [profileId]);
            }
            if (expiredProfileIds.has(profileId)) {
                await this.pool.query(`
                    DELETE FROM customer_profiles
                     WHERE profile_id = $1 AND status = 'active'
                       AND expires_at IS NOT NULL AND expires_at <= NOW()
                `, [profileId]);
            }
            for (const [sessionId, boundProfileId] of this._sessionProfiles) {
                if (boundProfileId === profileId) {
                    this._sessionProfiles.delete(sessionId);
                    this._allergyDecisions.delete(sessionId);
                }
            }
            await this._audit({ event: 'profile_expired', profileId, action: 'cleanup', source, result: 'expired' });
        }
        await this._audit({
            event: 'memory_cleanup_executed',
            action: 'cleanup',
            source,
            result: 'ok',
            metadata: { entries: entries.rowCount, profiles: profiles.rowCount, actor: actor ? String(actor).slice(0, 120) : null },
        });
        this._emit({ action: 'cleanup_executed', status: 'complete', expired: entries.rowCount + profiles.rowCount });
        return { expired: entries.rowCount + profiles.rowCount, profiles: profiles.rowCount, persisted: true };
    }

    async adminSnapshot() {
        const policy = await this.getPolicy();
        if (!this.pool) return { policy, profiles: 0, entries: 0, audit_events: 0, degraded: true };
        const result = await this.pool.query(`
            SELECT
                (SELECT COUNT(*) FROM customer_profiles WHERE status = 'active') AS profiles,
                (SELECT COUNT(*) FROM customer_profiles WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW() + INTERVAL '24 hours') AS expiring_profiles,
                (SELECT COUNT(*) FROM customer_profiles WHERE status = 'expired' OR (status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW())) AS expired_profiles,
                (SELECT COUNT(*) FROM customer_memory_entries WHERE status = 'active') AS entries,
                (SELECT COUNT(*) FROM memory_audit_events) AS audit_events,
                (SELECT MAX(created_at) FROM memory_audit_events WHERE event = 'memory_cleanup_executed') AS last_cleanup_at,
                (SELECT metadata FROM memory_audit_events WHERE event = 'memory_cleanup_executed' ORDER BY created_at DESC LIMIT 1) AS last_cleanup_metadata,
                (SELECT metadata FROM memory_audit_events WHERE event = 'memory_cleanup_failed' ORDER BY created_at DESC LIMIT 1) AS last_cleanup_error
        `);
        return { policy, ...result.rows[0], active_profiles: result.rows[0].profiles, degraded: false };
    }

    async recordCleanupFailure({ source = 'scheduled', actor = null, error = null } = {}) {
        const message = String(error?.message || error || 'Error desconocido').slice(0, 300);
        await this._audit({
            event: 'memory_cleanup_failed',
            action: 'cleanup',
            source,
            result: 'error',
            metadata: { error: message, actor: actor ? String(actor).slice(0, 120) : null },
        });
        this._emit({ action: 'cleanup_failed', status: 'error' });
        return { recorded: true };
    }

    async listProfiles({ limit = 100 } = {}) {
        if (!this.pool) return [...this._ephemeralProfiles.values()].map(profileShape).slice(0, limit);
        const result = await this.pool.query(
            `SELECT profile_id, display_name, identity_confidence, consent_status, retention_policy, status, created_at, updated_at, expires_at
               FROM customer_profiles ORDER BY updated_at DESC LIMIT $1`,
            [Math.min(500, Math.max(1, Number(limit) || 100))],
        );
        return result.rows.map(profileShape);
    }

    async getProfileForAdmin(profileId) {
        const pid = assertProfileId(profileId);
        const profile = await this._loadProfile(pid, { includeExpired: true });
        if (!profile) return null;
        const entries = profile.consent_status === 'session_only' ? profile.entries || [] : await this._loadEntries(pid, { includeExpired: true });
        return { profile: profileShape(profile), entries: entries.map(entry => ({ memory_id: entry.memory_id, memory_type: entry.memory_type, value: entry.value, source: entry.source, status: entry.status, created_at: entry.created_at, expires_at: entry.expires_at || null })) };
    }

    async adminForget({ profileId, scope = 'all', actor = 'admin' } = {}) {
        const pid = assertProfileId(profileId);
        if (scope !== 'all' && !FORGETTABLE_TYPES.has(scope)) {
            const error = new Error('scope de olvido inválido.');
            error.code = 'INVALID_FORGET_SCOPE';
            throw error;
        }
        await this._audit({ event: 'memory_forgotten', profileId: pid, action: 'delete', source: 'admin', result: 'requested', metadata: { scope, actor: String(actor).slice(0, 120) } });
        if (this.pool) {
            await this._deleteExternal(pid, scope === 'all' ? null : scope);
            if (scope === 'all') {
                await this.pool.query('DELETE FROM customer_memory_entries WHERE profile_id = $1', [pid]);
                await this.pool.query('DELETE FROM customer_profiles WHERE profile_id = $1', [pid]);
            } else {
                await this.pool.query('DELETE FROM customer_memory_entries WHERE profile_id = $1 AND memory_type = $2', [pid, scope]);
                if (scope === 'name') {
                    await this.pool.query('UPDATE customer_profiles SET display_name = NULL, identity_confidence = NULL, updated_at = NOW() WHERE profile_id = $1', [pid]);
                }
            }
        }
        const ephemeral = this._ephemeralProfiles.get(pid);
        if (ephemeral && scope === 'all') {
            this._ephemeralProfiles.delete(pid);
        } else if (ephemeral && scope !== 'all') {
            ephemeral.entries = (ephemeral.entries || []).filter(entry => entry.memory_type !== scope);
            if (scope === 'name') ephemeral.display_name = null;
            ephemeral.updated_at = this.now().toISOString();
        }
        if (scope === 'all') {
            for (const [sessionId, boundProfileId] of this._sessionProfiles) {
                if (boundProfileId === pid) {
                    this._sessionProfiles.delete(sessionId);
                    this._allergyDecisions.delete(sessionId);
                }
            }
        }
        this._emit({ action: 'memory_forgotten', memory_type: scope === 'all' ? null : scope, status: 'forgotten' });
        return { forgotten: true, profile_id: pid, scope };
    }

    async clearTestProfiles({ profileIds = [], executor = this.pool, actor = 'admin', deferExternal = false } = {}) {
        const ids = [...new Set(profileIds.map(assertProfileId))];
        if (!ids.length || !executor) return { deleted_profiles: 0, profile_ids: [] };
        const current = await executor.query(
            'SELECT profile_id FROM customer_profiles WHERE profile_id = ANY($1::uuid[]) AND is_test = true FOR UPDATE',
            [ids],
        );
        if (current.rows.length !== ids.length) {
            const error = new Error('Los perfiles de prueba cambiaron; genera una nueva vista previa.');
            error.code = 'STALE_CLEANUP_PREVIEW';
            throw error;
        }
        if (!deferExternal) {
            for (const profileId of ids) {
                await this._deleteExternal(profileId, null, { auditExecutor: executor });
            }
        }
        const deleted = await executor.query(
            'DELETE FROM customer_profiles WHERE profile_id = ANY($1::uuid[]) AND is_test = true RETURNING profile_id',
            [ids],
        );
        for (const row of deleted.rows) {
            await this._audit({
                event: 'test_profile_deleted',
                profileId: row.profile_id,
                action: 'delete',
                source: 'admin_history',
                result: 'ok',
                metadata: { actor: String(actor).slice(0, 120) },
                executor,
            });
        }
        return {
            deleted_profiles: deleted.rowCount || 0,
            profile_ids: deleted.rows.map(row => String(row.profile_id)),
            external_cleanup_deferred: Boolean(deferExternal),
        };
    }

    async clearExternalProfiles({ profileIds = [], actor = 'admin' } = {}) {
        const ids = [...new Set(profileIds.map(assertProfileId))];
        let cache_deleted = 0;
        let vectors_deleted = 0;
        for (const profileId of ids) {
            const result = await this._deleteExternal(profileId);
            cache_deleted += Number(result.cacheDeleted || 0);
            vectors_deleted += Number(result.vectorsDeleted || 0);
        }
        await this._audit({
            event: 'test_profile_external_cleanup_completed',
            action: 'delete',
            source: 'admin_history',
            result: 'ok',
            metadata: { actor: String(actor).slice(0, 120), profile_count: ids.length, cache_deleted, vectors_deleted },
        });
        return { profile_ids: ids, cache_deleted, vectors_deleted };
    }

    async anonymizeProfile({ profileId, actor = 'admin' } = {}) {
        const pid = assertProfileId(profileId);
        if (!this.pool) return { anonymized: false, profile_id: pid, persisted: false };
        await this._audit({ event: 'profile_anonymized', profileId: pid, action: 'anonymize', source: 'admin', metadata: { actor: String(actor).slice(0, 120) } });
        await this._deleteExternal(pid);
        await this.pool.query('DELETE FROM customer_memory_entries WHERE profile_id = $1', [pid]);
        await this.pool.query(`UPDATE customer_profiles SET display_name = NULL, identity_confidence = NULL, status = 'forgotten', forgotten_at = NOW(), updated_at = NOW() WHERE profile_id = $1`, [pid]);
        for (const [sessionId, boundProfileId] of this._sessionProfiles) {
            if (boundProfileId === pid) {
                this._sessionProfiles.delete(sessionId);
                this._allergyDecisions.delete(sessionId);
            }
        }
        this._emit({ action: 'profile_anonymized', status: 'forgotten' });
        return { anonymized: true, profile_id: pid, persisted: true };
    }

    async audit({ limit = 100 } = {}) {
        if (!this.pool) return [];
        const result = await this.pool.query(
            `SELECT audit_id, event, profile_id, memory_id, session_id, visit_id, table_id, memory_type, source, action, result, created_at, expires_at, metadata
               FROM memory_audit_events ORDER BY created_at DESC LIMIT $1`,
            [Math.min(500, Math.max(1, Number(limit) || 100))],
        );
        return result.rows;
    }

    async _loadProfile(profileId, { includeExpired = false } = {}) {
        const ephemeral = this._ephemeralProfiles.get(profileId);
        if (ephemeral) return ephemeral;
        if (!this.pool) return null;
        const predicate = includeExpired
            ? "status IN ('active', 'expired', 'forgotten')"
            : "status = 'active' AND (expires_at IS NULL OR expires_at > NOW())";
        const result = await this.pool.query(`SELECT * FROM customer_profiles WHERE profile_id = $1 AND ${predicate}`, [profileId]);
        return result.rows[0] || null;
    }

    async _loadEntries(profileId, { includeExpired = false } = {}) {
        const predicate = includeExpired
            ? ''
            : "AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())";
        const result = await this.pool.query(
            `SELECT memory_id, profile_id, memory_type, value, source, session_id, visit_id, table_id, status, created_at, updated_at, expires_at
               FROM customer_memory_entries
              WHERE profile_id = $1 ${predicate}
              ORDER BY updated_at DESC`,
            [profileId],
        );
        return result.rows;
    }

    _parseJson(value, fallback = null) {
        if (value && typeof value === 'object') return value;
        if (typeof value !== 'string') return fallback;
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }

    async _insertEntry({ profileId, sessionId, memoryType, value, source, visitId, tableId, expiresAt }) {
        const result = await this.pool.query(
            `INSERT INTO customer_memory_entries
                (profile_id, memory_type, value, source, session_id, visit_id, table_id, expires_at)
             VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
             RETURNING memory_id, memory_type, value, source, created_at, expires_at`,
            [profileId, memoryType, JSON.stringify(value), source, sessionId, visitId, tableId, expiresAt],
        );
        return result.rows[0];
    }

    async _deleteExternal(profileId, memoryType = null, { auditExecutor = this.pool } = {}) {
        let cacheDeleted = 0;
        if (this.cache?.scanIterator && this.cache?.del) {
            const keys = [];
            const suffix = memoryType ? `${memoryType}:*` : '*';
            for await (const key of this.cache.scanIterator({ MATCH: `memory:profile:${profileId}:${suffix}`, COUNT: 100 })) keys.push(key);
            if (keys.length) cacheDeleted = await this.cache.del(keys);
        }
        let vectorsDeleted = 0;
        if (this.vectorStore?.deleteByProfile) {
            try {
                vectorsDeleted = await this.vectorStore.deleteByProfile(profileId, memoryType) || 0;
            } catch (error) {
                await this._audit({ event: 'vector_memory_delete_failed', profileId, memoryType, action: 'delete', source: 'backend', result: 'error', metadata: { error: String(error.message || error).slice(0, 300) }, executor: auditExecutor });
                const failure = new Error('No se pudo eliminar la memoria vectorial.');
                failure.code = 'MEMORY_EXTERNAL_CLEANUP_FAILED';
                throw failure;
            }
        }
        if (vectorsDeleted > 0) {
            await this._audit({ event: 'vector_memory_deleted', profileId, memoryType, action: 'delete', source: 'backend', result: 'ok', metadata: { count: vectorsDeleted }, executor: auditExecutor });
        }
        return { cacheDeleted, vectorsDeleted };
    }

    async _withProfileLock(profileId, operation) {
        const previous = this._profileLocks.get(profileId) || Promise.resolve();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const queued = previous.then(() => gate);
        this._profileLocks.set(profileId, queued);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this._profileLocks.get(profileId) === queued) this._profileLocks.delete(profileId);
        }
    }

    async _audit({ event, profileId = null, memoryId = null, sessionId = null, visitId = null, tableId = null, memoryType = null, source = 'backend', action = 'observe', result = 'ok', expiresAt = null, metadata = {}, executor = this.pool } = {}) {
        if (!executor) return;
        try {
            await executor.query(
                `INSERT INTO memory_audit_events
                    (event, profile_id, memory_id, session_id, visit_id, table_id, memory_type, source, action, result, expires_at, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
                [event, profileId, memoryId, sessionId, visitId, tableId, memoryType, source, action, result, expiresAt, JSON.stringify(metadata)],
            );
        } catch (error) {
            this.logger.warn?.('[Fase9Memory] audit:', error.message);
        }
    }

    _emit(data) {
        const { session_id: _sessionId, profile_id: _profileId, ...safeData } = data || {};
        this.notify?.({ type: 'memory_event', ...safeData, timestamp: this.now().toISOString() });
    }
}

export { MEMORY_TYPES };
