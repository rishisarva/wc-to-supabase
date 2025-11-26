require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

// --------------------------------------
// ENVIRONMENT VARIABLES
// --------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

const TELEGRAM_TOKEN = 8549035142:AAEmjUh-rgJgwr5UJcf4B1zNblVxq1pl5jM;
const SUPPLIER_CHAT_ID = 8525379867;

console.log("🚀 Render Server Starting…");
console.log("Supabase URL:", SUPABASE_URL);

// --------------------------------------
// TELEGRAM BOT INITIALIZATION
// --------------------------------------
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Send message to you when server boots
bot.sendMessage(SUPPLIER_CHAT_ID, "🚀 Telegram Bot Started on Render!");

// --------------------------------------
// TELEGRAM COMMANDS
// --------------------------------------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Hello! Bot is active.");
});

bot.onText(/\/test/, (msg) => {
  bot.sendMessage(SUPPLIER_CHAT_ID, "📩 Test message received!");
});

// Supplier confirms payment: /paid 12345
bot.onText(/\/paid (.+)/, async (msg, match) => {
  const orderId = match[1];
  const chatId = msg.chat.id;

  try {
    // fetch order
    const fetchRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`,
      {
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
        }
      }
    );

    if (!fetchRes.data.length) {
      return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);
    }

    const order = fetchRes.data[0];

    // update order
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`,
      {
        status: "paid",
        next_message: null,
        supplier_sent: true,
      },
      {
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
          "Content-Type": "application/json",
        }
      }
    );

    // Notify you (supplier)
    const message = `
📦 *NEW PAID ORDER*

🧾 Order: *${order.order_id}*
👤 ${order.name}
📞 ${order.phone}
📍 ${order.address}

🛍 ${order.product}
🔖 SKU: ${order.sku}
📏 Size: ${order.size}

💰 ₹${order.amount}
`;

    await bot.sendMessage(SUPPLIER_CHAT_ID, message, {
      parse_mode: "Markdown",
    });

    bot.sendMessage(chatId, `✅ Order ${orderId} marked PAID.`);

  } catch (err) {
    console.log("PAID ERROR:", err.message);
    bot.sendMessage(chatId, "⚠️ Error processing payment.");
  }
});


// --------------------------------------
// HEALTH CHECK
// --------------------------------------
app.get("/", (req, res) => {
  res.send("WC → Supabase + Telegram Bot Active ✔");
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
