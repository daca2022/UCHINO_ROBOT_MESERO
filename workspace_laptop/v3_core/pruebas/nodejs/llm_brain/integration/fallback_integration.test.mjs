import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FallbackManager } from "../../src/services/FallbackManager.mjs";
import { CircuitBreaker } from "../../src/services/CircuitBreaker.mjs";
import { createTestLlmProvider } from "../helpers/mockLlmProvider.mjs";

/**
 * Crea un proveedor mock que siempre falla.
 * @param {string} name
 * @param {number} priority
 * @returns {{name: string, instance: object, priority: number}}
 */
function createFailingProvider(name, priority) {
    const provider = createTestLlmProvider(name);
    provider.sendText = async function () {
        throw new Error(`${name} unavailable`);
    };
    return { name, instance: provider, priority };
}

/**
 * Crea un proveedor mock que responde exitosamente.
 * @param {string} name
 * @param {number} priority
 * @returns {{name: string, instance: object, priority: number}}
 */
function createSuccessfulProvider(name, priority) {
    const provider = createTestLlmProvider(name);
    provider.sendText = async function () {
        return { text: `Response from ${name}`, functionCalls: [] };
    };
    return { name, instance: provider, priority };
}

describe("Fallback Integration — 3-Provider Chain", () => {
    let manager;

    beforeEach(() => {
        manager = null;
    });

    afterEach(() => {
        if (manager) manager.stopHealthChecks();
    });

    test("all providers up → primary responds", async () => {
        const providers = [
            createSuccessfulProvider("qwen-flash-dashscope", 1),
            createSuccessfulProvider("qwen-flash-openrouter", 2),
            createSuccessfulProvider("qwen-ollama-local", 3),
        ];
        manager = new FallbackManager({
            providers,
            circuitBreaker: { failureThreshold: 3, resetTimeout: 100 },
            retry: { maxRetries: 0, baseDelay: 0 },
            healthCheckInterval: 0,
        });

        const result = await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("Hola", []);
        });

        expect(result.text).toContain("dashscope");
        expect(manager.getActiveProvider().name).toBe("qwen-flash-dashscope");
    });

    test("primary down → secondary responds", async () => {
        const providers = [
            createFailingProvider("dashscope", 1),
            createSuccessfulProvider("openrouter", 2),
        ];
        manager = new FallbackManager({
            providers,
            circuitBreaker: { failureThreshold: 3, resetTimeout: 100 },
            retry: { maxRetries: 0, baseDelay: 0 },
            healthCheckInterval: 0,
        });

        const result = await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("Hola", []);
        });

        expect(result.text).toContain("openrouter");
        expect(manager.getActiveProvider().name).toBe("openrouter");
    });

    test("primary+secondary down → tertiary responds", async () => {
        const providers = [
            createFailingProvider("dashscope", 1),
            createFailingProvider("openrouter", 2),
            createSuccessfulProvider("ollama", 3),
        ];
        manager = new FallbackManager({
            providers,
            circuitBreaker: { failureThreshold: 3, resetTimeout: 100 },
            retry: { maxRetries: 0, baseDelay: 0 },
            healthCheckInterval: 0,
        });

        const result = await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("Hola", []);
        });

        expect(result.text).toContain("ollama");
        expect(manager.getActiveProvider().name).toBe("ollama");
    });

    test("all providers down → throws error", async () => {
        const providers = [
            createFailingProvider("dashscope", 1),
            createFailingProvider("openrouter", 2),
            createFailingProvider("ollama", 3),
        ];
        manager = new FallbackManager({
            providers,
            circuitBreaker: { failureThreshold: 3, resetTimeout: 100 },
            retry: { maxRetries: 0, baseDelay: 0 },
            healthCheckInterval: 0,
        });

        await expect(
            manager.executeWithFallback(async (provider) => {
                return await provider.sendText("Hola", []);
            })
        ).rejects.toThrow();
    });

    test("circuit breaker recovers after timeout", async () => {
        const providers = [
            createFailingProvider("dashscope", 1),
            createSuccessfulProvider("openrouter", 2),
        ];
        manager = new FallbackManager({
            providers,
            circuitBreaker: { failureThreshold: 2, resetTimeout: 100 },
            retry: { maxRetries: 0, baseDelay: 0 },
            healthCheckInterval: 0,
        });

        // Open circuit with 2 failures on dashscope
        for (let i = 0; i < 2; i++) {
            await manager
                .executeWithFallback(async (provider) => {
                    return await provider.sendText("test", []);
                })
                .catch(() => {});
        }

        // Verify circuit is OPEN
        const statusBefore = manager.getProviderStatus();
        expect(statusBefore.find((s) => s.name === "dashscope").circuitBreaker).toBe("OPEN");

        // Wait for circuit to reset (HALF_OPEN)
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Now make dashscope succeed
        providers[0].instance.sendText = async function () {
            return { text: "Recovered dashscope", functionCalls: [] };
        };

        const result = await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("Hola", []);
        });

        expect(result.text).toContain("Recovered");
        expect(manager.getActiveProvider().name).toBe("dashscope");
    });

    test("rapid flapping → circuit breaker prevents thrashing", async () => {
        const providers = [
            createFailingProvider("dashscope", 1),
            createSuccessfulProvider("openrouter", 2),
        ];
        manager = new FallbackManager({
            providers,
            circuitBreaker: { failureThreshold: 2, resetTimeout: 500 },
            retry: { maxRetries: 0, baseDelay: 0 },
            healthCheckInterval: 0,
        });

        // Rapidly fail dashscope 2 times to open the circuit
        for (let i = 0; i < 2; i++) {
            await manager
                .executeWithFallback(async (provider) => {
                    return await provider.sendText("flap", []);
                })
                .catch(() => {});
        }

        // Circuit should be OPEN now
        const status = manager.getProviderStatus();
        expect(status.find((s) => s.name === "dashscope").circuitBreaker).toBe("OPEN");

        // Subsequent calls should skip dashscope and go straight to openrouter
        // without thrashing (re-trying dashscope on every call)
        const results = [];
        for (let i = 0; i < 3; i++) {
            const result = await manager.executeWithFallback(async (provider) => {
                return await provider.sendText("stable", []);
            });
            results.push(result.text);
        }

        // All 3 calls should have hit openrouter, not dashscope
        for (const text of results) {
            expect(text).toContain("openrouter");
        }

        // Verify dashscope circuit is still OPEN (not thrashing between OPEN/CLOSED)
        const finalStatus = manager.getProviderStatus();
        expect(finalStatus.find((s) => s.name === "dashscope").circuitBreaker).toBe("OPEN");
    });
});
