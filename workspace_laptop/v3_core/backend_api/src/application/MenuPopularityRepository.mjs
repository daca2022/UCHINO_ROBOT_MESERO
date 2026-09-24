/**
 * Popularidad real desde PostgreSQL.
 *
 * Cuenta pedidos con estado de venta válido (excluye draft y cancelled)
 * y agrega por producto (platos JSONB) en el período solicitado.
 * Período válido: '24h' | '7d' | '30d' (default) | '90d' | 'all'.
 * Devuelve `[{ product_id, sales_count }]` ordenado descendente.
 */

const PERIOD_DAYS = {
    '24h': 1,
    '7d': 7,
    '30d': 30,
    '90d': 90,
    all: null,
};

const ESTADOS_VENTA_VALIDOS = new Set([
    'confirmed', 'sent_to_kitchen', 'preparing', 'ready', 'delivered',
    'entregado', 'preparando', 'listo', 'enviado_a_cocina', 'confirmado',
]);

const ESTADOS_EXCLUIDOS = new Set(['draft', 'cancelled', 'provisional', 'anulado']);

function fromEpoch(period) {
    if (!period) return null;
    const days = PERIOD_DAYS[period];
    if (days === undefined) {
        // Default conservador: 30 días.
        const ms = 30 * 24 * 60 * 60 * 1000;
        return Date.now() - ms;
    }
    if (days === null) return null;
    return Date.now() - days * 24 * 60 * 60 * 1000;
}

/**
 * Cuenta menciones de un product_id dentro de un JSONB `platos` o `items`.
 * `platos` y `items` son arreglos de objetos con `product_id` o `id`,
 * y un campo `cantidad` (1 por defecto).
 */
function sumQuantities(pedido, productId) {
    const sources = [];
    if (Array.isArray(pedido?.platos)) sources.push(pedido.platos);
    if (Array.isArray(pedido?.items)) sources.push(pedido.items);
    let total = 0;
    for (const arr of sources) {
        for (const entry of arr) {
            if (!entry) continue;
            const id = entry.product_id || entry.id;
            if (id !== productId) continue;
            const qty = Number(entry.cantidad ?? 1) || 1;
            total += qty;
        }
    }
    return total;
}

/**
 * @param {object} pool - pg.Pool
 * @param {string} period - uno de los valores en PERIOD_DAYS
 * @returns {Promise<Array<{product_id:string, sales_count:number}>>}
 */
export async function fetchSalesByProduct(pool, period = '30d') {
    if (!pool || typeof pool.query !== 'function') return [];
    const since = fromEpoch(period);
    const params = [];
    let whereEstado = '';
    if (since !== null) {
        whereEstado = 'AND timestamp >= $1';
        params.push(new Date(since).toISOString());
    }
    const sql = `
        SELECT id, platos, items, status, estado
        FROM pedidos
        WHERE 1=1
        ${since !== null ? 'AND timestamp >= $1' : ''}
    `;
    const result = await pool.query(sql, params);
    const counts = new Map();
    for (const row of result.rows || []) {
        const status = String(row.status || row.estado || '').toLowerCase();
        if (ESTADOS_EXCLUIDOS.has(status)) continue;
        if (ESTADOS_VENTA_VALIDOS.size > 0 && !ESTADOS_VENTA_VALIDOS.has(status)) continue;
        // Recorre los items únicos de la fila.
        const sources = [];
        if (Array.isArray(row.platos)) sources.push(row.platos);
        if (Array.isArray(row.items)) sources.push(row.items);
        const seenInRow = new Set();
        for (const arr of sources) {
            for (const entry of arr) {
                if (!entry) continue;
                const id = entry.product_id || entry.id;
                if (!id || seenInRow.has(id)) continue;
                seenInRow.add(id);
                const qty = Number(entry.cantidad ?? 1) || 1;
                counts.set(String(id), (counts.get(String(id)) || 0) + qty);
            }
        }
    }
    return Array.from(counts.entries())
        .map(([product_id, sales_count]) => ({ product_id, sales_count }))
        .sort((a, b) => b.sales_count - a.sales_count);
}

export { PERIOD_DAYS, ESTADOS_VENTA_VALIDOS, ESTADOS_EXCLUIDOS };
