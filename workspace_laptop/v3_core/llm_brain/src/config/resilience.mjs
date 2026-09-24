/**
 * Resilience Configuration — Timeouts, circuit breakers, health checks, retries.
 *
 * These constants are used by FallbackManager and CircuitBreaker to
 * configure provider resilience behavior. All sensitive values (API keys)
 * come from environment variables; this file only holds operational thresholds.
 */

export const PROVIDER_CONFIG = {
  OPENROUTER: {
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    timeout: 20000,
    maxRetries: 2,
    baseDelay: 1000,
  },
  OLLAMA_LOCAL: {
    baseUrl: process.env.OLLAMA_HOST || 'http://localhost:11434',
    timeout: 30000,
    maxRetries: 1,
    baseDelay: 2000,
  },
};

export const CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 5,      // 5 consecutive failures → OPEN circuit
  resetTimeout: 30000,      // 30 seconds before HALF_OPEN test
  halfOpenMaxAttempts: 2,   // Allow 2 test requests in HALF_OPEN state
};

export const HEALTH_CHECK_CONFIG = {
  interval: 30000,          // Check every 30 seconds
  timeout: 5000,            // 5 second timeout per health ping
};

export const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,          // Start at 1 second
  maxDelay: 8000,           // Cap at 8 seconds
  backoffMultiplier: 2,     // Exponential: 1s → 2s → 4s → 8s
};

export const LOGGING_CONFIG = {
  providerSwitch: 'info',
  circuitBreaker: 'warn',
  retry: 'debug',
};
