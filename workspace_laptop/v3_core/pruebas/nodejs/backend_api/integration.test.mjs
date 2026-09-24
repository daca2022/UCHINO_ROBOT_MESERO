import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../src/index.mjs';

describe('Integración Backend API', () => {
    it('debe crear la app y tener rutas definidas', async () => {
        const { app } = await createApp();
        assert.ok(app);

        const routes = app._router.stack
            .filter(r => r.route)
            .map(r => r.route.path);

        assert.ok(routes.includes('/api/status'));
        assert.ok(routes.includes('/api/menu'));
        assert.ok(routes.includes('/api/pedidos'));
        assert.ok(routes.includes('/api/pedidos/activos'));
        assert.ok(routes.includes('/api/cocina/cola'));
        assert.ok(routes.includes('/api/recorrido/iniciar'));
        assert.ok(routes.includes('/api/recorrido/estado'));
        assert.ok(routes.includes('/api/robot/estado'));
    });
});
