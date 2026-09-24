/**
 * Fase 10 — contrato único para texto visual y texto hablado.
 *
 * Este módulo es deliberadamente local, puro y determinista. El texto que se
 * muestra en pantalla se conserva; sólo la copia destinada a voz se limpia,
 * naturaliza y segmenta.
 */

const DEFAULT_OPTIONS = Object.freeze({
    locale: 'es-PE',
    maxSegmentLength: 180,
    preserveProductNames: true,
    normalizeCurrency: true,
    normalizeNumbers: true,
    removeEmojis: true,
    technicalContext: false,
    listContext: null,
});

const UNITS = Object.freeze([
    'cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
]);
const TEENS = Object.freeze({
    10: 'diez', 11: 'once', 12: 'doce', 13: 'trece', 14: 'catorce', 15: 'quince',
    16: 'dieciséis', 17: 'diecisiete', 18: 'dieciocho', 19: 'diecinueve',
});
const TENS = Object.freeze({
    20: 'veinte', 30: 'treinta', 40: 'cuarenta', 50: 'cincuenta',
    60: 'sesenta', 70: 'setenta', 80: 'ochenta', 90: 'noventa',
});
const HUNDREDS = Object.freeze({
    1: 'ciento', 2: 'doscientos', 3: 'trescientos', 4: 'cuatrocientos',
    5: 'quinientos', 6: 'seiscientos', 7: 'setecientos', 8: 'ochocientos',
    9: 'novecientos',
});

function numberToWords(value) {
    const number = Math.trunc(Number(value));
    if (!Number.isFinite(number) || number < 0 || number > 999999999) return String(value);
    if (number < 10) return UNITS[number];
    if (number < 20) return TEENS[number];
    if (number < 30) {
        if (number === 20) return 'veinte';
        if (number === 22) return 'veintidós';
        if (number === 23) return 'veintitrés';
        if (number === 26) return 'veintiséis';
        return `veinti${UNITS[number - 20]}`;
    }
    if (number < 100) {
        const ten = Math.floor(number / 10) * 10;
        const unit = number % 10;
        return unit ? `${TENS[ten]} y ${UNITS[unit]}` : TENS[ten];
    }
    if (number < 1000) {
        if (number === 100) return 'cien';
        const hundred = Math.floor(number / 100);
        const rest = number % 100;
        return rest ? `${HUNDREDS[hundred]} ${numberToWords(rest)}` : HUNDREDS[hundred].replace('ciento', 'cien');
    }
    if (number < 1000000) {
        const thousands = Math.floor(number / 1000);
        const rest = number % 1000;
        const prefix = thousands === 1 ? 'mil' : `${numberToWords(thousands)} mil`;
        return rest ? `${prefix} ${numberToWords(rest)}` : prefix;
    }
    const millions = Math.floor(number / 1000000);
    const rest = number % 1000000;
    const prefix = millions === 1 ? 'un millón' : `${numberToWords(millions)} millones`;
    return rest ? `${prefix} ${numberToWords(rest)}` : prefix;
}

function parseDecimal(value) {
    const normalized = String(value).replace(',', '.');
    const number = Number(normalized);
    if (!Number.isFinite(number)) return null;
    const [whole, fraction = ''] = normalized.split('.');
    const cents = fraction.slice(0, 2).padEnd(2, '0');
    return { number, whole: Math.trunc(Number(whole)), cents: Number(cents) };
}

function numberPhrase(value) {
    const normalized = String(value).replace(',', '.');
    if (!normalized.includes('.')) return numberToWords(normalized);
    const [whole, fraction = ''] = normalized.split('.');
    const trimmedFraction = fraction.replace(/0+$/u, '') || '0';
    return `${numberToWords(whole)} punto ${numberToWords(Number(trimmedFraction))}`;
}

function moneyToWords(value) {
    const parsed = parseDecimal(value);
    if (!parsed) return String(value);
    const { whole, cents } = parsed;
    if (whole === 0 && cents > 0) return `${numberToWords(cents)} céntimos`;
    const unit = whole === 1 ? 'sol' : 'soles';
    return cents > 0
        ? `${numberToWords(whole)} ${unit} con ${numberToWords(cents)} céntimos`
        : `${numberToWords(whole)} ${unit}`;
}

function fromInput(input) {
    if (input === null || input === undefined) return '';
    if (typeof input === 'string') return input;
    if (typeof input !== 'object') return String(input);
    const candidate = input.display_text ?? input.displayText ?? input.text
        ?? input.response_text ?? input.speech_text ?? input.message ?? input.response;
    if (typeof candidate === 'string') return candidate;
    try { return JSON.stringify(input); } catch { return ''; }
}

function extractJsonMessage(text) {
    const trimmed = text.trim();
    if (!/^[{[]/.test(trimmed)) return text;
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') return parsed;
        if (Array.isArray(parsed)) return parsed.map(fromInput).filter(Boolean).join('. ');
        const candidate = parsed.speech_text ?? parsed.response_text ?? parsed.text
            ?? parsed.message ?? parsed.response ?? parsed.error;
        return typeof candidate === 'string' ? candidate : text;
    } catch {
        return text;
    }
}

function removeTechnicalIdentifiers(text, state) {
    let result = text;
    const before = result;
    result = result
        .replace(/\b(?:order|session|visit|request|simulation|event)[_-]?id\s*[:=]\s*[^\s,;.)]+/giu, '')
        .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, '')
        .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, '')
        .replace(/\b(?:session_id|order_id|visit_id|request_id|simulation_id)\b/giu, '');
    state.technicalIdsRemoved ||= result !== before;
    return result;
}

function linkReplacement(label, url) {
    const normalized = String(label || '').toLowerCase();
    if (normalized.includes('menú') || normalized.includes('menu') || /\/robot\b/i.test(url)) {
        return 'Puedes ver el menú en la pantalla.';
    }
    if (normalized.includes('pedido') || normalized.includes('orden')) {
        return 'Puedes ver tu pedido en la pantalla.';
    }
    return label || 'Puedes ver esa información en la pantalla.';
}

function stripMarkdown(text, state) {
    let result = text;
    const before = result;
    const hadUrl = /(?:\[[^\]]+\]\(https?:\/\/[^)]+\)|https?:\/\/[^\s)\]}>]+)/iu.test(result);
    result = result
        .replace(/```[\s\S]*?```/g, '')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => linkReplacement(label, url))
        .replace(/https?:\/\/[^\s)\]}>]+/giu, (url) => linkReplacement('', url))
        .replace(/`[^`]*`/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*\n]+)\*/g, '$1')
        .replace(/_([^_\n]+)_/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s*/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '');
    // Las URLs nunca se leen completas, aunque un caller intente desactivar
    // la limpieza: es una política de seguridad del canal de voz, no una
    // preferencia visual configurable.
    if (hadUrl) {
        state.urlsRemoved = true;
        state.markdownRemoved = true;
    } else if (result !== before) {
        state.markdownRemoved = true;
    }
    if (result !== before) state.symbolsRemoved ||= true;
    return result;
}

function joinNatural(items) {
    const values = items.map(value => {
        const item = String(value).trim();
        return item ? item.charAt(0).toLowerCase() + item.slice(1) : item;
    }).filter(Boolean);
    if (values.length <= 1) return values[0] || '';
    const last = values.at(-1);
    const conjunction = /^(?:i|hi)[áéíóúü]?/iu.test(last) ? 'e' : 'y';
    if (values.length === 2) return `${values[0]} ${conjunction} ${last}`;
    return `${values.slice(0, -1).join(', ')} ${conjunction} ${last}`;
}

function cleanListItem(value) {
    return String(value || '')
        .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/u, '')
        .replace(/[|]+/g, ' ')
        .trim();
}

function naturalizeLists(text, state, options) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    const listItems = [];
    const nonList = [];
    let heading = null;
    let sawList = false;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/^\|?\s*:?[-]+:?\s*(?:\|\s*:?[-]+:?\s*)+\|?$/u.test(line)) {
            state.markdownRemoved = true;
            continue;
        }
        const bullet = line.match(/^(?:[-*+•]|\d+[.)])\s+(.+)$/u);
        if (bullet) {
            sawList = true;
            listItems.push(cleanListItem(bullet[1]));
            continue;
        }
        const tableCells = line.split('|').map(cell => cell.trim()).filter(Boolean);
        if (line.includes('|') && tableCells.length > 1) {
            sawList = true;
            listItems.push(tableCells.join(', '));
            state.markdownRemoved = true;
            continue;
        }
        if (!sawList && !listItems.length && !nonList.length && /:$/u.test(line)) {
            heading = line.slice(0, -1).trim();
            continue;
        }
        if (sawList && !nonList.length && /:$/u.test(line)) {
            heading = line.slice(0, -1).trim();
            continue;
        }
        nonList.push(line);
    }

    if (listItems.length < 2) return text;
    const source = String(text).toLowerCase();
    const orderContext = options.listContext === 'order'
        || /pedido|orden|total/u.test(source)
        || (!heading && !/opciones|disponib|tenemos/u.test(source));
    const catalogContext = options.listContext === 'catalog' || !orderContext;
    const maxItems = catalogContext ? 3 : listItems.length;
    const visibleItems = listItems.slice(0, maxItems);
    const listSentence = orderContext
        ? `Tu pedido contiene ${joinNatural(visibleItems)}.`
        : heading && !/^opciones?$/iu.test(heading)
            ? `En ${heading.toLowerCase()} tenemos ${joinNatural(visibleItems)}.`
            : `Tenemos ${joinNatural(visibleItems)}.`;
    const extra = catalogContext && listItems.length > 3
        ? ' Puedes ver más opciones en la pantalla.'
        : '';
    state.markdownRemoved = true;
    return [listSentence + extra, ...nonList].join(' ');
}

function naturalizeInlineCatalog(text, state, options) {
    if (options.listContext === 'order') return text;
    return String(text).replace(
        /\b((?:en\s+esta\s+categor[ií]a|tenemos|opciones\s+disponibles|puedes\s+elegir)[^:]*):\s*([^.!?\n]+)/giu,
        (full, prefix, rawList) => {
            const hasMoreHint = /\by\s+otras?\s+opciones?\b|\bm[aá]s\s+opciones?\b|\bver\s+(?:el\s+)?men[uú]\b/iu.test(rawList);
            const list = rawList
                .replace(/\s+y\s+otras?\s+opciones?.*$/iu, '')
                .replace(/\s+y\s+m[aá]s\s+opciones?.*$/iu, '')
                .trim();
            const items = list
                .split(/,\s*/u)
                .flatMap((item, index, all) => index === all.length - 1 ? item.split(/\s+y\s+/iu) : [item])
                .map(cleanListItem)
                .filter(Boolean);
            if (items.length < 4) return full;
            state.catalogLimited = true;
            const visible = items.slice(0, 3);
            const extra = hasMoreHint || items.length > 3
                ? ' Puedes ver más opciones en la pantalla.'
                : '';
            return `${prefix.trim()} ${joinNatural(visible)}.${extra}`;
        },
    );
}

function replaceCurrency(text, state) {
    let result = text;
    const currency = /\b(?:S\s*\/\.?|PEN)\s*([0-9]+(?:[.,][0-9]{1,2})?)\b/giu;
    result = result.replace(currency, (_, amount) => {
        state.currencyNormalized = true;
        return moneyToWords(amount);
    });
    result = result.replace(/\b([0-9]+(?:[.,][0-9]{1,2})?)\s+soles?\b/giu, (_, amount) => {
        state.currencyNormalized = true;
        return moneyToWords(amount);
    });
    return result;
}

function replaceTables(text, state) {
    let result = text;
    result = result
        .replace(/\bmesa\s*:\s*M(1[0-2]|[1-9])\b/giu, (_, number) => `Mesa ${numberToWords(number)}`)
        .replace(/\bmesa\s+M(1[0-2]|[1-9])\b/giu, (_, number) => `mesa ${numberToWords(number)}`)
        .replace(/\bM(1[0-2]|[1-9])\b/gu, (_, number) => `mesa ${numberToWords(number)}`);
    state.numbersNormalized ||= result !== text;
    return result;
}

function replaceNumbers(text, state) {
    let result = text;
    result = result
        .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/gu, (_, hour, minute) => {
            state.numbersNormalized = true;
            return `${numberToWords(hour)} y ${numberToWords(minute)}`;
        })
        .replace(/\b(\d+(?:[.,]\d+)?)\s*%/gu, (_, value) => {
            state.numbersNormalized = true;
            return `${numberPhrase(value)} por ciento`;
        })
        .replace(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|ml)\b/giu, (_, value, unit) => {
            state.numbersNormalized = true;
            const labels = { kg: 'kilogramos', g: 'gramos', ml: 'mililitros' };
            return `${numberPhrase(value)} ${labels[unit.toLowerCase()]}`;
        })
        .replace(/\b(\d+)[.,](\d+)\b/gu, (_, whole, fraction) => {
            state.numbersNormalized = true;
            return numberPhrase(`${whole}.${fraction}`);
        })
        .replace(/\b\d+\b/gu, (value) => {
            state.numbersNormalized = true;
            return numberToWords(value);
        });
    return result;
}

function replaceAbbreviations(text, state) {
    const before = text;
    let result = text
        .replace(/\baprox\.?\b/giu, 'aproximadamente')
        .replace(/\bmin\.?\b/giu, 'minutos')
        .replace(/\bseg\.?\b/giu, 'segundos')
        .replace(/\bn[uú]m\.?\b/giu, 'número')
        .replace(/\bROS\s*2\b/giu, (match) => match && state.technicalContext ? 'ROS dos' : '')
        .replace(/\bROS2\b/giu, (match) => match && state.technicalContext ? 'ROS dos' : '');
    state.abbreviationsNormalized ||= result !== before;
    return result;
}

function normalizeSymbols(text, state) {
    const before = text;
    let result = text
        .replace(/→|←|➜|➡/gu, '. ')
        .replace(/&/g, ' y ')
        .replace(/[|{}[\]<>]/g, ' ')
        .replace(/\//g, ', ')
        .replace(/[()]/g, '')
        .replace(/\+\s*/g, ' más ')
        .replace(/\.{3,}/g, '.')
        .replace(/!{2,}/g, '.')
        .replace(/\?{2,}/g, '?')
        .replace(/\s*;\s*/g, '. ')
        .replace(/\s*:\s*/g, '. ')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/[*_`#]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    state.symbolsRemoved ||= result !== before;
    return result.replace(/\.\s*\./g, '.').replace(/\s+/g, ' ').trim();
}

function capitalizeSentences(text) {
    let result = text.replace(/\bNO\b/gu, 'No');
    result = result.replace(/(^|[.!?]\s+)([a-záéíóúñü])/gu, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
    return result;
}

function buildMetadata(state, { segmentsCount, inputLength, outputLength, durationMs }) {
    return {
        markdown_removed: state.markdownRemoved,
        symbols_removed: state.symbolsRemoved,
        numbers_normalized: state.numbersNormalized,
        currency_normalized: state.currencyNormalized,
        abbreviations_normalized: state.abbreviationsNormalized,
        urls_removed: state.urlsRemoved,
        technical_ids_removed: state.technicalIdsRemoved,
        catalog_limited: state.catalogLimited,
        technical_context: state.technicalContext,
        segments_count: segmentsCount,
        input_length: inputLength,
        output_length: outputLength,
        duration_ms: durationMs,
    };
}

function normalizePedidoTotal(text, state, options) {
    const match = text.match(/^\s*Tu\s+pedido\s*\.\s*(.+?)\s*\.\s*Total\s*\.\s*(.+?)\s*\.?$/iu)
        || text.match(/^\s*Tu\s+pedido\s*:\s*(.+?)\s*\.\s*Total\s*:\s*(.+?)\s*\.?$/iu);
    if (!match) return text;
    const items = normalizeSymbols(replaceNumbers(replaceCurrency(match[1], state), state), state).replace(/\.$/u, '').trim();
    const total = normalizeSymbols(replaceCurrency(match[2], state), state).replace(/\.$/u, '').trim();
    state.numbersNormalized ||= /\d/u.test(match[1]);
    return `Tu pedido contiene ${items}. El total es de ${total}.`;
}

function splitSegments(text, maxLength) {
    if (!text) return [];
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) || [];
    const segments = [];
    for (const sentence of sentences.map(item => item.trim()).filter(Boolean)) {
        if (sentence.length <= maxLength) {
            segments.push(sentence);
            continue;
        }
        const clauses = sentence.split(/(?<=[,;])\s+/u).filter(Boolean);
        let current = '';
        for (const clause of clauses) {
            if (clause.length > maxLength) {
                const words = clause.split(/\s+/u);
                for (const word of words) {
                    if (!current) current = word;
                    else if (`${current} ${word}`.length <= maxLength) current += ` ${word}`;
                    else { segments.push(current.trim()); current = word; }
                }
                continue;
            }
            if (!current) current = clause;
            else if (`${current} ${clause}`.length <= maxLength) current += ` ${clause}`;
            else { segments.push(current.trim()); current = clause; }
        }
        if (current.trim()) segments.push(current.trim());
    }
    return segments;
}

/**
 * @param {string|object|null} input
 * @param {object} options
 * @returns {{displayText: string, speechText: string, segments: string[], metadata: object}}
 */
export function sanitizeForSpeech(input, options = {}) {
    const startedAt = Date.now();
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const displayText = fromInput(input);
    const state = {
        markdownRemoved: false,
        symbolsRemoved: false,
        numbersNormalized: false,
        currencyNormalized: false,
        abbreviationsNormalized: false,
        urlsRemoved: false,
        technicalIdsRemoved: false,
        catalogLimited: false,
        technicalContext: Boolean(merged.technicalContext),
    };
    if (!displayText.trim()) {
        return {
            displayText,
            speechText: '',
            segments: [],
            metadata: buildMetadata(state, {
                segmentsCount: 0,
                inputLength: displayText.length,
                outputLength: 0,
                durationMs: Date.now() - startedAt,
            }),
        };
    }

    let text = extractJsonMessage(displayText);
    text = removeTechnicalIdentifiers(text, state);
    text = naturalizeLists(stripMarkdown(text, state), state, merged);
    text = naturalizeInlineCatalog(text, state, merged);
    text = replaceTables(text, state);
    text = replaceCurrency(text, state);
    text = replaceAbbreviations(text, state);
    if (merged.normalizeNumbers !== false) text = replaceNumbers(text, state);
    text = normalizePedidoTotal(text, state, merged);
    text = normalizeSymbols(text, state);
    text = capitalizeSentences(text);
    const speechText = text.replace(/\s+/g, ' ').trim();
    const segments = splitSegments(speechText, Math.max(40, Number(merged.maxSegmentLength) || 180));

    return {
        displayText,
        speechText,
        segments,
        metadata: buildMetadata(state, {
            segmentsCount: segments.length,
            inputLength: displayText.length,
            outputLength: speechText.length,
            durationMs: Date.now() - startedAt,
        }),
    };
}

export function speechPayload(result, extra = {}) {
    return {
        display_text: result.displayText,
        speech_text: result.speechText,
        speech_segments: result.segments,
        sanitization: result.metadata,
        ...extra,
    };
}

export { moneyToWords, numberToWords, splitSegments };
