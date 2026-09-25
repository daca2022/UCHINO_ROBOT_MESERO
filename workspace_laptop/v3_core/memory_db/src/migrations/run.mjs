import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATION_LOCK_ID = 20260925;
const MIGRATION_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const { Pool } = pg;

function databaseConfig(env) {
    const required = ['POSTGRES_HOST', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'];
    const missing = required.filter((key) => !env[key]);
    if (missing.length > 0) {
        throw new Error(`Faltan variables PostgreSQL: ${missing.join(', ')}`);
    }

    const port = Number(env.POSTGRES_PORT || 5432);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('POSTGRES_PORT debe ser un puerto válido');
    }

    return {
        host: env.POSTGRES_HOST,
        port,
        user: env.POSTGRES_USER,
        password: env.POSTGRES_PASSWORD,
        database: env.POSTGRES_DB,
        max: 1,
        application_name: 'uchino-schema-migrations',
    };
}

async function migrationFiles() {
    const names = await readdir(MIGRATION_DIRECTORY);
    return names
        .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
        .sort();
}

async function applyMigrations(client) {
    const files = await migrationFiles();
    if (files.length === 0) {
        throw new Error('No se encontraron migraciones SQL numeradas');
    }

    await client.query(`
        CREATE TABLE IF NOT EXISTS uchino_schema_migrations (
            migration_name TEXT PRIMARY KEY,
            checksum CHAR(64) NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    let applied = 0;
    let unchanged = 0;
    for (const name of files) {
        const sql = await readFile(new URL(name, import.meta.url), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const previous = await client.query(
            'SELECT checksum FROM uchino_schema_migrations WHERE migration_name = $1',
            [name],
        );

        if (previous.rowCount > 0) {
            if (previous.rows[0].checksum.trim() !== checksum) {
                throw new Error(`La migración aplicada fue modificada: ${name}`);
            }
            unchanged += 1;
            continue;
        }

        await client.query('BEGIN');
        try {
            await client.query(sql);
            await client.query(
                'INSERT INTO uchino_schema_migrations (migration_name, checksum) VALUES ($1, $2)',
                [name, checksum],
            );
            await client.query('COMMIT');
            applied += 1;
        } catch (error) {
            await client.query('ROLLBACK');
            throw new Error(`Falló la migración ${name}`, { cause: error });
        }
    }

    return { applied, unchanged };
}

async function main() {
    const pool = new Pool(databaseConfig(process.env));
    try {
        const client = await pool.connect();
        let lockAcquired = false;
        try {
            await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
            lockAcquired = true;
            const result = await applyMigrations(client);
            console.log(`Migraciones aplicadas: ${result.applied}; ya vigentes: ${result.unchanged}`);
        } finally {
            try {
                if (lockAcquired) {
                    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
                }
            } finally {
                client.release();
            }
        }
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : 'error desconocido';
    const detail = error instanceof Error && error.cause instanceof Error
        ? `: ${error.cause.message}`
        : '';
    console.error(`Error al inicializar PostgreSQL: ${message}${detail}`);
    process.exitCode = 1;
});
