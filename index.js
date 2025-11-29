require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { DateTime } = require("luxon");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

// ================= ENV =================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID;
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

// WooCommerce auth — using your renamed vars
const WC_USER = process.env.WC_KEY || "";
const WC_PASS = process.env.WC_SECRET || "";

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("❌ Missing SUPABASE envs");
  process.exit(1);
}

// ================= Supabase Headers =================
const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

// ================= Telegram Bot (Webhook Mode) =================
let bot = new TelegramBot(TELEGRAM_TOKEN);
console.log("Telegram bot running in Webhook Mode");

// render webhook URL setup
const WEBHOOK_URL = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`);

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================= Helpers =================
function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

function nowISO() {
  return new Date().toISOString();
}

// ================= HEALTH CHECK =================
app.get("/", (req, res) => res.send("🔥 WC → Supabase Webhook Running"));

// ================= WOO → SUPABASE ORDER HOOK =================
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    const order = req.body.order;
    if (!order) return res.status(200).send("IGNORED");

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

    const mapped = {
      order_id: String(order.id),
      name: order.billing_address.first_name || "",
      phone: order.billing_address.phone || "",
      email: order.billing_address.email || "",
      amount: Number(order.total) || 0,
      product: order.line_items[0]?.name || "",
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
      paid_date: null,
      paid_message_pending: false
    };

    await axios.post(`${SUPABASE_URL}/rest/v1/orders`, mapped, { headers: sbHeaders });
    res.status(200).send("OK");

  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    res.status(200).send("OK");
  }
});

// ================= /paid COMMAND =================
bot.onText(/\/paid\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const orderId = match[1]?.trim();

  if (!orderId) return bot.sendMessage(chatId, "Usage: /paid <order_id>");

  try {
    const fetchRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}&select=*`,
      { headers: sbHeaders }
    );

    if (!fetchRes.data?.length)
      return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);

    const order = fetchRes.data[0];

    // ---- Update WooCommerce ----
    try {
      await axios.put(
        `https://visionsjersey.in/wp-json/wc/v3/orders/${orderId}`,
        { status: "processing" },
        { auth: { username: WC_USER, password: WC_PASS } }
      );
      console.log(`✔ WooCommerce updated for #${orderId}`);
    } catch (err) {
      console.log("❌ WooCommerce update failed:", err.message);
    }

    // ---- Update Supabase ----
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

    // ---- Send Supplier Format ----
    const supplierText = `📦 *NEW PAID ORDER*\n\nFrom:\nVision Jerseys\n+91 93279 05965\n\nTo:\nName: ${order.name}\nAddress: ${order.address}, ${order.state}, ${order.pincode}\nPhone: ${order.phone}\nSKU: ${order.sku}\n\nProduct: ${order.product}\nSize: ${order.size}\nQty: ${order.quantity}\n\nShipment: Normal`;

    if (SUPPLIER_CHAT_ID)
      await bot.sendMessage(SUPPLIER_CHAT_ID, supplierText, { parse_mode: "Markdown" });

    return bot.sendMessage(chatId, `✅ Order #${orderId} marked PAID\n✔ WooCommerce Updated\n✔ Supplier Notified\n✔ Customer message queued.`);

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "⚠️ Error. Check logs.");
  }
});

// ================= REMINDER CRON =================
app.get("/cron-check", async (req, res) => {
  try {
    const rAll = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`,
      { headers: sbHeaders }
    );

    const orders = rAll.data || [];
    const updates = [];

    for (const o of orders) {
      const hours = hoursSince(o.created_at);

      if (!o.reminder_24_sent && hours >= 24)
        updates.push({ id: o.order_id, patch: { reminder_24_sent: true, next_message: "reminder_48h" } });

      if (!o.reminder_48_sent && hours >= 48)
        updates.push({ id: o.order_id, patch: { reminder_48_sent: true, discounted_amount: o.amount - 30, next_message: "reminder_72h" } });

      if (!o.reminder_72_sent && hours >= 72)
        updates.push({ id: o.order_id, patch: { reminder_72_sent: true, status: "cancelled", next_message: null } });
    }

    for (const u of updates) {
      await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${u.id}`, u.patch, { headers: sbHeaders });
    }

    res.json({ ok: true, processed: updates.length });

  } catch (err) {
    console.error(err);
    res.status(500).send("ERROR");
  }
});

// ================= NIGHT SUMMARY =================
app.get("/night-summary", async (req, res) => {
  if (!bot) return res.status(400).send("Telegram disabled");

  try {
    const today = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();

    const paid = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${today}&select=*`,
      { headers: sbHeaders }
    );

    const pending = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&created_at=gte.${today}&select=*`,
      { headers: sbHeaders }
    );

    const totalRevenue = paid.data.reduce((sum, o) => sum + Number(o.amount || 0), 0);

    const msg = `📊 *Daily Summary*\n\n💸 Paid Orders: ${paid.data.length}\n📦 Pending: ${pending.data.length}\n💰 Revenue: ₹${totalRevenue}`;

    await bot.sendMessage(SUPPLIER_CHAT_ID, msg, { parse_mode: "Markdown" });

    res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.status(500).send("ERROR");
  }
});

// ================= START =================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 SERVER RUNNING");
  console.log("URL:", WEBHOOK_URL);
});
