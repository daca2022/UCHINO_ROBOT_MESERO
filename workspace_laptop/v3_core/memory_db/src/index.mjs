/**
 * @robot-mesero/memory-db
 * Punto de entrada público de persistencia.
 */

// Puertos
export { IRepository } from './ports/IRepository.mjs';
export { IVectorStore } from './ports/IVectorStore.mjs';

// Adaptadores
export { PostgresPedidoRepository } from './adapters/PostgresPedidoRepository.mjs';
export { PostgresMenuRepository } from './adapters/PostgresMenuRepository.mjs';
export { PostgresPersonalidadRepository } from './adapters/PostgresPersonalidadRepository.mjs';

// Servicios
export { MemoryService } from './services/MemoryService.mjs';
export {
    CONSENT_LEVELS,
    RETENTION_POLICIES,
    TemporaryMemoryService,
    buildMemoryExpiry,
    normalizeConsent,
    normalizeRetentionPolicy,
} from './services/TemporaryMemoryService.mjs';
