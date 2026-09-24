ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS archived_by VARCHAR(120);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS archive_reason TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS deletion_reason TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS retention_class VARCHAR(30) NOT NULL DEFAULT 'operational';
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS data_origin VARCHAR(30) NOT NULL DEFAULT 'customer_order';

UPDATE pedidos
   SET created_at = COALESCE(created_at, timestamp, NOW()),
       updated_at = COALESCE(updated_at, timestamp, NOW()),
       retention_class = COALESCE(NULLIF(retention_class, ''), CASE WHEN is_test THEN 'test' ELSE 'operational' END),
       data_origin = COALESCE(NULLIF(data_origin, ''), CASE WHEN is_test THEN 'automated_test' ELSE 'customer_order' END)
 WHERE created_at IS NULL OR updated_at IS NULL OR retention_class IS NULL OR data_origin IS NULL;

ALTER TABLE pedido_eventos ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE restaurant_visits ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE restaurant_visits ADD COLUMN IF NOT EXISTS data_origin VARCHAR(30) NOT NULL DEFAULT 'customer_order';
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS order_retention_policy (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    draft_hours INTEGER NOT NULL DEFAULT 24 CHECK (draft_hours >= 0 AND draft_hours <= 8760),
    test_hours INTEGER NOT NULL DEFAULT 24 CHECK (test_hours >= 0 AND test_hours <= 8760),
    delivered_days INTEGER NOT NULL DEFAULT 30 CHECK (delivered_days >= 0 AND delivered_days <= 3650),
    cancelled_days INTEGER NOT NULL DEFAULT 7 CHECK (cancelled_days >= 0 AND cancelled_days <= 3650),
    audit_days INTEGER NOT NULL DEFAULT 3650 CHECK (audit_days >= 0 AND audit_days <= 3650),
    auto_delete_historical BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(120)
);
INSERT INTO order_retention_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_pedidos_history_created ON pedidos(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_history_updated ON pedidos(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_history_status ON pedidos(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_history_table ON pedidos(table_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_history_archived ON pedidos(archived_at, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_history_test ON pedidos(is_test, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_history_confirmed ON pedidos(confirmed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_history_delivered ON pedidos(delivered_at DESC, id DESC);
