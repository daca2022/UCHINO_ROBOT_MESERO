/**
 * Interfaz de Almacén Vectorial — Para memoria semántica y búsqueda por similitud
 * Implementado por: ChromaAdapter, pgvector, etc.
 */
export class IVectorStore {
    /**
     * Almacena un texto con su embedding.
     * @param {string} collection — Namespace (ej. 'clientes', 'menu')
     * @param {string} id — Identificador único
     * @param {string} text — Texto a vectorizar
     * @param {Object} metadata — Datos adicionales (ej. {clienteId, timestamp})
     * @returns {Promise<void>}
     */
    async add(collection, id, text, metadata = {}) {
        throw new Error('add() debe ser implementado');
    }

    /**
     * Busca documentos similares a una query.
     * @param {string} collection
     * @param {string} query — Texto de búsqueda
     * @param {number} k — Número de resultados
     * @returns {Promise<Array<{id: string, text: string, score: number, metadata: Object}>>}
     */
    async search(collection, query, k = 5) {
        throw new Error('search() debe ser implementado');
    }

    /**
     * Elimina un documento del almacén.
     * @param {string} collection
     * @param {string} id
     * @returns {Promise<void>}
     */
    async remove(collection, id) {
        throw new Error('remove() debe ser implementado');
    }

    /**
     * Crea una colección si no existe.
     * @param {string} collection
     * @returns {Promise<void>}
     */
    async createCollection(collection) {
        throw new Error('createCollection() debe ser implementado');
    }

    /**
     * Verifica conectividad.
     * @returns {Promise<boolean>}
     */
    async healthCheck() {
        throw new Error('healthCheck() debe ser implementado');
    }
}
