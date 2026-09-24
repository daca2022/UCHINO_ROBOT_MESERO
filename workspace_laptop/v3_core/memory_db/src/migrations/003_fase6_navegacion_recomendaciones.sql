-- FASE 6: navegación conversacional del menú y recomendaciones controladas.
-- Cambios ADITIVOS. No elimina ni renombra columnas existentes.

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS destacado BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS recomendable BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS orden_aparicion INTEGER NOT NULL DEFAULT 100;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS etiqueta_promocional TEXT;

-- Asegura que las categorías aceptadas incluyen los valores reales del
-- checkout actual (la API ya entrega "plato"/"bebida"/"postre" en singular;
-- los datos históricos se insertaron con la categoría en singular).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'categoria_menu') THEN
        CREATE TYPE categoria_menu AS ENUM (
            'plato_principal', 'entrada', 'menu_completo', 'bebida', 'postre',
            'plato', 'platos', 'bebidas', 'postres'
        );
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END$$;

-- Si la columna categoria está declarada con el ENUM antiguo, lo ampliamos
-- solo si Postgres lo permite (ADD VALUE no es destructivo). Si la columna
-- es varchar(50) (caso real del repo), este bloque no hace nada.
DO $$
BEGIN
    BEGIN
        ALTER TYPE categoria_menu ADD VALUE IF NOT EXISTS 'plato';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TYPE categoria_menu ADD VALUE IF NOT EXISTS 'platos';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TYPE categoria_menu ADD VALUE IF NOT EXISTS 'bebidas';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
        ALTER TYPE categoria_menu ADD VALUE IF NOT EXISTS 'postres';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
END$$;

-- Registra explícitamente dos productos como recomendables/destacados para
-- que la UI tenga datos sobre los que operar sin depender de inserciones
-- manuales. El lomo y la chicha morada son los candidatos más comunes
-- en las recomendaciones del proyecto. Los demás productos mantienen los
-- defaults (destacado=false, recomendable=true).
UPDATE menu_items SET destacado = true,  orden_aparicion = 10 WHERE nombre = 'Lomo Saltado';
UPDATE menu_items SET destacado = true,  orden_aparicion = 20 WHERE nombre = 'Ceviche';
UPDATE menu_items SET                       orden_aparicion = 30 WHERE nombre = 'Pollo a la Brasa';
UPDATE menu_items SET                       orden_aparicion = 40 WHERE nombre = 'Tallarines';
UPDATE menu_items SET                       orden_aparicion = 10 WHERE nombre = 'Chicha Morada';
UPDATE menu_items SET                       orden_aparicion = 20 WHERE nombre = 'Inca Kola';

-- (Solo QA / desarrollo) Marca un par de productos con etiqueta promocional
-- para verificar el render en /robot. En un ambiente operativo real, esta
-- columna la llena el operador desde Admin.
UPDATE menu_items SET etiqueta_promocional = 'Más pedido' WHERE nombre = 'Lomo Saltado';
UPDATE menu_items SET etiqueta_promocional = 'Recomendado' WHERE nombre = 'Chicha Morada';

CREATE INDEX IF NOT EXISTS idx_menu_items_destacado ON menu_items(destacado) WHERE destacado = true;
CREATE INDEX IF NOT EXISTS idx_menu_items_orden ON menu_items(categoria, orden_aparicion);
CREATE INDEX IF NOT EXISTS idx_menu_items_disponible ON menu_items(disponible) WHERE disponible = true;
