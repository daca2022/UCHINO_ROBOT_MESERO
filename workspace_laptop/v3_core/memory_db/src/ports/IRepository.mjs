/**
 * Interfaz de Repositorio Genérico — Contrato para persistencia estructurada
 * Implementado por: PostgresRepository, RedisRepository, etc.
 *
 * @template T — Tipo de entidad (Pedido, Cliente, Plato)
 */
export class IRepository {
    /**
     * Crea un nuevo registro.
     * @param {T} entity
     * @returns {Promise<T>}
     */
    async create(entity) {
        throw new Error('create() debe ser implementado');
    }

    /**
     * Obtiene un registro por ID.
     * @param {string|number} id
     * @returns {Promise<T|null>}
     */
    async findById(id) {
        throw new Error('findById() debe ser implementado');
    }

    /**
     * Lista registros con filtros opcionales.
     * @param {Object} filters
     * @param {Object} options — {limit, offset, orderBy}
     * @returns {Promise<{data: T[], total: number}>}
     */
    async findAll(filters = {}, options = {}) {
        throw new Error('findAll() debe ser implementado');
    }

    /**
     * Actualiza un registro.
     * @param {string|number} id
     * @param {Partial<T>} updates
     * @returns {Promise<T|null>}
     */
    async update(id, updates) {
        throw new Error('update() debe ser implementado');
    }

    /**
     * Elimina un registro.
     * @param {string|number} id
     * @returns {Promise<boolean>}
     */
    async delete(id) {
        throw new Error('delete() debe ser implementado');
    }

    /**
     * Verifica conectividad.
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        throw new Error('healthCheck() debe ser implementado');
    }
}
