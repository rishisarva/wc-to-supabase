require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { DateTime } = require("luxon"); // optional: use for timezone-safe formatting (install luxon if you like)

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

// ----------------- ENV & CONFIG -----------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || null;
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID || null;

const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

// sanity
if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("ERROR: SUPABASE_URL and SUPABASE_ANON must be set in environment.");
  process.exit(1);
}

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

// ----------------- Telegram bot init -----------------
let bot = null;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log("Telegram bot initialized (polling ON)");
} else {
  console.log("No TELEGRAM_TOKEN — Telegram features disabled.");
}

// ----------------- Helpers -----------------
function nowISO() {
  return new Date().toISOString();
}
function nowLocalFormatted() {
  try {
    // if luxon installed, use timezone nicely
    const dt = DateTime.now().setZone(TIMEZONE);
    return dt.toFormat("yyyy-LL-dd HH:mm:ss");
  } catch (e) {
    return new Date().toISOString();
  }
}
function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}

// ----------------- Health -----------------
app.get("/", (req, res) => res.send("WC → Supabase Webhook Active"));

// ----------------- WooCommerce webhook: insert order -----------------
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    console.log("INCOMING RAW:", JSON.stringify(req.body).substring(0, 1500));
    const order = req.body.order;
    if (!order) return res.status(200).send("IGNORED");

    // extract size, quantity, state, pincode
    let size = "";
    let qty = 1;
    try {
      const meta = order.line_items?.[0]?.meta;
      if (meta) {
        const s = meta.find((m) => m.key === "pa_sizes" || m.label?.toLowerCase?.().includes("size"));
        if (s) size = s.value;
      }
      qty = order.total_line_items_quantity || order.line_items?.[0]?.quantity || 1;
    } catch (e) {}

    const mapped = {
      order_id: String(order.id),
      name: order.billing_address?.first_name || "",
      phone: order.billing_address?.phone || "",
      email: order.billing_address?.email || "",
      amount: Number(order.total) || 0,
      product: order.line_items?.[0]?.name || "",
      sku: order.line_items?.[0]?.sku || "",
      size: size || "",
      address: order.billing_address?.address_1 || "",
      state: order.billing_address?.state || "",
      pincode: order.billing_address?.postcode || "",
      quantity: Number(qty) || 1,

      status: "pending_payment",
      created_at: nowISO(),

      // reminder/control columns
      message_sent: false,
      next_message: "reminder_24h",
      reminder_24_sent: false,
      reminder_48_sent: false,
      reminder_72_sent: false,
      discounted_amount: null,
      supplier_sent: false,
      paid_at: null,
      paid_date: null
    };

    // Insert to supabase
    const insertUrl = `${SUPABASE_URL}/rest/v1/orders`;
    const insertRes = await axios.post(insertUrl, mapped, { headers: sbHeaders });
    console.log("✔ SAVED TO SUPABASE:", insertRes.data);
    return res.status(200).send("OK");
  } catch (err) {
    console.error("INSERT ERROR:", err.response?.data || err.message);
    // respond 200 so Woo doesn't keep retrying
    return res.status(200).send("OK");
  }
});

// ----------------- Telegram: /paid <order_id> command -----------------
// ----------------- Telegram: /paid <order_id> command -----------------
if (bot) {
  bot.onText(/\/paid\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1]?.trim();
    if (!orderId) return bot.sendMessage(chatId, "Usage: /paid <order_id>");

    try {
      // Fetch Supabase order
      const fetchUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}&select=*`;
      const fetchRes = await axios.get(fetchUrl, { headers: sbHeaders });

      if (!fetchRes.data?.length)
        return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);

      const order = fetchRes.data[0];

      // ---- Update WooCommerce to PROCESSING ----
      try {
        await axios.put(
          `https://visionsjersey.in/wp-json/wc/v3/orders/${orderId}`,
          { status: "processing" },
          { auth: { username: process.env.WC_KEY, password: process.env.WC_SECRET } }
        );
      } catch (err) {
        console.log("WooCommerce update failed →", err.response?.data || err);
      }

      // ---- Update Supabase ----
      const patchUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${orderId}`;
      await axios.patch(
        patchUrl,
        {
          status: "paid",
          paid_at: new Date().toISOString(),
          paid_message_pending: true, // AutoJS will detect
          next_message: null, reminder_24_sent: true, reminder_48_sent: true, reminder_72_sent: true
        },
        { headers: sbHeaders }
      );

      // ---- Supplier Format ----
      const supplierText =
`📦 *NEW PAID ORDER*

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

Shipment Mode: Normal
`;

      if (SUPPLIER_CHAT_ID) {
        await bot.sendMessage(SUPPLIER_CHAT_ID, supplierText, { parse_mode: "Markdown" });
      }

      // ---- Reply to Admin ----
      return bot.sendMessage(chatId, `✅ Order ${orderId} marked PAID.\n✔ WooCommerce Updated\n✔ Supplier Notified\n✔ AutoJS will send Thank-You message.`, { parse_mode: "Markdown" });

    } catch (err) {
      console.error("/paid error:", err.response?.data || err.message);
      return bot.sendMessage(chatId, "⚠️ Something went wrong. Check logs.");
    }
  });
}

// ----------------- Cron endpoint (call hourly) to advance reminders -----------------
app.get("/cron-check", async (req, res) => {
  try {
    // fetch all pending_payment orders
    const allUrl = `${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`;
    const rAll = await axios.get(allUrl, { headers: sbHeaders });
    const orders = rAll.data || [];
    const toPatch = [];

    for (const o of orders) {
      const created = o.created_at;
      const hours = hoursSince(created);

      // 24h -> mark 24 reminder ready if not sent
      if (!o.reminder_24_sent && hours >= 24) {
        toPatch.push({
          order_id: o.order_id,
          patch: { reminder_24_sent: true, next_message: "reminder_48h" }
        });
      }

      // 48h -> discount -30
      if (!o.reminder_48_sent && hours >= 48) {
        const discounted = Number(o.amount) - 30;
        toPatch.push({
          order_id: o.order_id,
          patch: { reminder_48_sent: true, discounted_amount: discounted, next_message: "reminder_72h" }
        });
      }

      // 72h -> cancel and stop reminders
      if (!o.reminder_72_sent && hours >= 72) {
        toPatch.push({
          order_id: o.order_id,
          patch: { reminder_72_sent: true, next_message: null, status: "cancelled" }
        });
      }
    }

    // apply patches sequentially (small delay to reduce DB race)
    for (const u of toPatch) {
      try {
        const patchUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(u.order_id)}`;
        await axios.patch(patchUrl, u.patch, { headers: sbHeaders });
        console.log("Patched", u.order_id, u.patch);
        // small delay
        await new Promise((r) => setTimeout(r, 200));
      } catch (e) {
        console.error("Patch error", u.order_id, e.response?.data || e.message);
      }
    }

    res.json({ ok: true, processed: toPatch.length });
  } catch (err) {
    console.error("CRON-CHECK error:", err.response?.data || err.message);
    res.status(500).send("ERROR");
  }
});

// ----------------- Night summary (call at 00:00 IST) -----------------
app.get("/night-summary", async (req, res) => {
  try {
    if (!bot || !SUPPLIER_CHAT_ID) {
      return res.status(400).send("Telegram or SUPPLIER_CHAT_ID not configured");
    }

    // compute today's calendar date in TIMEZONE, then fetch paid & pending that happened today
    // We'll compute midnight IST -> convert to UTC ISO to compare against timestamptz
    let startOfDayISO;
    try {
      const start = DateTime.now().setZone(TIMEZONE).startOf("day");
      startOfDayISO = start.toUTC().toISO();
    } catch (e) {
      // fallback: 24 hours ago
      startOfDayISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    }

    // Paid orders since start of day
    const paidUrl = `${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${encodeURIComponent(startOfDayISO)}&select=order_id,name,amount,product,paid_at`;
    const paidRes = await axios.get(paidUrl, { headers: sbHeaders });
    const paid = paidRes.data || [];

    // Pending orders created since start of day
    const pendingUrl = `${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&created_at=gte.${encodeURIComponent(startOfDayISO)}&select=order_id,name,amount,product,created_at`;
    const pendingRes = await axios.get(pendingUrl, { headers: sbHeaders });
    const pending = pendingRes.data || [];

    // Build summary text
    // header date in TIMEZONE
    let headerDate = "";
    try {
      headerDate = DateTime.now().setZone(TIMEZONE).toFormat("yyyy-LL-dd");
    } catch (e) {
      headerDate = new Date().toISOString().slice(0, 10);
    }

    let text = `📊 Daily Summary for ${headerDate}\n\n`;
    const totalPaid = paid.length;
    const totalRevenue = paid.reduce((s, r) => s + Number(r.amount || 0), 0);

    text += `Total paid orders: ${totalPaid}\nTotal revenue: ₹${totalRevenue}\n\n`;

    if (paid.length) {
      for (const p of paid) {
        // format paid time
        let paidAt = p.paid_at || "";
        try {
          paidAt = DateTime.fromISO(p.paid_at).setZone(TIMEZONE).toFormat("HH:mm");
        } catch (e) {}
        text += `• ${p.order_id} • ₹${p.amount} • ${p.name} • ${p.product}\n`;
      }
    } else {
      text += "_No paid orders today._\n";
    }

    // Pending / unpaid quick list appended
    text += `\nPending orders:\n`;
    if (pending.length) {
      for (const q of pending) {
        let t = q.created_at || "";
        try {
          t = DateTime.fromISO(q.created_at).setZone(TIMEZONE).toFormat("HH:mm");
        } catch (e) {}
        text += `• ${q.order_id} • ₹${q.amount} • ${q.name} • ${q.product}\n`;
      }
    } else {
      text += "_No pending orders today._\n";
    }

    // Send to supplier
    await bot.sendMessage(SUPPLIER_CHAT_ID, text, { parse_mode: "Markdown" });
    res.json({ ok: true, paid: paid.length, pending: pending.length });
  } catch (err) {
    console.error("NIGHT-SUMMARY error:", err.response?.data || err.message);
    res.status(500).send("ERROR");
  }
});

// ----------------- Start server -----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("WC → Supabase automation starting...");
  console.log("SUPABASE_URL =", SUPABASE_URL);
  console.log("Server listening on", PORT);
});
