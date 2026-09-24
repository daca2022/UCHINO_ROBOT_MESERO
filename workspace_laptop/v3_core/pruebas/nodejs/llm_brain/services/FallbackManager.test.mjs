import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FallbackManager } from "../../src/services/FallbackManager.mjs";

function createMockProvider(name, { shouldFail = false, failAfter = Infinity, latency = 0 } = {}) {
    let callCount = 0;
    return {
        name,
        initSession: async () => {},
        sendText: async (text, history = []) => {
            callCount++;
            if (latency > 0) await new Promise((r) => setTimeout(r, latency));
            if (shouldFail || callCount >= failAfter) {
                throw new Error(`Provider ${name} failed`);
            }
            return { text: `Response from ${name}`, functionCalls: [] };
        },
        sendAudio: async () => ({ audio: Buffer.from("mock"), text: `Audio from ${name}`, functionCalls: [] }),
        sendImage: async () => ({ text: `Image from ${name}`, functionCalls: [] }),
        closeSession: async () => {},
        getModelInfo: () => ({ name }),
    };
}

describe("FallbackManager", () => {
    let manager;

    beforeEach(() => {
        manager = null;
    });

    afterEach(() => {
        if (manager) manager.stopHealthChecks();
    });

    test("executes operation on primary provider successfully", async () => {
        const primary = createMockProvider("primary");
        const secondary = createMockProvider("secondary");

        manager = new FallbackManager({
            providers: [
                { name: "primary", instance: primary, priority: 1 },
                { name: "secondary", instance: secondary, priority: 2 },
            ],
            circuitBreaker: { failureThreshold: 3, resetTimeout: 100 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 0, // disabled
        });

        const result = await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("hello", []);
        });

        expect(result.text).toBe("Response from primary");
        expect(manager.getActiveProvider().name).toBe("primary");
    });

    test("falls back to secondary when primary fails", async () => {
        const primary = createMockProvider("primary", { shouldFail: true });
        const secondary = createMockProvider("secondary");

        manager = new FallbackManager({
            providers: [
                { name: "primary", instance: primary, priority: 1 },
                { name: "secondary", instance: secondary, priority: 2 },
            ],
            circuitBreaker: { failureThreshold: 3, resetTimeout: 100 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 0,
        });

        const result = await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("hello", []);
        });

        expect(result.text).toBe("Response from secondary");
        expect(manager.getActiveProvider().name).toBe("secondary");
    });

    test("falls back to tertiary when primary and secondary fail", async () => {
        const primary = createMockProvider("primary", { shouldFail: true });
        const secondary = createMockProvider("secondary", { shouldFail: true });
        const tertiary = createMockProvider("tertiary");

        manager = new FallbackManager({
            providers: [
                { name: "primary", instance: primary, priority: 1 },
                { name: "secondary", instance: secondary, priority: 2 },
                { name: "tertiary", instance: tertiary, priority: 3 },
            ],
            circuitBreaker: { failureThreshold: 3, resetTimeout: 100 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 0,
        });

        const result = await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("hello", []);
        });

        expect(result.text).toBe("Response from tertiary");
        expect(manager.getActiveProvider().name).toBe("tertiary");
    });

    test("circuit breaker opens after N failures on one provider", async () => {
        const primary = createMockProvider("primary", { shouldFail: true });
        const secondary = createMockProvider("secondary");

        manager = new FallbackManager({
            providers: [
                { name: "primary", instance: primary, priority: 1 },
                { name: "secondary", instance: secondary, priority: 2 },
            ],
            circuitBreaker: { failureThreshold: 2, resetTimeout: 1000 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 0,
        });

        // First call fails, fallback to secondary
        await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("hello", []);
        });

        // Second call fails again, circuit should open
        await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("hello", []);
        });

        const status = manager.getProviderStatus();
        const primaryStatus = status.find((s) => s.name === "primary");
        expect(primaryStatus.circuitBreaker).toBe("OPEN");
    });

    test("all providers down throws AllProvidersFailedError", async () => {
        const primary = createMockProvider("primary", { shouldFail: true });
        const secondary = createMockProvider("secondary", { shouldFail: true });

        manager = new FallbackManager({
            providers: [
                { name: "primary", instance: primary, priority: 1 },
                { name: "secondary", instance: secondary, priority: 2 },
            ],
            circuitBreaker: { failureThreshold: 3, resetTimeout: 1000 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 0,
        });

        let error;
        try {
            await manager.executeWithFallback(async (provider) => {
                return await provider.sendText("hello", []);
            });
        } catch (err) {
            error = err;
        }

        expect(error).toBeDefined();
        expect(error.name).toBe("AllProvidersFailedError");
    });

    test("health check pings all providers every N ms", async () => {
        const primary = createMockProvider("primary", { shouldFail: true });
        const secondary = createMockProvider("secondary");

        manager = new FallbackManager({
            providers: [
                { name: "primary", instance: primary, priority: 1 },
                { name: "secondary", instance: secondary, priority: 2 },
            ],
            circuitBreaker: { failureThreshold: 1, resetTimeout: 50 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 100,
        });

        // Force primary circuit open
        try {
            await manager.executeWithFallback(async (provider) => {
                return await provider.sendText("hello", []);
            });
        } catch {}

        expect(manager.getProviderStatus().find((s) => s.name === "primary").circuitBreaker).toBe("OPEN");

        // Wait for health check to run and close the circuit
        await new Promise((resolve) => setTimeout(resolve, 250));

        const status = manager.getProviderStatus();
        expect(status.find((s) => s.name === "primary").circuitBreaker).toBe("CLOSED");
    });

    test("onProviderSwitch event fired correctly", async () => {
        const primary = createMockProvider("primary", { shouldFail: true });
        const secondary = createMockProvider("secondary");

        manager = new FallbackManager({
            providers: [
                { name: "primary", instance: primary, priority: 1 },
                { name: "secondary", instance: secondary, priority: 2 },
            ],
            circuitBreaker: { failureThreshold: 3, resetTimeout: 100 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 0,
        });

        let switchEvent = null;
        manager.onProviderSwitch = (from, to) => {
            switchEvent = { from, to };
        };

        await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("hello", []);
        });

        expect(switchEvent).toBeDefined();
        expect(switchEvent.from).toBe("primary");
        expect(switchEvent.to).toBe("secondary");
    });

    test("getActiveProvider returns current active provider name", async () => {
        const primary = createMockProvider("primary");
        const secondary = createMockProvider("secondary");

        manager = new FallbackManager({
            providers: [
                { name: "primary", instance: primary, priority: 1 },
                { name: "secondary", instance: secondary, priority: 2 },
            ],
            circuitBreaker: { failureThreshold: 3, resetTimeout: 100 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 0,
        });

        expect(manager.getActiveProvider().name).toBe("primary");

        await manager.executeWithFallback(async (provider) => {
            return await provider.sendText("hello", []);
        });

        expect(manager.getActiveProvider().name).toBe("primary");
    });
});
