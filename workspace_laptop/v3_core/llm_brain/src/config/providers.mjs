import { QwenCloudAdapter } from '../adapters/QwenCloudAdapter.mjs';
import { QwenAdapter } from '../adapters/QwenAdapter.mjs';

const SPANISH_CAFE_PROMPT = `Eres Uchino, un robot mesero amable y eficiente que trabaja en una cafetería peruana en Lima. Atiendes a clientes en un ambiente universitario (UTEC) y debes reflejar calidez peruana.

Debes responder SIEMPRE en español peruano, con un tono cordial, cercano y profesional. Usa expresiones peruanas comunes cuando sea apropiado: "al toque" (rápido), "claro pe" (por supuesto), "ahorita" (en un momento), "chévere" (genial), "bacán" (excelente), "de todas maneras" (por supuesto).

Conoces el menú típico de cafetería peruana: café pasado, americano, expreso, capuchino, empanadas, sánguches (pollo, jamón, palta), jugos naturales (naranja, maracuyá, fresa), postres (tres leches, suspiro limeño, alfajores). Cuando un cliente pide "un cafecito" o "un juguito", entiendes que es con cariño y respondes con igual calidez.

Peruvian Spanish specifics:
- "palta" = aguacate (NO digas "aguacate")
- "sánguche" = sandwich (NO digas "bocadillo" ni "emparedado")
- "café pasado" = café filtrado tradicional
- "para llevar" o "para servir" = take-out o para consumir aquí
- "al paso" = pedido rápido para llevar
- "yapa" = algo extra (cuando el cliente bromea pidiendo)
- "pata" / "causa" = amigo (coloquial, úsalo solo si el cliente lo usa primero)
- "la cuenta" o "la chapita" = la factura
- "¿Qué se le antoja?" = ¿Qué desea ordenar?
- "¡Al toque nomás!" = ¡Enseguida!
- "con confianza nomás" = dígame sin pena/tranquilo

REGLAS:
- Siempre responde en español peruano natural, no en español neutro.
- Sé breve y directo — los clientes no quieren esperar.
- Si el cliente no especifica cantidad, asume 1.
- Confirma los pedidos antes de enviarlos a cocina repitiendo el detalle.
- Si algo no está claro, pide aclaración amablemente: "¿Me repites porfa?" o "¿Algo más te ofrezco?"
- Usa "usted" por defecto (respetuoso), cambia a "tú" solo si el cliente lo hace primero.
- Si el cliente usa jerga peruana, responde en el mismo tono para crear confianza.
- Ante quejas o demoras: "Disculpa la demora, ahorita te lo traigo" con empatía.

FUNCIONES DISPONIBLES:
Usa las funciones disponibles según lo que el cliente necesite.
No inventes funciones que no estén en la lista.`;

const DEFAULT_TOOLS = [{
    functionDeclarations: [
        {
            name: 'registrar_pedido',
            description: 'Registra el pedido provisional del cliente.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    mesa: { type: 'STRING' },
                    platos: {
                        type: 'ARRAY', items: {
                            type: 'OBJECT', properties: {
                                nombre: { type: 'STRING' },
                                cantidad: { type: 'INTEGER' },
                                notas: { type: 'STRING' },
                                precio: { type: 'NUMBER' }
                            }
                        }
                    },
                    bebida: { type: 'STRING' },
                    total: { type: 'NUMBER' }
                },
                required: ['platos']
            }
        },
        {
            name: 'confirmar_pedido',
            description: 'Confirma y envía el pedido a cocina.',
            parameters: { type: 'OBJECT', properties: {} }
        },
        {
            name: 'cancelar_pedido',
            description: 'Cancela el pedido actual.',
            parameters: { type: 'OBJECT', properties: {} }
        },
        {
            name: 'ir_a_lugar',
            description: 'Mueve el robot a un lugar específico.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    lugar: { type: 'STRING', enum: ['MESA', 'COCINA', 'UTENSILIOS', 'BEBIDAS', 'CAJA', 'BASE'] }
                },
                required: ['lugar']
            }
        },
        {
            name: 'expresar_emocion',
            description: 'Cambia la expresión del robot en la pantalla.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    emocion: { type: 'STRING', enum: ['feliz', 'emocionado', 'pensando', 'sorprendido', 'guiño', 'triste', 'celebrando'] },
                    mensaje: { type: 'STRING' }
                },
                required: ['emocion']
            }
        },
        {
            name: 'mostrar_menu',
            description: 'Muestra el menú del día.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    etapa: { type: 'STRING', enum: ['platos', 'bebidas', 'completo'] }
                }
            }
        },
        {
            name: 'guardar_memoria',
            description: 'Guarda información a largo plazo.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    categoria: { type: 'STRING', enum: ['cliente', 'preferencia', 'hecho', 'configuracion'] },
                    clave: { type: 'STRING' },
                    valor: { type: 'STRING' }
                },
                required: ['categoria', 'clave', 'valor']
            }
        }
    ]
}];

function createOpenRouterProvider(model) {
    return new QwenCloudAdapter({
        baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        model: model || process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash',
        systemPrompt: SPANISH_CAFE_PROMPT,
        tools: DEFAULT_TOOLS,
        timeout: 20000,
    });
}

function createOpenRouterFallbackProvider() {
    return new QwenCloudAdapter({
        baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        model: process.env.OPENROUTER_FALLBACK_MODEL || 'meta-llama/llama-3.1-8b-instruct',
        systemPrompt: SPANISH_CAFE_PROMPT,
        tools: DEFAULT_TOOLS,
        timeout: 20000,
    });
}

function createOllamaFallbackProvider() {
    return new QwenAdapter({
        baseUrl: process.env.OLLAMA_HOST || 'http://localhost:11434',
        model: process.env.QWEN35_9B_MODEL || 'qwen3.5:9b',
        systemPrompt: SPANISH_CAFE_PROMPT,
        tools: DEFAULT_TOOLS,
        requestTimeout: parseInt(process.env.QWEN35_9B_TIMEOUT_MS || '30000', 10),
    });
}

function createQwenVisionProvider() {
    return new QwenCloudAdapter({
        baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        model: process.env.OPENROUTER_VISION_MODEL || 'qwen/qwen3-vl-8b-instruct',
        systemPrompt: 'Eres un asistente que describe imágenes de forma concisa y precisa en español. Solo describe lo que ves, sin opiniones.',
        tools: [],
        timeout: 30000,
    });
}

export function createDefaultProviders() {
    return [
        { name: 'deepseek-v4-flash-openrouter', instance: createOpenRouterProvider(), priority: 1 },
        { name: 'llama-3.1-8b-instruct-openrouter', instance: createOpenRouterFallbackProvider(), priority: 2 },
        { name: 'qwen-9b-ollama', instance: createOllamaFallbackProvider(), priority: 3 },
    ];
}

export function createVisionProvider() {
    return createQwenVisionProvider();
}
