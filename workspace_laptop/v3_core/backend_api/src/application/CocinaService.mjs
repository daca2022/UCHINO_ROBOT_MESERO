/**
 * Servicio Cocina (KDS) — Kitchen Display System
 * Gestiona el flujo de pedidos hacia cocina: recibir, preparar, listo, entregar.
 * Reemplaza tab_cocina de Node-RED.
 */

export class CocinaService {
    constructor({ pedidoRepo, notificador, logger = console }) {
        this.pedidoRepo = pedidoRepo;
        this.notificador = notificador; // WebSocket/MQTT para pantalla cocina
        this.logger = logger;
        this.estadosValidos = ['sent_to_kitchen', 'preparing', 'ready', 'delivered'];
    }

    /**
     * Recibe un pedido enviado a cocina y lo pone en preparación.
     */
    async recibirPedido(pedidoId) {
        const pedido = await this.pedidoRepo.findById(pedidoId);
        if (!pedido) throw new Error(`Pedido no encontrado: ${pedidoId}`);
        if ((pedido.status || pedido.estado) !== 'sent_to_kitchen') {
            throw new Error(`Pedido ${pedidoId} no fue enviado a cocina (status: ${pedido.status || pedido.estado})`);
        }

        const actualizado = await this.pedidoRepo.update(pedidoId, { status: 'preparing' });
        this.notificador?.emit('cocina:pedido_nuevo', actualizado);
        this.logger.log('[CocinaService] Pedido en preparación:', pedidoId);
        return actualizado;
    }

    /**
     * Marca un pedido como listo para recoger.
     */
    async marcarListo(pedidoId) {
        const pedido = await this.pedidoRepo.findById(pedidoId);
        if (!pedido) throw new Error(`Pedido no encontrado: ${pedidoId}`);
        if ((pedido.status || pedido.estado) !== 'preparing') {
            throw new Error(`Pedido ${pedidoId} no está en preparación`);
        }

        const actualizado = await this.pedidoRepo.update(pedidoId, { status: 'ready' });
        this.notificador?.emit('cocina:pedido_listo', actualizado);
        this.logger.log('[CocinaService] Pedido listo:', pedidoId);
        return actualizado;
    }

    /**
     * Marca un pedido como entregado al robot.
     */
    async entregar(pedidoId) {
        const pedido = await this.pedidoRepo.findById(pedidoId);
        if (!pedido) throw new Error(`Pedido no encontrado: ${pedidoId}`);
        if ((pedido.status || pedido.estado) !== 'ready') {
            throw new Error(`Pedido ${pedidoId} no está listo para entregar`);
        }

        const actualizado = await this.pedidoRepo.update(pedidoId, { status: 'delivered' });
        this.notificador?.emit('cocina:pedido_entregado', actualizado);
        this.logger.log('[CocinaService] Pedido entregado:', pedidoId);
        return actualizado;
    }

    /**
     * Obtiene la cola actual de cocina (pedidos en_preparacion + listos).
     */
    async obtenerCola() {
        const { data } = await this.pedidoRepo.findAll(
            { status: 'preparing' },
            { orderBy: 'timestamp ASC' }
        );
        const { data: listos } = await this.pedidoRepo.findAll(
            { status: 'ready' },
            { orderBy: 'timestamp ASC' }
        );
        const { data: enviados } = await this.pedidoRepo.findAll(
            { status: 'sent_to_kitchen' },
            { orderBy: 'timestamp ASC' }
        );
        return { enviados, en_preparacion: data, listos };
    }

    /**
     * Estadísticas de cocina (tiempos promedio, etc).
     */
    async obtenerEstadisticas() {
        // TODO: calcular tiempos reales con timestamps
        const { data: hoy } = await this.pedidoRepo.findAll({}, {
            limit: 100,
            orderBy: 'timestamp DESC',
        });
        const total = hoy.length;
        const entregados = hoy.filter(p => (p.status || p.estado) === 'delivered').length;
        const en_cola = hoy.filter(p => ['sent_to_kitchen', 'preparing'].includes(p.status || p.estado)).length;

        return { total, entregados, en_cola, eficiencia: total > 0 ? entregados / total : 0 };
    }
}
