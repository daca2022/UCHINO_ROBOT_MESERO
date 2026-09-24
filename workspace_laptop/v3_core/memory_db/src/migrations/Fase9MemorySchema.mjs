/**
 * Esquema aditivo de Fase 9.
 *
 * No reutiliza `clientes` para inferir identidad: esa tabla pertenece a la
 * operación legacy y no tiene contrato de consentimiento ni expiración.
 */
export async function ensureFase9MemorySchema(pool) {
    if (!pool) return false;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS memory_policy (
            id SMALLINT PRIMARY KEY CHECK (id = 1),
            retention_policy VARCHAR(20) NOT NULL DEFAULT '1d'
                CHECK (retention_policy IN ('session_only', '1d', '7d', '30d', 'disabled')),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by VARCHAR(120)
        );
        INSERT INTO memory_policy (id, retention_policy)
        VALUES (1, '1d')
        ON CONFLICT (id) DO NOTHING;

        CREATE TABLE IF NOT EXISTS customer_profiles (
            profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            display_name VARCHAR(100),
            identity_source VARCHAR(40) NOT NULL DEFAULT 'user_declared',
            identity_confidence NUMERIC(3,2),
            consent_status VARCHAR(20) NOT NULL DEFAULT 'temporary'
                CHECK (consent_status IN ('session_only', 'temporary', 'disabled')),
            retention_policy VARCHAR(20) NOT NULL DEFAULT '1d'
                CHECK (retention_policy IN ('session_only', '1d', '7d', '30d', 'disabled')),
            status VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'expired', 'forgotten')),
            is_test BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ,
            forgotten_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_customer_profiles_active_expiry
            ON customer_profiles(status, expires_at);
        ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS identity_confidence NUMERIC(3,2);
        ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

        CREATE TABLE IF NOT EXISTS customer_memory_entries (
            memory_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            profile_id UUID NOT NULL REFERENCES customer_profiles(profile_id) ON DELETE CASCADE,
            memory_type VARCHAR(40) NOT NULL,
            value JSONB NOT NULL,
            source VARCHAR(40) NOT NULL DEFAULT 'user_declared',
            session_id VARCHAR(160),
            visit_id UUID,
            table_id VARCHAR(10),
            status VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'expired', 'forgotten')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_customer_memory_profile_status
            ON customer_memory_entries(profile_id, status, memory_type, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_customer_memory_expiry
            ON customer_memory_entries(status, expires_at);

        CREATE TABLE IF NOT EXISTS memory_audit_events (
            audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event VARCHAR(80) NOT NULL,
            profile_id UUID,
            memory_id UUID,
            session_id VARCHAR(160),
            visit_id UUID,
            table_id VARCHAR(10),
            memory_type VARCHAR(40),
            source VARCHAR(40) NOT NULL DEFAULT 'backend',
            action VARCHAR(40) NOT NULL DEFAULT 'observe',
            result VARCHAR(40) NOT NULL DEFAULT 'ok',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS idx_memory_audit_profile_time
            ON memory_audit_events(profile_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_audit_event_time
            ON memory_audit_events(event, created_at DESC);
    `);
    return true;
}
