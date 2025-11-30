require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { DateTime } = require("luxon");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

// ============== ENV =================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID;

const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

// WooCommerce credentials (RENDER VARIABLES: WC_KEY, WC_SECRET)
const WC_USER = process.env.WC_KEY || "";
const WC_PASS = process.env.WC_SECRET || "";

// sanity
if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("❌ SUPABASE_URL / SUPABASE_ANON missing");
  process.exit(1);
}

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

// ============== TELEGRAM BOT (POLLING) =================
let bot = null;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log("Telegram bot initialized (polling ON)");
} else {
  console.log("No TELEGRAM_TOKEN — Telegram features disabled.");
}

function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}
function nowISO() {
  return new Date().toISOString();
}

// ============== HEALTH =================
app.get("/", (req, res) => res.send("WC → Supabase Webhook Active"));

// ============== WOO → SUPABASE INSERT =================
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    const order = req.body.order;
    if (!order) return res.status(200).send("IGNORED");

    let size = "";
    let qty = 1;
    try {
      const meta = order.line_items?.[0]?.meta;
      if (meta) {
        const s = meta.find(
          (m) =>
            m.key === "pa_sizes" ||
            (m.label && m.label.toLowerCase().includes("size"))
        );
        if (s) size = s.value;
      }
      qty =
        order.total_line_items_quantity ||
        order.line_items?.[0]?.quantity ||
        1;
    } catch (_) {}

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

    const insertUrl = `${SUPABASE_URL}/rest/v1/orders`;
    const insertRes = await axios.post(insertUrl, mapped, { headers: sbHeaders });
    console.log("✔ SAVED TO SUPABASE:", insertRes.data);
    res.status(200).send("OK");
  } catch (err) {
    console.error("INSERT ERROR:", err.response?.data || err.message);
    res.status(200).send("OK");
  }
});

// ============== /paid <order_id> =================
if (bot) {
  bot.onText(/\/paid\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1]?.trim();
    if (!orderId) {
      return bot.sendMessage(chatId, "Usage: /paid <order_id>");
    }

    console.log("/paid called for", orderId);

    try {
      // fetch from Supabase
      const fetchUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(
        orderId
      )}&select=*`;
      const fetchRes = await axios.get(fetchUrl, { headers: sbHeaders });

      if (!fetchRes.data || !fetchRes.data.length) {
        return bot.sendMessage(chatId, `❌ Order ${orderId} not found.`);
      }
      const order = fetchRes.data[0];

      // ---------- Update WooCommerce → processing ----------
      if (WC_USER && WC_PASS) {
        try {
          await axios.put(
            // IMPORTANT → use .com (your ENOTFOUND earlier was .in)
            `https://visionsjersey.com/wp-json/wc/v3/orders/${orderId}`,
            { status: "processing" },
            { auth: { username: WC_USER, password: WC_PASS } }
          );
          console.log("✔ WooCommerce updated for", orderId);
        } catch (e) {
          console.error(
            "WooCommerce update failed:",
            e.response?.data || e.message
          );
        }
      } else {
        console.warn("WC_KEY / WC_SECRET not configured in Render env.");
      }

      // ---------- Update Supabase (mark paid + thank-you pending) ----------
      const patchUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(
        orderId
      )}`;
      await axios.patch(
        patchUrl,
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

      // ---------- Build “today till now” paid list ----------
      let startOfTodayISO;
      try {
        const start = DateTime.now().setZone(TIMEZONE).startOf("day");
        startOfTodayISO = start.toUTC().toISO();
      } catch (e) {
        startOfTodayISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      }

      const paidQ = `${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${encodeURIComponent(
        startOfTodayISO
      )}&select=order_id,name,amount,paid_at`;
      const paidRes = await axios.get(paidQ, { headers: sbHeaders });
      const paidRows = paidRes.data || [];

      let todayList = `📌 Paid orders for today (till now):\n\n`;
      if (!paidRows.length) {
        todayList += "_No paid orders for today yet._";
      } else {
        for (const r of paidRows) {
          let timeStr = r.paid_at;
          try {
            timeStr = DateTime.fromISO(r.paid_at)
              .setZone(TIMEZONE)
              .toFormat("HH:mm");
          } catch (_) {}
          todayList += `${r.name} • ${r.order_id} 🟩 ${timeStr} • ₹${r.amount}\n`;
        }
      }

      await bot.sendMessage(chatId, todayList, { parse_mode: "Markdown" });

      // ---------- Supplier format ----------
      const supplierText = `📦 *NEW PAID ORDER*\n\nFrom:\nVision Jerseys \n+91 93279 05965\n\nTo:\nName: ${order.name}\nAddress: ${order.address}\nState: ${order.state}\nPincode: ${order.pincode}\nPhone: ${order.phone}\nSKU ID: ${order.sku}\n\nProduct: ${order.product}\nSize: ${order.size}\nQuantity: ${order.quantity}\n\nShipment Mode: Normal`;

      // send to supplier
      if (SUPPLIER_CHAT_ID) {
        await bot.sendMessage(SUPPLIER_CHAT_ID, supplierText, {
          parse_mode: "Markdown"
        });
      }
      // also send to you (admin) so you always see the format
      await bot.sendMessage(chatId, supplierText, { parse_mode: "Markdown" });

      // ---------- Final confirmation ----------
      return bot.sendMessage(
        chatId,
        `✅ Order ${orderId} marked *PAID*.\n✔ WooCommerce status → processing\n✔ Supplier format sent\n✔ Customer thank-you will be sent by AutoJS.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("/paid error:", err.response?.data || err.message);
      return bot.sendMessage(chatId, "⚠️ Error processing /paid. Check server logs.");
    }
  });
}

// ============== CRON REMINDERS =================
app.get("/cron-check", async (req, res) => {
  try {
    const allUrl = `${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`;
    const rAll = await axios.get(allUrl, { headers: sbHeaders });
    const orders = rAll.data || [];
    const toPatch = [];

    for (const o of orders) {
      const h = hoursSince(o.created_at);

      if (!o.reminder_24_sent && h >= 24) {
        toPatch.push({
          order_id: o.order_id,
          patch: { reminder_24_sent: true, next_message: "reminder_48h" }
        });
      }
      if (!o.reminder_48_sent && h >= 48) {
        toPatch.push({
          order_id: o.order_id,
          patch: {
            reminder_48_sent: true,
            discounted_amount: Number(o.amount) - 30,
            next_message: "reminder_72h"
          }
        });
      }
      if (!o.reminder_72_sent && h >= 72) {
        toPatch.push({
          order_id: o.order_id,
          patch: {
            reminder_72_sent: true,
            next_message: null,
            status: "cancelled"
          }
        });
      }
    }

    for (const u of toPatch) {
      const pUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(
        u.order_id
      )}`;
      await axios.patch(pUrl, u.patch, { headers: sbHeaders });
      console.log("Patched", u.order_id, u.patch);
      await new Promise((r) => setTimeout(r, 150));
    }

    res.json({ ok: true, processed: toPatch.length });
  } catch (err) {
    console.error("CRON-CHECK error:", err.response?.data || err.message);
    res.status(500).send("ERROR");
  }
});

// ============== NIGHT SUMMARY (unchanged) =================
app.get("/night-summary", async (req, res) => {
  try {
    if (!bot || !SUPPLIER_CHAT_ID) {
      return res.status(400).send("Telegram or SUPPLIER_CHAT_ID not configured");
    }

    let startOfDayISO;
    try {
      const start = DateTime.now().setZone(TIMEZONE).startOf("day");
      startOfDayISO = start.toUTC().toISO();
    } catch (e) {
      startOfDayISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    }

    const paidUrl = `${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${encodeURIComponent(
      startOfDayISO
    )}&select=order_id,name,amount,product,paid_at`;
    const paidRes = await axios.get(paidUrl, { headers: sbHeaders });
    const paid = paidRes.data || [];

    const pendingUrl = `${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&created_at=gte.${encodeURIComponent(
      startOfDayISO
    )}&select=order_id,name,amount,product,created_at`;
    const pendingRes = await axios.get(pendingUrl, { headers: sbHeaders });
    const pending = pendingRes.data || [];

    let headerDate;
    try {
      headerDate = DateTime.now().setZone(TIMEZONE).toFormat("yyyy-LL-dd");
    } catch (e) {
      headerDate = new Date().toISOString().slice(0, 10);
    }

    let text = `📊 Daily Summary for ${headerDate}\n\n`;
    const totalPaid = paid.length;
    const totalRevenue = paid.reduce(
      (s, r) => s + Number(r.amount || 0),
      0
    );

    text += `Total paid orders: ${totalPaid}\nTotal revenue: ₹${totalRevenue}\n\n`;

    if (paid.length) {
      for (const p of paid) {
        text += `• ${p.order_id} • ₹${p.amount} • ${p.name} • ${p.product}\n`;
      }
    } else {
      text += "_No paid orders today._\n";
    }

    text += `\nPending orders:\n`;
    if (pending.length) {
      for (const q of pending) {
        text += `• ${q.order_id} • ₹${q.amount} • ${q.name} • ${q.product}\n`;
      }
    } else {
      text += "_No pending orders today._\n";
    }

    await bot.sendMessage(SUPPLIER_CHAT_ID, text, { parse_mode: "Markdown" });
    res.json({ ok: true, paid: paid.length, pending: pending.length });
  } catch (err) {
    console.error("NIGHT-SUMMARY error:", err.response?.data || err.message);
    res.status(500).send("ERROR");
  }
});

// ============== START =================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("WC → Supabase automation starting...");
  console.log("SUPABASE_URL =", SUPABASE_URL);
  console.log("Server listening on", PORT);
});
