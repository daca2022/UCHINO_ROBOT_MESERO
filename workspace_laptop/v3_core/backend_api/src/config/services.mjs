import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { createClient } from 'redis';
import { ChromaClient } from 'chromadb';
import { LlmOrchestrator, MockLlmProvider } from '../../../llm_brain/src/index.mjs';
import { MemoryService, PostgresPedidoRepository, PostgresMenuRepository, PostgresPersonalidadRepository } from '../../../memory_db/src/index.mjs';
import { TemporaryMemoryService } from '../../../memory_db/src/index.mjs';
import { ensureFase9MemorySchema } from '../../../memory_db/src/migrations/Fase9MemorySchema.mjs';
import { RecorridoService } from '../../../ros2_control/src/index.mjs';
import { VisionManager } from '../../../vision/vision_manager.mjs';
import { WhisperASRService } from '../application/WhisperASR.mjs';
import { SystemTTSService as PiperTTSService } from '../application/SystemTTSService.mjs';
import { HardwareControlService } from '../application/HardwareControlService.mjs';
import { Ros2DeliverySimulator } from '../application/Ros2DeliverySimulator.mjs';
import { WaiterAssistanceService } from '../application/WaiterAssistanceService.mjs';
import { Fase5SafetyService } from '../application/Fase5SafetyService.mjs';
import { OrderSessionManager } from '../application/OrderSessionManager.mjs';
import { TableVisitService } from '../application/TableVisitService.mjs';
import { OrderHistoryService } from '../application/OrderHistoryService.mjs';
import { DEFAULT_HRI_CONTEXT_RULES } from '../../../shared/hriContextRules.mjs';

const { Pool } = pg;

let services = null;

async function ensurePostgresSchema(pgPool) {
    await pgPool.query(`
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS table_id VARCHAR(10);
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS items JSONB;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS subtotal DECIMAL(10,2);
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'draft';
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS modo VARCHAR(20) DEFAULT 'tablet';
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'tablet';
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS requires_human BOOLEAN DEFAULT false;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS session_id VARCHAR(160);
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS declared_allergies JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS dietary_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS allergy_conflicts JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS special_warning TEXT;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS requires_special_confirmation BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS special_confirmation JSONB NOT NULL DEFAULT '{}'::jsonb;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS visit_id UUID;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS order_sequence INTEGER;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS order_kind VARCHAR(20);
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS archived_by VARCHAR(120);
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS archive_reason TEXT;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS deletion_reason TEXT;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS retention_class VARCHAR(30) NOT NULL DEFAULT 'operational';
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS data_origin VARCHAR(30) NOT NULL DEFAULT 'customer_order';

        ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS ingredientes JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS alergenos JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS restricciones JSONB NOT NULL DEFAULT '{}'::jsonb;
        ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS permite_modificadores BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS modificadores_disponibles JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS informacion_completa BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS advertencia_contaminacion TEXT;

        UPDATE pedidos
        SET
            table_id = COALESCE(table_id, mesa),
            items = COALESCE(items, platos),
            subtotal = COALESCE(subtotal, total, 0),
            status = COALESCE(status, CASE estado
                WHEN 'provisional' THEN 'draft'
                WHEN 'confirmado' THEN 'confirmed'
                WHEN 'en_preparacion' THEN 'preparing'
                WHEN 'listo' THEN 'ready'
                WHEN 'entregado' THEN 'delivered'
                WHEN 'cancelado' THEN 'cancelled'
                ELSE 'draft'
            END),
            mode = COALESCE(NULLIF(mode, ''), NULLIF(modo, ''), 'tablet'),
            modo = COALESCE(NULLIF(modo, ''), NULLIF(mode, ''), 'tablet'),
            notes = COALESCE(notes, notas, ''),
            created_at = COALESCE(created_at, timestamp, NOW()),
            updated_at = COALESCE(updated_at, timestamp, NOW()),
            is_test = COALESCE(is_test, false),
            retention_class = COALESCE(NULLIF(retention_class, ''), 'operational'),
            data_origin = COALESCE(NULLIF(data_origin, ''), 'customer_order'),
            confirmed_at = COALESCE(confirmed_at, CASE
                WHEN COALESCE(status, '') IN ('confirmed', 'sent_to_kitchen', 'preparing', 'ready', 'delivery_in_progress', 'delivered')
                THEN COALESCE(timestamp, NOW()) END),
            delivered_at = COALESCE(delivered_at, CASE
                WHEN COALESCE(status, '') = 'delivered' THEN COALESCE(timestamp, NOW()) END),
            cancelled_at = COALESCE(cancelled_at, CASE
                WHEN COALESCE(status, '') = 'cancelled' THEN COALESCE(timestamp, NOW()) END)
        WHERE table_id IS NULL
           OR items IS NULL
           OR subtotal IS NULL
           OR status IS NULL
           OR mode IS NULL
           OR modo IS NULL
           OR notes IS NULL
           OR created_at IS NULL
           OR updated_at IS NULL
           OR retention_class IS NULL
           OR data_origin IS NULL;

        CREATE TABLE IF NOT EXISTS personalidad (
            id INT PRIMARY KEY DEFAULT 1,
            tono TEXT DEFAULT 'cordial',
            humor TEXT DEFAULT 'bajo',
            formalidad TEXT DEFAULT 'usted',
            proactividad TEXT DEFAULT 'media',
            longitud TEXT DEFAULT 'corta',
            reglas_contexto JSONB DEFAULT '{}',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        INSERT INTO personalidad (id) VALUES (1)
        ON CONFLICT (id) DO NOTHING;

        CREATE TABLE IF NOT EXISTS pedido_eventos (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event VARCHAR(90) NOT NULL,
            session_id VARCHAR(160),
            order_id UUID,
            item_id VARCHAR(160),
            product_id UUID,
            mesa VARCHAR(10),
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            actor VARCHAR(80) NOT NULL DEFAULT 'system',
            previous_state JSONB NOT NULL DEFAULT '{}'::jsonb,
            next_state JSONB NOT NULL DEFAULT '{}'::jsonb,
            source VARCHAR(40) NOT NULL DEFAULT 'backend',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            is_test BOOLEAN NOT NULL DEFAULT false
        );
        ALTER TABLE pedido_eventos ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
        CREATE INDEX IF NOT EXISTS idx_pedido_eventos_order ON pedido_eventos(order_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_pedido_eventos_session ON pedido_eventos(session_id, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_pedido_eventos_event ON pedido_eventos(event, timestamp DESC);

        CREATE TABLE IF NOT EXISTS restaurant_tables (
            table_id VARCHAR(3) PRIMARY KEY,
            display_name VARCHAR(20) NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT true,
            status VARCHAR(32) NOT NULL DEFAULT 'available',
            current_visit_id UUID,
            active_session_id VARCHAR(160),
            active_order_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            opened_at TIMESTAMPTZ,
            last_status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            version INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT restaurant_tables_status_check CHECK (status IN (
                'available', 'occupied', 'ordering', 'order_confirmed', 'preparing',
                'ready', 'delivery_in_progress', 'served', 'closed', 'attention_requested'
            ))
        );

        CREATE TABLE IF NOT EXISTS restaurant_visits (
            visit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            table_id VARCHAR(3) NOT NULL REFERENCES restaurant_tables(table_id),
            status VARCHAR(16) NOT NULL DEFAULT 'active',
            opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            closed_at TIMESTAMPTZ,
            close_reason VARCHAR(80),
            session_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            order_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            additional_orders_allowed BOOLEAN NOT NULL DEFAULT true,
            guest_count INTEGER,
            notes TEXT,
            version INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT restaurant_visits_status_check CHECK (status IN ('active', 'closed')),
            CONSTRAINT restaurant_visits_guest_count_check CHECK (guest_count IS NULL OR guest_count > 0)
        );
        ALTER TABLE restaurant_visits ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE restaurant_visits ADD COLUMN IF NOT EXISTS data_origin VARCHAR(30) NOT NULL DEFAULT 'customer_order';
        CREATE TABLE IF NOT EXISTS order_retention_policy (
            id SMALLINT PRIMARY KEY CHECK (id = 1),
            draft_hours INTEGER NOT NULL DEFAULT 24 CHECK (draft_hours >= 0 AND draft_hours <= 8760),
            test_hours INTEGER NOT NULL DEFAULT 24 CHECK (test_hours >= 0 AND test_hours <= 8760),
            delivered_days INTEGER NOT NULL DEFAULT 30 CHECK (delivered_days >= 0 AND delivered_days <= 3650),
            cancelled_days INTEGER NOT NULL DEFAULT 7 CHECK (cancelled_days >= 0 AND cancelled_days <= 3650),
            audit_days INTEGER NOT NULL DEFAULT 3650 CHECK (audit_days >= 0 AND audit_days <= 3650),
            auto_delete_historical BOOLEAN NOT NULL DEFAULT false,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by VARCHAR(120)
        );
        INSERT INTO order_retention_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_visits_one_active
            ON restaurant_visits(table_id) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_restaurant_visits_table_opened
            ON restaurant_visits(table_id, opened_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pedidos_visit ON pedidos(visit_id, timestamp ASC);
        CREATE INDEX IF NOT EXISTS idx_pedidos_table_status ON pedidos(table_id, status);
        CREATE INDEX IF NOT EXISTS idx_pedidos_history_created ON pedidos(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_pedidos_history_status ON pedidos(status, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_pedidos_history_table ON pedidos(table_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_pedidos_history_archived ON pedidos(archived_at, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_pedidos_history_test ON pedidos(is_test, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_pedidos_history_confirmed ON pedidos(confirmed_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_pedidos_history_delivered ON pedidos(delivered_at DESC, id DESC);

        INSERT INTO restaurant_tables (table_id, display_name)
        SELECT 'M' || n, 'Mesa M' || n
        FROM generate_series(1, 12) AS n
        ON CONFLICT (table_id) DO NOTHING;
    `);

    await pgPool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_visit_id_fkey'
            ) THEN
                ALTER TABLE pedidos
                    ADD CONSTRAINT pedidos_visit_id_fkey
                    FOREIGN KEY (visit_id) REFERENCES restaurant_visits(visit_id)
                    NOT VALID;
            END IF;
        END $$;
    `);

    await backfillLegacyTableVisits(pgPool);

    await pgPool.query(
        `
        UPDATE personalidad
        SET reglas_contexto = $1::jsonb, updated_at = NOW()
        WHERE id = 1
          AND (
            reglas_contexto IS NULL
            OR reglas_contexto = '{}'::jsonb
          )
        `,
        [JSON.stringify(DEFAULT_HRI_CONTEXT_RULES)]
    );
}

/**
 * Conserva las relaciones de pedidos legacy sin convertir el backlog histórico
 * en ocupaciones operativas actuales.
 */
async function backfillLegacyTableVisits(pgPool) {
    const validTables = Array.from({ length: 12 }, (_, index) => `M${index + 1}`);
    for (const tableId of validTables) {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT table_id FROM restaurant_tables WHERE table_id = $1 FOR UPDATE', [tableId]);
            const importedVisit = await client.query(
                `SELECT visit_id
                   FROM restaurant_visits
                  WHERE table_id = $1
                    AND status = 'active'
                    AND notes = 'Visita enlazada desde pedidos históricos'
                    AND session_ids = '[]'::jsonb
                  FOR UPDATE`,
                [tableId],
            );
            for (const row of importedVisit.rows) {
                await client.query(
                    `UPDATE restaurant_visits
                        SET status = 'closed', closed_at = COALESCE(closed_at, NOW()),
                            close_reason = 'legacy_import_reconciled', version = version + 1, updated_at = NOW()
                      WHERE visit_id = $1`,
                    [row.visit_id],
                );
                await client.query(
                    `UPDATE restaurant_tables
                        SET current_visit_id = NULL, active_session_id = NULL,
                            active_order_ids = '[]'::jsonb, status = 'available', opened_at = NULL,
                            version = version + 1, last_status_changed_at = NOW(), updated_at = NOW()
                      WHERE table_id = $1 AND current_visit_id = $2`,
                    [tableId, row.visit_id],
                );
                await client.query(
                    `INSERT INTO pedido_eventos
                        (event, mesa, timestamp, actor, source, previous_state, next_state, metadata)
                     VALUES ('visit_closed', $1::varchar, NOW(), 'system', 'legacy_import',
                             jsonb_build_object('visit_id', $2::text, 'status', 'active'),
                             jsonb_build_object('visit_id', $2::text, 'status', 'closed'),
                             jsonb_build_object('reason', 'legacy_import_reconciled'))`,
                    [tableId, row.visit_id],
                );
            }
            const activeOrders = await client.query(
                `SELECT id, status, timestamp
                   FROM pedidos
                  WHERE table_id = $1
                    AND visit_id IS NULL
                    AND status NOT IN ('delivered', 'cancelled')
                  ORDER BY timestamp ASC NULLS LAST, id ASC
                  FOR UPDATE`,
                [tableId],
            );
            if (activeOrders.rows.length === 0) {
                await client.query('COMMIT');
                continue;
            }

            const visit = await client.query(
                `INSERT INTO restaurant_visits
                    (table_id, status, closed_at, close_reason, notes)
                 VALUES ($1, 'closed', NOW(), 'legacy_import_reconciled', 'Visita enlazada desde pedidos históricos')
                 RETURNING visit_id`,
                [tableId],
            );
            const visitId = visit.rows[0].visit_id;

            const orderIds = [];
            for (const [index, order] of activeOrders.rows.entries()) {
                const sequence = index + 1;
                const kind = sequence === 1 ? 'initial' : 'additional';
                await client.query(
                    `UPDATE pedidos
                        SET visit_id = COALESCE(visit_id, $1::uuid),
                            order_sequence = COALESCE(order_sequence, $2),
                            order_kind = COALESCE(order_kind, $3)
                      WHERE id = $4`,
                    [visitId, sequence, kind, order.id],
                );
                orderIds.push(String(order.id));
            }
            await client.query(
                `UPDATE restaurant_visits
                    SET order_ids = $1::jsonb, version = version + 1, updated_at = NOW()
                  WHERE visit_id = $2`,
                [JSON.stringify(orderIds), visitId],
            );
            await client.query(
                `INSERT INTO pedido_eventos
                    (event, mesa, timestamp, actor, source, previous_state, next_state, metadata)
                 VALUES ('visit_closed', $1::varchar, NOW(), 'system', 'legacy_import',
                         '{}'::jsonb, jsonb_build_object('visit_id', $2::text, 'status', 'closed'),
                         jsonb_build_object('reason', 'legacy_orders_backfill', 'order_count', $3::integer))`,
                [tableId, visitId, orderIds.length],
            );
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }
}

export async function createServices({ sendToUI } = {}) {
    if (services) return services;

    const logger = {
        log: (...args) => console.log('[SVCS]', ...args),
        error: (...args) => console.error('[SVCS]', ...args),
        warn: (...args) => console.warn('[SVCS]', ...args),
    };

    // SQLite (operación en tiempo real)
    const sqlitePath = process.env.SQLITE_PATH || './data/robot_mesero.db';
    mkdirSync(dirname(sqlitePath), { recursive: true });
    const sqlite = new DatabaseSync(sqlitePath);
    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS pedidos (
            id TEXT PRIMARY KEY,
            mesa TEXT NOT NULL,
            platos TEXT NOT NULL,
            bebida TEXT,
            total REAL,
            estado TEXT DEFAULT 'provisional',
            cliente_id TEXT,
            notas TEXT,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS clientes (
            id TEXT PRIMARY KEY,
            nombre TEXT,
            preferencias TEXT,
            frecuencia INTEGER DEFAULT 0,
            ultima_visita TEXT
        );
        CREATE TABLE IF NOT EXISTS configuracion (
            clave TEXT PRIMARY KEY,
            valor TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // PostgreSQL (analytics/reportes)
    const pgPool = new Pool({
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5432'),
        user: process.env.POSTGRES_USER || 'chipi',
        password: process.env.POSTGRES_PASSWORD,
        database: process.env.POSTGRES_DB || 'robot_mesero',
        max: 5,
    });
    await ensurePostgresSchema(pgPool).catch((e) => logger.warn('PostgreSQL schema update skipped:', e.message));
    await ensureFase9MemorySchema(pgPool).catch((e) => logger.warn('Fase 9 memory schema update skipped:', e.message));

    // Redis (caché)
    const redis = createClient({
        url: `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
    });
    await redis.connect().catch(() => logger.warn('Redis no disponible'));

    // ChromaDB (vectores)
    const chroma = new ChromaClient({
        path: `http://${process.env.CHROMA_HOST || 'localhost'}:${process.env.CHROMA_PORT || '8000'}`,
    });

    // Repositorios
    const pedidoRepo = new PostgresPedidoRepository(pgPool);
    const menuRepo = new PostgresMenuRepository(pgPool);
    const personalidadRepo = new PostgresPersonalidadRepository(pgPool);
    const tableService = new TableVisitService({
        pool: pgPool,
        pedidoRepo,
        sendToUI,
        autoReleaseAfterDelivery: String(process.env.AUTO_RELEASE_AFTER_DELIVERY || '').toLowerCase() === 'true',
        logger,
    });
    // Memory Service
    const vectorStore = {
        add: async (col, id, text, meta) => {
            try {
                const collection = await chroma.getOrCreateCollection({ name: col });
                await collection.add({ ids: [id], documents: [text], metadatas: [meta] });
            } catch (e) { logger.warn('ChromaDB add error:', e.message); }
        },
        search: async (col, query, k) => {
            try {
                const collection = await chroma.getOrCreateCollection({ name: col });
                return await collection.query({ queryTexts: [query], nResults: k });
            } catch (e) { logger.warn('ChromaDB search error:', e.message); return []; }
        },
        deleteByProfile: async (profileId, memoryType = null) => {
            try {
                const collection = await chroma.getOrCreateCollection({ name: 'customer_memory' });
                const where = memoryType ? { $and: [{ profile_id: profileId }, { memory_type: memoryType }] } : { profile_id: profileId };
                const existing = await collection.get({ where });
                const ids = Array.isArray(existing?.ids) ? existing.ids : [];
                if (ids.length) await collection.delete({ ids });
                return ids.length;
            } catch (e) {
                logger.warn('ChromaDB customer memory delete error:', e.message);
                throw e;
            }
        },
        healthCheck: async () => {
            try { await chroma.heartbeat(); return true; } catch { return false; }
        },
    };

    const memoryService = new MemoryService({
        pedidoRepo,
        menuRepo,
        cache: redis,
        vectorStore,
        logger,
    });

    const temporaryMemoryService = new TemporaryMemoryService({
        pool: pgPool,
        cache: redis,
        vectorStore,
        notify: (event) => sendToUI?.(event),
        logger,
        cleanupIntervalMs: Number(process.env.MEMORY_CLEANUP_INTERVAL_MS) || 15 * 60 * 1000,
    });

    const orderHistoryService = new OrderHistoryService({
        pool: pgPool,
        tableService,
        temporaryMemoryService,
        notify: (event) => sendToUI?.(event),
        logger,
    });

    const fase5SafetyService = new Fase5SafetyService({
        pgPool,
        notify: (event) => sendToUI?.(event),
        logger,
    });

    // LLM Brain with FallbackManager (OpenRouter primary → OpenRouter fallback → Ollama local)
    const llmOrchestrator = await LlmOrchestrator.fromDefaults({
        functionHandlers: {
            registrar_pedido: async (args) => {
                try {
                    const sessionId = String(args?.session_id || '').trim();
                    const requestedTable = args?.table_id || args?.mesa;
                    if (!sessionId || !requestedTable) {
                        return {
                            error: 'ORDER_SESSION_REQUIRED',
                            message: 'El pedido debe pasar por una sesión activa de voz o pantalla.',
                        };
                    }
                    const table = await tableService.getTable(requestedTable);
                    if (!table?.visit?.status || table.active_session_id !== sessionId) {
                        return {
                            error: 'TABLE_SESSION_CONFLICT',
                            message: 'La mesa no tiene una sesión activa compatible con este pedido.',
                        };
                    }
                    if (table.active_order_ids.length > 0 && args?.additional_order !== true) {
                        return {
                            error: 'ADDITIONAL_ORDER_REQUIRED',
                            message: 'La mesa ya tiene pedidos activos; usa el flujo explícito de pedido adicional.',
                        };
                    }
                    const menu = await memoryService.obtenerMenu();
                    const orderValidator = new OrderSessionManager({ memoryService, menu });
                    const incomingItems = Array.isArray(args?.items)
                        ? args.items
                        : Array.isArray(args?.platos)
                            ? args.platos
                            : [];
                    if (incomingItems.length === 0) {
                        return { error: 'El pedido debe contener al menos un producto del menú real' };
                    }
                    const validation = orderValidator.validateProducts(incomingItems);
                    if (validation.invalidos.length || validation.agotados.length || validation.invalid_modifiers.length) {
                        return {
                            error: 'El pedido contiene productos o modificadores que no están configurados en el menú real',
                            validation,
                        };
                    }
                    const canonicalItems = validation.validos;
                    const total = orderValidator.calculateTotal(canonicalItems);
                    const safety = fase5SafetyService.derive(canonicalItems, menu, args);
                    if (safety.requires_special_confirmation && args.special_confirmation?.decision !== 'confirmed') {
                        return { error: 'SPECIAL_CONFIRMATION_REQUIRED', safety };
                    }
                    const payload = {
                        ...args,
                        mesa: table.table_id,
                        table_id: table.table_id,
                        visit_id: table.current_visit_id,
                        session_id: sessionId,
                        status: 'draft',
                        items: canonicalItems,
                        platos: canonicalItems,
                        subtotal: total,
                        total,
                        declared_allergies: safety.declared_allergies,
                        dietary_restrictions: safety.dietary_restrictions,
                        allergy_conflicts: safety.allergy_conflicts,
                        special_warning: safety.special_warning,
                        requires_special_confirmation: safety.requires_special_confirmation,
                    };
                    let order = await memoryService.crearPedido(payload);
                    try {
                        order = await tableService.attachOrder({ order, source: 'llm_registrar_pedido' });
                    } catch (error) {
                        if (memoryService.pedidoRepo.deleteDraft) {
                            await memoryService.pedidoRepo.deleteDraft(order.id).catch(() => {});
                        }
                        throw error;
                    }
                    if (sendToUI) {
                        sendToUI({ type: 'navigate', section: 'pedido' });
                        canonicalItems.forEach(item => sendToUI({ type: 'add-to-cart', item }));
                    }
                    return order;
                }
                catch (e) { return { error: e.message }; }
            },
            confirmar_pedido: () => {
                if (sendToUI) sendToUI({ type: 'navigate', section: 'emocion', emotion: 'celebrando', text: '¡Pedido confirmado!' });
                return { ok: true };
            },
            cancelar_pedido: () => {
                if (sendToUI) sendToUI({ type: 'navigate', section: 'emocion', emotion: 'triste', text: 'Pedido cancelado' });
                return { ok: true };
            },
            ir_a_lugar: (args) => ({ ok: true, destino: args.lugar }),
            expresar_emocion: (args) => ({ ok: true, emocion: args.emocion }),
            mostrar_menu: async (args) => {
                if (sendToUI) sendToUI({ type: 'navigate', section: 'menu', etapa: args.etapa });
                try { return await memoryService.obtenerMenu(); }
                catch (e) { return { error: e.message }; }
            },
            guardar_memoria: async (args) => {
                try { return await memoryService.recordarCliente(args.clave, args.valor); }
                catch (e) { return { error: e.message }; }
            },
            ver_mesa: async (args) => {
                try { return await visionManager.verMesa(args); }
                catch (e) { return { error: e.message }; }
            },
            ver_cliente: async (args) => {
                try { return await visionManager.verCliente(args); }
                catch (e) { return { error: e.message }; }
            },
            ver_lugar: async () => {
                try { return await visionManager.verLugar(); }
                catch (e) { return { error: e.message }; }
            },
            render_ui: (args) => {
                if (sendToUI) sendToUI({ type: 'render_ui', component: args.componente, props: args.props });
                return { ok: true };
            },
        },
        onEmotion: (emo, msg) => {
            logger.log('Emoción:', emo, msg);
            if (sendToUI) sendToUI({ type: 'emotion', emotion: emo, text: msg });
        },
        logger,
    });

    // ROS2 Control (placeholder hasta integrar un adaptador físico verificado).
    // La simulación de entrega es deliberadamente separada de este objeto.
    const ros2Control = {
        mode: 'simulation',
        real_available: false,
        goTo: async (destino) => ({ success: true, destino }),
        stop: async () => {},
        getState: async () => ({
            mode: 'simulation',
            real_available: false,
            posicion: { x: 0, y: 0, theta: 0 },
            bateria: 100,
            estado: 'idle',
        }),
    };
    const recorridoService = new RecorridoService({
        robotCommand: ros2Control,
        telemetry: { onPosition: () => () => {} },
        logger,
    });

    // Piper TTS (síntesis de voz offline)
    const piperTTS = new PiperTTSService({ logger });
    const hardwareControl = new HardwareControlService({ logger });
    const ros2DeliverySimulator = new Ros2DeliverySimulator({
        pedidoRepo,
        tableService,
        notifyEvent: (event) => sendToUI?.({ type: 'ros2_event', event }),
        notifyUi: (data) => sendToUI?.(data),
        // No active rosbridge/rclpy publisher exists in this workspace. Keep
        // this null until a verified real adapter is injected explicitly.
        publisher: null,
        logger,
    });
    const waiterAssistanceService = new WaiterAssistanceService({
        redis,
        notify: (event) => sendToUI?.({ type: 'waiter_assistance', ...event }),
    });
    tableService.setWaiterAssistanceService(waiterAssistanceService);

    // Vision Manager (on-demand frame capture + OpenRouter vision)
    const visionManager = new VisionManager({
        llmOrchestrator,
        logger,
        captureUrl: process.env.VISION_CAPTURE_URL || 'http://localhost:8765',
        mockMode: !process.env.OPENROUTER_API_KEY || process.env.VISION_MOCK === 'true',
    });

    // Whisper ASR (speech-to-text con whisper.cpp CUDA)
    const whisperASR = new WhisperASRService();

    services = {
        sqlite,
        pgPool,
        redis,
        chroma,
        memoryService,
        temporaryMemoryService,
        llmOrchestrator,
        ros2Control,
        ros2DeliverySimulator,
        waiterAssistanceService,
        fase5SafetyService,
        recorridoService,
        visionManager,
        whisperASR,
        piperTTS,
        hardwareControl,
        personalidadRepo,
        tableService,
        orderHistoryService,
        logger,
    };

    return services;
}

export function getServices() {
    if (!services) throw new Error('Servicios no inicializados. Llama createServices() primero.');
    return services;
}
