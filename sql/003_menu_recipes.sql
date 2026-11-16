-- Menu categories, made-to-order items and making instructions (recipes).
-- Safe to run more than once. Existing items are ice pops, so they get the
-- 'Icepops' category and pop picture; new items default to 'Other'.

ALTER TABLE items ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'Icepops';
ALTER TABLE items ALTER COLUMN category SET DEFAULT 'Other';

-- Picture shown on the counter: pop, cup (drinks), fries, dessert, plate (anything else).
ALTER TABLE items ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'pop';
ALTER TABLE items ALTER COLUMN kind SET DEFAULT 'plate';
DO $$ BEGIN
  ALTER TABLE items ADD CONSTRAINT items_kind_check CHECK (kind IN ('pop', 'cup', 'fries', 'dessert', 'plate'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- false: made to order (fries, coffee). No stock count, never "sold out".
ALTER TABLE items ADD COLUMN IF NOT EXISTS track_stock boolean NOT NULL DEFAULT true;

-- Making instructions for one portion:
-- {"ingredients": [{"qty": 1, "unit": "tbsp", "name": "coffee powder"}], "steps": ["Blend for 30 seconds"]}
ALTER TABLE items ADD COLUMN IF NOT EXISTS recipe jsonb NOT NULL DEFAULT '{"ingredients": [], "steps": []}';
ALTER TABLE items ADD COLUMN IF NOT EXISTS prep_minutes integer CHECK (prep_minutes IS NULL OR prep_minutes BETWEEN 0 AND 240);

CREATE INDEX IF NOT EXISTS items_business_category_idx ON items (business_id, category);
