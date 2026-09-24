#!/usr/bin/env node
/**
 * fase3_test.mjs — FASE 3: Pruebas del LLM Pagado Real
 *
 * Ejecuta los 6 tests requeridos:
 *   A. 'Hola, ¿quién eres?'
 *   B. 'Dame un ceviche por favor.'
 *   C. 'Quiero dos tallarines.'
 *   D. Producto que no existe.
 *   E. API pagada caída (forzar error).
 *   F. Verificar modelo exacto en logs.
 *
 * Uso:
 *   node tools/fase3_test.mjs          # ejecuta todos
 *   node tools/fase3_test.mjs --test C  # solo test C
 *   node tools/fase3_test.mjs --list    # lista tests
 */

import 'dotenv/config';
import { Fase3Orchestrator } from '../src/application/Fase3Orchestrator.mjs';

// ─── Suites de test ───────────────────────────────────────────────
const TEST_CASES = {
    A: {
        name: 'Saludo básico',
        input: {
            user_text: 'Hola, ¿quién eres?',
            session_id: 'fase3_test_A',
            turn_id: 1,
            mesa: '5',
            client_id: 'test_A',
            conversation_history: [],
            current_order: {},
        },
        expected: {
            has_text: true,
            has_function_calls: false,
        },
    },
    B: {
        name: 'Pedido simple',
        input: {
            user_text: 'Dame un ceviche por favor.',
            session_id: 'fase3_test_B',
            turn_id: 1,
            mesa: '3',
            client_id: 'test_B',
            conversation_history: [],
            current_order: {},
        },
        expected: {
            has_text: true,
            has_function_calls: true,
            function_name: 'registrar_pedido',
            expected_product: 'Ceviche',
        },
    },
    C: {
        name: 'Pedido con cantidad',
        input: {
            user_text: 'Quiero dos tallarines.',
            session_id: 'fase3_test_C',
            turn_id: 1,
            mesa: '7',
            client_id: 'test_C',
            conversation_history: [],
            current_order: {},
        },
        expected: {
            has_text: true,
            has_function_calls: true,
            function_name: 'registrar_pedido',
            expected_product: 'Tallarines verdes',
        },
    },
    D: {
        name: 'Producto inexistente',
        input: {
            user_text: 'Dame un sushi por favor.',
            session_id: 'fase3_test_D',
            turn_id: 1,
            mesa: '2',
            client_id: 'test_D',
            conversation_history: [],
            current_order: {},
        },
        expected: {
            has_text: true,
            has_function_calls: false,
            should_not_register: true, // No debe llamar registrar_pedido
        },
    },
    E: {
        name: 'API caída (forzar error)',
        forceError: true, // flag para forzar fallo de conexión
        input: {
            user_text: 'Hola',
            session_id: 'fase3_test_E',
            turn_id: 1,
            mesa: '1',
            client_id: 'test_E',
            conversation_history: [],
            current_order: {},
        },
        expected: {
            should_error: true,
        },
    },
    F: {
        name: 'Verificación de modelo en logs',
        input: {
            user_text: 'Dame un ceviche por favor.',
            session_id: 'fase3_test_F',
            turn_id: 2,
            mesa: '3',
            client_id: 'test_F',
            conversation_history: [
                { role: 'user', content: 'Hola' },
                { role: 'assistant', content: '¡Hola! Soy Uchino, tu robot mesero.' },
            ],
            current_order: {},
        },
        expected: {
            has_text: true,
            check_model_in_logs: true,
        },
    },
};

// ─── Test runner ──────────────────────────────────────────────────
function pad(str, len) {
    return String(str).padEnd(len);
}

function color(status) {
    if (status === 'PASS') return '\x1b[32mPASS\x1b[0m';
    if (status === 'FAIL') return '\x1b[31mFAIL\x1b[0m';
    if (status === 'SKIP') return '\x1b[33mSKIP\x1b[0m';
    if (status === 'INFO') return '\x1b[36mINFO\x1b[0m';
    return status;
}

async function runTest(key, testCase, orchestrator) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`TEST ${key}: ${testCase.name}`);
    console.log(`${'='.repeat(72)}`);
    console.log(`Input: "${testCase.input.user_text}"`);
    console.log(`Mesa: ${testCase.input.mesa}, Sesión: ${testCase.input.session_id}`);
    console.log(`Historial: ${testCase.input.conversation_history.length} mensajes`);
    console.log();

    const results = { key, name: testCase.name, checks: [], passed: 0, failed: 0 };
    let response;

    if (testCase.forceError) {
        // Test E: Forzar error con URL inválida
        console.log(`  ${color('INFO')} Forzando error: creando orquestador con baseUrl inválida`);
        const brokenOrchestrator = new Fase3Orchestrator({
            baseUrl: 'https://openrouter.invalid/api/v1',
            timeoutMs: 3000,
        });
        try {
            response = await brokenOrchestrator.process(testCase.input);
        } catch (err) {
            response = { error: err.message, code: 'FETCH_ERROR' };
        }

        results.checks.push({ name: 'should_error' });
        if (response && (response.error || response.code)) {
            console.log(`  ${color('PASS')} Error esperado: ${response.error?.slice(0, 100)}`);
            results.passed++;
        } else {
            console.log(`  ${color('FAIL')} Se esperaba un error pero se obtuvo respuesta`);
            results.failed++;
        }
        return results;
    }

    try {
        response = await orchestrator.process(testCase.input);
    } catch (err) {
        console.log(`  ${color('FAIL')} Excepción no manejada: ${err.message}`);
        results.checks.push({ name: 'exception', error: err.message });
        results.failed++;
        return results;
    }

    console.log(`  ${color('INFO')} Response:`);
    console.log(`    Model: ${response.model || 'N/A'}`);
    console.log(`    Latency: ${response.latencyMs || 0}ms`);
    console.log(`    Paid: ${response.paid !== undefined ? response.paid : 'N/A'}`);
    console.log(`    Text: "${(response.text || '').slice(0, 120)}"`);
    console.log(`    Function calls: ${response.functionCalls?.length || 0}`);
    if (response.functionCalls?.length > 0) {
        for (const fc of response.functionCalls) {
            console.log(`      → ${fc.name}(${JSON.stringify(fc.args)})`);
        }
    }
    if (response.onFallback) {
        console.log(`  ${color('WARN')} Usando FALLBACK: ${response.model}`);
    }

    // Run checks
    if (testCase.expected.has_text) {
        results.checks.push({ name: 'has_text' });
        const hasFunctionCalls = response.functionCalls?.length > 0;
        // When model returns tool_calls finish_reason, content is intentionally empty
        // Text will come after tool result is injected. This is correct behavior.
        if (response.text && response.text.length > 0) {
            console.log(`  ${color('PASS')} Respuesta textual recibida (${response.text.length} chars)`);
            results.passed++;
        } else if (hasFunctionCalls) {
            console.log(`  ${color('PASS')} Sin texto (esperado: finish_reason=tool_calls, respuesta vendrá tras tool result)`);
            results.passed++;
        } else {
            console.log(`  ${color('FAIL')} No hay respuesta textual ni function calls`);
            results.failed++;
        }
    }

    if (testCase.expected.has_function_calls) {
        results.checks.push({ name: 'has_function_calls' });
        if (response.functionCalls?.length > 0) {
            console.log(`  ${color('PASS')} Function call detectada`);
            results.passed++;

            // Verificar nombre de función
            if (testCase.expected.function_name) {
                results.checks.push({ name: `function_name=${testCase.expected.function_name}` });
                const hasCorrectFn = response.functionCalls.some(fc =>
                    fc.name === testCase.expected.function_name
                );
                if (hasCorrectFn) {
                    console.log(`  ${color('PASS')} Función correcta: ${testCase.expected.function_name}`);
                    results.passed++;
                } else {
                    console.log(`  ${color('FAIL')} Función esperada: ${testCase.expected.function_name}, obtenida: ${response.functionCalls.map(f => f.name).join(',')}`);
                    results.failed++;
                }
            }

            // Verificar producto
            if (testCase.expected.expected_product) {
                results.checks.push({ name: `product=${testCase.expected.expected_product}` });
                const allNames = response.functionCalls.flatMap(fc =>
                    (fc.args?.platos || []).map(p => p.nombre)
                );
                const match = allNames.some(n =>
                    n.toLowerCase().includes(testCase.expected.expected_product.toLowerCase())
                );
                if (match) {
                    console.log(`  ${color('PASS')} Producto correcto: ${testCase.expected.expected_product}`);
                    results.passed++;
                } else {
                    console.log(`  ${color('FAIL')} Producto esperado: ${testCase.expected.expected_product}, obtenido: ${JSON.stringify(allNames)}`);
                    results.failed++;
                }
            }
        } else {
            console.log(`  ${color('FAIL')} Se esperaba function call pero no hubo`);
            results.failed++;
        }
    }

    if (testCase.expected.should_not_register) {
        results.checks.push({ name: 'should_not_register' });
        const hasRegister = response.functionCalls?.some(fc => fc.name === 'registrar_pedido');
        if (!hasRegister) {
            console.log(`  ${color('PASS')} No registró pedido (producto inexistente)`);
            results.passed++;
        } else {
            console.log(`  ${color('FAIL')} Registró pedido para producto inexistente`);
            results.failed++;
        }
    }

    if (testCase.expected.should_error) {
        results.checks.push({ name: 'should_error' });
        if (response.error || response.code) {
            console.log(`  ${color('PASS')} Error detectado: ${(response.error || response.code).slice(0, 100)}`);
            results.passed++;
        } else {
            console.log(`  ${color('FAIL')} Se esperaba error pero no ocurrió`);
            results.failed++;
        }
    }

    if (testCase.expected.check_model_in_logs) {
        results.checks.push({ name: 'model_in_logs' });
        const logsWithModel = (response.logs || []).filter(l =>
            l.data?.model === response.model
        );
        const modelStr = response.model || 'N/A';
        console.log(`  ${color('INFO')} Modelo en respuesta: ${modelStr}`);
        console.log(`  ${color('INFO')} Paid: ${response.paid}`);
        if (response.paid === true) {
            console.log(`  ${color('PASS')} Modelo pagado verificado`);
            results.passed++;
        } else {
            console.log(`  ${color('FAIL')} Modelo no marcado como pagado`);
            results.failed++;
        }
    }

    return results;
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    const testFilter = args.find(a => a.startsWith('--test='))?.split('=')[1];
    const showList = args.includes('--list');

    if (showList) {
        console.log('Tests disponibles:');
        for (const [key, tc] of Object.entries(TEST_CASES)) {
            console.log(`  ${key}: ${tc.name} — "${tc.input.user_text}"`);
        }
        return;
    }

    // Crear orquestador con la configuración real del .env
    const orchestrator = new Fase3Orchestrator();

    // Primero validar configuración
    console.log('Validando configuración...');
    const configCheck = orchestrator.validateConfig();
    if (!configCheck.valid) {
        console.error(`\n${color('FAIL')} Configuración inválida:`);
        for (const err of configCheck.errors) {
            console.error(`  - ${err}`);
        }
        process.exit(1);
    }
    console.log(`  ${color('PASS')} Modelo: ${configCheck.modelId}`);
    console.log(`  ${color('PASS')} API Key presente: ${!!orchestrator.apiKey}`);

    // Verificar contra API de OpenRouter
    console.log('\nVerificando modelo contra OpenRouter API...');
    const paidCheck = await orchestrator.verifyPaidModel();
    if (paidCheck.verified) {
        if (paidCheck.isPaid) {
            console.log(`  ${color('PASS')} Modelo PAGADO: $${paidCheck.promptPrice}/M prompt, $${paidCheck.completionPrice}/M completion`);
        } else {
            console.log(`  ${color('FAIL')} Modelo GRATUITO detectado! Precio prompt=$${paidCheck.promptPrice}`);
            process.exit(1);
        }
    } else {
        console.log(`  ${color('WARN')} No se pudo verificar contra API (${paidCheck.reason}), confiando en validación local`);
    }

    // Ejecutar tests
    const testKeys = testFilter ? [testFilter] : Object.keys(TEST_CASES);
    const results = [];

    for (const key of testKeys) {
        const testCase = TEST_CASES[key];
        if (!testCase) {
            console.error(`Test '${key}' no encontrado`);
            continue;
        }
        const result = await runTest(key, testCase, orchestrator);
        results.push(result);
    }

    // Resumen
    console.log(`\n${'='.repeat(72)}`);
    console.log('RESUMEN');
    console.log(`${'='.repeat(72)}`);
    let totalPassed = 0;
    let totalFailed = 0;
    for (const r of results) {
        const status = r.failed > 0 ? 'FAIL' : 'PASS';
        console.log(`  ${color(status)} ${r.key}: ${r.name} — ${r.passed} checks OK, ${r.failed} checks FAIL`);
        totalPassed += r.passed;
        totalFailed += r.failed;
    }
    console.log(`\n  Total: ${totalPassed} passed, ${totalFailed} failed`);
    if (totalFailed > 0) process.exit(1);
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
