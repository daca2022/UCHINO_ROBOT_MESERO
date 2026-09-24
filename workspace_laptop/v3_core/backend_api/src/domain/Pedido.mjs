/**
 * Entidad de dominio: Pedido
 * Pura, sin dependencias externas. Valida su propio estado.
 */
const STATUS_ALIASES = {
    provisional: 'draft',
    confirmado: 'confirmed',
    en_preparacion: 'preparing',
    listo: 'ready',
    entregado: 'delivered',
    cancelado: 'cancelled',
};

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

const VALID_STATUS = new Set([
    'draft',
    'pending_confirmation',
    'confirmed',
    'sent_to_kitchen',
    'preparing',
    'ready',
    'delivered',
    'cancelled',
]);

const VALID_MODES = new Set(['voice', 'tablet', 'admin']);

function normalizeStatus(status) {
    const canonical = STATUS_ALIASES[status] || status || 'draft';
    if (!VALID_STATUS.has(canonical)) {
        throw new Error(`Pedido: status invalido (${canonical})`);
    }
    return canonical;
}

function normalizeMode(mode) {
    const canonical = mode === 'touch_robot' || mode === undefined || mode === null ? 'tablet' : mode;
    if (!VALID_MODES.has(canonical)) {
        throw new Error(`Pedido: mode invalido (${canonical})`);
    }
    return canonical;
}

export class Pedido {
    constructor({
        id = crypto.randomUUID(),
        mesa,
        table_id,
        platos = [],
        items,
        bebida = null,
        subtotal = null,
        total = 0,
        estado,
        status,
        modo,
        mode,
        clienteId = null,
        cliente_id = null,
        notas = '',
        notes,
        requires_human = false,
        timestamp = new Date().toISOString(),
    }) {
        const resolvedTable = table_id || mesa;
        const resolvedItems = items || platos;
        if (!resolvedTable) throw new Error('Pedido: mesa es obligatoria');
        if (!Array.isArray(resolvedItems)) throw new Error('Pedido: platos debe ser array');

        this.id = id;
        this.mesa = resolvedTable;
        this.table_id = resolvedTable;
        this.platos = resolvedItems;
        this.items = resolvedItems;
        this.bebida = bebida;
        this.subtotal = subtotal === null ? total : subtotal;
        this.total = total;
        this.status = normalizeStatus(status || estado);
        this.estado = LEGACY_STATUS[this.status];
        this.mode = normalizeMode(mode || modo);
        this.modo = this.mode;
        this.clienteId = clienteId || cliente_id;
        this.notas = notes ?? notas;
        this.notes = notes ?? notas;
        this.requires_human = Boolean(requires_human);
        this.timestamp = timestamp;
    }

    confirmar() {
        if (!['draft', 'pending_confirmation'].includes(this.status)) {
            throw new Error(`No se puede confirmar un pedido en estado: ${this.status}`);
        }
        this.status = 'confirmed';
        this.estado = LEGACY_STATUS[this.status];
        return this;
    }

    enviarACocina() {
        if (this.status !== 'confirmed') {
            throw new Error(`No se puede enviar a cocina un pedido en estado: ${this.status}`);
        }
        this.status = 'sent_to_kitchen';
        this.estado = LEGACY_STATUS[this.status];
        return this;
    }

    cancelar() {
        if (['delivered', 'cancelled'].includes(this.status)) {
            throw new Error(`No se puede cancelar un pedido ya ${this.status}`);
        }
        this.status = 'cancelled';
        this.estado = LEGACY_STATUS[this.status];
        return this;
    }

    calcularTotal(menuItems) {
        let total = 0;
        for (const plato of this.items) {
            const item = menuItems.find(m => m.nombre === plato.nombre);
            total += (item?.precio || 0) * (plato.cantidad || 1);
        }
        this.subtotal = total;
        this.total = total;
        return this;
    }

    toJSON() {
        return {
            id: this.id,
            mesa: this.mesa,
            table_id: this.table_id,
            platos: this.platos,
            items: this.items,
            bebida: this.bebida,
            subtotal: this.subtotal,
            total: this.total,
            estado: this.estado,
            status: this.status,
            modo: this.modo,
            mode: this.mode,
            clienteId: this.clienteId,
            notas: this.notas,
            notes: this.notes,
            requires_human: this.requires_human,
            timestamp: this.timestamp,
        };
    }
}
