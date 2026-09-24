ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS visit_id UUID;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS order_sequence INTEGER;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS order_kind VARCHAR(20);

CREATE TABLE IF NOT EXISTS restaurant_tables (
    table_id VARCHAR(3) PRIMARY KEY,
    display_name VARCHAR(20) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    status VARCHAR(32) NOT NULL DEFAULT 'available',
    current_visit_id UUID,
    active_session_id VARCHAR(160),
    active_order_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    opened_at TIMESTAMPTZ,
    last_status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT restaurant_tables_status_check CHECK (status IN (
        'available', 'occupied', 'ordering', 'order_confirmed', 'preparing',
        'ready', 'delivery_in_progress', 'served', 'closed', 'attention_requested'
    ))
);

CREATE TABLE IF NOT EXISTS restaurant_visits (
    visit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id VARCHAR(3) NOT NULL REFERENCES restaurant_tables(table_id),
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    close_reason VARCHAR(80),
    session_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    order_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    additional_orders_allowed BOOLEAN NOT NULL DEFAULT true,
    guest_count INTEGER,
    notes TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT restaurant_visits_status_check CHECK (status IN ('active', 'closed')),
    CONSTRAINT restaurant_visits_guest_count_check CHECK (guest_count IS NULL OR guest_count > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_visits_one_active
    ON restaurant_visits(table_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_restaurant_visits_table_opened
    ON restaurant_visits(table_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_visit ON pedidos(visit_id, timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_pedidos_table_status ON pedidos(table_id, status);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_visit_id_fkey'
    ) THEN
        ALTER TABLE pedidos
            ADD CONSTRAINT pedidos_visit_id_fkey
            FOREIGN KEY (visit_id) REFERENCES restaurant_visits(visit_id)
            NOT VALID;
    END IF;
END $$;

INSERT INTO restaurant_tables (table_id, display_name)
SELECT 'M' || n, 'Mesa M' || n
FROM generate_series(1, 12) AS n
ON CONFLICT (table_id) DO NOTHING;
