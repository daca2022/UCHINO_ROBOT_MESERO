import { Intent } from './IntentClassifier.mjs';

function normalize(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function cloneItems(items = []) {
    return items.map(item => ({ ...item, cantidad: Math.max(1, Number(item.cantidad) || 1) }));
}

function addItem(items, incoming, quantity) {
    const key = normalize(incoming.nombre);
    const current = items.find(item => normalize(item.nombre) === key);
    if (current) current.cantidad += quantity;
    else items.push({ ...incoming, cantidad: quantity });
}

function productNames(products = []) {
    return new Set(products.map(product => normalize(product.nombre)));
}

/**
 * Aplica únicamente operaciones ya clasificadas y validadas contra el menú.
 * El módulo no calcula precios ni decide si un texto es una intención.
 */
export function applyDraftIntent({ currentItems = [], intent, entities = {} } = {}) {
    const current = cloneItems(currentItems);
    const next = cloneItems(currentItems);
    const products = entities.products || [];
    const names = productNames(products);
    const quantity = Math.max(1, Number(entities.quantity) || 1);

    if ([Intent.REPEAT_PRODUCT, Intent.CONSULT_ORDER, Intent.CONSULT_MENU, Intent.SHOW_CATEGORY,
        Intent.REQUEST_CLARIFICATION, Intent.REJECT_CONFIRMATION, Intent.SOCIAL_CONVERSATION,
        Intent.SELECT_INTERACTION_MODE, Intent.CHANGE_INTERACTION_MODE, Intent.REQUEST_HUMAN_WAITER,
        Intent.IDENTIFY_CUSTOMER, Intent.CHANGE_TABLE, Intent.FINISH_CONVERSATION, Intent.CONFIRM_ORDER]
        .includes(intent)) {
        return { items: current, changed: false, operation: 'read_only' };
    }

    if (intent === Intent.CANCEL_ORDER && entities.reset_all) {
        return { items: [], changed: current.length > 0, operation: 'reset' };
    }

    if (intent === Intent.ADD_PRODUCT || intent === Intent.INCREMENT_QUANTITY) {
        for (const product of products) addItem(next, product, quantity);
        return { items: next, changed: true, operation: intent };
    }

    if (intent === Intent.CHANGE_QUANTITY) {
        for (const product of products) {
            const key = normalize(product.nombre);
            const existing = next.find(item => normalize(item.nombre) === key);
            if (existing) existing.cantidad = quantity;
            else next.push({ ...product, cantidad: quantity });
        }
        return { items: next, changed: true, operation: 'set_total_quantity' };
    }

    if (intent === Intent.REMOVE_PRODUCT) {
        const filtered = next.filter(item => !names.has(normalize(item.nombre)));
        return { items: filtered, changed: filtered.length !== next.length, operation: 'remove_product' };
    }

    if (intent === Intent.DECREMENT_QUANTITY) {
        const filtered = [];
        for (const item of next) {
            if (!names.has(normalize(item.nombre))) {
                filtered.push(item);
                continue;
            }
            const remaining = item.cantidad - quantity;
            if (remaining > 0) filtered.push({ ...item, cantidad: remaining });
        }
        return { items: filtered, changed: JSON.stringify(filtered) !== JSON.stringify(next), operation: 'decrement_quantity' };
    }

    if (intent === Intent.REPLACE_PRODUCT) {
        const source = entities.source_product;
        const target = entities.target_product;
        if (!source || !target) return { items: current, changed: false, operation: 'replace_requires_entities' };
        const sourceKey = normalize(source.nombre);
        const sourceItem = next.find(item => normalize(item.nombre) === sourceKey);
        if (!sourceItem) return { items: current, changed: false, operation: 'replace_source_not_in_draft' };
        const replacementQuantity = sourceItem.cantidad || 1;
        const withoutSource = next.filter(item => normalize(item.nombre) !== sourceKey);
        addItem(withoutSource, target, replacementQuantity);
        return { items: withoutSource, changed: true, operation: 'replace_product' };
    }

    return { items: current, changed: false, operation: 'unsupported' };
}
