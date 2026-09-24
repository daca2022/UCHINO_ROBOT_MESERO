/**
 * Entidad de dominio: Cliente
 * Perfil del cliente para memoria y personalización.
 */
export class Cliente {
    constructor({
        id = crypto.randomUUID(),
        nombre = null,
        caraEmbedding = null,     // Para reconocimiento facial
        preferencias = [],        // ['picante', 'sin_gluten', 'café_descafeinado']
        historialPedidos = [],
        frecuencia = 0,
        ultimaVisita = null,
        notas = '',
    }) {
        this.id = id;
        this.nombre = nombre;
        this.caraEmbedding = caraEmbedding;
        this.preferencias = preferencias;
        this.historialPedidos = historialPedidos;
        this.frecuencia = frecuencia;
        this.ultimaVisita = ultimaVisita;
        this.notas = notas;
    }

    agregarPreferencia(pref) {
        if (!this.preferencias.includes(pref)) {
            this.preferencias.push(pref);
        }
        return this;
    }

    registrarVisita(pedidoId) {
        this.frecuencia += 1;
        this.ultimaVisita = new Date().toISOString();
        this.historialPedidos.push(pedidoId);
        return this;
    }

    toJSON() {
        return {
            id: this.id,
            nombre: this.nombre,
            caraEmbedding: this.caraEmbedding,
            preferencias: this.preferencias,
            historialPedidos: this.historialPedidos,
            frecuencia: this.frecuencia,
            ultimaVisita: this.ultimaVisita,
            notas: this.notas,
        };
    }
}
