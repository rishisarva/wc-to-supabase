require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

// --------------------------------------
// ENVIRONMENT VARIABLES
// --------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

console.log("🚀 Render Webhook Server Starting…");

// --------------------------------------
// HEALTH CHECK
// --------------------------------------
app.get("/", (req, res) => {
  res.send("WC → Supabase Webhook Active ✔");
});

// --------------------------------------
// WOO → SUPABASE HANDLER
// --------------------------------------
app.post("/woocommerce-webhook", async (req, res) => {
  console.log("INCOMING RAW:", JSON.stringify(req.body).substring(0, 1500));

  const order = req.body.order;
  if (!order) return res.status(200).send("IGNORED");

  // Extract size
  let size = "";
  try {
    const meta = order.line_items?.[0]?.meta;
    if (meta) {
      const s = meta.find(x => x.key === "pa_sizes");
      if (s) size = s.value;
    }
  } catch {}

  // Map fields
  const mapped = {
    order_id: String(order.id),
    name: order.billing_address?.first_name || "",
    phone: order.billing_address?.phone || "",
    email: order.billing_address?.email || "",
    amount: order.total,
    product: order.line_items?.[0]?.name || "",
    sku: order.line_items?.[0]?.sku || "",
    size,
    address: order.billing_address?.address_1 || "",
    status: "pending_payment",
    created_at: new Date().toISOString(),
    next_message: "reminder_24h",
    supplier_sent: false
  };

  console.log("MAPPED:", mapped);

  try {
    // Insert into Supabase
    const response = await axios.post(
      `${SUPABASE_URL}/rest/v1/orders`,
      mapped,
      {
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        }
      }
    );

    console.log("✔ SAVED TO SUPABASE:", response.data);
    return res.status(200).send("OK");
  } catch (err) {
    console.error("INSERT ERROR →", err.response?.data || err.message);
    return res.status(200).send("OK");
  }
});

// --------------------------------------
// START SERVER
// --------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Listening on ${PORT}`);
});
