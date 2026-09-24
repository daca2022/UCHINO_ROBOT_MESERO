import { describe, test, expect } from "bun:test";
import {
  PROVIDER_CONFIG,
  CIRCUIT_BREAKER_CONFIG,
  HEALTH_CHECK_CONFIG,
  RETRY_CONFIG,
  LOGGING_CONFIG,
} from "../../src/config/resilience.mjs";

const VALID_LOG_LEVELS = ["debug", "info", "warn", "error"];

// ─── PROVIDER_CONFIG ────────────────────────────────────────────────────────

describe("PROVIDER_CONFIG", () => {
  const providers = ["OPENROUTER", "OLLAMA_LOCAL"];

  test("all providers are defined", () => {
    for (const name of providers) {
      expect(PROVIDER_CONFIG[name]).toBeDefined();
    }
  });

  describe("each provider", () => {
    for (const name of providers) {
      const cfg = PROVIDER_CONFIG[name];

      test(`${name} timeout > 0`, () => {
        expect(cfg.timeout).toBeGreaterThan(0);
      });

      test(`${name} maxRetries >= 0`, () => {
        expect(cfg.maxRetries).toBeGreaterThanOrEqual(0);
      });

      test(`${name} baseDelay > 0`, () => {
        expect(cfg.baseDelay).toBeGreaterThan(0);
      });

      test(`${name} baseUrl is a valid URL`, () => {
        const url = new URL(cfg.baseUrl);
        expect(url.protocol).toMatch(/^https?:$/);
        expect(url.hostname.length).toBeGreaterThan(0);
      });
    }
  });

  test("OPENROUTER baseUrl uses HTTPS", () => {
    expect(new URL(PROVIDER_CONFIG.OPENROUTER.baseUrl).protocol).toBe("https:");
  });

  test("OLLAMA_LOCAL baseUrl is HTTP (local)", () => {
    expect(new URL(PROVIDER_CONFIG.OLLAMA_LOCAL.baseUrl).protocol).toBe("http:");
  });

  test("timeout values are reasonable (<= 120000ms)", () => {
    for (const name of providers) {
      expect(PROVIDER_CONFIG[name].timeout).toBeLessThanOrEqual(120000);
    }
  });
});

// ─── CIRCUIT_BREAKER_CONFIG ─────────────────────────────────────────────────

describe("CIRCUIT_BREAKER_CONFIG", () => {
  test("failureThreshold > 0", () => {
    expect(CIRCUIT_BREAKER_CONFIG.failureThreshold).toBeGreaterThan(0);
  });

  test("failureThreshold < 100 (reasonable maximum)", () => {
    expect(CIRCUIT_BREAKER_CONFIG.failureThreshold).toBeLessThan(100);
  });

  test("resetTimeout > 0", () => {
    expect(CIRCUIT_BREAKER_CONFIG.resetTimeout).toBeGreaterThan(0);
  });

  test("resetTimeout is a reasonable value (≤ 300000ms)", () => {
    expect(CIRCUIT_BREAKER_CONFIG.resetTimeout).toBeLessThanOrEqual(300000);
  });

  test("halfOpenMaxAttempts > 0", () => {
    expect(CIRCUIT_BREAKER_CONFIG.halfOpenMaxAttempts).toBeGreaterThan(0);
  });

  test("halfOpenMaxAttempts ≤ failureThreshold (safety)", () => {
    expect(CIRCUIT_BREAKER_CONFIG.halfOpenMaxAttempts).toBeLessThanOrEqual(
      CIRCUIT_BREAKER_CONFIG.failureThreshold
    );
  });

  test("resetTimeout ≥ 1000ms (minimum practical)", () => {
    expect(CIRCUIT_BREAKER_CONFIG.resetTimeout).toBeGreaterThanOrEqual(1000);
  });
});

// ─── HEALTH_CHECK_CONFIG ────────────────────────────────────────────────────

describe("HEALTH_CHECK_CONFIG", () => {
  test("interval > 0", () => {
    expect(HEALTH_CHECK_CONFIG.interval).toBeGreaterThan(0);
  });

  test("timeout > 0", () => {
    expect(HEALTH_CHECK_CONFIG.timeout).toBeGreaterThan(0);
  });

  test("timeout < interval (no overlap)", () => {
    expect(HEALTH_CHECK_CONFIG.timeout).toBeLessThan(HEALTH_CHECK_CONFIG.interval);
  });

  test("interval ≥ 5000ms (minimum practical)", () => {
    expect(HEALTH_CHECK_CONFIG.interval).toBeGreaterThanOrEqual(5000);
  });
});

// ─── RETRY_CONFIG ───────────────────────────────────────────────────────────

describe("RETRY_CONFIG", () => {
  test("maxRetries >= 0", () => {
    expect(RETRY_CONFIG.maxRetries).toBeGreaterThanOrEqual(0);
  });

  test("baseDelay > 0", () => {
    expect(RETRY_CONFIG.baseDelay).toBeGreaterThan(0);
  });

  test("maxDelay >= baseDelay", () => {
    expect(RETRY_CONFIG.maxDelay).toBeGreaterThanOrEqual(RETRY_CONFIG.baseDelay);
  });

  test("backoffMultiplier > 1 (exponential backoff)", () => {
    expect(RETRY_CONFIG.backoffMultiplier).toBeGreaterThan(1);
  });

  test("maxRetries ≤ 10 (sane maximum)", () => {
    expect(RETRY_CONFIG.maxRetries).toBeLessThanOrEqual(10);
  });

  test("maxDelay ≤ 60000ms (1 minute cap)", () => {
    expect(RETRY_CONFIG.maxDelay).toBeLessThanOrEqual(60000);
  });

  test("baseDelay * backoffMultiplier^(maxRetries-1) ≤ maxDelay", () => {
    const worstCaseDelay =
      RETRY_CONFIG.baseDelay *
      Math.pow(RETRY_CONFIG.backoffMultiplier, RETRY_CONFIG.maxRetries - 1);
    expect(worstCaseDelay).toBeLessThanOrEqual(RETRY_CONFIG.maxDelay);
  });
});

// ─── LOGGING_CONFIG ─────────────────────────────────────────────────────────

describe("LOGGING_CONFIG", () => {
  test("providerSwitch is a valid log level", () => {
    expect(VALID_LOG_LEVELS).toContain(LOGGING_CONFIG.providerSwitch);
  });

  test("circuitBreaker is a valid log level", () => {
    expect(VALID_LOG_LEVELS).toContain(LOGGING_CONFIG.circuitBreaker);
  });

  test("retry is a valid log level", () => {
    expect(VALID_LOG_LEVELS).toContain(LOGGING_CONFIG.retry);
  });

  test("all keys are one of the expected names", () => {
    const keys = Object.keys(LOGGING_CONFIG);
    const expected = ["providerSwitch", "circuitBreaker", "retry"];
    expect(keys.sort()).toEqual(expected.sort());
  });
});

// ─── STRUCTURAL ─────────────────────────────────────────────────────────────

describe("module structure", () => {
  test("exports all 5 named configs", () => {
    const mod = require("../../src/config/resilience.mjs");
    expect(mod.PROVIDER_CONFIG).toBeDefined();
    expect(mod.CIRCUIT_BREAKER_CONFIG).toBeDefined();
    expect(mod.HEALTH_CHECK_CONFIG).toBeDefined();
    expect(mod.RETRY_CONFIG).toBeDefined();
    expect(mod.LOGGING_CONFIG).toBeDefined();
  });

  test("PROVIDER_CONFIG has exactly 2 providers", () => {
    const names = Object.keys(PROVIDER_CONFIG);
    expect(names.length).toBe(2);
    expect(names.sort()).toEqual(["OLLAMA_LOCAL", "OPENROUTER"]);
  });
});
