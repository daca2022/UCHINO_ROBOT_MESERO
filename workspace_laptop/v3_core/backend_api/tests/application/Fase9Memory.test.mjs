import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import {
    CONSENT_LEVELS,
    RETENTION_POLICIES,
    TemporaryMemoryService,
    buildMemoryExpiry,
    normalizeConsent,
    normalizeRetentionPolicy,
} from '../../../memory_db/src/services/TemporaryMemoryService.mjs';
import { classifyMemoryIntent, MemoryIntent } from '../../src/application/MemoryIntentRules.mjs';
import { createMemoryRouter } from '../../src/routes/memory.mjs';
import { createSessionsRouter } from '../../src/routes/sessions.mjs';
import { projectKitchenOrder } from '../../src/application/TableVisitService.mjs';

test('Fase 9 policy: consent and retention only accept the public contract', () => {
    assert.deepEqual(CONSENT_LEVELS, ['session_only', 'temporary', 'disabled']);
    assert.deepEqual(RETENTION_POLICIES, ['session_only', '1d', '7d', '30d', 'disabled']);
    assert.equal(normalizeConsent('temporary'), 'temporary');
    assert.equal(normalizeConsent('unknown'), null);
    assert.equal(normalizeRetentionPolicy('1d'), '1d');
    assert.equal(normalizeRetentionPolicy('24h'), '1d');
    assert.equal(normalizeRetentionPolicy('unknown'), null);
});

test('Fase 9 policy: session-only and disabled never create a persistent expiry', () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    assert.equal(buildMemoryExpiry({ consent: 'session_only', retentionPolicy: 'session_only', now }), null);
    assert.equal(buildMemoryExpiry({ consent: 'disabled', retentionPolicy: '1d', now }), null);
    assert.equal(buildMemoryExpiry({ consent: 'temporary', retentionPolicy: '1d', now }).toISOString(), '2026-07-27T12:00:00.000Z');
});

test('Fase 9 service: same name never resolves a profile and missing profile cannot be recovered', async () => {
    const service = new TemporaryMemoryService({
        pool: null,
        now: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    const david = await service.createProfile({ sessionId: 'session-a', displayName: 'David', consent: 'session_only' });
    const ana = await service.createProfile({ sessionId: 'session-b', displayName: 'Ana', consent: 'session_only' });
    assert.notEqual(david.profile_id, ana.profile_id);
    assert.equal(await service.findProfileByName('David'), null);
    assert.equal(await service.recoverProfile({ profileId: 'David', sessionId: 'session-c' }), null);
});

test('Fase 9 service: session isolation prevents cross-session memory reads', async () => {
    const service = new TemporaryMemoryService({
        pool: null,
        now: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    const a = await service.createProfile({ sessionId: 'session-a', displayName: 'David', consent: 'session_only' });
    const b = await service.createProfile({ sessionId: 'session-b', displayName: 'Ana', consent: 'session_only' });
    await service.remember({ sessionId: 'session-a', profileId: a.profile_id, memoryType: 'preference', value: 'ceviche' });
    assert.equal((await service.summary({ sessionId: 'session-a', profileId: a.profile_id })).preferences[0], 'ceviche');
    assert.deepEqual((await service.summary({ sessionId: 'session-b', profileId: b.profile_id })).preferences, []);
    await assert.rejects(
        service.summary({ sessionId: 'session-b', profileId: a.profile_id }),
        error => error.code === 'PROFILE_SESSION_MISMATCH',
    );
});

test('Fase 9 service: forget is idempotent and removes ephemeral data without touching orders', async () => {
    const service = new TemporaryMemoryService({
        pool: null,
        now: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    const profile = await service.createProfile({ sessionId: 'session-a', displayName: 'David', consent: 'session_only' });
    await service.remember({ sessionId: 'session-a', profileId: profile.profile_id, memoryType: 'allergy', value: 'maní' });
    const first = await service.forget({ sessionId: 'session-a', profileId: profile.profile_id, scope: 'all' });
    const second = await service.forget({ sessionId: 'session-a', profileId: profile.profile_id, scope: 'all' });
    assert.equal(first.forgotten, true);
    assert.equal(second.forgotten, true);
    assert.equal((await service.summary({ sessionId: 'session-a', profileId: profile.profile_id })).profile, null);
});

test('Fase 9 intent: explicit denial wins over an identity declaration', () => {
    const result = classifyMemoryIntent('Me llamo David, pero no lo recuerdes');
    assert.equal(result.intent, MemoryIntent.FORGET);
    assert.equal(result.entities.explicit_denial, true);
    assert.equal(classifyMemoryIntent('Olvida mi nombre').entities.scope, 'name');
    assert.equal(classifyMemoryIntent('Prefiero poca sal').entities.preference_type, 'salt_level');
    assert.equal(classifyMemoryIntent('Cámbialo a Pedro').intent, MemoryIntent.UPDATE_NAME);
    assert.equal(classifyMemoryIntent('Mi plato favorito es ceviche').intent, MemoryIntent.FAVORITE);
});

test('Fase 9 intent: memory operations are separated from order mutation', () => {
    assert.equal(classifyMemoryIntent('Me llamo David').intent, MemoryIntent.IDENTIFY);
    assert.equal(classifyMemoryIntent('Soy alérgico al pescado'), null);
    assert.equal(classifyMemoryIntent('Soy alérgico a la sal'), null);
    assert.equal(classifyMemoryIntent('No soy alérgico, solo no me gusta la cebolla'), null);
    assert.equal(classifyMemoryIntent('Recuérdame que soy alérgico al pescado').intent, MemoryIntent.ALLERGY);
    assert.equal(classifyMemoryIntent('Recuérdame que me gusta la chicha morada').intent, MemoryIntent.PREFERENCE);
    assert.equal(classifyMemoryIntent('¿Qué recuerdas de mí?').intent, MemoryIntent.QUERY);
    assert.equal(classifyMemoryIntent('Repite mi último pedido').intent, MemoryIntent.REORDER);
    assert.equal(classifyMemoryIntent('¿Cuál fue mi pedido anterior?').intent, MemoryIntent.LAST_ORDER);
    assert.equal(classifyMemoryIntent('Repite mi último pedido').mutates_order, true);
    assert.equal(classifyMemoryIntent('¿Qué recuerdas de mí?').mutates_order, false);
});

test('Fase 9 service: profile recovery requires explicit temporary consent', async () => {
    const service = new TemporaryMemoryService({
        pool: null,
        now: () => new Date('2026-07-26T12:00:00.000Z'),
    });
    const profile = await service.createProfile({ sessionId: 'session-a', consent: 'session_only' });
    await assert.rejects(
        service.attachProfileToSession({ sessionId: 'session-b', profileId: profile.profile_id }),
        error => error.code === 'MEMORY_CONSENT_REQUIRED',
    );
});

test('Fase 9 service: last confirmed order falls back to PostgreSQL orders', async () => {
    const profileId = '11111111-1111-4111-8111-111111111111';
    const queries = [];
    const pool = {
        async query(sql) {
            queries.push(sql);
            if (sql.includes('SELECT * FROM customer_profiles')) {
                return { rows: [{ profile_id: profileId, display_name: 'David', consent_status: 'temporary', retention_policy: '1d', status: 'active', created_at: new Date(), updated_at: new Date(), expires_at: new Date(Date.now() + 86_400_000) }] };
            }
            if (sql.includes('FROM customer_memory_entries')) return { rows: [] };
            if (sql.includes('FROM pedidos')) {
                return { rows: [{ id: '22222222-2222-4222-8222-222222222222', table_id: 'M8', items: [{ product_id: 'ceviche-id', nombre: 'Ceviche', cantidad: 1 }], timestamp: new Date('2026-07-26T12:00:00.000Z') }] };
            }
            return { rows: [], rowCount: 0 };
        },
    };
    const service = new TemporaryMemoryService({ pool, cleanupIntervalMs: 0 });
    await service.attachProfileToSession({ sessionId: 'session-a', profileId, consent: 'temporary' });
    const result = await service.getLastConfirmedOrder({ sessionId: 'session-a', profileId });
    assert.equal(result.mesa, 'M8');
    assert.equal(result.items[0].nombre, 'Ceviche');
    assert.ok(queries.some(sql => sql.includes('FROM pedidos')));
});

test('Fase 9 consent: disabled never creates an ephemeral profile or returns its name', async () => {
    const service = new TemporaryMemoryService({ pool: null, cleanupIntervalMs: 0 });
    const result = await service.createProfile({
        sessionId: 'session-disabled',
        displayName: 'No debe persistir',
        consent: 'disabled',
    });
    assert.equal(result.profile_id, null);
    assert.equal(result.display_name, null);
    assert.equal(service.getBoundProfileId('session-disabled'), null);
    assert.equal((await service.summary({ sessionId: 'session-disabled', profileId: null })).profile, null);
});

test('Fase 9 identity: generic soy statements are not captured as names', () => {
    assert.equal(classifyMemoryIntent('Soy vegetariano'), null);
    assert.equal(classifyMemoryIntent('Soy diabético'), null);
    assert.equal(classifyMemoryIntent('Soy celíaco'), null);
    assert.equal(classifyMemoryIntent('Soy peruano'), null);
    assert.equal(classifyMemoryIntent('Soy hipertenso'), null);
    assert.equal(classifyMemoryIntent('Soy asmático'), null);
    assert.equal(classifyMemoryIntent('Soy embarazada'), null);
    assert.equal(classifyMemoryIntent('Soy Ana y prefiero poca sal').intent, MemoryIntent.PREFERENCE);
    assert.equal(classifyMemoryIntent('Soy Ana y prefiero poca sal').entities.name, undefined);
    assert.equal(classifyMemoryIntent('Soy Ana').intent, MemoryIntent.IDENTIFY);
    assert.equal(classifyMemoryIntent('Me llamo Ana María').entities.name, 'Ana Maria');
});

test('Fase 9 session privacy: active listing is Admin-only and recovery requires the session token', async () => {
    const session = {
        session_id: 'private-session',
        session_status: 'active',
        session_access_token: 'private-token',
        mesa: 'M8',
        robot_id: 'uchino-01',
        state: 'idle',
        draft_items: [],
    };
    const lifecycle = {
        get: id => id === session.session_id ? session : null,
        snapshot: id => id === session.session_id ? { session_id: session.session_id, mesa: session.mesa, session_status: session.session_status } : null,
        recover: () => ({ ok: true, session }),
        listActive: () => [session],
        listAll: () => [session],
    };
    const manager = { get: id => id === session.session_id ? session : null };
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', createSessionsRouter(lifecycle, manager));
    const server = createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    try {
        const address = server.address();
        const active = await fetch(`http://127.0.0.1:${address.port}/api/sessions/active`);
        assert.equal(active.status, 401);
        const recoveryWithoutToken = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${session.session_id}/recover`, { method: 'POST' });
        assert.equal(recoveryWithoutToken.status, 401);
        const recoveryWithToken = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${session.session_id}/recover`, {
            method: 'POST',
            headers: { 'X-Session-Token': session.session_access_token },
        });
        assert.equal(recoveryWithToken.status, 200);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('Fase 9 WebSocket memory events omit session and profile identifiers', async () => {
    const events = [];
    const service = new TemporaryMemoryService({ pool: null, notify: event => events.push(event), cleanupIntervalMs: 0 });
    await service.createProfile({ sessionId: 'session-private', consent: 'session_only' });
    const event = events.at(-1);
    assert.equal(event.type, 'memory_event');
    assert.equal(Object.hasOwn(event, 'session_id'), false);
    assert.equal(Object.hasOwn(event, 'profile_id'), false);
    assert.equal(event.action, 'profile_created');
});

test('Fase 9 recovery: concurrent profile attachment allows only one active session', async () => {
    const service = new TemporaryMemoryService({ pool: null, cleanupIntervalMs: 0 });
    const profileId = '11111111-1111-4111-8111-111111111111';
    service._ephemeralProfiles.set(profileId, {
        profile_id: profileId,
        display_name: 'Temporal',
        identity_confidence: 1,
        consent_status: 'temporary',
        retention_policy: '1d',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        entries: [],
    });
    const results = await Promise.allSettled([
        service.attachProfileToSession({ sessionId: 'session-b', profileId, consent: 'temporary' }),
        service.attachProfileToSession({ sessionId: 'session-c', profileId, consent: 'temporary' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'PROFILE_IN_USE').length, 1);
});

test('Fase 9 deletion: external vector failure is surfaced instead of false success', async () => {
    const profileId = '22222222-2222-4222-8222-222222222222';
    const service = new TemporaryMemoryService({
        pool: { async query() { return { rows: [], rowCount: 0 }; } },
        vectorStore: { async deleteByProfile() { throw new Error('chroma unavailable'); } },
        cleanupIntervalMs: 0,
    });
    service._ephemeralProfiles.set(profileId, {
        profile_id: profileId,
        consent_status: 'temporary',
        retention_policy: '1d',
        status: 'active',
        entries: [],
    });
    service._sessionProfiles.set('session-delete', profileId);
    await assert.rejects(
        service.forget({ sessionId: 'session-delete', profileId, scope: 'all' }),
        error => error.code === 'MEMORY_EXTERNAL_CLEANUP_FAILED',
    );
});

test('Fase 11 cleanup expirado no elimina memoria externa no vencida del perfil', async () => {
    const profileId = '33333333-3333-4333-8333-333333333333';
    const externalDeletes = [];
    const service = new TemporaryMemoryService({
        pool: {
            async query(sql) {
                if (sql.includes('SELECT memory_id, profile_id, memory_type')) {
                    return { rows: [{ memory_id: 'memory-name', profile_id: profileId, memory_type: 'name' }], rowCount: 1 };
                }
                return { rows: [], rowCount: 0 };
            },
        },
        vectorStore: {
            async deleteByProfile(id, memoryType) {
                externalDeletes.push({ id, memoryType });
                return 1;
            },
        },
        cleanupIntervalMs: 0,
    });
    await service.cleanupExpired({ source: 'test' });
    assert.deepEqual(externalDeletes, [{ id: profileId, memoryType: 'name' }]);
});

test('Fase 9 admin forget: selective ephemeral deletion keeps the profile binding', async () => {
    const service = new TemporaryMemoryService({ pool: null, cleanupIntervalMs: 0 });
    const profile = await service.createProfile({ sessionId: 'session-selective', consent: 'session_only' });
    await service.remember({ sessionId: 'session-selective', profileId: profile.profile_id, memoryType: 'preference', value: 'ceviche' });
    await service.adminForget({ profileId: profile.profile_id, scope: 'preference' });
    assert.equal(service.getBoundProfileId('session-selective'), profile.profile_id);
    assert.deepEqual((await service.summary({ sessionId: 'session-selective', profileId: profile.profile_id })).preferences, []);
});

test('Fase 9 kitchen projection: operational data excludes customer and session identifiers', () => {
    const projected = projectKitchenOrder({
        id: 'order-1',
        table_id: 'M8',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        clienteId: 'customer-secret',
        cliente_id: 'customer-secret',
        session_id: 'session-secret',
        declared_allergies: ['maní'],
        allergy_conflicts: ['maní'],
        special_warning: 'Revisión humana',
    });
    assert.equal(Object.hasOwn(projected, 'clienteId'), false);
    assert.equal(Object.hasOwn(projected, 'cliente_id'), false);
    assert.equal(Object.hasOwn(projected, 'session_id'), false);
    assert.deepEqual(projected.declared_allergies, ['maní']);
    assert.deepEqual(projected.allergy_conflicts, ['maní']);
});

test('Fase 9 HTTP boundary: profile context comes from the active session, not the request body', async () => {
    const session = {
        session_id: 'route-session',
        session_status: 'active',
        session_access_token: 'route-token',
        visit_id: 'visit-session',
        mesa: 'M8',
    };
    let observed = null;
    const manager = {
        get: id => id === session.session_id ? session : null,
        setMemoryProfile() {},
    };
    const memoryService = {
        async createProfile(args) {
            observed = args;
            return { profile_id: null, consent_status: 'disabled', expires_at: null };
        },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/memory', createMemoryRouter({ orderSessionManager: manager, memoryService }));
    const server = createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    try {
        const address = server.address();
        const unauthorized = await fetch(`http://127.0.0.1:${address.port}/api/memory/profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: session.session_id, consent: 'disabled' }),
        });
        assert.equal(unauthorized.status, 401);
        const response = await fetch(`http://127.0.0.1:${address.port}/api/memory/profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Session-Token': session.session_access_token },
            body: JSON.stringify({
                session_id: session.session_id,
                display_name: 'Declarado',
                consent: 'disabled',
                source: 'admin',
                visit_id: 'spoofed-visit',
                table_id: 'M99',
            }),
        });
        assert.equal(response.status, 201);
        assert.equal(observed.visitId, session.visit_id);
        assert.equal(observed.tableId, session.mesa);
        assert.equal(observed.source, 'user_declared');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
