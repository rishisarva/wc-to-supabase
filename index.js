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
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log("🤖 Telegram Bot Ready");
}

// Helpers
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
      const meta = order.line_items[0]?.meta;
      if (meta) {
        const s = meta.find(m => m.key === "pa_sizes" || (m.label && m.label.toLowerCase().includes("size")));
        if (s) size = s.value;
      }
      qty = order.total_line_items_quantity || order.line_items[0]?.quantity;
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

    return res.send("OK");
  } catch (err) {
    console.error(err.message);
    res.send("ERR");
  }
});

// ---------------- /paid ----------------
if (bot) {
  bot.onText(/\/paid\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1]?.trim();

    if (!orderId) return bot.sendMessage(chatId, "❌ Use: `/paid <order_id>`", { parse_mode: "Markdown" });

    try {
      const fetch = await axios.get(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}&select=*`, { headers: sbHeaders });
      if (!fetch.data.length) return bot.sendMessage(chatId, "Order not found.");

      const order = fetch.data[0];

      // update WooCommerce
      await axios.put(
        `https://visionsjersey.com/wp-json/wc/v3/orders/${orderId}`,
        { status: "processing" },
        { auth: { username: WC_USER, password: WC_PASS } }
      );

      // mark Supabase
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`,
        {
          status: "paid",
          paid_at: nowISO(),
          paid_message_pending: true,
          reminder_24_sent: true,
          reminder_48_sent: true,
          reminder_72_sent: true,
          next_message: null
        },
        { headers: sbHeaders }
      );

      // Supplier format
      const supplier = `📦 *NEW PAID ORDER*\n\nName: ${order.name}\nPhone: ${order.phone}\nAddress: ${order.address}, ${order.state} - ${order.pincode}\n\nProduct: ${order.product}\nSize: ${order.size}\nQty: ${order.quantity}\nSKU: ${order.sku}`;

      if (SUPPLIER_CHAT_ID) bot.sendMessage(SUPPLIER_CHAT_ID, supplier, { parse_mode: "Markdown" });
      bot.sendMessage(chatId, supplier, { parse_mode: "Markdown" });

      bot.sendMessage(chatId, `✅ Order *${orderId}* marked paid.\nCustomer reply will be sent.`, { parse_mode: "Markdown" });

    } catch (err) {
      bot.sendMessage(chatId, "⚠️ Something went wrong.");
      console.error(err.response?.data || err.message);
    }
  });
}

// ---------------- /resend_qr ----------------
if (bot) {
  bot.onText(/\/resend_qr\s+(.+)/i, async (msg, match) => {
    const id = match[1]?.trim();
    if (!id) return bot.sendMessage(msg.chat.id, "Usage: /resend_qr <order_id>");

    await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${id}`, { resend_qr_pending: true }, { headers: sbHeaders });

    bot.sendMessage(msg.chat.id, `🔁 QR resend triggered for ${id}`);
  });
}

// ---------------- /track ----------------
if (bot) {
  bot.onText(/\/track\s+(\S+)\s+(\S+)\s+(\S+)/i, async (msg, match) => {
    const [_, orderId, phone, tracking] = match;

    await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`, {
      tracking_sent: true,
      status: "completed"
    }, { headers: sbHeaders });

    bot.sendMessage(msg.chat.id, `📦 Tracking sent:\nID: *${tracking}*\nPhone: ${phone}`, { parse_mode: "Markdown" });

    bot.sendMessage(msg.chat.id, `
📦 Track Your India Post Order

👉 Tracking ID: *${tracking}*

🔗 https://myspeedpost.com/
    `, { parse_mode: "Markdown" });

  });
}

// ---------------- /export_today ----------------
if (bot) {
  bot.onText(/\/export_today/i, async (msg) => {
    const chat = msg.chat.id;

    const start = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();

    const orders = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?created_at=gte.${start}&select=order_id,name,phone,amount,status`,
      { headers: sbHeaders }
    );

    if (!orders.data.length) return bot.sendMessage(chat, "📭 No orders today.");

    let text = "📄 Today Orders:\n\n";
    orders.data.forEach(o => text += `• ${o.order_id} | ${o.name} | ₹${o.amount} | ${o.status}\n`);

    bot.sendMessage(chat, text);
  });
}

// ---------------- /today quick stats ----------------
bot?.onText(/\/today/i, async msg => {
  const chat = msg.chat.id;
  const start = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();

  const r = await axios.get(
    `${SUPABASE_URL}/rest/v1/orders?paid_at=gte.${start}&status=eq.paid&select=*`,
    { headers: sbHeaders }
  );

  if (!r.data.length) return bot.sendMessage(chat, "📭 No paid orders yet.");

  let t = `📅 *Today’s Paid Orders*\n\n`;
  r.data.forEach(o => t += `• ${o.order_id} | ${o.name} | ₹${o.amount}\n`);
  bot.sendMessage(chat, t, { parse_mode: "Markdown" });
});

// ---------------- CRON / REMINDERS ----------------
app.get("/cron-check", async (req, res) => {
  try {
    const orders = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`,
      { headers: sbHeaders }
    );

    for (const o of orders.data) {
      const h = hoursSince(o.created_at);

      if (!o.reminder_24_sent && h >= 24)
        await patch(o.order_id, { reminder_24_sent: true, next_message: "reminder_48h" });

      if (!o.reminder_48_sent && h >= 48)
        await patch(o.order_id, { reminder_48_sent: true, discounted_amount: o.amount - 30, next_message: "reminder_72h" });

      if (!o.reminder_72_sent && h >= 72)
        await patch(o.order_id, { reminder_72_sent: true, status: "cancelled" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.send("ERR");
  }
});

// ---------------- Night Summary ----------------
app.get("/night-summary", async (req, res) => {
  if (!bot || !SUPPLIER_CHAT_ID) return res.send("BOT DISABLED");

  const start = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();

  const paid = await axios.get(
    `${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${start}&select=*`,
    { headers: sbHeaders }
  );

  let report = `📊 Daily Summary\nPaid Orders: ${paid.data.length}`;

  bot.sendMessage(SUPPLIER_CHAT_ID, report);
  res.send("OK");
});

// ---------------- LISTEN ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
