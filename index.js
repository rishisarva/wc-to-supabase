require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { DateTime } = require("luxon");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

// ---------------- ENV ----------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID;
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

// WooCommerce Keys (Render Variables)
const WC_USER = process.env.WC_KEY || "";
const WC_PASS = process.env.WC_SECRET || "";

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("❌ Missing Supabase credentials");
  process.exit(1);
}

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

// ---------------- Telegram ----------------
let bot = null;
let todayPaidList = [];  // 🔥 New storage

if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log("🤖 Telegram Bot Ready");
}

function nowISO() { return new Date().toISOString(); }
function hoursSince(iso) { return (Date.now() - new Date(iso).getTime()) / 3600000; }


// ---------------- HEALTH ----------------
app.get("/", (req, res) => res.send("🔥 WC → Supabase Automation Live"));


// ---------------- WEBHOOK INSERT ----------------
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    const order = req.body.order;
    if (!order) return res.send("NO ORDER");

    let size = "";
    let qty = 1;

    try {
      const meta = order.line_items?.[0]?.meta;
      if (meta) {
        const s = meta.find(m => m.key === "pa_sizes" || m.label?.toLowerCase()?.includes("size"));
        if (s) size = s.value;
      }
      qty = order.total_line_items_quantity || order.line_items?.[0]?.quantity || 1;
    } catch (_) {}

    await axios.post(`${SUPABASE_URL}/rest/v1/orders`, {
      order_id: String(order.id),
      name: order.billing_address.first_name,
      phone: order.billing_address.phone,
      email: order.billing_address.email,
      amount: Number(order.total),
      product: order.line_items[0].name,
      sku: order.line_items[0]?.sku || "",
      size,
      address: order.billing_address.address_1,
      state: order.billing_address.state,
      pincode: order.billing_address.postcode,
      quantity: qty,

      status: "pending_payment",
      created_at: nowISO(),
      message_sent: false,
      paid_message_pending: false,
      resend_qr_pending: false
    }, { headers: sbHeaders });

    res.send("OK");
  } catch (err) {
    console.error(err.message);
    res.send("ERR");
  }
});


// ---------------- 📌 /paid COMMAND ----------------
if (bot) {
  bot.onText(/\/paid\s+(.+)/i, async (msg, match) => {

    const chatId = msg.chat.id;
    const orderId = match[1]?.trim();
    if (!orderId) return bot.sendMessage(chatId, "❌ Use: `/paid <order_id>`", { parse_mode: "Markdown" });

    try {
      // fetch
      const { data } = await axios.get(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}&select=*`, { headers: sbHeaders });
      if (!data.length) return bot.sendMessage(chatId, "❌ Order not found.");

      const o = data[0];

      // update WooCommerce
      await axios.put(
        `https://visionsjersey.com/wp-json/wc/v3/orders/${orderId}`,
        { status: "processing" },
        { auth: { username: WC_USER, password: WC_PASS } }
      );

      // update Supabase status
      await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`, {
        status: "paid",
        paid_at: nowISO(),
        paid_message_pending: true
      }, { headers: sbHeaders });


      // ---------------- Supplier Format EXACT ----------------
      const text = `
📦 *NEW PAID ORDER*

From:
Vision Jerseys 
+91 93279 05965

To:
Name: ${o.name}
Address: ${o.address}
State: ${o.state}
Pincode: ${o.pincode}
Phone: ${o.phone}
SKU ID: ${o.sku}

Product: ${o.product}
Size: ${o.size}
Quantity: ${o.quantity}

Shipment Mode: Normal
_________`;

      if (SUPPLIER_CHAT_ID) bot.sendMessage(SUPPLIER_CHAT_ID, text, { parse_mode: "Markdown" });
      bot.sendMessage(chatId, text, { parse_mode: "Markdown" });


      // ---------------- add to TODAY list ----------------
      const todayDate = DateTime.now().setZone(TIMEZONE).toFormat("dd-MM-yyyy");
      todayPaidList.push({ name: o.name, id: orderId });

      let formattedList = `🌼 *${todayDate} Orders*\n\n`;
      todayPaidList.forEach((x, i) => {
        formattedList += `${i + 1}. ${x.name} (${x.id}) 📦  # ${todayDate}\n`;
      });

      bot.sendMessage(chatId, formattedList, { parse_mode: "Markdown" });


      return bot.sendMessage(chatId, `✔ Payment logged. AutoJS will now send customer thank-you.`);

    } catch (err) {
      console.error(err.response?.data || err.message);
      bot.sendMessage(chatId, "⚠ Error while processing order.");
    }
  });
}


// ---------------- RESET TODAY LIST ----------------
bot?.onText(/\/reset_today/i, msg => {
  todayPaidList = [];
  bot.sendMessage(msg.chat.id, "🧹 Today order list cleared.");
});


// ---------------- MENU ----------------
bot?.onText(/\/menu/i, msg => {
  bot.sendMessage(msg.chat.id, `
📌 *VisionsJersey Menu*

🧾 Orders:
• /paid <order_id> — Mark paid + share supplier format + add to today's log  
• /reset_today — Clear today's paid list

📦 Tracking:
• /track <order_id> <phone> <trackingID>

🔁 Other:
• /resend_qr <order_id> — Trigger QR resend  
• /export_today — Export full today orders  
• /today — Show today's paid orders  

`, { parse_mode: "Markdown" });
});


// ---------------- LISTEN ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
