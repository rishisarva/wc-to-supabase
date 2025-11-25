require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

// Map WooCommerce → Supabase format
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

app.post('/woocommerce-webhook', async (req, res) => {
  try {
    const order = req.body;
    if (!order.id) return res.status(400).send("Invalid Order");

    const mapped = cleanOrder(order);
    const inserted = await insertToSupabase(mapped);
    console.log("Inserted:", inserted);

    res.send("OK");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Error");
  }
});

app.get('/', (req, res) => res.send("WC → Supabase Webhook Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
