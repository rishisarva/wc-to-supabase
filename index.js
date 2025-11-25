require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

// Map WooCommerce -> Supabase format
function cleanOrder(order) {
  return {
    order_id: String(order.id),
    name: order.billing?.first_name || "",
    phone: order.billing?.phone || "",
    email: order.billing?.email || "",
    amount: order.total || 0,
    product: order.line_items?.[0]?.name || "",
    sku: order.line_items?.[0]?.sku || "",
    size: "",
    address: order.billing?.address_1 || "",
    status: "pending_payment"
  };
}

async function insertToSupabase(obj) {
  const url = `${SUPABASE_URL}/rest/v1/orders`;
  const r = await axios.post(url, obj, {
    headers: {
      "apikey": SUPABASE_ANON,
      "Authorization": `Bearer ${SUPABASE_ANON}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    }
  });
  return r.data;
}

// Health check
app.get('/', (req, res) => {
  console.log('GET / from', req.ip);
  res.send('WC → Supabase Webhook Running');
});

// Main webhook
app.post('/woocommerce-webhook', async (req, res) => {
  try {
    console.log('INCOMING WEBHOOK RAW BODY:', JSON.stringify(req.body).slice(0,2000));
    const order = req.body;
    if (!order || !order.id) {
      console.warn('Invalid order payload');
      return res.status(400).send('Invalid order payload');
    }
    const mapped = cleanOrder(order);
    const inserted = await insertToSupabase(mapped);
    console.log('Inserted into Supabase:', inserted);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error', err.response?.data || err.message);
    return res.status(500).send('Error');
  }
});

// Catch all to log unexpected methods/paths (helps debugging 404s)
app.all('*', (req, res) => {
  console.warn('UNHANDLED REQUEST', req.method, req.path);
  res.status(404).send('Not found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Listening on ${PORT}`); });
