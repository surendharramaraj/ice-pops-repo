# Icepops

Counter billing, stock, sales reports and e-bills for ice-pop shops, sold as a monthly subscription. Each business signs up, gets a free trial, and has its own outlets, staff logins and data.

## Run it on your computer

```
npm install      # first time only
npm start
```

Open http://localhost:8000/signup.html to create a business, or http://localhost:8000/ to log in.

The data is saved in `data/pgdata` (PostgreSQL running inside Node, called PGlite). Only one server can use that folder at a time.

### Try the demo

```
npm run demo
```

It uses a separate database (`data/pgdemo`) with two years of example sales. Log in as:

- Owner: `demo@icepops.test`, password `icepops-demo`
- Cashier: `cashier@icepops.test`, password `icepops-demo`

To reset the demo, stop the server and delete the `data/pgdemo` folder.

### Bring in your old spreadsheet

If you used the earlier version that saved to `data/icepops-data.xlsx`:

1. Run `npm start`, sign up, then stop the server (Ctrl+C).
2. Run `npm run import-excel -- data/icepops-data.xlsx you@example.com` with the email you signed up with.
3. Run `npm start` again. Your flavours, stock and bills are there, and bill numbers carry on.

## Database

The SQL is in `sql/`:

| File | What it does |
| --- | --- |
| `001_schema.sql` | Creates every table. Safe to run again. |
| `002_plans.sql` | Inserts or updates the Lite, Pro and Enterprise plans. |
| `003_menu_recipes.sql` | Adds menu categories, made-to-order items and recipes. |
| `demo_seed.sql` | Inserts the demo business. Never run it on your live database. |

The server runs the first two every time it starts. To use them yourself on a PostgreSQL server: `psql "$DATABASE_URL" -f sql/001_schema.sql -f sql/002_plans.sql`.

Tables: `businesses`, `outlets`, `users`, `sessions`, `plans`, `subscriptions`, `payments`, `items`, `outlet_stock`, `stock_log`, `bills`, `bill_items`. Every row belongs to one business, and the server filters every query by the logged-in user's business. Money is stored in paise.

## Menu, categories and recipes

Any item can go on the menu, not just ice pops. On the Inventory page, each item has:

- **Category:** Icepops, Snacks, Beverages, Desserts or your own. The counter shows a tab for each, and reports show sales by category.
- **Picture:** ice pop, cup, fries box, dessert slice or plate, in the item's colour.
- **Made to order:** for fries, coffee and anything else you don't count. These never show as sold out.
- **Recipe:** ingredients for one portion (amount, unit, ingredient, for example `1 tbsp coffee powder`), steps, and prep time.

At the counter, **Recipe** on a card shows how to make one portion. After a sale with recipe items, the **making slip** opens with every item's instructions, amounts multiplied by the quantity ordered. It can be printed for the kitchen.

Recipes are instructions only: they don't yet reduce stock of sugar, milk or other ingredients.

## Plans and limits

| Plan | Price a month | Outlets | Logins | Menu items |
| --- | --- | --- | --- | --- |
| Lite | ₹499 | 1 | 3 | 50 |
| Pro | ₹1,499 | 3 | 10 | Unlimited |
| Enterprise | Custom | Unlimited | Unlimited | Unlimited |

New businesses get a 14-day trial of Lite. When the trial or a subscription ends, they can still log in, see reports and download their data, but can't bill or change stock until they choose a plan. A failed renewal gets 3 days' grace. Change prices and limits in `sql/002_plans.sql` and restart.

## Roles

- **Owner:** everything, including plan, payments, business details, outlets and staff logins.
- **Manager:** counter, inventory and reports at every outlet.
- **Cashier:** counter and e-bills at one outlet.

## Taking payments with Razorpay

Without Razorpay keys the server runs in **test billing mode**: choosing a plan turns it on for a month without payment. Never sell in this mode.

To go live:

1. In the Razorpay dashboard, create a plan for Lite and Pro (Subscriptions → Plans, monthly, ₹499 and ₹1,499).
2. Link them: `UPDATE plans SET razorpay_plan_id = 'plan_...' WHERE id = 'lite';` (and the same for `pro`).
3. Add a webhook pointing to `https://your-domain/api/billing/webhook` with the events `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled` and `subscription.completed`.
4. Start the server with `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` set. Billing switches to Razorpay mode automatically.

Changing plans while a Razorpay subscription is active isn't automatic yet: the owner cancels, then chooses the new plan when the period ends, or you change it for them in the Razorpay dashboard.

## Hosting online

**On your own Ubuntu server with nginx and PostgreSQL:** see [DEPLOY.md](DEPLOY.md). One command sets it all up: `deploy/deploy.sh ubuntu@SERVER_IP --setup your-domain.com you@example.com`.

**On a hosting platform:**

Run it on any Node host (Render, Railway, a VPS) with a PostgreSQL database (Supabase, Neon, AWS RDS):

| Setting | Value |
| --- | --- |
| `DATABASE_URL` | Your PostgreSQL connection string |
| `HOST` | `0.0.0.0` |
| `PORT` | Usually set by the host |
| `COOKIE_SECURE` | `1` when served over HTTPS (most hosts set this automatically through `X-Forwarded-Proto`) |
| `RAZORPAY_*` | As above |

Turn on daily database backups at your database provider, and serve the site only over HTTPS.

## Other settings

- Currency symbol and the "Low" stock level: top of `store.js`.
- Make customer name and mobile required at checkout: `REQUIRE_CUSTOMER = true` in `store.js`.
- Contact shown on the Enterprise plan card: `SALES_CONTACT` in `account.html`.
- Business name, address, phone and GSTIN on e-bills: each owner sets these on their Account page.
