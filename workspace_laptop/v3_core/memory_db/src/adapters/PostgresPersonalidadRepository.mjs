/**
 * Repositorio PostgreSQL: personalidad (singleton)
 *
 * Tabla: personalidad (id siempre = 1)
 *   tono            cordial|serio|entusiasta|calido
 *   humor           bajo|medio|alto
 *   formalidad      usted|mixto|tu
 *   proactividad    baja|media|alta
 *   longitud        corta|media|larga
 *   reglas_contexto JSONB (reglas por contexto HRI)
 *
 * No extiende IRepository porque no es una coleccion: es un singleton.
 * Expone get() y update() solamente.
 */

import pg from 'pg';
import { normalizeContextRules } from '../../../shared/hriContextRules.mjs';

const { Pool } = pg;

const CAMPOS_VALIDOS = ['tono', 'humor', 'formalidad', 'proactividad', 'longitud'];

export class PostgresPersonalidadRepository {
    constructor(pool = null) {
        this.pool = pool || new Pool({
            host:     process.env.POSTGRES_HOST || 'localhost',
            port:     parseInt(process.env.POSTGRES_PORT || '5432'),
            user:     process.env.POSTGRES_USER || 'chipi',
            password: process.env.POSTGRES_PASSWORD,
            database: process.env.POSTGRES_DB || 'robot_mesero',
            max: 5,
            idleTimeoutMillis: 30000,
        });
    }

    async get() {
        const res = await this.pool.query('SELECT * FROM personalidad WHERE id = 1');
        if (res.rows.length === 0) {
            // Auto-recuperacion: si la fila singleton no existe, la crea.
            await this.pool.query('INSERT INTO personalidad (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
            const retry = await this.pool.query('SELECT * FROM personalidad WHERE id = 1');
            return this._toEntity(retry.rows[0]);
        }
        return this._toEntity(res.rows[0]);
    }

    async update(updates) {
        const allowed = [...CAMPOS_VALIDOS, 'reglas_contexto'];
        const keys = Object.keys(updates).filter(k => allowed.includes(k));
        if (keys.length === 0) return this.get();

        const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
        const values = keys.map(k => (
            k === 'reglas_contexto'
                ? JSON.stringify(normalizeContextRules(updates[k]))
                : updates[k]
        ));

        const sql = `UPDATE personalidad SET ${setClause}, updated_at = NOW() WHERE id = 1 RETURNING *`;
        const res = await this.pool.query(sql, values);
        return res.rows.length ? this._toEntity(res.rows[0]) : null;
    }

    async healthCheck() {
        try {
            await this.pool.query('SELECT 1 FROM personalidad WHERE id = 1');
            return true;
        } catch {
            return false;
        }
    }

    _toEntity(row) {
        return {
            tono: row.tono,
            humor: row.humor,
            formalidad: row.formalidad,
            proactividad: row.proactividad,
            longitud: row.longitud,
            reglas_contexto: normalizeContextRules(
                typeof row.reglas_contexto === 'string'
                    ? JSON.parse(row.reglas_contexto)
                    : row.reglas_contexto
            ),
            updated_at: row.updated_at,
        };
    }
}
