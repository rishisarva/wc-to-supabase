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

// in-memory storage for clearing today's orders manually
let clearedTodayDate = null;

// ---------------- Telegram Bot ----------------
let bot = null;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log("🤖 Telegram Bot Ready");
} else {
  console.log("⚠️ No TELEGRAM_TOKEN found, bot disabled.");
}

// Helpers
function nowISO() {
  return new Date().toISOString();
}
function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

// ---------------- HEALTH CHECK ----------------
app.get("/", (req, res) => res.send("🔥 WC → Supabase Automation Live"));


// ---------------- SAVE ORDER (WooCommerce → Supabase) ----------------
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    const order = req.body.order;
    if (!order) return res.send("NO ORDER");

    let size = "";
    let qty = 1;

    try {
      const meta = order.line_items[0]?.meta;
      if (meta) {
        const s = meta.find(
          (m) => m.key === "pa_sizes" || (m.label && m.label.toLowerCase().includes("size"))
        );
        if (s) size = s.value;
      }
      qty = order.total_line_items_quantity || order.line_items[0]?.quantity || 1;
    } catch (_) {}

    const mapped = {
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
      next_message: "reminder_24h",
      reminder_24_sent: false,
      reminder_48_sent: false,
      reminder_72_sent: false,
      discounted_amount: null,
      supplier_sent: false,
      paid_at: null,
      paid_message_pending: false,
      resend_qr_pending: false,
      tracking_sent: false
    };

    await axios.post(`${SUPABASE_URL}/rest/v1/orders`, mapped, { headers: sbHeaders });

    res.send("OK");
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.response?.data || err.message);
    res.send("ERR");
  }
});


// ---------------- /MENU COMMAND ----------------
if (bot) {
  bot.onText(/\/menu/i, async (msg) => {
    const chatId = msg.chat.id;

    const text = `
📌 *VisionsJersey Bot Commands*

/paid <order_id>  
/resend_qr <order_id>  
/track <order_id> <phone> <tracking_id>  
/export_today  
/today  
/clear_today  
`;

    bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  });
}



// ---------------- /PAID COMMAND ----------------
if (bot) {
  bot.onText(/\/paid\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1]?.trim();

    if (!orderId) return bot.sendMessage(chatId, "❌ Usage: /paid <order_id>");

    try {
      // get order
      const fetchRes = await axios.get(
        `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}&select=*`,
        { headers: sbHeaders }
      );

      if (!fetchRes.data.length) return bot.sendMessage(chatId, "❌ Order not found.");
      const order = fetchRes.data[0];

      // update woocommerce
      if (WC_USER && WC_PASS) {
        try {
          await axios.put(
            `https://visionsjersey.com/wp-json/wc/v3/orders/${orderId}`,
            { status: "processing" },
            { auth: { username: WC_USER, password: WC_PASS } }
          );
        } catch (e) {
          console.log("WC update failed");
        }
      }

      // update supabase
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`,
        {
          status: "paid",
          paid_at: nowISO(),
          paid_message_pending: true,
          next_message: null,
          reminder_24_sent: true,
          reminder_48_sent: true,
          reminder_72_sent: true
        },
        { headers: sbHeaders }
      );

      // Supplier message format
      const supplierText = `
📦 NEW PAID ORDER

From:
Vision Jerseys 
+91 93279 05965

To:
Name: ${order.name}
Address: ${order.address}
State: ${order.state}
Pincode: ${order.pincode}
Phone: ${order.phone}
SKU ID: ${order.sku}

Product: ${order.product}
Size: ${order.size}
Quantity: ${order.quantity}

Shipment Mode: Normal`.trim();

      if (SUPPLIER_CHAT_ID) bot.sendMessage(SUPPLIER_CHAT_ID, supplierText);
      bot.sendMessage(chatId, supplierText);

      // generate today list
      const startDay = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();

      const paidRes = await axios.get(
        `${SUPABASE_URL}/rest/v1/orders?paid_at=gte.${startDay}&status=eq.paid&select=*`,
        { headers: sbHeaders }
      );

      const paid = paidRes.data;

      let todayDate = DateTime.now().setZone(TIMEZONE).toFormat("yyyy-LL-dd");
      let text = `${todayDate} orders 🌼\n\n`;

      paid.forEach((o, i) => {
        let formatted = DateTime.fromISO(o.paid_at).setZone(TIMEZONE).toFormat("dd/LL/yyyy");
        text += `${i + 1}. ${o.name} (${o.order_id}) 📦 # ${formatted}\n`;
      });

      bot.sendMessage(chatId, text);

      bot.sendMessage(chatId, `✅ Order ${orderId} marked as PAID.`);

    } catch (err) {
      console.error("/paid error:", err.response?.data || err.message);
      bot.sendMessage(chatId, "⚠️ Something failed.");
    }
  });
}



// ---------------- /RESEND_QR COMMAND ----------------
if (bot) {
  bot.onText(/\/resend_qr\s+(.+)/i, async (msg, match) => {
    const orderId = match[1]?.trim();
    if (!orderId) return bot.sendMessage(msg.chat.id, "Usage: /resend_qr <order_id>");

    await axios.patch(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`,
      { resend_qr_pending: true },
      { headers: sbHeaders }
    );

    bot.sendMessage(msg.chat.id, `🔁 QR resend triggered for ${orderId}`);
  });
}



// ---------------- /TRACK COMMAND ----------------
if (bot) {
  bot.onText(/\/track\s+(\S+)\s+(\S+)\s+(\S+)/i, async (msg, match) => {
    const [_, orderId, phone, tracking] = match;

    try {
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`,
        { tracking_sent: true, status: "completed" },
        { headers: sbHeaders }
      );

      bot.sendMessage(msg.chat.id, `📦 Tracking sent for ${orderId}: ${tracking}`);
    } catch {
      bot.sendMessage(msg.chat.id, "⚠️ Failed to update tracking");
    }
  });
}



// ---------------- /EXPORT_TODAY ----------------
if (bot) {
  bot.onText(/\/export_today/i, async (msg) => {
    const start = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();
    const res = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?created_at=gte.${start}&select=*`,
      { headers: sbHeaders }
    );

    if (!res.data.length) return bot.sendMessage(msg.chat.id, "📭 No orders today.");

    let text = "📄 Today Orders:\n\n";
    res.data.forEach((o) => text += `• ${o.order_id} | ${o.name} | ₹${o.amount} | ${o.status}\n`);

    bot.sendMessage(msg.chat.id, text);
  });
}



// ---------------- /TODAY ----------------
if (bot) {
  bot.onText(/\/today/i, async (msg) => {
    const dateKey = DateTime.now().setZone(TIMEZONE).toISODate();

    if (clearedTodayDate === dateKey)
      return bot.sendMessage(msg.chat.id, "☑️ Today list cleared.");

    const start = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();

    const res = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?paid_at=gte.${start}&status=eq.paid&select=*`,
      { headers: sbHeaders }
    );

    if (!res.data.length) return bot.sendMessage(msg.chat.id, "📭 No paid orders today.");

    let t = "📅 Today Paid Orders\n\n";
    res.data.forEach((o) => t += `• ${o.order_id} | ${o.name} | ₹${o.amount}\n`);

    bot.sendMessage(msg.chat.id, t);
  });
}



// ---------------- /CLEAR_TODAY ----------------
if (bot) {
  bot.onText(/\/clear_today/i, async (msg) => {
    clearedTodayDate = DateTime.now().setZone(TIMEZONE).toISODate();
    bot.sendMessage(msg.chat.id, "🧹 Today's list cleared.");
  });
}



// ---------------- CRON REMINDER ----------------
app.get("/cron-check", async (req, res) => {
  try {
    const all = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`,
      { headers: sbHeaders }
    );

    for (const o of all.data) {
      const h = hoursSince(o.created_at);

      if (!o.reminder_24_sent && h >= 24)
        await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${o.order_id}`, { reminder_24_sent: true }, { headers: sbHeaders });

      if (!o.reminder_48_sent && h >= 48)
        await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${o.order_id}`, { reminder_48_sent: true }, { headers: sbHeaders });

      if (!o.reminder_72_sent && h >= 72)
        await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${o.order_id}`, { reminder_72_sent: true, status: "cancelled" }, { headers: sbHeaders });
    }

    res.json({ ok: true });
  } catch (err) {
    res.send("ERR");
  }
});



// ---------------- LISTEN ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
