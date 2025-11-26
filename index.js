require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

// DEBUG — PRINT RAW ENV VARIABLE
console.log("RAW ENV SUPABASE_URL =", JSON.stringify(process.env.SUPABASE_URL));

const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

// Health
app.get('/', (req, res) => {
  res.send("WC → Supabase Ready");
});

// Webhook
app.post('/woocommerce-webhook', async (req, res) => {
  try {
    console.log("INCOMING RAW:", JSON.stringify(req.body).substring(0,1500));

    const order = req.body.order;
    if (!order) return res.status(200).send("Ignored");

    let size = "";
    if (order.line_items?.[0]?.meta) {
      const s = order.line_items[0].meta.find(x => x.key === "pa_sizes");
      if (s) size = s.value;
    }

    const mapped = {
      order_id: String(order.id),
      name: order.billing_address?.first_name || "",
      phone: order.billing_address?.phone || "",
      email: order.billing_address?.email || "",
      amount: order.total,
      product: order.line_items?.[0]?.name,
      sku: order.line_items?.[0]?.sku,
      size: size,
      address: order.billing_address?.address_1,
      status: order.payment_details?.paid ? "paid" : "pending_payment"
    };

    console.log("MAPPED:", mapped);

    // Build final URL
    const finalURL = `${SUPABASE_URL}/rest/v1/orders`;

    // DEBUG — PRINT FINAL URL
    console.log("FULL URL FINAL =", JSON.stringify(finalURL));

    const response = await axios.post(
      finalURL,
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

    console.log("INSERT OK:", response.data);
    return res.status(200).send("OK");

  } catch (err) {
    console.log("WEBHOOK ERROR FULL:", err);
    return res.status(200).send("OK");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Listening on", PORT));
