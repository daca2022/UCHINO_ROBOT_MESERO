/**
 * Reglas de memoria personal. Se evalúan antes del LLM y antes de cualquier
 * mutación del pedido. Mesa, nombre o client_id nunca son identificadores.
 */

export const MemoryIntent = Object.freeze({
    CONSENT: 'memory_consent',
    IDENTIFY: 'memory_identify_customer',
    UPDATE_NAME: 'memory_update_customer_name',
    COMPANION: 'memory_remember_companion',
    PREFERENCE: 'memory_remember_preference',
    FAVORITE: 'memory_remember_favorite_product',
    ALLERGY: 'memory_remember_allergy',
    QUERY: 'memory_query',
    RETENTION_QUERY: 'memory_query_retention',
    FORGET: 'memory_forget',
    LAST_ORDER: 'memory_query_last_order',
    REORDER: 'memory_reorder_last_order',
    CONFIRM_RECOVERED_ALLERGY: 'memory_confirm_recovered_allergy',
    REJECT_RECOVERED_ALLERGY: 'memory_reject_recovered_allergy',
    UNSAFE_QUERY: 'memory_unsafe_reference',
    CLARIFICATION: 'memory_clarification',
});

function normalize(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function formatCapturedName(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .split(' ')
        .map(part => part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part)
        .join(' ');
}

function result(intent, entities = {}, confidence = 0.98, mutatesOrder = false) {
    return {
        intent,
        confidence,
        mutates_order: mutatesOrder,
        mutates_memory: ![
            MemoryIntent.QUERY,
            MemoryIntent.RETENTION_QUERY,
            MemoryIntent.LAST_ORDER,
            MemoryIntent.REORDER,
            MemoryIntent.UNSAFE_QUERY,
            MemoryIntent.CLARIFICATION,
            MemoryIntent.CONFIRM_RECOVERED_ALLERGY,
            MemoryIntent.REJECT_RECOVERED_ALLERGY,
        ].includes(intent),
        requires_clarification: false,
        entities,
        source: 'deterministic_memory_rule',
    };
}

export function classifyMemoryIntent(text) {
    const normalized = normalize(text);
    if (!normalized) return null;

    if (/(?:borra|elimina)\s+(?:todos?\s+)?(?:los\s+)?clientes|perfil\s+mas\s+parecido|persona\s+anterior|pedido\s+de\s+[a-z]|cliente\s+de\s+ayer|que\s+recuerda\s+la\s+mesa\s+\d+/u.test(normalized)) {
        return result(MemoryIntent.UNSAFE_QUERY, { reason: 'third_party_or_bulk_reference' });
    }

    // La negativa domina incluso si en la misma frase aparece el nombre o
    // una orden afirmativa: "me llamo David, pero no lo recuerdes".
    if (/(?:me\s+llamo|mi\s+nombre\s+es|soy)\s+[^,.]+,?\s+pero\s+no\s+(?:lo\s+)?(?:recuerdes|guardes)/.test(normalized)) {
        return result(MemoryIntent.FORGET, { scope: 'all', explicit_denial: true });
    }
    const selectiveForget = normalized.match(/(?:olvida|borra|elimina|no\s+(?:lo\s+)?(?:recuerdes|guardes))\s+(?:mi\s+|mis\s+|el\s+|la\s+|las\s+|los\s+)?(nombre|acompanantes?|acompañantes?|preferencias?|alergias?|restricciones?|pedido|perfil|memoria)/u);
    if (selectiveForget) {
        const scopeAliases = {
            nombre: 'name', acompanante: 'companion', acompanantes: 'companion', acompañante: 'companion', acompañantes: 'companion',
            preferencia: 'preference', preferencias: 'preference', alergia: 'allergy', alergias: 'allergy',
            restriccion: 'restriction', restricciones: 'restriction', pedido: 'last_confirmed_order',
            perfil: 'all', memoria: 'all',
        };
        return result(MemoryIntent.FORGET, { scope: scopeAliases[selectiveForget[1]] || 'all', explicit_denial: true });
    }
    if (/(?:olvida|borra|elimina)\s+(?:algo|eso|esa cosa)\b/u.test(normalized)) {
        return result(MemoryIntent.CLARIFICATION, { reason: 'ambiguous_forget' });
    }
    if (/(?:olvida|borra|elimina)\s+(?:todo|mi memoria|lo que sabes|mi perfil)|no\s+(?:lo\s+)?recuerdes\b|no\s+me\s+recuerdes\b/u.test(normalized)) {
        return result(MemoryIntent.FORGET, { scope: 'all', explicit_denial: true });
    }

    if (/(?:no\s+quiero\s+que\s+guardes|no\s+guardes\s+mis\s+datos|no\s+quiero\s+que\s+recuerdes|sin\s+memoria|no\s+memorices)/.test(normalized)) {
        return result(MemoryIntent.CONSENT, { consent: 'disabled', explicit_denial: true });
    }
    if (/(?:solo\s+(?:para|por)\s+(?:este\s+pedido|esta\s+atencion|esta\s+sesion)|no\s+lo\s+guardes\s+despues|no\s+guardes\s+esto|memoria\s+solo\s+por\s+hoy)/.test(normalized)) {
        return result(MemoryIntent.CONSENT, { consent: 'session_only' });
    }
    if (/(?:puedes\s+recordarme|recuerdame\s+para\s+(?:la\s+proxima|otra\s+vez)|guardalo\s+para\s+despues|puedes\s+guardar\s+(?:mis|esta)|memoriza|recuerda\s+todo\s+lo\s+que\s+diga)/.test(normalized)) {
        return result(MemoryIntent.CONSENT, { consent: 'temporary', explicit_only: true });
    }

    if (/(?:cuando|cuanto\s+tiempo|por\s+cuanto)\s+(?:olvidaras|se\s+guardara|durar[aá])|retencion|vence\s+mi\s+memoria/.test(normalized)) {
        return result(MemoryIntent.RETENTION_QUERY, { read_only: true });
    }

    const recoveredAllergyConfirmation = /(?:confirmo|si|sí|correcto|sigue\s+(?:siendo\s+)?correct[ao]|puedes\s+considerar)\b.*(?:alergia|alergico|alergica)/u.test(normalized)
        || /(?:mi\s+alergia)\s+(?:sigue|continua)\b/u.test(normalized);
    if (recoveredAllergyConfirmation) return result(MemoryIntent.CONFIRM_RECOVERED_ALLERGY, { explicit: true });
    if (/(?:no\s+(?:la\s+)?confirmo|ya\s+no\s+soy\s+alergic[oa]|no\s+tengo\s+esa\s+alergia|rechazo\s+(?:esa\s+)?alergia)/u.test(normalized)) {
        return result(MemoryIntent.REJECT_RECOVERED_ALLERGY, { explicit: true });
    }

    if (/(?:repite|repetir|pide|pedir|ordena|ordenar).*(?:ultimo|ultima|anterior|vez pasada|lo mismo)/.test(normalized)) {
        return result(MemoryIntent.REORDER, { explicit: true }, 0.99, true);
    }
    if (/(?:ultimo pedido|pedido anterior|que pedi la ultima vez|lo que pedi antes|que ordene antes)/.test(normalized)) {
        return result(MemoryIntent.LAST_ORDER, { read_only: true });
    }
    if (/(?:que recuerdas de mi|que sabes de mi|que tienes guardado|mis preferencias|mi memoria)/.test(normalized)) {
        return result(MemoryIntent.QUERY, { read_only: true });
    }

    const updateName = normalized.match(/\b(?:cambialo|cámbialo|actualiza\s+mi\s+nombre|cambia\s+mi\s+nombre)\s+(?:a|por)\s+([a-z][a-z' -]{1,60})/i);
    if (updateName) return result(MemoryIntent.UPDATE_NAME, { name: formatCapturedName(updateName[1]) });

    const name = normalized.match(/\b(?:me llamo|mi nombre es)\s+([a-záéíóúñ][a-záéíóúñ' -]{1,60})$/i)
        || normalized.match(/\bsoy\s+(?!(?:alergic[oa]|vegetarian[oa]|vegan[oa]|intolerante|diabetic[oa]|celiac[oa]|hipertens[oa]|peruan[oa]|asmatic[oa]|embarazad[oa]|epileptic[oa]|autist[oa]|discapacitad[oa]|inmunodeprimid[oa]|cliente|persona|estudiante|menor|mujer|hombre|mesa|acompañante|acompanante|de)\b)([a-záéíóúñ][a-záéíóúñ'-]{1,30}(?:\s+[a-záéíóúñ][a-záéíóúñ'-]{1,30}){0,2})$/i);
    if (name) return result(MemoryIntent.IDENTIFY, { name: formatCapturedName(name[1]) });

    const companion = normalized.match(/\b(?:mi acompanante|mi acompañante|venimos con|estoy con|mi acompanante se llama|mi acompañante se llama)\s+([a-záéíóúñ][a-záéíóúñ' -]{1,60})/i);
    if (companion) return result(MemoryIntent.COMPANION, { companion: formatCapturedName(companion[1]) });

    const favorite = normalized.match(/\b(?:mi\s+(?:plato\s+)?favorito\s+(?:es|suele\s+ser)|mi\s+favorito\s+es)\s+(.{2,100})$/u);
    if (favorite) return result(MemoryIntent.FAVORITE, { favorite_product: favorite[1].trim() });

    const allergy = normalized.match(/\brecuerda(?:me)?\s+que\s+soy\s+alergic[oa]\s+(?:a|al)\s+(?:(?:el|la|los|las)\s+)?(.{2,80})$/i);
    if (allergy) return result(MemoryIntent.ALLERGY, { allergy: allergy[1].trim(), remember_consent: normalized.startsWith('recuerda') ? 'temporary' : null });

    const modePreference = normalized.match(/\b(?:prefiero\s+pedir\s+|prefiero\s+)(?:por\s+)?(voz|pantalla|la\s+pantalla|un\s+mesero|mesero)\b/u);
    if (modePreference) {
        const rawMode = modePreference[1].replace(/^la\s+/, '').trim();
        const interactionMode = rawMode === 'voz' ? 'voice' : rawMode.includes('mesero') ? 'human_waiter' : 'screen';
        return result(MemoryIntent.PREFERENCE, { preference: interactionMode, preference_type: 'interaction_mode', remember_consent: normalized.startsWith('recuerda') ? 'temporary' : null });
    }

    const preference = normalized.match(/\b(?:recuerda(?:me)?\s+que\s+(?:me\s+gusta|prefiero)|me\s+gusta|me\s+encanta|prefiero|siempre\s+prefiero|normalmente\s+pido)\s+(.{2,100})$/i);
    const explicitMemoryPreference = /^(?:recuerda|recuerdame)\s+que\s+/u.test(normalized);
    if (preference && !/(?:pedir|ordenar|comer)\s+(?:un|una|el|la|los|las)\b/.test(normalized)
        && (explicitMemoryPreference || !/^(?:un|una|el|la|los|las)\b/.test(preference[1].trim()))) {
        const value = preference[1].trim();
        const preferenceType = /sal/.test(value) ? 'salt_level' : /picante/.test(value) ? 'spice_level' : /cebolla/.test(value) ? 'ingredient_preference' : 'general';
        return result(MemoryIntent.PREFERENCE, { preference: value, preference_type: preferenceType, remember_consent: normalized.startsWith('recuerda') ? 'temporary' : null });
    }

    return null;
}
