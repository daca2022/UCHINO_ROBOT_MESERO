import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RecorridoService } from '../src/services/RecorridoService.mjs';

describe('RecorridoService — Navegación', () => {
    function crearMockRobot() {
        return {
            comandos: [],
            goTo: async (lugar) => { comandos.push(lugar); },
        };
    }

    it('debe iniciar recorrido con etapas correctas', async () => {
        const robot = { goTo: async () => {} };
        const svc = new RecorridoService({ robotCommand: robot });

        const estado = await svc.iniciarRecorrido('ped-1', 'M3');
        assert.strictEqual(estado.activo, true);
        assert.strictEqual(estado.pedidoId, 'ped-1');
        assert.strictEqual(estado.etapaActual, 'cocina');
        assert.strictEqual(estado.totalEtapas, 5);
        assert.strictEqual(estado.progreso, 0);
    });

    it('debe avanzar etapas secuencialmente', async () => {
        const robot = { goTo: async () => {} };
        const svc = new RecorridoService({ robotCommand: robot });
        await svc.iniciarRecorrido('ped-2', 'M1');

        await svc.avanzar(); // utensilios
        let estado = svc.obtenerEstado();
        assert.strictEqual(estado.etapaActual, 'utensilios');
        assert.strictEqual(estado.progreso, 25);

        await svc.avanzar(); // bebidas
        estado = svc.obtenerEstado();
        assert.strictEqual(estado.etapaActual, 'bebidas');
        assert.strictEqual(estado.progreso, 50);
    });

    it('debe fallar al avanzar sin recorrido activo', async () => {
        const svc = new RecorridoService({ robotCommand: { goTo: async () => {} } });
        await assert.rejects(svc.avanzar(), /No hay recorrido activo/);
    });

    it('debe fallar al avanzar si recorrido está completo', async () => {
        const robot = { goTo: async () => {} };
        const svc = new RecorridoService({ robotCommand: robot });
        await svc.iniciarRecorrido('ped-3', 'M2');

        // Avanzar hasta el final
        await svc.avanzar(); // utensilios
        await svc.avanzar(); // bebidas
        await svc.avanzar(); // mesa
        await svc.avanzar(); // base (última)

        await assert.rejects(svc.avanzar(), /Recorrido ya completado/);
    });

    it('debe cancelar y volver a base', async () => {
        const robot = { comandos: [], goTo: async (l) => robot.comandos.push(l) };
        const svc = new RecorridoService({ robotCommand: robot });
        await svc.iniciarRecorrido('ped-4', 'M5');

        const res = await svc.cancelar();
        assert.strictEqual(res.cancelado, true);
        assert.strictEqual(robot.comandos.includes('BASE'), true);
    });

    it('debe archivar recorridos en historial', async () => {
        const robot = { goTo: async () => {} };
        const svc = new RecorridoService({ robotCommand: robot });
        await svc.iniciarRecorrido('ped-5', 'M1');
        await svc.cancelar();

        const hist = svc.obtenerHistorial();
        assert.strictEqual(hist.length, 1);
        assert.strictEqual(hist[0].resultado, 'cancelado');
    });

    it('debe limitar historial a 50 recorridos', async () => {
        const robot = { goTo: async () => {} };
        const svc = new RecorridoService({ robotCommand: robot });

        for (let i = 0; i < 55; i++) {
            await svc.iniciarRecorrido(`ped-${i}`, 'M1');
            await svc.cancelar();
        }

        assert.strictEqual(svc.historial.length, 50);
    });
});
