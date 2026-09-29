// routes/store.js — Northline Ops Bookstore (digital products).
//
// Endpoints:
//   GET  /api/store/products          public product catalog
//   GET  /api/store/sample            free sample-chapter PDF (lead magnet)
//   POST /api/store/checkout          auth — Stripe Checkout for one product
//   GET  /api/store/library           auth — products this user has bought
//   GET  /api/store/download/:id      auth — download a purchased product file
//
// Admin (under /api/admin/store/*, mounted separately in routes/admin.js):
//   orders list, product list, product update.
//
// Tables are created on boot (CREATE TABLE IF NOT EXISTS) and the three
// launch products are seeded idempotently, so a deploy is all it takes.
'use strict';

const path = require('path');
const fs = require('fs');
const config = require('../config');
const db = require('../db');
const billing = require('../lib/billing');

const DIGITAL_DIR = path.join(__dirname, '..', 'data', 'digital');

const SEED_PRODUCTS = [
  {
    slug: 'playbook-ebook',
    title: "The Warehouse Manager's Playbook",
    subtitle: 'eBook (PDF)',
    description:
      'The complete playbook: 29 chapters of practical warehouse operations leadership — people first, hiring, onboarding, safety, training, KPIs, P&L, receiving, put-away, inventory, picking, and dock operations. Written from the warehouse floor, not a desk.',
    price_cents: 2900,
    currency: 'cad',
    file_name: 'playbook-full.pdf',
    includes: ['Complete 29-chapter book (PDF)', 'Lifetime updates to the eBook'],
    sort_order: 1,
  },
  {
    slug: 'playbook-bundle',
    title: 'Playbook + Template Pack',
    subtitle: 'eBook + companion tools (ZIP)',
    description:
      'The full playbook plus the companion tools from the book: the new-hire training tracker, the ROI calculator, and the probation review & PDP toolkit. Everything you need to put the chapters to work.',
    price_cents: 4900,
    currency: 'cad',
    file_name: 'playbook-bundle.zip',
    includes: [
      'Complete 29-chapter book (PDF)',
      'New-Hire Training Tracker (Excel)',
      'ROI Calculator (Excel)',
      'Probation Review & PDP Toolkit (Excel)',
      'Playbook Recurring Calendar (.ics)',
      'Playbook Annual Operations Calendar (.ics)',
    ],
    sort_order: 2,
  },
  {
    slug: 'playbook-team',
    title: 'Team License — 5 seats',
    subtitle: 'For your whole leadership team (ZIP)',
    description:
      'Everything in the Template Pack, licensed for up to 5 members of your leadership team. Share it inside your company and run the playbook together.',
    price_cents: 7900,
    currency: 'cad',
    file_name: 'playbook-bundle.zip',
    includes: [
      'Everything in the Template Pack',
      'License for up to 5 team members',
      'Share inside your company',
    ],
    sort_order: 3,
  },
];

async function ensureStoreTables() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      description TEXT,
      price_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'cad',
      file_name TEXT,
      includes JSONB NOT NULL DEFAULT '[]',
      active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS digital_orders (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      product_id UUID NOT NULL REFERENCES products(id),
      stripe_session_id TEXT UNIQUE,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'cad',
      status TEXT NOT NULL DEFAULT 'paid',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS digital_orders_user_idx ON digital_orders (user_id)`);
  for (const p of SEED_PRODUCTS) {
    await db.query(
      `INSERT INTO products (id, slug, title, subtitle, description, price_cents, currency, file_name, includes, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,true,$10)
       ON CONFLICT (slug) DO NOTHING`,
      [db.newId('prod'), p.slug, p.title, p.subtitle, p.description, p.price_cents, p.currency,
       p.file_name, JSON.stringify(p.includes), p.sort_order]
    );
  }
  // One-time price update 2026-09-27: eBook $49->$29, bundle $99->$49, team
  // $199->$79. Keyed on the old values so it fires once and never clobbers
  // a price the admin later sets with the price editor.
  await db.query(`UPDATE products SET price_cents = 2900 WHERE slug = 'playbook-ebook' AND price_cents = 4900`);
  await db.query(`UPDATE products SET price_cents = 4900 WHERE slug = 'playbook-bundle' AND price_cents = 9900`);
  await db.query(`UPDATE products SET price_cents = 7900 WHERE slug = 'playbook-team' AND price_cents = 19900`);
  // 2026-09-27: advertise the recurring calendar in the bundle's includes
  // (idempotent — skips rows that already list it, e.g. after an admin edit).
  await db.query(`UPDATE products SET includes = includes || '["Playbook Recurring Calendar (.ics)"]'::jsonb
                  WHERE slug = 'playbook-bundle' AND NOT (includes ? 'Playbook Recurring Calendar (.ics)')`);
  // 2026-09-29: advertise the annual operations calendar in the bundle's includes
  // (idempotent — skips rows that already list it, e.g. after an admin edit).
  await db.query(`UPDATE products SET includes = includes || '["Playbook Annual Operations Calendar (.ics)"]'::jsonb
                  WHERE slug = 'playbook-bundle' AND NOT (includes ? 'Playbook Annual Operations Calendar (.ics)')`);
}
ensureStoreTables().catch((e) => console.error('[store] table init failed:', e.message));

// Idempotent fulfillment, called from the Stripe webhook.
async function fulfillDigitalPurchase({ sessionId, productId, userId, amountCents, currency }) {
  if (!db.isEnabled() || !sessionId || !productId || !userId) return null;
  const r = await db.query(
    `INSERT INTO digital_orders (id, user_id, product_id, stripe_session_id, amount_cents, currency, status)
     VALUES ($1,$2,$3,$4,$5,$6,'paid')
     ON CONFLICT (stripe_session_id) DO NOTHING RETURNING id`,
    [db.newId('dord'), userId, productId, sessionId,
     Math.round(Number(amountCents) || 0), (currency || 'cad').toLowerCase()]
  );
  return r.rows.length ? r.rows[0].id : null;
}

function publicProduct(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    price_cents: row.price_cents,
    currency: row.currency,
    includes: row.includes || [],
    cover_url: '/img/playbook-cover.png',
  };
}

const router = require('express').Router();

// GET /api/store/products — public catalog.
router.get('/products', async (req, res) => {
  if (!db.isEnabled()) return res.json({ products: [] });
  try {
    const r = await db.query(
      `SELECT * FROM products WHERE active ORDER BY sort_order, created_at`
    );
    res.json({ products: r.rows.map(publicProduct) });
  } catch (e) {
    console.error('[store/products]', e.message);
    res.status(500).json({ error: 'Could not load the store.' });
  }
});

// GET /api/store/sample — free sample chapter (lead magnet, no auth).
router.get('/sample', (req, res) => {
  const file = path.join(DIGITAL_DIR, 'playbook-sample.pdf');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Sample not available yet.' });
  res.download(file, 'Warehouse-Managers-Playbook-Sample-Chapter.pdf');
});

// POST /api/store/checkout — start Stripe Checkout for one product.
router.post('/checkout', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to buy.' });
  if (!db.isEnabled()) return res.status(501).json({ error: 'Store requires a database.' });
  if (!config.stripeKey) {
    return res.status(501).json({ error: 'Payments are not configured yet: set STRIPE_SECRET_KEY on the server.' });
  }
  const slug = (req.body && req.body.slug) || '';
  try {
    const pr = await db.query(`SELECT * FROM products WHERE slug = $1 AND active LIMIT 1`, [slug]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Product not found.' });
    const product = pr.rows[0];
    // Already owns it — send them to the library instead of charging again.
    const owned = await db.query(
      `SELECT id FROM digital_orders WHERE user_id = $1 AND product_id = $2 AND status = 'paid' LIMIT 1`,
      [req.user.id, product.id]
    );
    if (owned.rows.length) {
      return res.status(409).json({ error: 'You already own this — find it in My Library.', owned: true });
    }
    const stripe = require('stripe')(config.stripeKey);
    let customerId = null;
    try { customerId = (await billing.getBillingState(req.user.id) || {}).stripeCustomerId || null; } catch { /* ignore */ }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.name || undefined,
        metadata: { user_id: req.user.id },
      });
      customerId = customer.id;
      try { await billing.setSubscription(req.user.id, { stripe_customer_id: customerId }); } catch { /* ignore */ }
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      client_reference_id: req.user.id,
      line_items: [{
        price_data: {
          currency: product.currency || 'cad',
          unit_amount: product.price_cents,
          product_data: {
            name: `Northline Ops — ${product.title}`,
            description: product.subtitle || undefined,
          },
        },
        quantity: 1,
      }],
      metadata: { type: 'digital_purchase', product_id: product.id, user_id: req.user.id, slug: product.slug },
      payment_intent_data: { metadata: { type: 'digital_purchase', product_id: product.id } },
      success_url: `${origin}/?store=purchased&product=${encodeURIComponent(product.slug)}`,
      cancel_url: `${origin}/?store=cancelled`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[store/checkout]', e.message);
    res.status(502).json({ error: 'Could not start payment: ' + e.message });
  }
});

// GET /api/store/library — products this user owns.
router.get('/library', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to see your library.' });
  if (!db.isEnabled()) return res.json({ items: [] });
  try {
    const r = await db.query(
      `SELECT p.*, o.created_at AS purchased_at
       FROM digital_orders o JOIN products p ON p.id = o.product_id
       WHERE o.user_id = $1 AND o.status = 'paid'
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json({ items: r.rows.map((row) => ({ ...publicProduct(row), purchased_at: row.purchased_at })) });
  } catch (e) {
    console.error('[store/library]', e.message);
    res.status(500).json({ error: 'Could not load your library.' });
  }
});

// GET /api/store/download/:id — download a purchased product file.
router.get('/download/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to download.' });
  if (!db.isEnabled()) return res.status(501).json({ error: 'Store requires a database.' });
  try {
    const r = await db.query(
      `SELECT p.file_name, p.title FROM digital_orders o
       JOIN products p ON p.id = o.product_id
       WHERE o.user_id = $1 AND p.id = $2 AND o.status = 'paid' LIMIT 1`,
      [req.user.id, req.params.id]
    );
    if (!r.rows.length || !r.rows[0].file_name) {
      return res.status(404).json({ error: 'Purchase not found.' });
    }
    const safeName = path.basename(r.rows[0].file_name);
    const file = path.join(DIGITAL_DIR, safeName);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not available yet.' });
    const dlName = r.rows[0].title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') + path.extname(safeName);
    res.download(file, dlName);
  } catch (e) {
    console.error('[store/download]', e.message);
    res.status(500).json({ error: 'Download failed.' });
  }
});

module.exports = router;
module.exports.fulfillDigitalPurchase = fulfillDigitalPurchase;
