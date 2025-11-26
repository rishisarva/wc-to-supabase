require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

// ----------------- ENV -----------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_ANON");
  process.exit(1);
}

// Telegram bot
let bot = null;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log("Telegram bot initialized.");
} else {
  console.log("⚠️ Telegram bot NOT running (missing TELEGRAM_TOKEN)");
}

// ----------------- HEADER -----------------
const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

function nowISO() {
  return new Date().toISOString();
}

function todayDate() {
  const d = new Date();
  return d.toISOString().split("T")[0];
}

function hoursBetween(oldISO) {
  return (Date.now() - new Date(oldISO).getTime()) / (1000 * 60 * 60);
}

// ----------------- HEALTH -----------------
app.get("/", (req, res) => res.send("WC → Supabase Webhook Running ✔"));

// ---------------- WOO WEBHOOK (insert order) ----------------
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    console.log("RAW:", JSON.stringify(req.body).substring(0, 500));

    const order = req.body.order;
    if (!order) return res.status(200).send("IGNORED");

    // extract size
    let size = "";
    try {
      const meta = order.line_items?.[0]?.meta;
      if (meta) {
        const m = meta.find((x) => x.key === "pa_sizes");
        if (m) size = m.value;
      }
    } catch {}

    const mapped = {
      order_id: String(order.id),
      name: order.billing_address?.first_name || "",
      phone: order.billing_address?.phone || "",
      email: order.billing_address?.email || "",
      amount: order.total || 0,
      product: order.line_items?.[0]?.name || "",
      sku: order.line_items?.[0]?.sku || "",
      size,
      address: order.billing_address?.address_1 || "",
      status: "pending_payment",
      created_at: nowISO(),

      message_sent: false,
      next_message: "reminder_24h",

      reminder_24_sent: false,
      reminder_48_sent: false,
      reminder_72_sent: false,

      discounted_amount: null,
      supplier_sent: false
    };

    const insertURL = `${SUPABASE_URL}/rest/v1/orders`;
    const resp = await axios.post(insertURL, mapped, { headers: sbHeaders });

    console.log("✔ Stored in Supabase:", resp.data);

    res.status(200).send("OK");
  } catch (e) {
    console.error("WEBHOOK ERROR:", e.response?.data || e.message);
    res.status(200).send("OK");
  }
});

// --------------- /paid ORDER COMMAND ---------------
if (bot) {
  bot.onText(/\/paid\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1].trim();

    try {
      // fetch order
      const url = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}&select=*`;
      const r = await axios.get(url, { headers: sbHeaders });

      if (!r.data.length) {
        return bot.sendMessage(chatId, `❌ Order *${orderId}* not found.`, { parse_mode: "Markdown" });
      }

      const order = r.data[0];

      // mark as paid
      const paidTime = nowISO();
      const patchURL = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`;
      await axios.patch(patchURL, {
        status: "paid",
        paid_at: paidTime,
        paid_date: todayDate(),
        next_message: null,
        reminder_24_sent: true,
        reminder_48_sent: true,
        reminder_72_sent: true
      }, { headers: sbHeaders });

      // TODAY SUMMARY (Paid + Pending)
      const today = todayDate();

      const todayURL = `${SUPABASE_URL}/rest/v1/orders?created_at=gte.${today}T00:00:00Z&select=*`;
      const todayRes = await axios.get(todayURL, { headers: sbHeaders });
      const todayOrders = todayRes.data || [];

      const paidOrders = todayOrders.filter(o => o.status === "paid");
      const pendingOrders = todayOrders.filter(o => o.status === "pending_payment");

      let summary = `📅 *Today’s Orders (${today})*\n\n`;
      summary += `🟩 Paid Orders: *${paidOrders.length}*\n`;
      summary += `🟧 Pending Orders: *${pendingOrders.length}*\n\n`;

      if (todayOrders.length) {
        summary += `📌 *Order List:*\n`;
        todayOrders.forEach(o => {
          summary += `• ${o.order_id} • ₹${o.amount} • ${o.name} • ${o.product}\n`;
        });
      }

      await bot.sendMessage(chatId, summary, { parse_mode: "Markdown" });

      // SEND SUPPLIER FORMAT
      const txt =
        `📦 *PAID ORDER*\n\n` +
        `From:\nVision Jerseys\n${order.phone}\n\n` +
        `To:\n${order.address}\n\n` +
        `PRODUCT: ${order.product}\n` +
        `SIZE: ${order.size}\n` +
        `SKU: ${order.sku}\n\n` +
        `ORDER ID: ${order.order_id}\n` +
        `CUSTOMER: ${order.name}\n` +
        `PHONE: ${order.phone}\n` +
        `PAID: ₹${order.amount}`;

      await bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });

      return bot.sendMessage(chatId, `✅ Order *${orderId}* marked as PAID.`, { parse_mode: "Markdown" });

    } catch (err) {
      console.error("/paid ERROR:", err.response?.data || err.message);
      return bot.sendMessage(chatId, "⚠️ Error. Check logs.");
    }
  });
}

// ---------------- NIGHT SUMMARY (Paid + Pending) ----------------
app.get("/night-summary", async (req, res) => {
  try {
    if (!bot || !SUPPLIER_CHAT_ID) {
      return res.status(400).send("Telegram not configured");
    }

    const today = todayDate();

    const url = `${SUPABASE_URL}/rest/v1/orders?created_at=gte.${today}T00:00:00Z&select=*`;
    const r = await axios.get(url, { headers: sbHeaders });
    const rows = r.data || [];

    const paid = rows.filter(o => o.status === "paid");
    const pending = rows.filter(o => o.status === "pending_payment");

    let text =
      `🌙 *Daily Summary for ${today}*\n\n` +
      `🟩 Paid: *${paid.length}*\n` +
      `🟧 Pending: *${pending.length}*\n\n`;

    if (rows.length) {
      text += `📌 *Orders:*\n`;
      rows.forEach(o => {
        text += `• ${o.order_id} • ₹${o.amount} • ${o.name} • ${o.product}\n`;
      });
    }

    await bot.sendMessage(SUPPLIER_CHAT_ID, text, { parse_mode: "Markdown" });
    return res.send({ ok: true });

  } catch (err) {
    console.error("SUMMARY ERROR:", err.response?.data || err.message);
    res.status(500).send("ERROR");
  }
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server live on ${PORT}`));
