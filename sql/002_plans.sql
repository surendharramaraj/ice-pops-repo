-- Subscription plans. Runs every time the server starts, so editing a price or
-- limit here and restarting updates it. razorpay_plan_id is never overwritten:
-- set it once with the UPDATE at the bottom.

INSERT INTO plans (id, name, price_monthly_paise, max_outlets, max_users, max_items, features, self_serve, sort_order)
VALUES
  ('lite', 'Lite', 49900, 1, 3, 50,
   ARRAY['Counter billing', 'Stock tracking', 'E-bills and PDF bills', 'Sales reports', 'Excel export'],
   true, 1),
  ('pro', 'Pro', 149900, 3, 10, NULL,
   ARRAY['Everything in Lite', 'Up to 3 outlets', 'Reports across outlets', 'Up to 10 staff logins', 'Unlimited items'],
   true, 2),
  ('enterprise', 'Enterprise', 0, NULL, NULL, NULL,
   ARRAY['Everything in Pro', 'Unlimited outlets and staff', 'Franchise-wide menu', 'Priority support', 'Custom setup'],
   false, 3)
ON CONFLICT (id) DO UPDATE SET
  name                = EXCLUDED.name,
  price_monthly_paise = EXCLUDED.price_monthly_paise,
  max_outlets         = EXCLUDED.max_outlets,
  max_users           = EXCLUDED.max_users,
  max_items           = EXCLUDED.max_items,
  features            = EXCLUDED.features,
  self_serve          = EXCLUDED.self_serve,
  sort_order          = EXCLUDED.sort_order;

-- After creating the plans in the Razorpay dashboard (Subscriptions → Plans), link them:
-- UPDATE plans SET razorpay_plan_id = 'plan_XXXXXXXXXXXXXX' WHERE id = 'lite';
-- UPDATE plans SET razorpay_plan_id = 'plan_YYYYYYYYYYYYYY' WHERE id = 'pro';
