/**
 * Admin Router — endpoints de autenticación y dashboard para el panel admin.
 *
 * Uso en index.mjs:
 *   import { createAdminRouter } from './routes/admin.mjs';
 *   app.use('/api/admin', createAdminRouter());
 *
 * La ruta POST /api/admin/login es pública.
 * Todas las demás rutas bajo /api/admin requieren JWT válido (middleware adminAuth).
 *
 * @module routes/admin
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { exec } from 'child_process';
import fs from 'fs';
import { adminAuth } from '../middleware/adminAuth.mjs';
import { getServices } from '../config/services.mjs';
import { ADMIN_PASS, ADMIN_USER, JWT_SECRET, isAdminAuthConfigured } from '../config/adminSecurity.mjs';

/**
 * Crea y retorna el router Express para rutas de admin.
 *
 * @returns {import('express').Router}
 */
export function createAdminRouter(orderSessionManager = null, tableService = null) {
    const router = Router();

    // ── Login (público, sin autenticación) ──────────────────
    router.post('/login', async (req, res) => {
        try {
            if (!isAdminAuthConfigured()) {
                return res.status(503).json({
                    error: 'Admin no configurado. Defina ADMIN_PASSWORD o GF_SECURITY_ADMIN_PASSWORD en .env',
                });
            }

            const { user, pass } = req.body;

            if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
                return res.status(401).json({ error: 'Credenciales invalidas' });
            }

            const token = jwt.sign(
                { user: ADMIN_USER, role: 'admin' },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            res.json({ token, user: ADMIN_USER });
        } catch (err) {
            res.status(500).json({ error: 'Error interno al generar el token' });
        }
    });

    // ── Auth check (verifica que el token siga siendo válido) ─
    router.get('/check', adminAuth, async (req, res) => {
        res.json({ user: req.adminUser.user });
    });

    // ── Dashboard data (protegido) ──────────────────────────
    router.get('/dashboard', adminAuth, async (req, res) => {
        try {
            // Placeholder: retorna datos básicos del dashboard
            res.json({
                user: req.adminUser.user,
                timestamp: new Date().toISOString(),
                // Datos del dashboard serán expandidos en el futuro
                metrics: {
                    pedidos_activos: 0,
                    pedidos_completados: 0,
                },
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/seguridad/pedidos', adminAuth, async (req, res) => {
        try {
            const { memoryService, fase5SafetyService } = getServices();
            const data = fase5SafetyService
                ? await fase5SafetyService.listSafetyOrders(memoryService.pedidoRepo, { limit: req.query.limit })
                : [];
            res.json({ data, total: data.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/seguridad/eventos', adminAuth, async (req, res) => {
        try {
            const { fase5SafetyService } = getServices();
            const data = fase5SafetyService
                ? await fase5SafetyService.listEvents({ orderId: req.query.order_id, sessionId: req.query.session_id, limit: req.query.limit })
                : [];
            res.json({ data, total: data.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Solicitudes de asistencia humana ─────────────────────
    // Independiente de los estados de preparación de Cocina y sin crear pedidos.
    router.get('/waiter-requests', adminAuth, async (req, res) => {
        try {
            const { waiterAssistanceService } = getServices();
            if (!waiterAssistanceService) return res.status(503).json({ error: 'Servicio de asistencia no disponible' });
            const requestedStatus = ['pending', 'attended', 'all'].includes(req.query.status) ? req.query.status : 'all';
            const requests = await waiterAssistanceService.list({ status: requestedStatus });
            return res.json({ data: requests, count: requests.length, status: requestedStatus });
        } catch (error) {
            return res.status(503).json({ error: `No se pudieron cargar las solicitudes: ${error.message}` });
        }
    });

    router.post('/waiter-requests/:id/attend', adminAuth, async (req, res) => {
        try {
            const { waiterAssistanceService } = getServices();
            if (!waiterAssistanceService) return res.status(503).json({ error: 'Servicio de asistencia no disponible' });
            const request = await waiterAssistanceService.attend(req.params.id);
            return res.json({ request, updated: true });
        } catch (error) {
            if (error.code === 'NOT_FOUND') return res.status(404).json({ error: error.message });
            return res.status(503).json({ error: `No se pudo cerrar la solicitud: ${error.message}` });
        }
    });

    router.get('/tables', adminAuth, async (req, res) => {
        try {
            if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
            const data = await tableService.listTables({ status: req.query.status || null });
            res.json({ data, count: data.length, config: await tableService.getConfig() });
        } catch (error) {
            res.status(error.code === 'INVALID_TABLE' ? 400 : 500).json({ error: error.message, code: error.code || 'TABLES_ERROR' });
        }
    });

    router.get('/tables/:tableId/history', adminAuth, async (req, res) => {
        try {
            if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
            const page = await tableService.historyPage(req.params.tableId, req.query);
            res.json(page);
        } catch (error) {
            res.status(error.code === 'INVALID_TABLE' ? 400 : 500).json({ error: error.message, code: error.code || 'HISTORY_ERROR' });
        }
    });

    router.post('/tables/:tableId/visits/start', adminAuth, async (req, res) => {
        try {
            if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
            const result = await tableService.startVisit({
                tableId: req.params.tableId,
                robotId: req.body?.robot_id || 'uchino-01',
                source: req.body?.source === 'robot_arrival' ? 'robot_arrival' : 'admin',
                guestCount: req.body?.guest_count,
            });
            res.status(201).json(result);
        } catch (error) {
            res.status(['TABLE_OCCUPIED', 'TABLE_DISABLED', 'ROBOT_BUSY'].includes(error.code) ? 409 : 400).json({ error: error.message, code: error.code || 'VISIT_START_ERROR', visit_id: error.visit_id || null });
        }
    });

    router.post('/tables/:tableId/visits/additional', adminAuth, async (req, res) => {
        try {
            if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
            const result = await tableService.startAdditionalOrder({
                tableId: req.params.tableId,
                robotId: req.body?.robot_id || 'uchino-01',
                source: 'admin',
                guestCount: req.body?.guest_count,
            });
            res.status(201).json(result);
        } catch (error) {
            res.status(['NO_ACTIVE_VISIT', 'TABLE_DISABLED', 'ROBOT_BUSY', 'ADDITIONAL_ORDERS_DISABLED'].includes(error.code) ? 409 : 400).json({ error: error.message, code: error.code || 'ADDITIONAL_ORDER_ERROR' });
        }
    });

    router.post('/tables/:tableId/visits/:visitId/continue', adminAuth, async (req, res) => {
        try {
            if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
            const result = await tableService.continueVisit({
                tableId: req.params.tableId,
                visitId: req.params.visitId,
                robotId: req.body?.robot_id || 'uchino-01',
                source: 'admin',
            });
            res.json(result);
        } catch (error) {
            res.status(['VISIT_NOT_FOUND', 'ROBOT_BUSY'].includes(error.code) ? 409 : 400).json({ error: error.message, code: error.code || 'CONTINUE_VISIT_ERROR' });
        }
    });

    router.post('/tables/:tableId/visits/:visitId/close', adminAuth, async (req, res) => {
        try {
            if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
            const result = await tableService.closeVisit({
                tableId: req.params.tableId,
                visitId: req.params.visitId,
                source: 'admin',
                reason: req.body?.reason || 'admin_closed',
                force: false,
            });
            if (result.blocked) return res.status(409).json({ ...result, code: 'TABLE_CLOSE_BLOCKED' });
            res.json(result);
        } catch (error) {
            res.status(error.code === 'VISIT_NOT_FOUND' ? 404 : ['TABLE_CONFLICT', 'TABLE_ACTIVE'].includes(error.code) ? 409 : 400).json({ error: error.message, code: error.code || 'CLOSE_ERROR' });
        }
    });

    router.post('/tables/:tableId/visits/:visitId/force-close', adminAuth, async (req, res) => {
        try {
            if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
            const result = await tableService.closeVisit({
                tableId: req.params.tableId,
                visitId: req.params.visitId,
                source: 'admin',
                reason: req.body?.reason,
                force: true,
                confirmation: req.body?.confirmation === true,
            });
            res.json(result);
        } catch (error) {
            res.status(['FORCE_CONFIRMATION_REQUIRED', 'FORCE_REASON_REQUIRED'].includes(error.code) ? 400 : 409).json({ error: error.message, code: error.code || 'FORCE_CLOSE_ERROR' });
        }
    });

    router.patch('/tables/:tableId', adminAuth, async (req, res) => {
        try {
            if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
            let table = await tableService.getTable(req.params.tableId);
            if (!table) return res.status(404).json({ error: 'Mesa no encontrada', code: 'TABLE_NOT_FOUND' });
            if (req.body?.enabled !== undefined) table = await tableService.setTableEnabled(req.params.tableId, req.body.enabled, { source: 'admin' });
            if (req.body?.display_name) table = await tableService.setTableDisplayName(req.params.tableId, req.body.display_name, { source: 'admin' });
            res.json(table);
        } catch (error) {
            res.status(['INVALID_TABLE', 'TABLE_ACTIVE', 'INVALID_ENABLED'].includes(error.code) ? 400 : 409).json({ error: error.message, code: error.code || 'TABLE_UPDATE_ERROR' });
        }
    });

    router.patch('/tables/:tableId/visits/:visitId/guest-count', adminAuth, async (req, res) => {
        try {
            if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
            res.json(await tableService.setGuestCount(req.params.tableId, req.params.visitId, req.body?.guest_count));
        } catch (error) {
            res.status(error.code === 'VISIT_NOT_FOUND' ? 404 : 400).json({ error: error.message, code: error.code || 'GUEST_COUNT_ERROR' });
        }
    });

    router.get('/tables/config', adminAuth, async (_req, res) => {
        if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
        res.json(await tableService.getConfig());
    });

    router.patch('/tables/config/auto-release', adminAuth, async (req, res) => {
        try {
            if (!tableService) return res.status(503).json({ error: 'Servicio de mesas no disponible' });
            res.json(await tableService.setAutoReleaseAfterDelivery(req.body?.enabled === true, { source: 'admin' }));
        } catch (error) {
            res.status(400).json({ error: error.message, code: error.code || 'CONFIG_ERROR' });
        }
    });

    // ── T3: Health check de servicios del robot ─────────────
    router.get('/status', adminAuth, async (req, res) => {
        const status = { docker: false, backend: true, orchestrator: false, pipeline: false, stt: false };

        // Docker
        try {
            await new Promise((resolve) => {
                exec('docker ps', { timeout: 5000 }, (err, stdout) => {
                    status.docker = !err && stdout.includes('CONTAINER ID');
                    resolve();
                });
            });
        } catch { /* docker not available */ }

        // HTTP checks en paralelo
        const [orchOk, pipelineOk, sttOk] = await Promise.all([
            fetch('http://localhost:8100/health', { signal: AbortSignal.timeout(3000) })
                .then(r => r.ok).catch(() => false),
            fetch('http://localhost:8001', { signal: AbortSignal.timeout(3000) })
                .then(r => true).catch(() => false),
            fetch('http://localhost:8002', { signal: AbortSignal.timeout(3000) })
                .then(r => true).catch(() => false),
        ]);

        status.orchestrator = orchOk;
        status.pipeline = pipelineOk;
        status.stt = sttOk;

        res.json(status);
    });

    // ── T4: Estado de las 7 memorias ─────────────────────────
    router.get('/memories', adminAuth, async (req, res) => {
        const memories = {};

        // Try to get live service connections (may fail if services not init'd)
        let svc = null;
        try { svc = getServices(); } catch { /* services not available */ }

        // 1. SQLite
        {
            const sqlitePath = process.env.SQLITE_PATH || '/home/david/chipi_workspace_pln/v3_core/data/robot_mesero.db';
            try {
                const stats = fs.statSync(sqlitePath);
                memories.sqlite = { exists: true, path: sqlitePath, size_bytes: stats.size };
            } catch {
                memories.sqlite = { exists: false, path: sqlitePath, size_bytes: 0 };
            }
        }

        // 2. PostgreSQL
        {
            const host = process.env.POSTGRES_HOST || 'localhost';
            const port = parseInt(process.env.POSTGRES_PORT || '5432');
            try {
                if (svc?.pgPool) {
                    await svc.pgPool.query('SELECT 1');
                    memories.postgres = { connected: true, host, port };
                } else {
                    throw new Error('No pgPool');
                }
            } catch {
                memories.postgres = { connected: false, host, port };
            }
        }

        // 3. Redis
        {
            const host = process.env.REDIS_HOST || 'localhost';
            const port = parseInt(process.env.REDIS_PORT || '6379');
            try {
                if (svc?.redis) {
                    const start = Date.now();
                    await svc.redis.ping();
                    memories.redis = { connected: true, ping_ms: Date.now() - start };
                } else {
                    throw new Error('No redis client');
                }
            } catch {
                memories.redis = { connected: false, ping_ms: 0, host, port };
            }
        }

        // 4. ChromaDB
        {
            const host = process.env.CHROMA_HOST || 'localhost';
            const port = process.env.CHROMA_PORT || '8000';
            try {
                const r = await fetch(`http://${host}:${port}/api/v1/heartbeat`, { signal: AbortSignal.timeout(3000) });
                memories.chromadb = { connected: r.ok };
            } catch {
                memories.chromadb = { connected: false };
            }
        }

        // 5. mem0
        {
            const configPath = process.env.MEM0_CONFIG_PATH || '/home/david/chipi_workspace_pln/v3_core/memory/mem0_setup.py';
            try {
                fs.accessSync(configPath, fs.constants.F_OK);
                memories.mem0 = { configured: true, config_path: configPath };
            } catch {
                memories.mem0 = { configured: false, config_path: configPath };
            }
        }

        // 6. person_memory
        {
            const personPath = '/home/david/chipi_workspace_pln/v3_core/memory/person_memory.py';
            try {
                fs.accessSync(personPath, fs.constants.F_OK);
                memories.person_memory = { configured: true };
            } catch {
                memories.person_memory = { configured: false };
            }
        }

        // 7. InfluxDB
        {
            const host = process.env.INFLUXDB_HOST || 'localhost';
            const port = process.env.INFLUXDB_PORT || '8086';
            try {
                const r = await fetch(`http://${host}:${port}/ping`, { signal: AbortSignal.timeout(3000) });
                memories.influxdb = { connected: r.ok };
            } catch {
                memories.influxdb = { connected: false };
            }
        }

        res.json(memories);
    });

    // ── T5: Métricas de uso del LLM ──────────────────────────
    router.get('/llm-metrics', adminAuth, async (req, res) => {
        try {
            const { llmOrchestrator } = getServices();
            res.json(llmOrchestrator.getMetrics());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/hardware', adminAuth, async (req, res) => {
        try {
            const { llmOrchestrator, hardwareControl } = getServices();
            res.json({
                llm: {
                    active: llmOrchestrator.getActiveProvider()?.name || 'unknown',
                    providers: llmOrchestrator.listProviders(),
                },
                audio: hardwareControl.getState(),
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.put('/hardware/llm-provider', adminAuth, async (req, res) => {
        try {
            const { provider } = req.body || {};
            if (!provider || typeof provider !== 'string') {
                return res.status(400).json({ error: 'provider es requerido' });
            }
            const { llmOrchestrator } = getServices();
            const active = await llmOrchestrator.switchProvider(provider);
            res.json({ active, providers: llmOrchestrator.listProviders() });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.put('/hardware/audio-volume', adminAuth, async (req, res) => {
        try {
            const { volume } = req.body || {};
            const { hardwareControl } = getServices();
            res.json(hardwareControl.setAudioVolume(volume));
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ── T6: Inyectar datos de prueba (solo desarrollo) ───────
    router.post('/mock-data', adminAuth, async (req, res) => {
        try {
            if (process.env.NODE_ENV !== 'development') {
                return res.status(403).json({ error: 'Solo disponible en modo desarrollo' });
            }

            const populated = { sqlite: 0, redis: 0, chromadb: false };

            let svc = null;
            try { svc = getServices(); } catch { /* services not available */ }

            // Poblar SQLite con 50 pedidos mock
            if (svc?.sqlite) {
                try {
                    const insert = svc.sqlite.prepare(`
                        INSERT OR IGNORE INTO pedidos (id, mesa, platos, bebida, total, estado, notas, timestamp)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `);
                    for (let i = 1; i <= 50; i++) {
                        const mesa = String((i % 10) + 1);
                        const platos = JSON.stringify([{ id: String((i % 8) + 1), nombre: `Plato ${(i % 8) + 1}`, cantidad: 1, precio: 12.5 }]);
                        insert.run(
                            `mock-${i}`, mesa, platos,
                            i % 3 === 0 ? 'Coca-Cola' : null,
                            12.5 + (i % 5) * 2,
                            i % 4 === 0 ? 'completado' : 'pendiente',
                            `Nota mock ${i}`,
                            new Date().toISOString(),
                        );
                    }
                    populated.sqlite = 50;
                } catch (e) {
                    console.error('[mock-data] SQLite error:', e.message);
                }
            }

            // Poblar Redis con 5 keys de ejemplo
            if (svc?.redis) {
                try {
                    const samples = {
                        'mock:cliente:1': JSON.stringify({ nombre: 'Carlos', preferencias: 'cafe', visitas: 5 }),
                        'mock:cliente:2': JSON.stringify({ nombre: 'Maria', preferencias: 'te', visitas: 3 }),
                        'mock:pedido:activo': JSON.stringify({ id: 'mock-1', mesa: '3', estado: 'pendiente' }),
                        'mock:config:mensaje_bienvenida': 'Bienvenido a la cafeteria UTEC. Soy Uchino, tu robot mesero.',
                        'mock:sesion:last_session': new Date().toISOString(),
                    };
                    for (const [key, val] of Object.entries(samples)) {
                        await svc.redis.set(key, val, { EX: 3600 });
                    }
                    populated.redis = 5;
                } catch (e) {
                    console.error('[mock-data] Redis error:', e.message);
                }
            }

            // Intentar poblar ChromaDB
            if (svc?.chroma) {
                try {
                    const col = await svc.chroma.getOrCreateCollection({ name: 'mock_menu' });
                    await col.add({
                        ids: ['mock-1', 'mock-2', 'mock-3'],
                        documents: [
                            'Cafe pasado peruano con leche evaporada',
                            'Pizza Margarita con queso fresco y albahaca',
                            'Ceviche fresco con camote y choclo',
                        ],
                        metadatas: [
                            { tipo: 'bebida', precio: 5.0 },
                            { tipo: 'plato', precio: 12.5 },
                            { tipo: 'plato', precio: 18.0 },
                        ],
                    });
                    populated.chromadb = true;
                } catch (e) {
                    console.error('[mock-data] ChromaDB error:', e.message);
                }
            }

            res.json({ success: true, populated });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // PERSONALIDAD (singleton)
    // ═══════════════════════════════════════════════════════════

    router.get('/personalidad', adminAuth, async (req, res) => {
        try {
            const { personalidadRepo } = getServices();
            if (!personalidadRepo) {
                return res.status(503).json({ error: 'personalidadRepo no disponible' });
            }
            const personalidad = await personalidadRepo.get();
            res.json(personalidad);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.put('/personalidad', adminAuth, async (req, res) => {
        try {
            const { personalidadRepo, llmOrchestrator } = getServices();
            if (!personalidadRepo) {
                return res.status(503).json({ error: 'personalidadRepo no disponible' });
            }
            const updated = await personalidadRepo.update(req.body);
            // Hot-reload: si hay orchestrator y provee reloadPersonalidad, lo invocamos.
            if (llmOrchestrator?.reloadPersonalidad) {
                try {
                    await llmOrchestrator.reloadPersonalidad();
                } catch (e) {
                    console.warn('[admin] reloadPersonalidad fallo:', e.message);
                }
            }
            res.json(updated);
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // ROS2 / FLUJO DEL ROBOT — simulador explícito, sin rosbridge
    // ═══════════════════════════════════════════════════════════

    function simulatorErrorStatus(error) {
        if (/no encontrado/i.test(error.message)) return 404;
        if (/requerido|formato/i.test(error.message)) return 400;
        if (/ya existe|solo se pueden|no hay|no se puede|no coincide|no admite|ya terminó|ya no está listo|transición no permitida/i.test(error.message)) return 409;
        return 500;
    }

    async function simulatorAction(req, res, action) {
        try {
            const { ros2DeliverySimulator } = getServices();
            if (!ros2DeliverySimulator) {
                return res.status(503).json({ error: 'simulador ROS2 no disponible' });
            }
            const result = await action(ros2DeliverySimulator);
            return res.json(result);
        } catch (error) {
            return res.status(simulatorErrorStatus(error)).json({ error: error.message });
        }
    }

    router.get('/ros2/estado', adminAuth, async (req, res) => {
        await simulatorAction(req, res, (simulator) => simulator.getSnapshot());
    });

    router.post('/ros2/entrega/iniciar', adminAuth, async (req, res) => {
        await simulatorAction(req, res, (simulator) => simulator.start(
            req.body?.order_id || req.body?.pedidoId,
            { arm_positions: req.body?.arm_positions },
        ));
    });

    router.post('/ros2/entrega/confirmar-cocina', adminAuth, async (req, res) => {
        await simulatorAction(req, res, (simulator) => simulator.confirmKitchen({
            orderId: req.body?.order_id,
            simulationId: req.body?.simulation_id,
        }));
    });

    router.post('/ros2/entrega/confirmar-recogida', adminAuth, async (req, res) => {
        await simulatorAction(req, res, (simulator) => simulator.confirmPickup({
            orderId: req.body?.order_id,
            simulationId: req.body?.simulation_id,
        }));
    });

    router.post('/ros2/entrega/confirmar-mesa', adminAuth, async (req, res) => {
        await simulatorAction(req, res, (simulator) => simulator.confirmTable({
            orderId: req.body?.order_id,
            simulationId: req.body?.simulation_id,
        }));
    });

    router.post('/ros2/entrega/finalizar', adminAuth, async (req, res) => {
        await simulatorAction(req, res, (simulator) => simulator.finishDelivery({
            orderId: req.body?.order_id,
            simulationId: req.body?.simulation_id,
        }));
    });

    router.post('/ros2/entrega/cancelar', adminAuth, async (req, res) => {
        await simulatorAction(req, res, (simulator) => simulator.cancel({
            orderId: req.body?.order_id,
            simulationId: req.body?.simulation_id,
        }));
    });

    // ── PEDIDOS: operaciones administrativas seguras ─────────
    // El historial confirmado/entregado es inmutable desde este panel.
    router.delete('/pedidos/:id', adminAuth, async (req, res) => {
        try {
            const { orderHistoryService } = getServices();
            if (!orderHistoryService) return res.status(503).json({ error: 'orderHistoryService no disponible' });
            const result = await orderHistoryService.deleteOrder(req.params.id, {
                actor: req.adminUser?.user || 'admin',
                reason: req.body?.reason,
                confirm: req.body?.confirm === true,
            });
            return res.json(result);
        } catch (err) {
            const status = err.status || (err.code === 'ORDER_NOT_FOUND' ? 404 : 500);
            res.status(status).json({ error: err.message, code: err.code || 'ORDER_DELETE_ERROR' });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // MENÚ (CRUD sobre menu_items)
    // ═══════════════════════════════════════════════════════════

    // GET /api/admin/menu — listar todo (con filtros opcionales)
    router.get('/menu', adminAuth, async (req, res) => {
        try {
            const { memoryService } = getServices();
            if (!memoryService) return res.status(503).json({ error: 'memoryService no disponible' });
            const filters = {};
            if (req.query.categoria) filters.categoria = req.query.categoria;
            const result = await memoryService.menuRepo.findAll(filters);
            res.json({ data: result.data, total: result.total });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // POST /api/admin/menu — crear item
    router.post('/menu', adminAuth, async (req, res) => {
        try {
            const { memoryService, redis, fase5SafetyService } = getServices();
            if (!memoryService) return res.status(503).json({ error: 'memoryService no disponible' });
            const created = await memoryService.menuRepo.create(req.body);
            // Invalidar cache para que /api/menu publique el cambio
            await redis?.del('menu:del_dia').catch(() => {});
            await orderSessionManager?.refreshMenu();
            await fase5SafetyService?.record({ event: 'menu_safety_updated', actor: 'admin', source: 'admin', productId: created.id, nextState: created, metadata: { action: 'create' } });
            res.status(201).json(created);
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // PUT /api/admin/menu/:id — actualizar item
    router.put('/menu/:id', adminAuth, async (req, res) => {
        try {
            const { memoryService, redis, fase5SafetyService } = getServices();
            if (!memoryService) return res.status(503).json({ error: 'memoryService no disponible' });
            const updated = await memoryService.menuRepo.update(req.params.id, req.body);
            if (!updated) return res.status(404).json({ error: 'Item no encontrado' });
            await redis?.del('menu:del_dia').catch(() => {});
            await orderSessionManager?.refreshMenu();
            await fase5SafetyService?.record({ event: 'menu_safety_updated', actor: 'admin', source: 'admin', productId: updated.id, nextState: updated, metadata: { action: 'update', fields: Object.keys(req.body || {}) } });
            res.json(updated);
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // DELETE /api/admin/menu/:id — eliminar item
    router.delete('/menu/:id', adminAuth, async (req, res) => {
        try {
            const { memoryService, redis, fase5SafetyService } = getServices();
            if (!memoryService) return res.status(503).json({ error: 'memoryService no disponible' });
            const ok = await memoryService.menuRepo.delete(req.params.id);
            if (!ok) return res.status(404).json({ error: 'Item no encontrado' });
            await redis?.del('menu:del_dia').catch(() => {});
            await orderSessionManager?.refreshMenu();
            await fase5SafetyService?.record({ event: 'menu_safety_updated', actor: 'admin', source: 'admin', productId: req.params.id, metadata: { action: 'delete' } });
            res.json({ deleted: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
