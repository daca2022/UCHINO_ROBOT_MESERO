/**
 * Fixtures para tests del módulo llm_brain.
 * Datos de muestra: conversaciones, function calls y errores típicos.
 *
 * @module tests/helpers/fixtures
 */

/** Conversación de café típica: cliente pidiendo comida */
export const SAMPLE_CAFE_CONVERSATION = [
    { role: 'system', content: 'Eres un mesero amable y eficiente de un café-restaurante. Respondes en español.' },
    { role: 'user', content: 'Hola, ¿qué tal?' },
    { role: 'assistant', content: '¡Buenos días! Bienvenido. ¿Qué gusta ordenar el día de hoy?' },
    { role: 'user', content: 'Quiero un lomo saltado y una Inca Kola.' },
    { role: 'assistant', content: 'Excelente elección. Un lomo saltado y una Inca Kola. ¿Algo más?' },
    { role: 'user', content: 'Sí, un suspiro a la limeña de postre.' },
    { role: 'assistant', content: 'Perfecto, agregamos un suspiro a la limeña. Le confirmo su pedido en un momento.' },
];

/** Function call de registrar_pedido */
export const FUNCTION_CALL_REGISTRAR_PEDIDO = {
    name: 'registrar_pedido',
    args: {
        items: [
            { nombre: 'Lomo Saltado', cantidad: 1, notas: 'sin cebolla' },
            { nombre: 'Inca Kola', cantidad: 1, notas: '' },
            { nombre: 'Suspiro a la Limeña', cantidad: 1, notas: '' },
        ],
        mesa: 'M3',
    },
};

/** Function call de expresar_emocion (saludo/bienvenida) */
export const FUNCTION_CALL_EXPRESAR_EMOCION = {
    name: 'expresar_emocion',
    args: {
        emocion: 'feliz',
        mensaje: '¡Qué alegría tenerlos hoy en El Mesero!',
    },
};

/** Function call de guardar_memoria */
export const FUNCTION_CALL_GUARDAR_MEMORIA = {
    name: 'guardar_memoria',
    args: {
        clave: 'cliente_preferencia_mesa_3',
        valor: 'prefiere lomo saltado sin cebolla, le gusta el suspiro a la limeña',
    },
};

/** Error de timeout simulado */
export const ERROR_TIMEOUT = new Error('Request timeout: LLM no respondió en 30s');
ERROR_TIMEOUT.code = 'TIMEOUT';
ERROR_TIMEOUT.statusCode = 408;

/** Error de rate limit simulado */
export const ERROR_RATE_LIMIT = new Error('Rate limit exceeded: demasiadas solicitudes');
ERROR_RATE_LIMIT.code = 'RATE_LIMIT';
ERROR_RATE_LIMIT.statusCode = 429;

/** Error de autenticación simulado */
export const ERROR_AUTH = new Error('Authentication failed: API key inválida o expirada');
ERROR_AUTH.code = 'AUTH_ERROR';
ERROR_AUTH.statusCode = 401;

/** LlmResponse completa de registro de pedido */
export const LLM_RESPONSE_REGISTRAR_PEDIDO = {
    audio: null,
    text: '¡Perfecto! Su pedido ha sido registrado: Lomo Saltado (x1), Inca Kola (x1) y Suspiro a la Limeña (x1) para la mesa M3.',
    functionCalls: [FUNCTION_CALL_REGISTRAR_PEDIDO],
};

/** LlmResponse con emoción (sin function calls) */
export const LLM_RESPONSE_EMOCION = {
    audio: null,
    text: '¡Qué alegría tenerlos hoy en El Mesero!',
    functionCalls: [FUNCTION_CALL_EXPRESAR_EMOCION],
};

/** LlmResponse de despedida */
export const LLM_RESPONSE_DESPEDIDA = {
    audio: null,
    text: 'Gracias por su visita, ¡vuelva pronto!',
    functionCalls: [],
};

/** Mensaje del sistema típico para el robot mesero */
export const SYSTEM_PROMPT_MESERO =
    'Eres un mesero robot amable y eficiente. ' +
    'Respondes siempre en español. ' +
    'Usas function calls para registrar pedidos, expresar emociones y guardar recuerdos. ' +
    'Nunca inventas información que no hayas recibido del cliente.';
