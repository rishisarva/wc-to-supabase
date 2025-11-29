require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { DateTime } = require("luxon");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

// ---------------- CONFIG ----------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID;
const WC_KEY = process.env.WC_KEY;
const WC_SECRET = process.env.WC_SECRET;

const BASE_URL = process.env.BASE_URL || "https://wc-to-supabase.onrender.com";
const TIMEZONE = "Asia/Kolkata";

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

// --------- Telegram Webhook Mode ---------
let bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: true });
bot.setWebHook(`${BASE_URL}/telegram-webhook`);
console.log("Telegram bot running in Webhook Mode");

// Telegram webhook route
app.post("/telegram-webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ---------------- TIME HELPERS ----------------
function nowISO() {
  return new Date().toISOString();
}

function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

// ---------------- HEALTH CHECK ----------------
app.get("/", (_, res) => res.send("WC→Supabase Running ✓"));

// ---------------- ORDER RECEIVED (Webhook) ----------------
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    const order = req.body.order;
    if (!order) return res.status(200).send("NO_ORDER");

    const mapped = {
      order_id: String(order.id),
      name: order.billing_address.first_name || "",
      phone: order.billing_address.phone || "",
      email: order.billing_address.email || "",
      amount: Number(order.total) || 0,
      product: order.line_items?.[0]?.name || "",
      sku: order.line_items?.[0]?.sku || "",
      size: order.line_items?.[0]?.meta?.find(m => m.key.includes("size"))?.value || "",
      address: order.billing_address.address_1 || "",
      state: order.billing_address.state || "",
      pincode: order.billing_address.postcode || "",
      quantity: order.total_line_items_quantity || 1,

      status: "pending_payment",
      created_at: nowISO(),

      message_sent: false,
      paid_message_pending: false,

      reminder_24_sent: false,
      reminder_48_sent: false,
      reminder_72_sent: false,

      next_message: "reminder_24h",
      discounted_amount: null,
      supplier_sent: false,
      paid_at: null
    };

    await axios.post(`${SUPABASE_URL}/rest/v1/orders`, mapped, { headers: sbHeaders });

    return res.status(200).send("OK");
  } catch (err) {
    console.log("Webhook Error:", err.message);
    return res.status(200).send("OK");
  }
});

// ---------------- /paid COMMAND ----------------
bot.onText(/\/paid (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const orderId = match[1].trim();

  try {
    // GET ORDER
    const fetchUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}&select=*`;
    const f = await axios.get(fetchUrl, { headers: sbHeaders });
    if (!f.data.length) return bot.sendMessage(chatId, "❌ Order not found.");

    const o = f.data[0];

    // -------- UPDATE WooCommerce to PROCESSING --------
    try {
      await axios.put(
        `https://visionsjersey.in/wp-json/wc/v3/orders/${orderId}`,
        { status: "processing" },
        { auth: { username: WC_KEY, password: WC_SECRET } }
      );
    } catch (err) {
      console.log("WooCommerce update failed");
    }

    // -------- Notify Supplier --------
    const supplierMsg = `
📦 *NEW PAID ORDER*

👤 Name: ${o.name}
📞 ${o.phone}

📍 ${o.address}, ${o.state} - ${o.pincode}

🆔 Order ID: ${o.order_id}
🎽 Product: ${o.product}
📏 Size: ${o.size}
🔢 Qty: ${o.quantity}

🚚 Shipment: Normal
`.trim();

    await bot.sendMessage(SUPPLIER_CHAT_ID, supplierMsg, { parse_mode: "Markdown" });

    // -------- MARK ORDER PAID IN SUPABASE --------
    await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`, {
      status: "paid",
      paid_at: nowISO(),
      paid_message_pending: true,
      reminder_24_sent: true,
      reminder_48_sent: true,
      reminder_72_sent: true,
      next_message: null
    }, { headers: sbHeaders });

    bot.sendMessage(chatId, `✅ Order ${orderId} marked PAID.\n📦 Processing started.`);

  } catch (err) {
    bot.sendMessage(chatId, "Error. Check Render logs.");
  }
});

// ---------------- REMINDER CRON ----------------
app.get("/cron-check", async (req, res) => {
  try {
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`, { headers: sbHeaders });
    const orders = r.data || [];
    const patches = [];

    for (const o of orders) {
      const h = hoursSince(o.created_at);

      if (h >= 24 && !o.reminder_24_sent)
        patches.push({ id: o.order_id, patch: { reminder_24_sent: true, next_message: "reminder_48h" }});

      if (h >= 48 && !o.reminder_48_sent)
        patches.push({ id: o.order_id, patch: { reminder_48_sent: true, discounted_amount: o.amount - 30, next_message: "reminder_72h" }});

      if (h >= 72 && !o.reminder_72_sent)
        patches.push({ id: o.order_id, patch: { reminder_72_sent: true, status: "cancelled", next_message: null }});
    }

    for (const entry of patches) {
      await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${entry.id}`, entry.patch, { headers: sbHeaders });

      // UPDATE WooCommerce IF CANCELLED
      if (entry.patch.status === "cancelled") {
        try {
          await axios.put(
            `https://visionsjersey.in/wp-json/wc/v3/orders/${entry.id}`,
            { status: "cancelled" },
            { auth: { username: WC_KEY, password: WC_SECRET } }
          );
        } catch {}
      }
    }

    res.json({ updated: patches.length });
  } catch (err) {
    res.status(500).send("ERR");
  }
});

// ---------------- START ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\n🚀 SERVER RUNNING");
  console.log("URL:", BASE_URL);
});
