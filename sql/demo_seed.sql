-- Demo business for trying the app: one outlet, an owner and a cashier login,
-- eight ice-pop flavours, three café items with recipes, and a 14-day trial.
-- Run after 001_schema.sql, 002_plans.sql and 003_menu_recipes.sql. `npm run demo` runs this for you and adds two years of
-- example sales on top.
--
--   Owner login:   demo@icepops.test     password: icepops-demo
--   Cashier login: cashier@icepops.test  password: icepops-demo
--
-- Never run this on your live database: the passwords above are public.

BEGIN;

INSERT INTO businesses (id, name, address, phone, gstin)
VALUES ('00000000-0000-4000-8000-000000000001', 'Icepops Demo', '12 MG Road, Bengaluru 560001', '98450 00000', '')
ON CONFLICT (id) DO NOTHING;

INSERT INTO outlets (id, business_id, name, address)
VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'MG Road', '12 MG Road, Bengaluru')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, business_id, outlet_id, name, email, password_hash, role)
VALUES
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', NULL,
   'Demo Owner', 'demo@icepops.test',
   'scrypt$16384$rO4T5OLaUxSv/h5C78IoWg==$cQlqA6ygL/SFk8FIhe9Y4vo4lM+qAGpjUwMeZkup0//tr5lTlmwffUTCRLaG5a253PER3hZ4T2lRq0ByGhm9kg==',
   'owner'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101',
   'Demo Cashier', 'cashier@icepops.test',
   'scrypt$16384$rO4T5OLaUxSv/h5C78IoWg==$cQlqA6ygL/SFk8FIhe9Y4vo4lM+qAGpjUwMeZkup0//tr5lTlmwffUTCRLaG5a253PER3hZ4T2lRq0ByGhm9kg==',
   'cashier')
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscriptions (business_id, plan_id, status, trial_ends_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'lite', 'trialing', now() + interval '14 days')
ON CONFLICT (business_id) DO NOTHING;

INSERT INTO items (id, business_id, name, price_paise, colour_a, colour_b, category, kind)
VALUES
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000001', 'Alphonso Mango', 4000, '#F9A61A', '#FFD23F', 'Icepops', 'pop'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000001', 'Strawberry',     3500, '#E8344E', '#FF8A9A', 'Icepops', 'pop'),
  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000001', 'Orange Bar',     3000, '#F26A1B', '#F26A1B', 'Icepops', 'pop'),
  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000001', 'Kala Khatta',    3500, '#5B2A86', '#9B5FC0', 'Icepops', 'pop'),
  ('00000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-000000000001', 'Rose Milk',      4000, '#F58BB0', '#FBD3E0', 'Icepops', 'pop'),
  ('00000000-0000-4000-8000-000000000306', '00000000-0000-4000-8000-000000000001', 'Lychee',         4500, '#F4C6CB', '#FFF0EE', 'Icepops', 'pop'),
  ('00000000-0000-4000-8000-000000000307', '00000000-0000-4000-8000-000000000001', 'Chilli Guava',   4500, '#3FA34D', '#F0627A', 'Icepops', 'pop'),
  ('00000000-0000-4000-8000-000000000308', '00000000-0000-4000-8000-000000000001', 'Tender Coconut', 5000, '#F5F1E3', '#CFE8C6', 'Icepops', 'pop')
ON CONFLICT (id) DO NOTHING;

-- Café items: made to order (no stock count) except the brownie, each with
-- making instructions for one portion.
INSERT INTO items (id, business_id, name, price_paise, colour_a, colour_b, category, kind, track_stock, prep_minutes, recipe)
VALUES
  ('00000000-0000-4000-8000-000000000309', '00000000-0000-4000-8000-000000000001', 'French Fries', 9000, '#D9342B', '#F2C230', 'Snacks', 'fries', false, 6,
   '{"ingredients": [
      {"qty": 150, "unit": "g", "name": "frozen fries"},
      {"qty": 0.5, "unit": "tsp", "name": "salt"},
      {"qty": 0.25, "unit": "tsp", "name": "peri-peri masala"},
      {"qty": 1, "unit": "sachet", "name": "tomato ketchup"}
    ],
    "steps": [
      "Heat the fryer oil to 175 °C.",
      "Fry the fries for 3 to 4 minutes until golden and crisp.",
      "Drain for 30 seconds, then toss with the salt and peri-peri masala.",
      "Serve in a fries box with the ketchup on the side."
    ]}'),
  ('00000000-0000-4000-8000-000000000310', '00000000-0000-4000-8000-000000000001', 'Cold Coffee', 12000, '#6F4E37', '#E9D8C4', 'Beverages', 'cup', false, 3,
   '{"ingredients": [
      {"qty": 1, "unit": "tbsp", "name": "coffee powder"},
      {"qty": 1, "unit": "spoon", "name": "sugar"},
      {"qty": 200, "unit": "ml", "name": "chilled milk"},
      {"qty": 1, "unit": "scoop", "name": "vanilla ice cream"},
      {"qty": 4, "unit": "cubes", "name": "ice"}
    ],
    "steps": [
      "Mix the coffee powder and sugar with 2 tbsp of warm water until dissolved.",
      "Add the milk, ice cream and ice to the blender with the coffee mix.",
      "Blend for 30 seconds until frothy.",
      "Pour into a 350 ml cup, dust with coffee powder and serve with a straw."
    ]}'),
  ('00000000-0000-4000-8000-000000000311', '00000000-0000-4000-8000-000000000001', 'Brownie', 8000, '#5A3A22', '#8B5A3C', 'Desserts', 'dessert', true, 2,
   '{"ingredients": [
      {"qty": 1, "unit": "piece", "name": "brownie"},
      {"qty": 1, "unit": "tbsp", "name": "chocolate sauce"}
    ],
    "steps": [
      "Warm the brownie in the microwave for 20 seconds.",
      "Plate it and drizzle the chocolate sauce over the top."
    ]}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO outlet_stock (outlet_id, item_id, stock)
SELECT '00000000-0000-4000-8000-000000000101', v.item_id::uuid, v.stock
FROM (VALUES
  ('00000000-0000-4000-8000-000000000301', 24),
  ('00000000-0000-4000-8000-000000000302', 18),
  ('00000000-0000-4000-8000-000000000303', 30),
  ('00000000-0000-4000-8000-000000000304', 12),
  ('00000000-0000-4000-8000-000000000305', 0),
  ('00000000-0000-4000-8000-000000000306', 3),
  ('00000000-0000-4000-8000-000000000307', 10),
  ('00000000-0000-4000-8000-000000000308', 15),
  ('00000000-0000-4000-8000-000000000309', 0),
  ('00000000-0000-4000-8000-000000000310', 0),
  ('00000000-0000-4000-8000-000000000311', 12)
) AS v(item_id, stock)
ON CONFLICT (outlet_id, item_id) DO NOTHING;

INSERT INTO stock_log (business_id, outlet_id, item_id, item_name, change, reason, stock_after)
SELECT i.business_id, s.outlet_id, i.id, i.name, s.stock, 'Opening stock', s.stock
FROM items i
JOIN outlet_stock s ON s.item_id = i.id
WHERE i.business_id = '00000000-0000-4000-8000-000000000001' AND i.track_stock
  AND NOT EXISTS (SELECT 1 FROM stock_log l WHERE l.item_id = i.id);

COMMIT;
