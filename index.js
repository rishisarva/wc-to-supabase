require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

// -------------------------
// ENVIRONMENT VARIABLES
// -------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID;

const CUSTOMER_MSG_TEMPLATE = process.env.CUSTOMER_MSG_TEMPLATE || 
`Hey {{name}}, 👋

Thanks for placing your order!

🧾 *Order ID:* {{order_id}}
🛍 *Product:* {{product}}
💰 *Amount:* ₹{{amount}}

Below is your payment QR.  
Once paid, reply *DONE* — our team will text you within 10 minutes.`;

const QR_IMAGE_URL = process.env.QR_IMAGE_URL;

// Initialize Telegram Bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log("🚀 Server starting…");
console.log("SUPABASE_URL =", SUPABASE_URL);

// -----------------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------------
app.get("/", (req, res) => {
  res.send("WC → Supabase Automation Active");
});

// -----------------------------------------------------------
// 1) WOO WEBHOOK → Save Order
// -----------------------------------------------------------
app.post("/woocommerce-webhook", async (req, res) => {
  console.log("INCOMING RAW:", JSON.stringify(req.body).substring(0, 1500));

  const data = req.body;
  const order = data.order;
  if (!order) return res.status(200).send("IGNORED");

  // Extract size
  let size = "";
  if (order.line_items?.[0]?.meta) {
    const m = order.line_items[0].meta.find(x => x.key === "pa_sizes");
    if (m) size = m.value;
  }

  // Prepare mapped object
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
    next_message: "reminder_24h",   // first reminder to send after 24h
    supplier_sent: false
  };

  console.log("MAPPED:", mapped);

  try {
    // Insert into Supabase
    const insertURL = `${SUPABASE_URL}/rest/v1/orders`;
    console.log("FULL URL →", insertURL);

    const sb = await axios.post(
      insertURL,
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

    console.log("✔️ INSERTED:", sb.data);

    // SEND MESSAGE TO CUSTOMER
    const msg = CUSTOMER_MSG_TEMPLATE
      .replace("{{name}}", mapped.name)
      .replace("{{order_id}}", mapped.order_id)
      .replace("{{product}}", mapped.product)
      .replace("{{amount}}", mapped.amount);

    await bot.sendMessage(mapped.phone.replace("+", ""), msg, { parse_mode: "Markdown" });
    await bot.sendPhoto(mapped.phone.replace("+", ""), QR_IMAGE_URL);

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    return res.status(200).send("OK");
  }
});

// -----------------------------------------------------------
// 2) TELEGRAM COMMAND: /paid <order_id>
// -----------------------------------------------------------
bot.onText(/\/paid (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const orderId = match[1].trim();

  try {
    const fetchRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`,
      {
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`
        }
      }
    );

    if (!fetchRes.data.length) {
      return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);
    }

    const order = fetchRes.data[0];

    // Update to paid
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`,
      {
        status: "paid",
        next_message: null,
        supplier_sent: true
      },
      {
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
          "Content-Type": "application/json"
        }
      }
    );

    // Message to supplier (which is YOU)
    const supplierMsg = `
📦 *NEW PAID ORDER*

🧾 Order ID: *${order.order_id}*
👤 Name: *${order.name}*
📞 ${order.phone}
📍 ${order.address}

🛍 ${order.product}
🔖 SKU: ${order.sku}
📏 Size: ${order.size}

💰 *₹${order.amount}*
    `;

    await bot.sendMessage(SUPPLIER_CHAT_ID, supplierMsg, { parse_mode: "Markdown" });

    await bot.sendMessage(chatId, `✅ Order ${orderId} marked PAID & sent to supplier.`);

  } catch (err) {
    console.error("TG /paid error:", err.message);
    bot.sendMessage(chatId, "⚠️ Error processing request.");
  }
});

// -----------------------------------------------------------
// 3) CRON JOB ENDPOINT triggered by Render Scheduler
// -----------------------------------------------------------
app.get("/cron-check", async (req, res) => {
  try {
    // fetch all pending unpaid orders
    const result = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment`,
      {
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`
        }
      }
    );

    const orders = result.data;

    for (const o of orders) {
      const hoursPassed =
        (Date.now() - new Date(o.created_at).getTime()) / (1000 * 60 * 60);

      // 24h reminder
      if (o.next_message === "reminder_24h" && hoursPassed >= 24) {
        await bot.sendMessage(
          o.phone.replace("+", ""),
          `⏰ Reminder: Your order *${o.order_id}* is still unpaid. Please pay to confirm.`
        );

        await axios.patch(
          `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${o.order_id}`,
          { next_message: "reminder_40h" },
          {
            headers: {
              apikey: SUPABASE_ANON,
              Authorization: `Bearer ${SUPABASE_ANON}`
            }
          }
        );
      }

      // 40h reminder with discount
      if (o.next_message === "reminder_40h" && hoursPassed >= 40) {
        await bot.sendMessage(
          o.phone.replace("+", ""),
          `🔥 Special Offer!\nComplete your order *${o.order_id}* now & get ₹30 OFF!\nNew amount: ₹${o.amount - 30}`
        );

        await axios.patch(
          `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${o.order_id}`,
          { next_message: null },
          {
            headers: {
              apikey: SUPABASE_ANON,
              Authorization: `Bearer ${SUPABASE_ANON}`
            }
          }
        );
      }
    }

    res.send("CRON OK");
  } catch (err) {
    console.error("CRON ERROR:", err.message);
    res.send("CRON ERROR");
  }
});

// -----------------------------------------------------------
// START SERVER
// -----------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Listening on ${PORT}`);
});
