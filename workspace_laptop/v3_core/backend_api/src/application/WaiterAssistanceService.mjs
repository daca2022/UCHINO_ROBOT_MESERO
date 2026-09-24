import { randomUUID } from 'node:crypto';

const KEY_SET = 'uchino:waiter_assistance:ids';
const KEY_PREFIX = 'uchino:waiter_assistance:';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeMesa(value) {
    const raw = String(value || '').trim().toUpperCase().replace(/^MESA\s*/u, '').replace(/^M(?=\d)/u, '');
    if (!/^([1-9]|1[0-2])$/u.test(raw)) throw new Error(`Mesa inválida: ${value}`);
    return `M${Number(raw)}`;
}

function isExpired(record, now = Date.now()) {
    return Boolean(record?.expires_at && new Date(record.expires_at).getTime() <= now);
}

export class WaiterAssistanceService {
    constructor({ redis = null, notify = null, clock = () => new Date(), onRequest = null, onUpdate = null, logger = console } = {}) {
        this.redis = redis;
        this.notify = typeof notify === 'function' ? notify : () => {};
        this.clock = clock;
        this.logger = logger;
        this.onRequest = typeof onRequest === 'function' ? onRequest : null;
        this.onUpdate = typeof onUpdate === 'function' ? onUpdate : null;
        this.memory = new Map();
        this.requestLocks = new Map();
    }

    setRequestHandler(handler) {
        this.onRequest = typeof handler === 'function' ? handler : null;
    }

    setUpdateHandler(handler) {
        this.onUpdate = typeof handler === 'function' ? handler : null;
    }

    _key(id) {
        return `${KEY_PREFIX}${id}`;
    }

    async _read(id) {
        if (this.redis?.hGetAll) {
            try {
                const data = await this.redis.hGetAll(this._key(id));
                if (data && Object.keys(data).length > 0) return this._deserialize(data);
            } catch (error) {
                console.warn('[WaiterAssistanceService] Redis read fallback:', error.message);
            }
        }
        const record = this.memory.get(id);
        return record ? clone(record) : null;
    }

    async _write(record) {
        this.memory.set(record.request_id, clone(record));
        if (this.redis?.hSet) {
            try {
                await this.redis.hSet(this._key(record.request_id), this._serialize(record));
                if (this.redis.sAdd) await this.redis.sAdd(KEY_SET, record.request_id);
            } catch (error) {
                console.warn('[WaiterAssistanceService] Redis write fallback:', error.message);
            }
        }
    }

    _serialize(record) {
        return Object.fromEntries(Object.entries(record).map(([key, value]) => [
            key,
            typeof value === 'object' ? JSON.stringify(value) : String(value),
        ]));
    }

    _deserialize(record) {
        const output = { ...record };
        for (const key of ['products']) {
            if (typeof output[key] === 'string') {
                try { output[key] = JSON.parse(output[key]); } catch { output[key] = []; }
            }
        }
        return output;
    }

    async _all() {
        const memoryRecords = [...this.memory.values()].map(clone);
        if (this.redis?.sMembers) {
            try {
                const ids = await this.redis.sMembers(KEY_SET);
                const records = await Promise.all(ids.map(id => this._read(id)));
                const byId = new Map(records.filter(Boolean).map(record => [record.request_id, record]));
                for (const record of memoryRecords) {
                    if (!byId.has(record.request_id)) byId.set(record.request_id, record);
                }
                return [...byId.values()];
            } catch (error) {
                console.warn('[WaiterAssistanceService] Redis list fallback:', error.message);
            }
        }
        return memoryRecords;
    }

    async request({
        session_id,
        mesa,
        table_id = null,
        visit_id = null,
        robot_id = null,
        origin = 'robot',
        timestamp = this.clock().toISOString(),
        expires_at = null,
    } = {}) {
        if (!session_id) throw new Error('session_id es obligatorio');
        const previous = this.requestLocks.get(session_id) || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        this.requestLocks.set(session_id, current);
        await previous.catch(() => {});
        try {
            const normalizedMesa = normalizeMesa(mesa);
            const normalizedTableId = table_id ? normalizeMesa(table_id) : normalizedMesa;
            const nowMs = this.clock().getTime();
            const existing = (await this._all()).find(record => record.session_id === session_id
                && record.status === 'pending'
                && !isExpired(record, nowMs)
                && record.table_id === normalizedTableId
                && record.visit_id === (visit_id || null)
                && record.robot_id === (robot_id || null));
            if (existing) return { created: false, request: clone(existing) };

            const request = {
                event: 'waiter_assistance_requested',
                request_id: randomUUID(),
                session_id,
                mesa: normalizedMesa,
                table_id: normalizedTableId,
                visit_id: visit_id || null,
                robot_id: robot_id || null,
                timestamp,
                status: 'pending',
                origin,
                expires_at: expires_at || new Date(new Date(timestamp).getTime() + 15 * 60 * 1000).toISOString(),
            };
            await this._write(request);
            this.notify(clone(request));
            if (this.onRequest) {
                try { await this.onRequest(clone(request)); }
                catch (error) { this.logger.warn?.(`[WaiterAssistanceService] request handler: ${error.message}`); }
            }
            return { created: true, request: clone(request) };
        } finally {
            release();
            if (this.requestLocks.get(session_id) === current) this.requestLocks.delete(session_id);
        }
    }

    async list({ status = 'all', tableId = null, visitId = null, sessionId = null, robotId = null } = {}) {
        const records = await this._all();
        return records
            .filter(record => status === 'all' || record.status === status)
            .filter(record => !tableId || record.table_id === normalizeMesa(tableId))
            .filter(record => !visitId || record.visit_id === visitId)
            .filter(record => !sessionId || record.session_id === sessionId)
            .filter(record => !robotId || record.robot_id === robotId)
            .filter(record => record.status !== 'pending' || !isExpired(record))
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }

    async attend(requestId) {
        if (!requestId) throw new Error('request_id es obligatorio');
        const record = await this._read(requestId);
        if (!record) {
            const error = new Error('Solicitud de mesero no encontrada');
            error.code = 'NOT_FOUND';
            throw error;
        }
        if (record.status === 'attended') return clone(record);
        const updated = {
            ...record,
            status: 'attended',
            attended_at: this.clock().toISOString(),
        };
        await this._write(updated);
        this.notify({
            event: 'waiter_assistance_updated',
            request_id: updated.request_id,
            session_id: updated.session_id,
            mesa: updated.mesa,
            timestamp: updated.attended_at,
            status: updated.status,
            request: clone(updated),
        });
        if (this.onUpdate) {
            try { await this.onUpdate(clone(updated)); }
            catch (error) { this.logger.warn?.(`[WaiterAssistanceService] update handler: ${error.message}`); }
        }
        return clone(updated);
    }
}
