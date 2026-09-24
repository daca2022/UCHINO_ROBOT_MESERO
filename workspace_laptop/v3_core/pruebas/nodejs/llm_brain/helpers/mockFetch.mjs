/**
 * Mock de fetch para tests — intercepta llamadas HTTP y devuelve respuestas controladas.
 *
 * Uso:
 *   import { createMockFetch } from './helpers/mockFetch.mjs';
 *   const mockFetch = createMockFetch();
 *   mockFetch.install();
 *   mockFetch.mock(/\/api\/chat/, { status: 200, body: '{"ok":true}' });
 *   const res = await fetch('https://api.example.com/api/chat');
 *   console.log(mockFetch.calls()); // [{ url, method, headers, body }]
 *   mockFetch.reset();
 *   mockFetch.uninstall();
 *
 * @module tests/helpers/mockFetch
 */

/**
 * Crea un interceptor de fetch configurable.
 * @returns {MockFetch} API de mock
 */
export function createMockFetch() {
    /** @type {Map<RegExp|string, {response: Response, delay: number}>} */
    const mocks = new Map();

    /** @type {Array<{url: string, method: string, headers: Record<string,string>, body: string|null}>} */
    const callLog = [];

    let originalFetch = null;
    let installed = false;

    /**
     * Crea un objeto Response a partir de opciones.
     * @param {{status?: number, body?: string|null, headers?: Record<string,string>}} opts
     * @returns {Response}
     */
    function buildResponse({ status = 200, body = '', headers = {} } = {}) {
        const h = new Headers(headers);
        if (!h.has('content-type') && typeof body === 'string' && body.startsWith('{')) {
            h.set('content-type', 'application/json');
        }
        return new Response(body, { status, statusText: status === 200 ? 'OK' : 'Error', headers: h });
    }

    /**
     * Encuentra el primer mock que matchea la URL.
     * @param {string} urlStr
     * @returns {{response: Response, delay: number}|undefined}
     */
    function findMock(urlStr) {
        for (const [pattern, entry] of mocks) {
            if (typeof pattern === 'string') {
                if (urlStr === pattern || urlStr.includes(pattern)) return entry;
            } else if (pattern instanceof RegExp) {
                if (pattern.test(urlStr)) return entry;
            }
        }
        return undefined;
    }

    /** @param {RequestInfo|URL} input @param {RequestInit} [init] */
    async function mockFetchFn(input, init = {}) {
        const urlStr = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.toString()
                : input.url;

        const method = init.method || (input instanceof Request ? input.method : 'GET');
        const reqHeaders = init.headers || (input instanceof Request ? Object.fromEntries(input.headers.entries()) : {});
        const body = init.body || (input instanceof Request ? input.body : null) || null;

        callLog.push({ url: urlStr, method, headers: reqHeaders, body });

        const match = findMock(urlStr);
        if (!match) {
            throw new Error(`[mockFetch] No hay mock registrado para: ${urlStr}`);
        }

        const { response, delay } = match;

        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        return response.clone();
    }

    return {
        /**
         * Registra una respuesta mock para un patrón de URL.
         * @param {string|RegExp} urlPattern - Patrón de URL a interceptar
         * @param {object} opts
         * @param {number} [opts.status=200] - Código HTTP
         * @param {string} [opts.body=''] - Cuerpo de la respuesta
         * @param {Record<string,string>} [opts.headers={}] - Headers HTTP
         * @param {number} [opts.delay=0] - Retardo artificial en ms (útil para timeout)
         */
        mock(urlPattern, { status = 200, body = '', headers = {}, delay = 0 } = {}) {
            const response = buildResponse({ status, body, headers });
            mocks.set(urlPattern, { response, delay });
        },

        /**
         * Devuelve el registro de llamadas realizadas al mock.
         * @returns {Array<{url: string, method: string, headers: Record<string,string>, body: string|null}>}
         */
        calls() {
            return [...callLog];
        },

        /** Limpia todos los mocks y el registro de llamadas. */
        reset() {
            mocks.clear();
            callLog.length = 0;
        },

        /** Reemplaza globalThis.fetch con el mock. */
        install() {
            if (installed) return;
            originalFetch = globalThis.fetch;
            Object.defineProperty(globalThis, 'fetch', {
                value: mockFetchFn,
                configurable: true,
                writable: true,
            });
            installed = true;
        },

        /** Restaura el fetch original. */
        uninstall() {
            if (!installed) return;
            Object.defineProperty(globalThis, 'fetch', {
                value: originalFetch,
                configurable: true,
                writable: true,
            });
            originalFetch = null;
            installed = false;
        },

        /** Indica si el mock está actualmente instalado. */
        get installed() {
            return installed;
        },
    };
}
