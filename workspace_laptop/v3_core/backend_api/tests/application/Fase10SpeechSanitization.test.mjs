import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForSpeech } from '../../src/application/SpeechTextSanitizer.mjs';

test('naturaliza pedido, moneda y cantidades sin tocar el display', () => {
    const result = sanitizeForSpeech('**Tu pedido:** 3 tallarines. Total: S/ 60.');

    assert.equal(result.displayText, '**Tu pedido:** 3 tallarines. Total: S/ 60.');
    assert.equal(result.speechText, 'Tu pedido contiene tres tallarines. El total es de sesenta soles.');
    assert.deepEqual(result.segments, [
        'Tu pedido contiene tres tallarines.',
        'El total es de sesenta soles.',
    ]);
});

test('convierte listas de pedido y elimina markdown, URL y emojis', () => {
    const result = sanitizeForSpeech('- Ceviche\n- Chicha morada\n- Suspiro a la limeña\n[Ver menú](http://localhost:3005/robot) 😍');

    assert.equal(result.speechText, 'Tu pedido contiene ceviche, chicha morada y suspiro a la limeña. Puedes ver el menú en la pantalla.');
    assert.doesNotMatch(result.speechText, /[*_`]|https?:\/\/|😍/u);
    assert.equal(result.metadata.urls_removed, true);
});

test('la política de voz elimina URLs incluso si el caller intenta desactivarla', () => {
    const result = sanitizeForSpeech('Consulta https://uchino.local/menu.', { removeUrls: false });

    assert.doesNotMatch(result.speechText, /https?:\/\//u);
    assert.equal(result.metadata.urls_removed, true);
});

test('naturaliza mesa, precio decimal, porcentajes y abreviaturas', () => {
    const result = sanitizeForSpeech('Mesa: M8. S/ 22.50. 20%. Espera 2 min y 3 seg.');

    assert.equal(result.speechText, 'Mesa ocho. Veintidós soles con cincuenta céntimos. Veinte por ciento. Espera dos minutos y tres segundos.');
});

test('conserva advertencias y negaciones, pero omite identificadores técnicos', () => {
    const result = sanitizeForSpeech('**Advertencia:** contiene maní. NO confirmes. order_id: 550e8400-e29b-41d4-a716-446655440000.');

    assert.equal(result.speechText, 'Advertencia. Contiene maní. No confirmes.');
    assert.doesNotMatch(result.speechText, /550e8400|order_id|asterisco|guion/u);
});

test('limita catálogos largos a tres opciones y conserva una indicación útil', () => {
    const result = sanitizeForSpeech('Opciones:\n- Ceviche\n- Lomo saltado\n- Tallarines verdes\n- Chicha morada\n- Suspiro limeño');

    assert.equal(result.speechText, 'Tenemos ceviche, lomo saltado y tallarines verdes. Puedes ver más opciones en la pantalla.');
});

test('limita un catálogo inline real y evita hablar la lista completa', () => {
    const input = 'En esta categoría tenemos: Chicha Morada, Emoliente, Inca Kola, Maracuyá, Ají de Gallina y otras opciones que puedes ver en pantalla.';
    const result = sanitizeForSpeech(input, { listContext: 'catalog' });
    assert.equal(result.speechText, 'En esta categoría tenemos chicha Morada, emoliente e inca Kola. Puedes ver más opciones en la pantalla.');
    assert.equal(result.metadata.catalog_limited, true);
});

test('segmenta respuestas largas sin cortar palabras y es idempotente', () => {
    const source = 'He agregado un ceviche sin cebolla. El total actual es de veintidós soles. ¿Deseas agregar algo más?';
    const result = sanitizeForSpeech(source, { maxSegmentLength: 55 });
    const again = sanitizeForSpeech(result.speechText, { maxSegmentLength: 55 });

    assert.ok(result.segments.length >= 3);
    assert.ok(result.segments.every(segment => segment.length <= 55));
    assert.equal(again.speechText, result.speechText);
    assert.equal(again.segments.join(' '), result.segments.join(' '));
});

test('entrada vacía, null y símbolos no generan texto hablado', () => {
    assert.deepEqual(sanitizeForSpeech(null).segments, []);
    assert.equal(sanitizeForSpeech('*** ___ 😍').speechText, '');
});

test('resiste entradas adversariales sin enviar JSON, código, IDs o URLs al TTS', () => {
    const inputs = [
        '***Pedido***',
        '____',
        '### Total',
        'S/20.50',
        'M8',
        'http://localhost:3005/admin',
        'order_id: 550e8400-e29b-41d4-a716-446655440000',
        '😍🔥✅',
        'uno... dos..... tres',
        'NO confirmes',
        'Sin maní / sin leche / sin gluten',
        JSON.stringify({ message: '**Total:** S/ 20.50', order_id: '550e8400-e29b-41d4-a716-446655440000' }),
        '```json\n{"total":"S/ 20"}\n```',
        '| Producto | Precio |\n|---|---|\n| Ceviche | S/ 22 |',
        'Respuesta larga '.repeat(220),
        'Texto con \u0000 caracteres extraños <>[]{}',
        'S/ 1.00 y PEN 2.50',
    ];

    for (const input of inputs) {
        const result = sanitizeForSpeech(input);
        assert.doesNotMatch(result.speechText, /https?:\/\/|order_id|550e8400|```|[😍🔥✅]/u);
        assert.ok(result.segments.every(segment => segment.length <= 180));
    }
});
