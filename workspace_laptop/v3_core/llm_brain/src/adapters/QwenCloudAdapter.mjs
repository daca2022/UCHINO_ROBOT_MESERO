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
        },
        {
            name: 'render_ui',
            description: 'MUY IMPORTANTE: Renderiza un componente visual en la pantalla táctil del robot. Usa esta herramienta cuando el cliente pida ver algo visual (precios, fotos, menú, cuenta, alertas) o cuando quieras mostrar información gráfica. Siempre responde con TTS además de renderizar.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    componente: {
                        type: 'STRING',
                        enum: ['showDish', 'showMenu', 'showOrder', 'showTotal', 'showAlert', 'showGreeting'],
                        description: 'Componente a renderizar'
                    },
                    props: {
                        type: 'OBJECT',
                        description: 'Propiedades del componente según el tipo:\n- showDish: { nombre, precio, descripcion, imagen?, delivery?, categoria? }\n- showMenu: { categoria?, platos: [{ nombre, precio, descripcion }] }\n- showOrder: { platos: [{ nombre, cantidad, precio }], total }\n- showTotal: { subtotal, delivery, total, metodo_pago? }\n- showAlert: { mensaje, tipo: "info"|"warning"|"error"|"success" }\n- showGreeting: { mensaje, nombre_cliente? }'
                    }
                },
                required: ['componente', 'props']
            }
        }
    ]
}];

/**
 * Adaptador para Qwen3.5-Flash vía API cloud (DashScope / OpenRouter).
 * Usa el formato OpenAI-compatible: /chat/completions
 */
export class QwenCloudAdapter extends ILlmProvider {
    constructor({
        baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey = '',
        model = 'qwen3.5-flash',
        systemPrompt = SPANISH_CAFE_PROMPT,
        tools = DEFAULT_TOOLS,
        timeout = 30000,
    } = {}) {
        super();
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.apiKey = apiKey;
        this.modelName = model;
        this.systemPrompt = systemPrompt;
        this.tools = tools;
        this.requestTimeout = timeout;
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
        throw new Error('QwenCloudAdapter: sendAudio not supported. Pipeline is STT→text→LLM.');
    }

    async sendText(text, history = []) {
        this._ensureSession();
        const ROLE_MAP = { model: 'assistant', user: 'user', system: 'system' };
        const contextMessages = history.length > 0
            ? history.map(m => ({ role: ROLE_MAP[m.role] || m.role, content: m.content }))
            : [];
        this.messages = [
            { role: 'system', content: this.systemPrompt },
            ...contextMessages,
            { role: 'user', content: text }
        ];
        return this._chat();
    }

    async sendImage(image, prompt) {
        this._ensureSession();
        this.messages = [
            { role: 'system', content: this.systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
                ],
            },
        ];
        return this._chat();
    }

    async closeSession() {
        this.sessionActive = false;
        this.messages = [];
    }

    getModelInfo() {
        return {
            name: this.modelName,
            version: 'cloud-openai-compatible',
            modality: ['text', 'image'],
        };
    }

    // ── Internal ──────────────────────────────────────────

    async _chatStream(onChunk) {
        const body = {
            model: this.modelName,
            messages: this.messages,
            stream: true,
            temperature: 0.3,
            max_tokens: 120,
        };
        // Para voz: NO usar tools (queremos texto conversacional, no function calling)
        // y deshabilitar reasoning de deepseek (ahorra 5-10s de latencia)
        const useTools = this._voiceMode === true ? false : (this.tools && this.tools.length > 0);
        if (useTools) {
            const openAiTools = this._convertTools(this.tools);
            if (openAiTools.length > 0) {
                body.tools = openAiTools;
            }
        }
        if (this._voiceMode === true && this.modelName?.includes('deepseek')) {
            body.reasoning = { enabled: false };
        }

        const url = `${this.baseUrl}/chat/completions`;
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'Accept': 'text/event-stream',
            },
            body: JSON.stringify(body),
        };

        const response = await this._fetchWithRetry(url, options);
        if (!response.ok) {
            const errText = await response.text().catch(() => 'unknown');
            throw new Error(`LLM stream failed: ${response.status} ${errText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let chunkCount = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                console.error('[STREAM] done, total chunks:', chunkCount, 'content len:', fullContent.length);
                break;
            }
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') {
                    console.error('[STREAM] [DONE] received, content:', fullContent.length);
                    if (fullContent && onChunk) onChunk(fullContent, true);
                    return fullContent;
                }
                try {
                    const parsed = JSON.parse(data);
                    chunkCount++;
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        fullContent += delta;
                        if (onChunk) onChunk(fullContent, false);
                    } else if (parsed.choices?.[0]?.finish_reason) {
                        console.error('[STREAM] finish_reason:', parsed.choices[0].finish_reason);
                    }
                } catch (e) {
                    console.error('[STREAM] parse error:', e.message, 'data:', data.slice(0, 100));
                }
            }
        }
        if (fullContent && onChunk) onChunk(fullContent, true);
        return fullContent;
    }

    async _chat() {
        const body = {
            model: this.modelName,
            messages: this.messages,
            stream: false,
            temperature: 0.3,
            max_tokens: 200,
        };

        const openAiTools = this._convertTools(this.tools);
        if (openAiTools.length > 0) {
            body.tools = openAiTools;
        }

        const url = `${this.baseUrl}/chat/completions`;
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
        };

        console.error('[DEBUG-ADAPTER] _chat() called');
        console.error('[DEBUG-ADAPTER] baseUrl:', this.baseUrl);
        console.error('[DEBUG-ADAPTER] modelName:', this.modelName);
        console.error('[DEBUG-ADAPTER] apiKey prefix:', this.apiKey?.substring(0, 10) + '...');
        console.error('[DEBUG-ADAPTER] messages count:', this.messages?.length);
        console.error('[DEBUG-ADAPTER] url:', url);

        const response = await this._fetchWithRetry(url, options);

        console.error('[DEBUG-ADAPTER] response status:', response?.status);
        console.error('[DEBUG-ADAPTER] response ok:', response?.ok);

        if (!response.ok) {
            const errText = await response.text().catch(() => 'unknown');
            throw new Error(`QwenCloudAdapter: HTTP ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const message = data.choices?.[0]?.message || {};

        const result = {
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

    async _fetchWithRetry(url, options, maxRetries = 3) {
        const delays = [1000, 2000, 4000];
        let lastError;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            console.error('[DEBUG-ADAPTER] _fetchWithRetry attempt', attempt, '/', maxRetries);
            try {
                const response = await this._fetchWithTimeout(url, options, this.requestTimeout);
                if (response.ok || response.status < 500) {
                    return response;
                }
                // 5xx → retryable
                lastError = new Error(`HTTP ${response.status}`);
                console.error('[DEBUG-ADAPTER] _fetchWithRetry 5xx error, will retry:', lastError.message);
            } catch (err) {
                lastError = err;
                console.error('[DEBUG-ADAPTER] _fetchWithRetry error:', lastError?.message);
            }

            if (attempt < maxRetries) {
                await this._sleep(delays[attempt]);
            }
        }

        throw new Error(`QwenCloudAdapter: sendText falló después de ${maxRetries + 1} intentos: ${lastError.message}`);
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

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _ensureSession() {
        if (!this.sessionActive) {
            throw new Error('QwenCloudAdapter: sesión no iniciada. Llama initSession() primero.');
        }
    }
}
