/**
 * Repositorio PostgreSQL: menu_items
 * Implementa IRepository<MenuItem>
 *
 * Tabla: menu_items
 *   id          uuid PK
 *   nombre      varchar(100) NOT NULL
 *   descripcion text
 *   precio      numeric(10,2) NOT NULL
 *   categoria   varchar(50) NOT NULL
 *   disponible  boolean DEFAULT true
 *   imagen_url  text
 *
 * Categorias validas (CHECK en BD): platos, bebidas, postres
 */

import pg from 'pg';
import { IRepository } from '../ports/IRepository.mjs';

const { Pool } = pg;

const CATEGORIAS_VALIDAS = ['platos', 'bebidas', 'postres'];
const PLURAL_A_SINGULAR = { platos: 'plato', bebidas: 'bebida', postres: 'postre' };

export class PostgresMenuRepository extends IRepository {
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
        if (!entity.nombre) throw new Error('MenuItem: nombre obligatorio');
        if (entity.precio === undefined || entity.precio === null) throw new Error('MenuItem: precio obligatorio');
        if (!entity.categoria) throw new Error('MenuItem: categoria obligatoria');
        const catSingular = entity.categoria;
        const catPlural = PLURAL_A_SINGULAR[entity.categoria] ? entity.categoria : null;
        // Acepta singular o plural como input; guarda en plural (formato BD).
        const catBD = catPlural || (Object.keys(PLURAL_A_SINGULAR).find(k => PLURAL_A_SINGULAR[k] === entity.categoria));
        if (!catBD) {
            throw new Error(`MenuItem: categoria invalida (${[...CATEGORIAS_VALIDAS, ...Object.values(PLURAL_A_SINGULAR)].join(', ')})`);
        }

        const sql = `
            INSERT INTO menu_items (
                nombre, descripcion, precio, categoria, disponible, imagen_url,
                ingredientes, alergenos, restricciones, permite_modificadores,
                modificadores_disponibles, informacion_completa, advertencia_contaminacion
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13)
            RETURNING *`;
        const values = [
            entity.nombre,
            entity.descripcion || null,
            entity.precio,
            catBD,
            entity.disponible !== false,
            entity.imagen_url || null,
            JSON.stringify(Array.isArray(entity.ingredientes) ? entity.ingredientes : []),
            JSON.stringify(Array.isArray(entity.alergenos) ? entity.alergenos : []),
            JSON.stringify(entity.restricciones && typeof entity.restricciones === 'object' ? entity.restricciones : {}),
            entity.permite_modificadores !== false,
            JSON.stringify(Array.isArray(entity.modificadores_disponibles) ? entity.modificadores_disponibles : []),
            entity.informacion_completa === true,
            entity.advertencia_contaminacion || null,
        ];
        const res = await this.pool.query(sql, values);
        return this._toEntity(res.rows[0]);
    }

    async findById(id) {
        const res = await this.pool.query('SELECT * FROM menu_items WHERE id = $1', [id]);
        return res.rows.length ? this._toEntity(res.rows[0]) : null;
    }

    async findAll(filters = {}, options = {}) {
        let sql = 'SELECT * FROM menu_items WHERE 1=1';
        const values = [];
        let idx = 1;

        if (filters.categoria) {
            // Acepta singular o plural en el filtro (misma lógica que create).
            const catPlural = PLURAL_A_SINGULAR[filters.categoria] ? filters.categoria : null;
            const catBD = catPlural || Object.keys(PLURAL_A_SINGULAR).find(k => PLURAL_A_SINGULAR[k] === filters.categoria);
            sql += ` AND categoria = $${idx++}`;
            values.push(catBD || filters.categoria);
        }
        if (filters.disponible !== undefined) { sql += ` AND disponible = $${idx++}`; values.push(filters.disponible); }

        const countRes = await this.pool.query(sql.replace('SELECT *', 'SELECT COUNT(*)'), values);
        const total = parseInt(countRes.rows[0].count);

        if (options.orderBy) sql += ` ORDER BY ${options.orderBy}`;
        else sql += ' ORDER BY categoria, nombre';
        if (options.limit)  { sql += ` LIMIT $${idx++}`; values.push(options.limit); }
        if (options.offset) { sql += ` OFFSET $${idx++}`; values.push(options.offset); }

        const res = await this.pool.query(sql, values);
        return { data: res.rows.map(r => this._toEntity(r)), total };
    }

    async update(id, updates) {
        const allowed = [
            'nombre', 'descripcion', 'precio', 'categoria', 'disponible', 'imagen_url',
            'ingredientes', 'alergenos', 'restricciones', 'permite_modificadores',
            'modificadores_disponibles', 'informacion_completa', 'advertencia_contaminacion',
            'destacado', 'recomendable', 'orden_aparicion', 'etiqueta_promocional',
        ];
        const keys = Object.keys(updates).filter(k => allowed.includes(k));
        if (keys.length === 0) return null;

        if (updates.categoria) {
            const catPlural = PLURAL_A_SINGULAR[updates.categoria] || updates.categoria;
            if (!CATEGORIAS_VALIDAS.includes(catPlural)) {
                throw new Error(`MenuItem: categoria invalida (${[...CATEGORIAS_VALIDAS, ...Object.values(PLURAL_A_SINGULAR)].join(', ')})`);
            }
            updates = { ...updates, categoria: catPlural };
        }

        const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const jsonKeys = new Set(['ingredientes', 'alergenos', 'restricciones', 'modificadores_disponibles']);
        const values = keys.map(k => jsonKeys.has(k) ? JSON.stringify(updates[k] ?? (k === 'restricciones' ? {} : [])) : updates[k]);
        values.unshift(id);

        const sql = `UPDATE menu_items SET ${setClause} WHERE id = $1 RETURNING *`;
        const res = await this.pool.query(sql, values);
        return res.rows.length ? this._toEntity(res.rows[0]) : null;
    }

    async delete(id) {
        const res = await this.pool.query('DELETE FROM menu_items WHERE id = $1', [id]);
        return res.rowCount > 0;
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
            nombre: row.nombre,
            descripcion: row.descripcion,
            precio: typeof row.precio === 'string' ? parseFloat(row.precio) : row.precio,
            categoria: PLURAL_A_SINGULAR[row.categoria] || row.categoria,
            disponible: row.disponible,
            imagen_url: row.imagen_url,
            ingredientes: this._parseJson(row.ingredientes, []),
            alergenos: this._parseJson(row.alergenos, []),
            restricciones: this._parseJson(row.restricciones, {}),
            permite_modificadores: row.permite_modificadores !== false,
            modificadores_disponibles: this._parseJson(row.modificadores_disponibles, []),
            informacion_completa: row.informacion_completa === true,
            advertencia_contaminacion: row.advertencia_contaminacion || '',
            destacado: row.destacado === true,
            recomendable: row.recomendable !== false,
            orden_aparicion: Number.isFinite(Number(row.orden_aparicion)) ? Number(row.orden_aparicion) : 100,
            etiqueta_promocional: row.etiqueta_promocional || null,
        };
    }

    _parseJson(value, fallback = []) {
        if (typeof value !== 'string') return value ?? fallback;
        try { return JSON.parse(value); } catch { return fallback; }
    }
}
