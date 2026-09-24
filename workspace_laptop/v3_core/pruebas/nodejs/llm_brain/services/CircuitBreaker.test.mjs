import { describe, test, expect, beforeEach } from "bun:test";
import { CircuitBreaker } from "../../src/services/CircuitBreaker.mjs";

describe("CircuitBreaker", () => {
    let cb;

    beforeEach(() => {
        cb = new CircuitBreaker({
            failureThreshold: 3,
            resetTimeout: 100,
            halfOpenMaxAttempts: 2,
        });
    });

    test("starts in CLOSED state and canExecute returns true", () => {
        expect(cb.getState()).toBe("CLOSED");
        expect(cb.canExecute()).toBe(true);
    });

    test("after N failures state becomes OPEN and canExecute returns false", () => {
        cb.recordFailure();
        cb.recordFailure();
        expect(cb.getState()).toBe("CLOSED"); // still closed at 2
        expect(cb.canExecute()).toBe(true);

        cb.recordFailure(); // 3rd failure
        expect(cb.getState()).toBe("OPEN");
        expect(cb.canExecute()).toBe(false);
    });

    test("after resetTimeout state transitions to HALF_OPEN", async () => {
        cb.recordFailure();
        cb.recordFailure();
        cb.recordFailure();
        expect(cb.getState()).toBe("OPEN");

        // Wait for reset timeout
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(cb.getState()).toBe("HALF_OPEN");
        expect(cb.canExecute()).toBe(true);
    });

    test("success in HALF_OPEN transitions to CLOSED", async () => {
        cb.recordFailure();
        cb.recordFailure();
        cb.recordFailure();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(cb.getState()).toBe("HALF_OPEN");

        cb.recordSuccess();
        expect(cb.getState()).toBe("CLOSED");
        expect(cb.canExecute()).toBe(true);
    });

    test("failure in HALF_OPEN transitions back to OPEN", async () => {
        cb.recordFailure();
        cb.recordFailure();
        cb.recordFailure();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(cb.getState()).toBe("HALF_OPEN");

        cb.recordFailure();
        expect(cb.getState()).toBe("OPEN");
        expect(cb.canExecute()).toBe(false);
    });

    test("recordSuccess and recordFailure count correctly", () => {
        expect(cb.failureCount).toBe(0);
        cb.recordFailure();
        expect(cb.failureCount).toBe(1);
        cb.recordFailure();
        expect(cb.failureCount).toBe(2);
        cb.recordSuccess();
        expect(cb.failureCount).toBe(0);
    });

    test("getState returns correct state string", () => {
        expect(cb.getState()).toBe("CLOSED");
        cb.recordFailure();
        cb.recordFailure();
        cb.recordFailure();
        expect(cb.getState()).toBe("OPEN");
    });
});
