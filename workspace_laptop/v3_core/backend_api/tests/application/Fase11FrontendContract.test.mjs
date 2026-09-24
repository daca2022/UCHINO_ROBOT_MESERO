import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const cocinaEntrypoint = resolve(
    new URL('.', import.meta.url).pathname,
    '../../../frontend_ui/src/main-cocina.jsx',
);
const indexSource = resolve(
    new URL('.', import.meta.url).pathname,
    '../../src/index.mjs',
);
const hooksSource = resolve(
    new URL('.', import.meta.url).pathname,
    '../../../frontend_ui/src/hooks.js',
);
const adminDashboardSource = resolve(
    new URL('.', import.meta.url).pathname,
    '../../../frontend_ui/src/AdminDashboard.jsx',
);
const cocinaSource = resolve(
    new URL('.', import.meta.url).pathname,
    '../../../frontend_ui/src/CocinaKDS.jsx',
);

test('Fase 11: el entrypoint independiente de Cocina monta AuthProvider alrededor de CocinaKDS', async () => {
    const source = await readFile(cocinaEntrypoint, 'utf8');

    assert.match(source, /import\s+\{\s*AuthProvider\s*\}\s+from\s+['"]\.\/admin\/AuthContext\.jsx['"]/u);
    assert.match(source, /<AuthProvider>\s*<CocinaKDS\s*\/>\s*<\/AuthProvider>/su);
});

test('Fase 11: el caller interno de voz propaga el token de la sesión ASR', async () => {
    const source = await readFile(indexSource, 'utf8');
    assert.match(source, /X-Session-Token['"]\s*:\s*session\.session_access_token/u);
});

test('Fase 11: WS/UI autentica las superficies operativas cuando tienen token', async () => {
    const [hooks, admin, cocina] = await Promise.all([
        readFile(hooksSource, 'utf8'),
        readFile(adminDashboardSource, 'utf8'),
        readFile(cocinaSource, 'utf8'),
    ]);
    assert.match(hooks, /useWebSocket\(path, auth = null\)/u);
    assert.match(hooks, /type: 'auth'/u);
    assert.match(admin, /useWebSocket\('\/ws\/ui', token\)/u);
    assert.match(cocina, /useWebSocket\('\/ws\/ui', token\)/u);
});
