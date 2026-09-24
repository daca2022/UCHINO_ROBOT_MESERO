/**
 * Servicio de Memoria — Consolida operaciones de PostgreSQL + Redis + ChromaDB
 * Reemplaza la lógica de tab_memoria en Node-RED (proxy HTTP redundante).
 */

export class MemoryService {
    constructor({ pedidoRepo, clienteRepo, menuRepo, vectorStore, cache, logger = console }) {
        this.pedidoRepo = pedidoRepo;
        this.clienteRepo = clienteRepo;
        this.menuRepo = menuRepo;
        this.vectorStore = vectorStore;
        this.cache = cache;
        this.logger = logger;
    }

    // ── Menú ──────────────────────────────────────────────────────
    async obtenerMenu() {
        const cacheKey = 'menu:del_dia';
        const cached = await this.cache?.get(cacheKey);
        if (cached) return JSON.parse(cached);

        const result = await this.menuRepo.findAll();
        const menu = Array.isArray(result) ? result : result.data;
        await this.cache?.set(cacheKey, JSON.stringify(menu), { EX: 300 }); // 5 min TTL
        return menu;
    }

    // ── Pedidos ───────────────────────────────────────────────────
    async crearPedido(datos) {
        const pedido = await this.pedidoRepo.create(datos);
        await this.cache?.del('pedidos:activos');
        this.logger.log('[MemoryService] Pedido creado:', pedido.id);
        return pedido;
    }

    async obtenerPedido(id) {
        return this.pedidoRepo.findById(id);
    }

    async listarPedidosActivos() {
        const cacheKey = 'pedidos:activos';
        const cached = await this.cache?.get(cacheKey);
        if (cached) return JSON.parse(cached);

        const { data } = await this.pedidoRepo.findAll(
            { status: 'sent_to_kitchen' },
            { orderBy: 'timestamp DESC' }
        );
        await this.cache?.set(cacheKey, JSON.stringify(data), { EX: 60 });
        return data;
    }

    async actualizarEstadoPedido(id, status) {
        const pedido = await this.pedidoRepo.update(id, { status });
        await this.cache?.del('pedidos:activos');
        this.logger.log('[MemoryService] Pedido actualizado:', id, '→', estado);
        return pedido;
    }

    // ── Clientes y Memoria Semántica ──────────────────────────────
    async recordarCliente(clienteId, texto) {
        await this.vectorStore.add('clientes', clienteId, texto, {
            clienteId,
            timestamp: new Date().toISOString(),
        });
    }

    async recordarPreferencias(clienteId) {
        const recuerdos = await this.vectorStore.search(
            'clientes',
            `Preferencias del cliente ${clienteId}`,
            5
        );
        return recuerdos.map(r => r.text);
    }

    // ── Telemetría ────────────────────────────────────────────────
    async guardarTelemetria(datos) {
        // Insertar en PostgreSQL para series temporales
        // TODO: implementar cuando se defina schema de telemetria
        this.logger.log('[MemoryService] Telemetría guardada:', datos.estado);
    }

    // ── Health Check ──────────────────────────────────────────────
    async healthCheck() {
        const checks = await Promise.all([
            this.pedidoRepo.healthCheck(),
            this.cache?.ping?.().then(() => true).catch(() => false),
            this.vectorStore?.healthCheck().catch(() => false),
        ]);
        return {
            postgresql: checks[0],
            redis: checks[1] ?? false,
            chromadb: checks[2] ?? false,
            overall: checks.every(Boolean),
        };
    }
}
