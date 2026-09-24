/**
 * Setup global para tests del módulo llm_brain.
 * Configura mocks, limpieza y helpers reutilizables.
 *
 * Importar en cada archivo de test:
 *   import { useTestSetup } from '../setup.mjs';
 *   const { mockFetch, provider } = useTestSetup();
 *
 *   beforeAll(() => mockFetch.install());
 *   afterEach(() => { mockFetch.reset(); provider.resetTestState(); });
 *   afterAll(() => mockFetch.uninstall());
 *
 * @module tests/setup
 */

import { beforeEach, afterEach, afterAll, beforeAll } from 'bun:test';
import { createMockFetch } from './helpers/mockFetch.mjs';
import { createTestLlmProvider } from './helpers/mockLlmProvider.mjs';

/**
 * Prepara el entorno de test con fetch mock y LLM provider mock.
 * Llama una vez por archivo de test para obtener las instancias.
 *
 * @returns {{ mockFetch: MockFetch, provider: TestLlmProvider }}
 */
export function useTestSetup() {
    const mockFetch = createMockFetch();
    const provider = createTestLlmProvider();

    beforeAll(() => {
        mockFetch.install();
    });

    afterEach(() => {
        mockFetch.reset();
        provider.resetTestState();
    });

    afterAll(() => {
        mockFetch.uninstall();
    });

    return { mockFetch, provider };
}
