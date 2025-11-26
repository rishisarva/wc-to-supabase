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

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || null; // used only for /paid and /night-summary
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID || null;

const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

// quick sanity
if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_ANON must be set");
  process.exit(1);
}

// init telegram only if token present
let bot = null;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log("Telegram bot initialized (polling ON)");
} else {
  console.log("Telegram bot not initialized (no TELEGRAM_TOKEN). /paid and /night-summary will fail if invoked.");
}

console.log("WC → Supabase automation starting...");
console.log("SUPABASE_URL =", SUPABASE_URL);

// ----------------- Utilities -----------------
const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

function nowISO() {
  return new Date().toISOString();
}

function hoursBetween(olderISO) {
  return (Date.now() - new Date(olderISO).getTime()) / (1000 * 60 * 60);
}

// ----------------- Health -----------------
app.get("/", (req, res) => res.send("WC → Supabase Webhook Active"));

// ----------------- WooCommerce webhook: insert order -----------------
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    console.log("INCOMING RAW:", JSON.stringify(req.body).substring(0, 1500));
    const order = req.body.order;
    if (!order) {
      console.warn("No order in payload");
      return res.status(200).send("IGNORED");
    }

    // try to extract size
    let size = "";
    try {
      const meta = order.line_items?.[0]?.meta;
      if (meta) {
        const m = meta.find((x) => x.key === "pa_sizes");
        if (m) size = m.value;
      }
    } catch (e) {}

    // map fields - these columns should exist in your supabase table
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

      // control flags for AutoJS + reminders
      message_sent: false,           // AutoJS will flip this to true after sending first messages
      next_message: "reminder_24h",  // server cron will update this over time
      reminder_24_sent: false,
      reminder_48_sent: false,
      reminder_72_sent: false,
      discounted_amount: null,
      supplier_sent: false
    };

    // Insert into supabase
    const insertURL = `${SUPABASE_URL}/rest/v1/orders`;
    const resp = await axios.post(insertURL, mapped, { headers: sbHeaders });
    console.log("✔ SAVED TO SUPABASE:", resp.data);
    return res.status(200).send("OK");
  } catch (err) {
    console.error("INSERT ERROR:", err.response?.data || err.message);
    return res.status(200).send("OK"); // avoid webhook retries
  }
});

// ----------------- Telegram: /paid <order_id> -----------------
if (bot) {
  bot.onText(/\/paid\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1].trim();
    try {
      // fetch order
      const fetchUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`;
      const fetchRes = await axios.get(fetchUrl, { headers: sbHeaders });
      if (!fetchRes.data || !fetchRes.data.length) {
        return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);
      }
      const order = fetchRes.data[0];

      // patch to paid and disable reminders
      const patchUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`;
      await axios.patch(patchUrl, {
        status: "paid",
        next_message: null,
        reminder_24_sent: true,
        reminder_48_sent: true,
        reminder_72_sent: true,
      }, { headers: sbHeaders });

      // send supplier message (YOU)
      if (SUPPLIER_CHAT_ID) {
        const supplierMsg = `📦 *PAID ORDER*\n\n🧾 Order ID: *${order.order_id}*\n👤 Name: *${order.name}*\n📞 ${order.phone}\n📍 ${order.address}\n\n🛍 ${order.product}\n🔖 SKU: ${order.sku}\n📏 Size: ${order.size}\n\n💰 *₹${order.amount}*`;
        await bot.sendMessage(SUPPLIER_CHAT_ID, supplierMsg, { parse_mode: "Markdown" });
      }

      return bot.sendMessage(chatId, `✅ Order ${orderId} marked as PAID. Supplier notified.`);
    } catch (err) {
      console.error("/paid error:", err.response?.data || err.message);
      return bot.sendMessage(chatId, "⚠️ Error processing /paid. Check server logs.");
    }
  });
}

// ----------------- Cron-check: run hourly (trigger via Render Cron) -----------------
// This endpoint updates rows and sets flags. AutoJS should poll Supabase and send the actual WhatsApp messages
app.get("/cron-check", async (req, res) => {
  try {
    // fetch all pending_payment orders
    const url = `${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`;
    const r = await axios.get(url, { headers: sbHeaders });
    const orders = r.data || [];

    const updates = [];

    for (const o of orders) {
      const hours = hoursBetween(o.created_at);
      // 24h
      if (!o.reminder_24_sent && hours >= 24) {
        // mark 24h reminder ready
        updates.push({ order_id: o.order_id, patch: { reminder_24_sent: true, next_message: "reminder_48h" } });
      }

      // 48h -> set discounted amount -30 and mark ready
      if (!o.reminder_48_sent && hours >= 48) {
        const discounted = Number(o.amount) - 30;
        updates.push({
          order_id: o.order_id,
          patch: { reminder_48_sent: true, discounted_amount: discounted, next_message: "reminder_72h" }
        });
      }

      // 72h -> cancel
      if (!o.reminder_72_sent && hours >= 72) {
        updates.push({
          order_id: o.order_id,
          patch: { reminder_72_sent: true, next_message: null, status: "cancelled" }
        });
      }
    }

    // apply updates sequentially (small pauses)
    for (const u of updates) {
      const patchUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(u.order_id)}`;
      try {
        await axios.patch(patchUrl, u.patch, { headers: sbHeaders });
        console.log(`Patched ${u.order_id} ->`, u.patch);
      } catch (e) {
        console.error("PATCH ERROR", u.order_id, e.response?.data || e.message);
      }
    }

    res.send({ ok: true, processed: updates.length });
  } catch (err) {
    console.error("CRON-CHECK ERROR:", err.response?.data || err.message);
    res.status(500).send("ERROR");
  }
});

// ----------------- Night summary: send day's paid orders summary to supplier -----------------
// Schedule to call this endpoint at 00:00 IST (Render cron)
app.get("/night-summary", async (req, res) => {
  try {
    if (!bot || !SUPPLIER_CHAT_ID) {
      return res.status(400).send("Telegram or SUPPLIER_CHAT_ID missing");
    }

    // compute today's date range in server timezone (we will treat server timestamps as UTC ISO)
    // To avoid timezone conversions here, select orders whose created_at is within last 24h and status paid.
    // You can fine tune using timezone-aware logic if required.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const qUrl = `${SUPABASE_URL}/rest/v1/orders?status=eq.paid&created_at=gte.${encodeURIComponent(since)}&select=order_id,name,amount,product,sku,size,created_at`;
    const r = await axios.get(qUrl, { headers: sbHeaders });
    const rows = r.data || [];

    const total = rows.length;
    let sumAmount = 0;
    rows.forEach((x) => { sumAmount += Number(x.amount || 0); });

    let text = `📊 *Daily Paid Orders Summary*\n\nTotal paid (last 24h): *${total}*\nTotal amount: *₹${sumAmount}*\n\n`;

    if (rows.length) {
      text += "Orders:\n";
      for (const x of rows) {
        text += `• ${x.order_id} • ₹${x.amount} • ${x.name} • ${x.product}\n`;
      }
    } else {
      text += "_No paid orders in the last 24 hours._";
    }

    await bot.sendMessage(SUPPLIER_CHAT_ID, text, { parse_mode: "Markdown" });
    return res.send({ ok: true, total });
  } catch (err) {
    console.error("NIGHT SUMMARY ERROR:", err.response?.data || err.message);
    return res.status(500).send("ERROR");
  }
});

// ----------------- START -----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
