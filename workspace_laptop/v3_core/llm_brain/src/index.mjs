/**
 * @robot-mesero/llm-brain
 * Punto de entrada público del cerebro multimodal.
 */

// Puertos (contratos)
export { ILlmProvider } from './ports/ILlmProvider.mjs';

// Adaptadores
export { MockLlmProvider } from './adapters/MockLlmProvider.mjs';
export { QwenAdapter } from './adapters/QwenAdapter.mjs';
export { QwenCloudAdapter } from './adapters/QwenCloudAdapter.mjs';

// Servicios de orquestación
export { LlmOrchestrator } from './services/LlmOrchestrator.mjs';
