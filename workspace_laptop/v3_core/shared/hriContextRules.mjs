export const HRI_CONTEXT_LABELS = Object.freeze({
    reposo_base: 'Reposo en base',
    recepcion_orden_admin: 'Recepcion de orden de mesero/admin',
    llegada_mesa: 'Llegada a mesa',
    explicacion_modos: 'Explicacion de los 3 modos',
    conversacion_general: 'Conversacion general',
    toma_pedido_voz: 'Toma de pedido por voz',
    correccion_pedido: 'Correccion de pedido',
    confirmacion_final: 'Confirmacion final',
    envio_cocina: 'Envio a cocina',
    solicitud_cuenta: 'Solicitud de cuenta',
    manejo_queja: 'Manejo de queja',
    llamada_mesero: 'Llamada a mesero humano',
    navegacion_advertencia: 'Navegacion y advertencias de movimiento',
    pausa_error_tecnico: 'Pausa o error tecnico',
});

export const HRI_CONTEXT_KEYS = Object.freeze(Object.keys(HRI_CONTEXT_LABELS));

export const DEFAULT_HRI_CONTEXT_RULES = Object.freeze({
    reposo_base: 'Mantente disponible, breve y sin iniciar pedidos si nadie te llama. Si despiertas por wake word, saluda y pregunta en que mesa o flujo debes ayudar.',
    recepcion_orden_admin: 'Confirma el destino indicado por el mesero o Admin, repite la mesa si existe y no inventes rutas ni pedidos.',
    llegada_mesa: 'Anuncia tu llegada, presentate como Uchino y ofrece los tres modos de atencion sin presionar al cliente.',
    explicacion_modos: 'Explica en una frase cada modo: voz, tableta o mesero humano. Cierra preguntando cual prefiere.',
    conversacion_general: 'Responde dudas sobre menu, precios, ingredientes o el servicio. Si la pregunta deriva en pedido, pasa a toma de pedido por voz.',
    toma_pedido_voz: 'Extrae productos, cantidades y notas. Mantén el pedido como borrador hasta que el cliente confirme.',
    correccion_pedido: 'Acepta cambios sin discutir, confirma solo el item corregido y conserva el resto del pedido.',
    confirmacion_final: 'Lee el resumen del pedido con cantidades, notas y total si esta disponible. Pide confirmacion explicita antes de enviar a cocina.',
    envio_cocina: 'Informa que el pedido fue enviado a cocina y evita prometer tiempos exactos si no hay dato real.',
    solicitud_cuenta: 'Aclara que puedes avisar al personal o iniciar el flujo de pago disponible. No inventes cobros ni metodos no configurados.',
    manejo_queja: 'Reconoce el problema, disculpate brevemente y escala a humano si hay demora, error de pedido, molestia o riesgo de mala experiencia.',
    llamada_mesero: 'Confirma que llamaras a un mesero humano y marca requires_human cuando el flujo tenga pedido o incidencia asociada.',
    navegacion_advertencia: 'Antes de moverte, avisa el destino y pide espacio. Durante movimiento, prioriza seguridad sobre conversacion.',
    pausa_error_tecnico: 'Explica el fallo en lenguaje simple, ofrece repetir o llamar a un humano, y no ocultes errores de red, audio o vision.',
});

const KEYWORD_CONTEXTS = [
    ['manejo_queja', ['queja', 'demora', 'tarde', 'mal', 'equivocado', 'frio', 'fría', 'molesto', 'reclamo']],
    ['solicitud_cuenta', ['cuenta', 'pagar', 'boleta', 'factura', 'cobrar', 'chapita']],
    ['llamada_mesero', ['mesero', 'humano', 'persona', 'atencion humana', 'llama a alguien']],
    ['correccion_pedido', ['corrige', 'corregir', 'cambiar', 'quita', 'agrega', 'mejor no', 'en vez de']],
    ['confirmacion_final', ['confirmo', 'confirmar', 'esta bien', 'está bien', 'asi nomas', 'así nomás']],
    ['toma_pedido_voz', ['quiero', 'pideme', 'pídeme', 'traeme', 'tráeme', 'dame', 'ordenar']],
    ['explicacion_modos', ['modos', 'como pido', 'cómo pido', 'voz', 'tableta', 'pantalla']],
    ['navegacion_advertencia', ['muevete', 'muévete', 'anda', 've a', 'ir a', 'lleva', 'cocina', 'base']],
    ['pausa_error_tecnico', ['error', 'no funciona', 'fallo', 'falló', 'sin audio', 'sin red']],
    ['llegada_mesa', ['llegaste', 'ya llegaste', 'mesa']],
];

const STATE_CONTEXTS = Object.freeze({
    idle: 'reposo_base',
    greeting: 'llegada_mesa',
    taking_order: 'toma_pedido_voz',
    confirming: 'correccion_pedido',
    confirming_order: 'confirmacion_final',
    delivering: 'navegacion_advertencia',
    farewell: 'conversacion_general',
});

export function normalizeContextRules(reglasContexto = {}) {
    const source = reglasContexto && typeof reglasContexto === 'object' ? reglasContexto : {};
    return HRI_CONTEXT_KEYS.reduce((acc, key) => {
        const value = source[key];
        acc[key] = typeof value === 'string' && value.trim()
            ? value.trim()
            : DEFAULT_HRI_CONTEXT_RULES[key];
        return acc;
    }, {});
}

export function detectHriContext({ text = '', state = '', explicitContext = '' } = {}) {
    if (HRI_CONTEXT_KEYS.includes(explicitContext)) return explicitContext;
    if (STATE_CONTEXTS[state]) return STATE_CONTEXTS[state];

    const normalizedText = String(text).toLowerCase();
    for (const [context, keywords] of KEYWORD_CONTEXTS) {
        if (keywords.some((keyword) => normalizedText.includes(keyword))) {
            return context;
        }
    }
    return 'conversacion_general';
}

export function buildHriContextCatalog(reglasContexto = {}) {
    const rules = normalizeContextRules(reglasContexto);
    return HRI_CONTEXT_KEYS
        .map((key) => `- ${HRI_CONTEXT_LABELS[key]} (${key}): ${rules[key]}`)
        .join('\n');
}

export function buildActiveHriContextBlock(reglasContexto = {}, context = {}) {
    const rules = normalizeContextRules(reglasContexto);
    const activeContext = detectHriContext(context);
    return [
        '',
        '## Contexto operativo activo',
        `- Contexto: ${HRI_CONTEXT_LABELS[activeContext]} (${activeContext})`,
        `- Regla: ${rules[activeContext]}`,
    ].join('\n');
}
