/**
 * Repositorio PostgreSQL: Pedidos
 * Implementa IRepository<Pedido>
 */

import pg from 'pg';
import { randomUUID } from 'crypto';
import { IRepository } from '../ports/IRepository.mjs';

const { Pool } = pg;
const LEGACY_STATUS = {
    draft: 'provisional',
    pending_confirmation: 'provisional',
    confirmed: 'confirmado',
    sent_to_kitchen: 'confirmado',
    preparing: 'en_preparacion',
    ready: 'listo',
    delivered: 'entregado',
    cancelled: 'cancelado',
};

const STATUS_ALIASES = {
    provisional: 'draft',
    confirmado: 'confirmed',
    en_preparacion: 'preparing',
    listo: 'ready',
    entregado: 'delivered',
    cancelado: 'cancelled',
};
const ORDER_STATUSES = new Set([
    'draft', 'pending_confirmation', 'provisional', 'confirmed', 'sent_to_kitchen',
    'preparing', 'ready', 'delivery_in_progress', 'delivered', 'cancelled',
]);

function normalizeStatus(status, { strict = false } = {}) {
    const normalized = STATUS_ALIASES[status] || status || 'draft';
    if (strict && !ORDER_STATUSES.has(normalized)) {
        const error = new Error(`Estado de pedido inválido: ${status}`);
        error.code = 'INVALID_ORDER_STATUS';
        throw error;
    }
    return normalized;
}

function normalizeMode(mode) {
    if (!mode || mode === 'touch_robot') return 'tablet';
    return mode;
}

export class PostgresPedidoRepository extends IRepository {
    constructor(pool = null) {
        super();
        this.pool = pool || new Pool({
            host:     process.env.POSTGRES_HOST || 'localhost',
            port:     parseInt(process.env.POSTGRES_PORT || '5432'),
            user:     process.env.POSTGRES_USER || 'chipi',
            password: process.env.POSTGRES_PASSWORD,
            database: process.env.POSTGRES_DB || 'robot_mesero',
            max: 10,
            idleTimeoutMillis: 30000,
        });
    }

    async create(entity) {
        const tableId = entity.table_id || entity.mesa;
        const items = entity.items || entity.platos || [];
        const status = normalizeStatus(entity.status || entity.estado, { strict: true });
        const mode = normalizeMode(entity.mode || entity.modo);
        const notes = entity.notes ?? entity.notas ?? '';
        const subtotal = entity.subtotal ?? entity.total ?? 0;
        const sql = `
            INSERT INTO pedidos (
                id, mesa, table_id, platos, items, bebida, subtotal, total,
                estado, status, modo, mode, cliente_id, notas, notes, requires_human, timestamp,
                session_id, declared_allergies, dietary_restrictions, allergy_conflicts,
                special_warning, requires_special_confirmation, special_confirmation,
                visit_id, order_sequence, order_kind, created_at, updated_at,
                confirmed_at, delivered_at, cancelled_at, is_test, archived_at,
                archived_by, archive_reason, deleted_at, deletion_reason,
                retention_class, data_origin
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                    $18, $19::jsonb, $20::jsonb, $21::jsonb, $22, $23, $24::jsonb,
                    $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36,
                    $37, $38, $39, $40)
            RETURNING *`;
        const createdAt = entity.created_at || entity.timestamp || new Date().toISOString();
        const isTest = entity.is_test === true;
        const confirmedAt = ['confirmed', 'sent_to_kitchen', 'preparing', 'ready', 'delivery_in_progress', 'delivered'].includes(status)
            ? (entity.confirmed_at || createdAt)
            : (entity.confirmed_at || null);
        const deliveredAt = status === 'delivered' ? (entity.delivered_at || createdAt) : (entity.delivered_at || null);
        const cancelledAt = status === 'cancelled' ? (entity.cancelled_at || createdAt) : (entity.cancelled_at || null);
        const values = [
            entity.id || randomUUID(),
            tableId,
            tableId,
            JSON.stringify(items),
            JSON.stringify(items),
            entity.bebida,
            subtotal,
            entity.total,
            LEGACY_STATUS[status] || status,
            status,
            mode,
            mode,
            entity.clienteId || entity.cliente_id || null,
            notes,
            notes,
            Boolean(entity.requires_human),
            entity.timestamp || new Date().toISOString(),
            entity.session_id || null,
            JSON.stringify(entity.declared_allergies || []),
            JSON.stringify(entity.dietary_restrictions || []),
            JSON.stringify(entity.allergy_conflicts || []),
            entity.special_warning || null,
            Boolean(entity.requires_special_confirmation),
            JSON.stringify(entity.special_confirmation || {}),
            entity.visit_id || null,
            entity.order_sequence || null,
            entity.order_kind || null,
            createdAt,
            entity.updated_at || createdAt,
            confirmedAt,
            deliveredAt,
            cancelledAt,
            isTest,
            entity.archived_at || null,
            entity.archived_by || null,
            entity.archive_reason || null,
            entity.deleted_at || null,
            entity.deletion_reason || null,
            entity.retention_class || (isTest ? 'test' : 'operational'),
            entity.data_origin || (isTest ? 'automated_test' : 'customer_order'),
        ];
        const res = await this.pool.query(sql, values);
        return this._toEntity(res.rows[0]);
    }

    async findById(id) {
        const res = await this.pool.query('SELECT * FROM pedidos WHERE id = $1', [id]);
        return res.rows.length ? this._toEntity(res.rows[0]) : null;
    }

    async findAll(filters = {}, options = {}) {
        let sql = 'SELECT * FROM pedidos WHERE 1=1';
        const values = [];
        let idx = 1;

        if (filters.status) { sql += ` AND status = $${idx++}`; values.push(normalizeStatus(filters.status)); }
        if (filters.estado) { sql += ` AND status = $${idx++}`; values.push(normalizeStatus(filters.estado)); }
        if (filters.mode)   { sql += ` AND mode = $${idx++}`; values.push(normalizeMode(filters.mode)); }
        if (filters.modo)   { sql += ` AND mode = $${idx++}`; values.push(normalizeMode(filters.modo)); }
        if (filters.mesa)   { sql += ` AND table_id = $${idx++}`; values.push(filters.mesa); }
        if (filters.table_id) { sql += ` AND table_id = $${idx++}`; values.push(filters.table_id); }
        if (filters.visit_id) { sql += ` AND visit_id = $${idx++}`; values.push(filters.visit_id); }

        const countRes = await this.pool.query(sql.replace('SELECT *', 'SELECT COUNT(*)'), values);
        const total = parseInt(countRes.rows[0].count);

        if (options.orderBy) sql += ` ORDER BY ${options.orderBy}`;
        if (options.limit)   { sql += ` LIMIT $${idx++}`; values.push(options.limit); }
        if (options.offset)  { sql += ` OFFSET $${idx++}`; values.push(options.offset); }

        const res = await this.pool.query(sql, values);
        return { data: res.rows.map(r => this._toEntity(r)), total };
    }

    async update(id, updates) {
        const normalized = { ...updates };
        if (updates.status || updates.estado) {
            normalized.status = normalizeStatus(updates.status || updates.estado, { strict: true });
            normalized.estado = LEGACY_STATUS[normalized.status] || normalized.status;
        }
        if (updates.mode || updates.modo) {
            normalized.mode = normalizeMode(updates.mode || updates.modo);
            normalized.modo = normalized.mode;
        }
        if (updates.table_id || updates.mesa) {
            normalized.table_id = updates.table_id || updates.mesa;
            normalized.mesa = normalized.table_id;
        }
        if (updates.items || updates.platos) {
            normalized.items = updates.items || updates.platos;
            normalized.platos = normalized.items;
        }
        if (updates.notes !== undefined || updates.notas !== undefined) {
            normalized.notes = updates.notes ?? updates.notas;
            normalized.notas = normalized.notes;
        }
        if (updates.declared_allergies !== undefined) normalized.declared_allergies = updates.declared_allergies;
        if (updates.dietary_restrictions !== undefined) normalized.dietary_restrictions = updates.dietary_restrictions;
        if (updates.allergy_conflicts !== undefined) normalized.allergy_conflicts = updates.allergy_conflicts;
        if (updates.special_confirmation !== undefined) normalized.special_confirmation = updates.special_confirmation;

        const allowed = [
            'mesa', 'table_id', 'platos', 'items', 'bebida', 'subtotal', 'total',
            'estado', 'status', 'modo', 'mode', 'cliente_id', 'notas', 'notes', 'requires_human',
            'session_id', 'declared_allergies', 'dietary_restrictions', 'allergy_conflicts',
            'special_warning', 'requires_special_confirmation', 'special_confirmation',
            'visit_id',
        ];
        const keys = Object.keys(normalized).filter(k => allowed.includes(k));
        if (keys.length === 0) return null;

        const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const jsonKeys = new Set(['platos', 'items', 'declared_allergies', 'dietary_restrictions', 'allergy_conflicts', 'special_confirmation']);
        const values = keys.map(k => jsonKeys.has(k) ? JSON.stringify(normalized[k] ?? (k === 'special_confirmation' ? {} : [])) : normalized[k]);
        values.unshift(id);

        const sql = `UPDATE pedidos SET ${setClause},
                updated_at = NOW(),
                confirmed_at = CASE
                    WHEN status IN ('confirmed', 'sent_to_kitchen', 'preparing', 'ready', 'delivery_in_progress', 'delivered')
                    THEN COALESCE(confirmed_at, NOW()) ELSE confirmed_at END,
                delivered_at = CASE WHEN status = 'delivered' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
                cancelled_at = CASE WHEN status = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END
            WHERE id = $1 RETURNING *`;
        const res = await this.pool.query(sql, values);
        return res.rows.length ? this._toEntity(res.rows[0]) : null;
    }

    async updateIfStatus(id, expectedStatus, updates) {
        const normalized = { ...updates };
        if (updates.status || updates.estado) {
            normalized.status = normalizeStatus(updates.status || updates.estado, { strict: true });
            normalized.estado = LEGACY_STATUS[normalized.status] || normalized.status;
        }
        if (updates.mode || updates.modo) {
            normalized.mode = normalizeMode(updates.mode || updates.modo);
            normalized.modo = normalized.mode;
        }
        if (updates.table_id || updates.mesa) {
            normalized.table_id = updates.table_id || updates.mesa;
            normalized.mesa = normalized.table_id;
        }
        if (updates.items || updates.platos) {
            normalized.items = updates.items || updates.platos;
            normalized.platos = normalized.items;
        }
        if (updates.notes !== undefined || updates.notas !== undefined) {
            normalized.notes = updates.notes ?? updates.notas;
            normalized.notas = normalized.notes;
        }
        if (updates.declared_allergies !== undefined) normalized.declared_allergies = updates.declared_allergies;
        if (updates.dietary_restrictions !== undefined) normalized.dietary_restrictions = updates.dietary_restrictions;
        if (updates.allergy_conflicts !== undefined) normalized.allergy_conflicts = updates.allergy_conflicts;
        if (updates.special_confirmation !== undefined) normalized.special_confirmation = updates.special_confirmation;

        const allowed = [
            'mesa', 'table_id', 'platos', 'items', 'bebida', 'subtotal', 'total',
            'estado', 'status', 'modo', 'mode', 'cliente_id', 'notas', 'notes', 'requires_human',
            'session_id', 'declared_allergies', 'dietary_restrictions', 'allergy_conflicts',
            'special_warning', 'requires_special_confirmation', 'special_confirmation',
            'visit_id',
        ];
        const keys = Object.keys(normalized).filter(k => allowed.includes(k));
        if (keys.length === 0) return null;

        const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const jsonKeys = new Set(['platos', 'items', 'declared_allergies', 'dietary_restrictions', 'allergy_conflicts', 'special_confirmation']);
        const values = keys.map(k => jsonKeys.has(k) ? JSON.stringify(normalized[k] ?? (k === 'special_confirmation' ? {} : [])) : normalized[k]);
        values.unshift(id);
        values.push(normalizeStatus(expectedStatus, { strict: true }));

        const sql = `UPDATE pedidos SET ${setClause},
                updated_at = NOW(),
                confirmed_at = CASE
                    WHEN status IN ('confirmed', 'sent_to_kitchen', 'preparing', 'ready', 'delivery_in_progress', 'delivered')
                    THEN COALESCE(confirmed_at, NOW()) ELSE confirmed_at END,
                delivered_at = CASE WHEN status = 'delivered' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
                cancelled_at = CASE WHEN status = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE cancelled_at END
            WHERE id = $1 AND status = $${values.length} RETURNING *`;
        const res = await this.pool.query(sql, values);
        return res.rows.length ? this._toEntity(res.rows[0]) : null;
    }

    async delete(id) {
        const res = await this.pool.query('DELETE FROM pedidos WHERE id = $1', [id]);
        return res.rowCount > 0;
    }

    async deleteDraft(id) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const current = await client.query('SELECT id, visit_id, status FROM pedidos WHERE id = $1 FOR UPDATE', [id]);
            if (!current.rows[0] || current.rows[0].status !== 'draft') {
                await client.query('ROLLBACK');
                return false;
            }
            const deleted = await client.query(
                "DELETE FROM pedidos WHERE id = $1 AND status = 'draft' RETURNING id, visit_id",
                [id],
            );
            if (deleted.rows[0]?.visit_id) {
                await client.query(
                    `UPDATE restaurant_visits
                        SET order_ids = COALESCE((
                            SELECT jsonb_agg(value)
                              FROM jsonb_array_elements_text(COALESCE(order_ids, '[]'::jsonb)) AS values(value)
                             WHERE value <> $1
                        ), '[]'::jsonb),
                        version = version + 1, updated_at = NOW()
                      WHERE visit_id = $2`,
                    [String(id), deleted.rows[0].visit_id],
                );
            }
            await client.query('COMMIT');
            return deleted.rowCount > 0;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async healthCheck() {
        try {
            await this.pool.query('SELECT 1');
            return true;
        } catch {
            return false;
        }
    }

    // ── Privado ───────────────────────────────────────────────────
    _toEntity(row) {
        return {
            id: row.id,
            mesa: row.table_id || row.mesa,
            table_id: row.table_id || row.mesa,
            platos: this._parseJson(row.items ?? row.platos),
            items: this._parseJson(row.items ?? row.platos),
            bebida: row.bebida,
            subtotal: row.subtotal === null || row.subtotal === undefined ? parseFloat(row.total || 0) : parseFloat(row.subtotal),
            total: parseFloat(row.total || 0),
            estado: row.estado,
            status: normalizeStatus(row.status || row.estado),
            modo: row.mode || row.modo || 'tablet',
            mode: row.mode || row.modo || 'tablet',
            clienteId: row.cliente_id,
            notas: row.notes ?? row.notas,
            notes: row.notes ?? row.notas,
            requires_human: Boolean(row.requires_human),
            timestamp: row.timestamp,
            session_id: row.session_id || null,
            declared_allergies: this._parseJson(row.declared_allergies),
            dietary_restrictions: this._parseJson(row.dietary_restrictions),
            allergy_conflicts: this._parseJson(row.allergy_conflicts),
            special_warning: row.special_warning || '',
            requires_special_confirmation: Boolean(row.requires_special_confirmation),
            special_confirmation: this._parseJson(row.special_confirmation, {}),
            visit_id: row.visit_id || null,
            order_sequence: row.order_sequence === null || row.order_sequence === undefined ? null : Number(row.order_sequence),
            order_kind: row.order_kind || null,
            created_at: row.created_at || row.timestamp || null,
            updated_at: row.updated_at || row.timestamp || null,
            confirmed_at: row.confirmed_at || null,
            delivered_at: row.delivered_at || null,
            cancelled_at: row.cancelled_at || null,
            is_test: Boolean(row.is_test),
            archived_at: row.archived_at || null,
            archived_by: row.archived_by || null,
            archive_reason: row.archive_reason || null,
            deleted_at: row.deleted_at || null,
            deletion_reason: row.deletion_reason || null,
            retention_class: row.retention_class || (row.is_test ? 'test' : 'operational'),
            data_origin: row.data_origin || (row.is_test ? 'automated_test' : 'customer_order'),
        };
    }

    _parseJson(value, fallback = []) {
        if (typeof value !== 'string') return value ?? fallback;
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }
}
