import { ILlmProvider } from '../ports/ILlmProvider.mjs';

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

export class QwenAdapter extends ILlmProvider {
    constructor({
        baseUrl = process.env.OLLAMA_HOST || 'http://localhost:11434',
        model = process.env.QWEN_MODEL || 'qwen3:14b',
        systemPrompt = SPANISH_CAFE_PROMPT,
        tools = DEFAULT_TOOLS,
        requestTimeout = parseInt(process.env.QWEN_TIMEOUT_MS || '30000', 10),
        keepAlive = process.env.QWEN_KEEP_ALIVE || '5m',
        unloadOnClose = true,
    } = {}) {
        super();
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.modelName = model;
        this.systemPrompt = systemPrompt;
        this.tools = tools;
        this.requestTimeout = requestTimeout;
        this.keepAlive = keepAlive;
        this.unloadOnClose = unloadOnClose;
        this.messages = [];
        this.sessionActive = false;
    }

    async initSession(systemPrompt) {
        if (systemPrompt) this.systemPrompt = systemPrompt;
        this.messages = [
            { role: 'system', content: this.systemPrompt }
        ];
        this.sessionActive = true;
    }

    async sendAudio(_pcm16, _sampleRate) {
        throw new Error('QwenAdapter: sendAudio no soportado. Qwen3 es solo texto.');
    }

    async sendText(text, history = []) {
        this._ensureSession();
        const contextMessages = history.length > 0
            ? history.map(m => ({ role: m.role, content: m.content }))
            : [];
        this.messages = [
            { role: 'system', content: this.systemPrompt },
            ...contextMessages,
            { role: 'user', content: text }
        ];
        return this._chat();
    }

    async sendImage(_image, _prompt) {
        throw new Error('QwenAdapter: sendImage no soportado. Qwen3 no es multimodal. Usa QwenCloudAdapter con Qwen3 VL 8B para vision.');
    }

    async closeSession() {
        this.sessionActive = false;
        this.messages = [];
        if (this.unloadOnClose) {
            await this._unloadModel().catch(() => {});
        }
    }

    getModelInfo() {
        return {
            name: this.modelName,
            version: 'ollama-qwen3-fallback',
            modality: ['text'],
        };
    }

    async _chat() {
        const body = {
            model: this.modelName,
            messages: this.messages,
            stream: false,
            options: {
                temperature: 0.3,
                top_p: 0.9,
            },
        };

        const ollamaTools = this._convertTools(this.tools);
        if (ollamaTools.length > 0) {
            body.tools = ollamaTools;
        }

        const response = await this._fetchWithTimeout(
            `${this.baseUrl}/api/chat`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            },
            this.requestTimeout
        );

        if (!response.ok) {
            const errText = await response.text().catch(() => 'unknown');
            throw new Error(`QwenAdapter: Ollama error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const message = data.message || {};

        const result = {
            audio: null,
            text: message.content || '',
            functionCalls: [],
        };

        if (message.tool_calls?.length > 0) {
            result.functionCalls = message.tool_calls.map(tc => {
                const fn = tc.function || tc;
                let args = {};
                if (typeof fn.arguments === 'string') {
                    try { args = JSON.parse(fn.arguments); } catch { args = {}; }
                } else if (fn.arguments) {
                    args = fn.arguments;
                }
                return { name: fn.name, args };
            });
        }

        return result;
    }

    _convertTools(tools) {
        if (!tools?.length) return [];
        const result = [];
        for (const tool of tools) {
            if (tool.functionDeclarations) {
                for (const fn of tool.functionDeclarations) {
                    result.push({
                        type: 'function',
                        function: {
                            name: fn.name,
                            description: fn.description,
                            parameters: this._convertSchema(fn.parameters || {}),
                        },
                    });
                }
            }
        }
        return result;
    }

    _convertSchema(params) {
        const schema = { type: 'object' };
        if (params.description) schema.description = params.description;
        if (params.properties) {
            schema.properties = {};
            for (const [key, val] of Object.entries(params.properties)) {
                schema.properties[key] = this._convertProp(val);
            }
        }
        if (params.required) schema.required = params.required;
        return schema;
    }

    _convertProp(val) {
        const result = { type: this._toJsonType(val.type) };
        if (val.description) result.description = val.description;
        if (val.enum) result.enum = val.enum;
        if (val.items) {
            result.items = { type: this._toJsonType(val.items.type) };
            if (val.items.properties) {
                result.items.properties = {};
                for (const [k, v] of Object.entries(val.items.properties)) {
                    result.items.properties[k] = this._convertProp(v);
                }
            }
        }
        return result;
    }

    _toJsonType(geminiType) {
        const map = {
            STRING: 'string',
            INTEGER: 'integer',
            NUMBER: 'number',
            BOOLEAN: 'boolean',
            OBJECT: 'object',
            ARRAY: 'array',
        };
        return map[geminiType] || 'string';
    }

    async _fetchWithTimeout(url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    async _unloadModel() {
        await fetch(`${this.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.modelName,
                keep_alive: '0s',
            }),
        });
    }

    _ensureSession() {
        if (!this.sessionActive) {
            throw new Error('QwenAdapter: sesión no iniciada. Llama initSession() primero.');
        }
    }
}
