require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

// Health Check
app.get('/', (req, res) => {
  console.log("GET / from", req.ip);
  res.send("WC → Supabase Webhook Running");
});

// WooCommerce Webhook Handler
app.post('/woocommerce-webhook', async (req, res) => {
  try {
    console.log("INCOMING WEBHOOK RAW BODY:", JSON.stringify(req.body).substring(0, 2000));

    const incoming = req.body;

    // WooCommerce sends { order: {...} }
    const order = incoming.order;
    if (!order || !order.id) {
      console.warn("Invalid order payload, ignoring...");
      return res.status(200).send("Ignored");
    }

    // Extract size (pa_sizes) from meta
    let size = "";
    if (order.line_items?.[0]?.meta) {
      const sizeMeta = order.line_items[0].meta.find(m => m.key === "pa_sizes");
      if (sizeMeta) size = sizeMeta.value;
    }

    // Map to Supabase fields
    const mapped = {
      order_id: String(order.id),
      name: order.billing_address?.first_name || "",
      phone: order.billing_address?.phone || "",
      email: order.billing_address?.email || "",
      amount: order.total || 0,
      product: order.line_items?.[0]?.name || "",
      sku: order.line_items?.[0]?.sku || "",
      size: size,
      address: order.billing_address?.address_1 || "",
      status: order.payment_details?.paid ? "paid" : "pending_payment"
    };

    console.log("MAPPED:", mapped);

    const response = await axios.post(
      `${SUPABASE_URL}/rest/v1/orders`,
      mapped,
      {
        headers: {
          "apikey": SUPABASE_ANON,
          "Authorization": `Bearer ${SUPABASE_ANON}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        }
      }
    );

    console.log("Inserted into Supabase:", response.data);
    return res.status(200).send("OK");

  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    return res.status(200).send("OK"); // Avoid retries
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
