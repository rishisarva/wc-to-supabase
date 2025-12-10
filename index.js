// index.js — VisionsJersey automation (Final: multi-item, sizes= "sizes", technique="technique", S1 supplier format)
// 2025-12 - Final by assistant

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
  console.error("❌ Missing SUPABASE_URL or SUPABASE_ANON environment variable.");
  process.exit(1);
}

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

// in-memory flag to "clear" today's orders from /today (does NOT touch DB)
let clearedTodayDate = null;

// ---------------- Telegram ----------------
let bot = null;
if (TELEGRAM_TOKEN) {
  // polling mode (works on Render; be sure only a single instance is running)
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log("🤖 Telegram Bot Ready (polling)");
} else {
  console.warn("⚠️ TELEGRAM_TOKEN missing — bot disabled.");
}

// Helpers
function nowISO() {
  return new Date().toISOString();
}
function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}
async function patch(order_id, patchBody) {
  const pUrl =
    `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(order_id)}`;
  return axios.patch(pUrl, patchBody, { headers: sbHeaders });
}

// Small safe sender — uses plain text to avoid markdown parse errors
async function safeSend(chatId, text) {
  if (!bot) return;
  try {
    return await bot.sendMessage(chatId, text);
  } catch (e) {
    console.error("safeSend error:", e.response?.data || e.message || e);
    // fallback: try without extra options
    try {
      return await bot.sendMessage(chatId, String(text));
    } catch (_) {}
  }
}

// ---------------- HEALTH ----------------
app.get("/", (req, res) => res.send("🔥 WC → Supabase Automation Live"));

// ---------------- Utility: parse items from Woo order line_items ----------------
function extractItemsFromWoo(order) {
  // expects order.line_items array
  const items = [];
  try {
    const lineItems = order.line_items || [];
    for (const li of lineItems) {
      const product = li.name || "";
      const sku = li.sku || "";
      const quantity = li.quantity || li.qty || 1;
      // try to find meta entries for sizes and technique
      let size = "";
      let technique = "";
      try {
        const meta = li.meta || li.meta_data || li.meta_data || [];
        for (const m of meta) {
          const key = (m.key || m.name || "").toString().toLowerCase();
          const label = (m.label || m.display_key || "").toString().toLowerCase();
          const value = m.value || m.display_value || m.option || m || "";
          if (!size && (key === "sizes" || key.includes("size") || label.includes("size"))) {
            size = String(value);
          }
          if (!technique && (key === "technique" || key.includes("technique") || label.includes("technique"))) {
            technique = String(value);
          }
          // also sometimes meta stored as {key:'pa_sizes', value: 'L'} etc — catch those:
          if (!size && (key === "pa_sizes" || key === "pa_size")) size = String(value);
          if (!technique && (key === "pa_technique" || key === "pa-technique")) technique = String(value);
        }
      } catch (_) {}
      // fallback: if order contains aggregated attributes in li, try attributes
      try {
        const attrs = li.attributes || li.variation || [];
        for (const a of attrs) {
          const name = (a.name || a.key || "").toString().toLowerCase();
          const val = a.option || a.value || "";
          if (!size && (name === "sizes" || name.includes("size"))) size = String(val);
          if (!technique && (name === "technique" || name.includes("technique"))) technique = String(val);
        }
      } catch (_) {}
      items.push({
        product,
        sku,
        size,
        technique,
        quantity
      });
    }
  } catch (err) {
    console.error("extractItemsFromWoo error:", err && err.message ? err.message : err);
  }
  return items;
}

// ---------------- WEBHOOK INSERT (Woo → Supabase) ----------------
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    const order = req.body.order || req.body; // some webhooks send the order at root
    if (!order) return res.send("NO ORDER");

    // parse items
    const items = extractItemsFromWoo(order);

    // if items empty, try to build from other available fields
    if (!items.length) {
      // fallback: create a single item from order.line_items[0] if present
      try {
        const li = (order.line_items && order.line_items[0]) || {};
        items.push({
          product: li.name || "",
          sku: li.sku || "",
          size: "",
          technique: "",
          quantity: li.quantity || 1
        });
      } catch (_) {}
    }

    // figure overall qty (sum)
    let qty = 0;
    for (const it of items) qty += Number(it.quantity || 0);

    const billing = order.billing_address || order.billing || order.billing_info || {};

    const mapped = {
      order_id: String(order.id || order.order_number || order.number || ""),
      name: billing.first_name || billing.name || billing.full_name || "",
      phone: billing.phone || order.billing_phone || "",
      email: billing.email || "",
      amount: Number(order.total) || Number(order.total_amount) || 0,
      product: items[0] ? items[0].product : "",
      sku: items[0] ? items[0].sku : "",
      size: items[0] ? items[0].size : "",
      technique: items[0] ? items[0].technique : "",
      address: billing.address_1 || billing.address || "",
      state: billing.state || "",
      pincode: billing.postcode || billing.postal_code || "",
      quantity: qty || 1,
      items: items, // JSON column
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
      tracking_sent: false,
      hidden_from_today: false,
      // previous_* fields
      previous_status: null,
      previous_paid_at: null,
      previous_amount: null,
      previous_next_message: null,
      previous_reminder_24_sent: null,
      previous_reminder_48_sent: null,
      previous_reminder_72_sent: null
    };

    // Insert into supabase orders table
    await axios.post(`${SUPABASE_URL}/rest/v1/orders`, mapped, { headers: sbHeaders });

    return res.send("OK");
  } catch (err) {
    console.error("WEBHOOK ERROR:", err && err.response ? err.response.data || err.message : err.message || err);
    return res.status(200).send("ERR");
  }
});

/* ---------------------------------------------------
   /menu  → show commands
--------------------------------------------------- */
if (bot) {
  bot.onText(/\/menu/i, async (msg) => {
    const chatId = msg.chat.id;
    const text =
`VisionsJersey Bot Commands:

/order <order_id>
- Show panel with actions:
  Mark Paid / Resend QR / Track / Cancel

/paid <order_id>
- Mark order as paid
- WooCommerce → processing
- Supabase → status paid + thank-you pending
- Sends supplier format (multi-item)
- Saves paid item to paid_order_items (today) and sends today's paid list

/resend_qr <order_id>
- Trigger AutoJS to resend QR + pending message

/track <order_id> <phone> <tracking_id>
- Mark order completed in Supabase and reply tracking text

/export_today
- List today's orders (all statuses)

/today
- Show today's PAID orders

/clear_today
- Hide today's paid orders from /today (view only)

/paidorders
- Show buttons for paid orders by date (3 days before, today, 3 days after)

Notes:
- Cancel button opens a submenu: Cancel only in list, Cancel in Woo+Supabase, Restore (if available).`;
    await safeSend(chatId, text);
  });
}

/* ---------------------------------------------------
   Core: mark paid logic (shared)
   - uses items from orders.items (JSON)
   - saves a row into paid_order_items (day = today)
--------------------------------------------------- */
async function handleMarkPaid(chatId, orderId) {
  console.log("handleMarkPaid:", orderId);

  // 1) Fetch order
  let fetchRes;
  try {
    fetchRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`,
      { headers: sbHeaders }
    );
  } catch (err) {
    console.error("fetch order error:", err && err.response ? err.response.data || err.message : err.message || err);
    await safeSend(chatId, `❌ Error fetching order ${orderId}`);
    return;
  }

  if (!fetchRes.data || !fetchRes.data.length) {
    await safeSend(chatId, `❌ Order ${orderId} not found in Supabase.`);
    return;
  }
  const order = fetchRes.data[0];

  // Normalize items field (could be string or JSON)
  let items = [];
  try {
    if (!order.items) {
      items = [{
        product: order.product || "",
        sku: order.sku || "",
        size: order.size || "",
        technique: order.technique || "",
        quantity: order.quantity || 1
      }];
    } else if (typeof order.items === "string") {
      try {
        items = JSON.parse(order.items);
      } catch (_) {
        items = [];
      }
    } else {
      items = order.items;
    }
  } catch (err) {
    items = [];
  }
  if (!items || !items.length) {
    // fallback single
    items = [{
      product: order.product || "",
      sku: order.sku || "",
      size: order.size || "",
      technique: order.technique || "",
      quantity: order.quantity || 1
    }];
  }

  // 2) Update WooCommerce -> processing (best-effort)
  if (WC_USER && WC_PASS) {
    try {
      await axios.put(
        `https://visionsjersey.com/wp-json/wc/v3/orders/${orderId}`,
        { status: "processing" },
        { auth: { username: WC_USER, password: WC_PASS } }
      );
      console.log("✔ WooCommerce updated to processing:", orderId);
    } catch (e) {
      console.error("WooCommerce update failed:", e && e.response ? e.response.data || e.message : e.message || e);
      // continue anyway
    }
  } else {
    console.warn("WC_KEY / WC_SECRET not configured in environment.");
  }

  // 3) Update Supabase -> mark paid + set paid_message_pending so AutoJS sends thank-you
  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`,
      {
        status: "paid",
        paid_at: nowISO(),
        paid_message_pending: true,
        reminder_24_sent: true,
        reminder_48_sent: true,
        reminder_72_sent: true,
        next_message: null,
        hidden_from_today: false
      },
      { headers: sbHeaders }
    );
  } catch (e) {
    console.error("Supabase patch (paid) failed:", e && e.response ? e.response.data || e.message : e.message || e);
    // continue
  }

  // 4) Insert into paid_order_items (day = today's date in TIMEZONE)
  try {
    let dayKey;
    try {
      dayKey = DateTime.now().setZone(TIMEZONE).toISODate(); // YYYY-MM-DD
    } catch (_) {
      dayKey = new Date().toISOString().slice(0, 10);
    }

    const paidItem = {
      day: dayKey,
      order_id: order.order_id || String(orderId),
      name: order.name || "",
      amount: order.amount || 0,
      items: items,
      created_at: nowISO()
    };

    // insert row
    await axios.post(
      `${SUPABASE_URL}/rest/v1/paid_order_items`,
      paidItem,
      { headers: sbHeaders }
    );
  } catch (e) {
    console.error("Insert paid_order_items failed:", e && e.response ? e.response.data || e.message : e.message || e);
  }

  // 5) Build supplier format S1 (compact block per item)
  let supplierText = `📦 NEW PAID ORDER

From:
Vision Jerseys 
+91 93279 05965

To:
Name: ${order.name || ""}
Address: ${order.address || ""}
State: ${order.state || ""}
Pincode: ${order.pincode || ""}
Phone: ${order.phone || ""}

Items:\n`;

  try {
    items.forEach((it, idx) => {
      const pr = it.product || "";
      const sku = it.sku || "";
      const size = it.size || "";
      const technique = it.technique || "";
      const qty = it.quantity || 1;
      supplierText += `${idx + 1}) ${pr}\n   SKU: ${sku}\n   Size: ${size}\n   Technique: ${technique}\n   Qty: ${qty}\n\n`;
    });
  } catch (e) {
    supplierText += `• ${order.product || ""} (SKU:${order.sku || ""}) Qty:${order.quantity || 1}\n\n`;
  }

  supplierText += `Shipment Mode: Normal`;

  // send to supplier + admin chat
  try {
    if (SUPPLIER_CHAT_ID) await safeSend(SUPPLIER_CHAT_ID, supplierText);
    await safeSend(chatId, supplierText);
  } catch (e) {
    console.error("failed to send supplier message:", e && e.response ? e.response.data || e.message : e.message || e);
  }

  // 6) Build today's paid list from paid_order_items (primary source)
  let listText = "";
  try {
    let dayKey;
    try {
      dayKey = DateTime.now().setZone(TIMEZONE).toISODate(); // YYYY-MM-DD
    } catch (_) {
      dayKey = new Date().toISOString().slice(0, 10);
    }

    const paidItemsRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${encodeURIComponent(dayKey)}&select=order_id,name,amount,created_at`,
      { headers: sbHeaders }
    );
    const saved = paidItemsRes.data || [];

    let headerDate;
    try {
      headerDate = DateTime.now().setZone(TIMEZONE).toFormat("yyyy-LL-dd");
    } catch (_) {
      headerDate = new Date().toISOString().slice(0, 10);
    }

    listText = `${headerDate} orders 🌼\n\n`;
    if (!saved.length) {
      listText += "No paid orders for today yet.";
    } else {
      saved.forEach((r, idx) => {
        let dateStr = r.created_at || "";
        try {
          dateStr = DateTime.fromISO(r.created_at).setZone(TIMEZONE).toFormat("dd/LL/yyyy");
        } catch (_) {}
        listText += `${idx + 1}. ${r.name || "-"} (${r.order_id}) 📦 # ${dateStr}\n`;
      });
    }
  } catch (e) {
    console.error("Failed to build today's list from paid_order_items:", e && e.response ? e.response.data || e.message : e.message || e);
    listText = "Today's paid list couldn't be loaded from DB.";
  }

  await safeSend(chatId, listText);

  // final confirmation
  await safeSend(chatId, `✅ Order ${orderId} marked paid.\nWooCommerce → processing (attempted)\nSupabase updated.\nCustomer thank-you will be sent automatically by AutoJS.`);
}

/* ---------------------------------------------------
   /paid <order_id> (command)
--------------------------------------------------- */
if (bot) {
  bot.onText(/\/paid\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1] && match[1].trim();
    if (!orderId) return safeSend(chatId, "❌ Use: /paid <order_id>");

    try {
      await handleMarkPaid(chatId, orderId);
    } catch (err) {
      console.error("/paid error:", err && err.response ? err.response.data || err.message : err.message || err);
      await safeSend(chatId, "⚠️ Error processing /paid. Check logs.");
    }
  });
}

/* ---------------------------------------------------
   /order <order_id> — show panel w/ inline buttons
--------------------------------------------------- */
if (bot) {
  bot.onText(/\/order\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1] && match[1].trim();
    if (!orderId) return safeSend(chatId, "Usage: /order <order_id>");

    try {
      const resp = await axios.get(
        `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`,
        { headers: sbHeaders }
      );
      if (!resp.data.length) return safeSend(chatId, `❌ Order ${orderId} not found.`);

      const o = resp.data[0];
      const text = `📦 Order #${o.order_id}\n\nName: ${o.name || ""}\nAmount: ₹${o.amount || 0}`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "✅ Mark Paid", callback_data: `order_paid:${o.order_id}` },
            { text: "🔁 Resend QR", callback_data: `order_resend:${o.order_id}` }
          ],
          [
            { text: "📦 Track", callback_data: `order_track:${o.order_id}` },
            { text: "❌ Cancel", callback_data: `order_cancel:${o.order_id}` }
          ]
        ]
      };

      await bot.sendMessage(chatId, text, { reply_markup: keyboard });
    } catch (e) {
      console.error("/order error:", e && e.response ? e.response.data || e.message : e.message || e);
      await safeSend(chatId, "⚠️ Failed to load order.");
    }
  });
}

/* ---------------------------------------------------
   /resend_qr <order_id>
--------------------------------------------------- */
if (bot) {
  bot.onText(/\/resend_qr\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const id = match[1] && match[1].trim();
    if (!id) return safeSend(chatId, "Usage: /resend_qr <order_id>");

    try {
      await axios.patch(
        `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(id)}`,
        { resend_qr_pending: true },
        { headers: sbHeaders }
      );
      await safeSend(chatId, `🔁 QR resend triggered for order ${id}.`);
    } catch (e) {
      console.error("/resend_qr error:", e && e.response ? e.response.data || e.message : e.message || e);
      await safeSend(chatId, "⚠️ Failed to set resend flag.");
    }
  });
}

/* ---------------------------------------------------
   /track <order_id> <phone> <tracking_id>
--------------------------------------------------- */
if (bot) {
  bot.onText(/\/track\s+(\S+)\s+(\S+)\s+(\S+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const [_, orderId, phone, tracking] = match;
    try {
      await patch(orderId, { tracking_sent: true, status: "completed" });

      await safeSend(chatId, `📦 Tracking set:\nOrder: ${orderId}\nPhone: ${phone}\nTracking ID: ${tracking}`);

      const infoText =
`📦 Track Your India Post Order

Dear Customer,
To track your India Post order, we have provided a tracking ID in the format “CLXXXXXXXXIN”.

Example: CL505XX0845IN

Please copy your tracking ID and paste it on the official tracking website below:
🔗 Track Your Order Here: https://myspeedpost.com/

On this website, you can also get live updates about your order directly on WhatsApp so that you never miss your delivery date.
Thank you for shopping with us! Visionsjersey.`;

      await safeSend(chatId, infoText);
    } catch (e) {
      console.error("/track error:", e && e.response ? e.response.data || e.message : e.message || e);
      await safeSend(chatId, "⚠️ Failed to update tracking.");
    }
  });
}

/* ---------------------------------------------------
   /export_today
--------------------------------------------------- */
if (bot) {
  bot.onText(/\/export_today/i, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const start = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();
      const resp = await axios.get(
        `${SUPABASE_URL}/rest/v1/orders?created_at=gte.${encodeURIComponent(start)}&select=order_id,name,phone,amount,status`,
        { headers: sbHeaders }
      );
      const rows = resp.data || [];
      if (!rows.length) return safeSend(chatId, "📭 No orders today.");
      let txt = "📄 Today Orders:\n\n";
      rows.forEach((o) => {
        txt += `• ${o.order_id} | ${o.name || ""} | ₹${o.amount || 0} | ${o.status || ""}\n`;
      });
      await safeSend(chatId, txt);
    } catch (e) {
      console.error("/export_today error:", e && e.response ? e.response.data || e.message : e.message || e);
      await safeSend(chatId, "⚠️ Failed to export today's orders.");
    }
  });
}

/* ---------------------------------------------------
   /today
   - Read primary source: paid_order_items table (day)
--------------------------------------------------- */
if (bot) {
  bot.onText(/\/today/i, async (msg) => {
    const chatId = msg.chat.id;
    let todayKey;
    try {
      todayKey = DateTime.now().setZone(TIMEZONE).toISODate();
    } catch (_) {
      todayKey = new Date().toISOString().slice(0, 10);
    }
    if (clearedTodayDate === todayKey) {
      return safeSend(chatId, "✅ Today's orders were cleared from /today view.");
    }

    try {
      // use paid_order_items table (primary source) to list today's paid
      const r = await axios.get(
        `${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${encodeURIComponent(todayKey)}&select=order_id,name,amount,created_at`,
        { headers: sbHeaders }
      );
      const rows = (r.data || []).filter((x) => true);
      if (!rows.length) return safeSend(chatId, "📭 No paid orders yet today.");
      let text = "📅 Today’s Paid Orders\n\n";
      rows.forEach((o) => {
        text += `• ${o.order_id} | ${o.name || ""} | ₹${o.amount || 0}\n`;
      });
      await safeSend(chatId, text);
    } catch (e) {
      console.error("/today error:", e && e.response ? e.response.data || e.message : e.message || e);
      await safeSend(chatId, "⚠️ Failed to fetch today's paid orders.");
    }
  });
}

/* ---------------------------------------------------
   /clear_today
--------------------------------------------------- */
if (bot) {
  bot.onText(/\/clear_today/i, async (msg) => {
    let todayKey;
    try {
      todayKey = DateTime.now().setZone(TIMEZONE).toISODate();
    } catch (_) {
      todayKey = new Date().toISOString().slice(0, 10);
    }
    clearedTodayDate = todayKey;
    await safeSend(msg.chat.id, "✅ Cleared today's paid orders from /today view (DB not changed).");
  });
}

/* ---------------------------------------------------
   /paidorders (D-3 .. D+3)
--------------------------------------------------- */
if (bot) {
  bot.onText(/\/paidorders/i, async (msg) => {
    const chatId = msg.chat.id;
    let base;
    try {
      base = DateTime.now().setZone(TIMEZONE).startOf("day");
    } catch (_) {
      base = DateTime.now();
    }

    const buttons = [];
    const row1 = [];
    for (let i = -3; i <= -1; i++) {
      const d = base.plus({ days: i });
      row1.push({ text: d.toFormat("dd/MM"), callback_data: `paidorders:${d.toISODate()}` });
    }
    buttons.push(row1);

    buttons.push([{ text: "Today", callback_data: `paidorders:${base.toISODate()}` }]);

    const row3 = [];
    for (let i = 1; i <= 3; i++) {
      const d = base.plus({ days: i });
      row3.push({ text: d.toFormat("dd/MM"), callback_data: `paidorders:${d.toISODate()}` });
    }
    buttons.push(row3);

    await bot.sendMessage(chatId, "📅 Choose a date to view paid orders:", { reply_markup: { inline_keyboard: buttons } });
  });
}

/* ---------------------------------------------------
   CALLBACK HANDLER (inline buttons)
   - order_paid, order_resend, order_track, order_cancel
   - order_cancel opens submenu with options:
       order_cancel_action:<id>:only_list
       order_cancel_action:<id>:full
       order_cancel_action:<id>:restore
   - paidorders callbacks prefer paid_order_items table
--------------------------------------------------- */
if (bot) {
  bot.on("callback_query", async (query) => {
    const data = query.data || "";
    const chatId = query.message && query.message.chat && query.message.chat.id;
    try {
      // order buttons
      if (data.startsWith("order_paid:")) {
        const orderId = data.split(":")[1];
        await handleMarkPaid(chatId, orderId);
      } else if (data.startsWith("order_resend:")) {
        const orderId = data.split(":")[1];
        await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`, { resend_qr_pending: true }, { headers: sbHeaders });
        await safeSend(chatId, `🔁 QR resend triggered for order ${orderId}.`);
      } else if (data.startsWith("order_track:")) {
        const orderId = data.split(":")[1];
        await safeSend(chatId, `To set tracking, use:\n/track ${orderId} <phone> <tracking_id>`);
      } else if (data.startsWith("order_cancel:")) {
        // show cancel submenu
        const orderId = data.split(":")[1];
        const keyboard = {
          inline_keyboard: [
            [
              { text: "🗂 Cancel only in today list", callback_data: `order_cancel_action:${orderId}:only_list` },
              { text: "❌ Cancel in Woo+Supabase", callback_data: `order_cancel_action:${orderId}:full` }
            ],
            [
              { text: "♻️ Restore (if cancelled)", callback_data: `order_cancel_action:${orderId}:restore` }
            ]
          ]
        };
        await bot.sendMessage(chatId, `Choose cancel action for order ${orderId}:`, { reply_markup: keyboard });
      }

      // cancel submenu actions
      else if (data.startsWith("order_cancel_action:")) {
        const parts = data.split(":");
        const orderId = parts[1];
        const action = parts[2];

        if (action === "only_list") {
          // set hidden_from_today true (does not modify DB status)
          await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`, { hidden_from_today: true }, { headers: sbHeaders });
          await safeSend(chatId, `✅ Order ${orderId} hidden from today's list.`);
        } else if (action === "full") {
          // FULL cancel: save previous fields, set cancelled, call Woo
          const fetchRes = await axios.get(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`, { headers: sbHeaders });
          const rows = fetchRes.data || [];
          if (!rows.length) return safeSend(chatId, `Order ${orderId} not found.`);
          const o = rows[0];

          // prepare previous_* backup
          const backup = {
            previous_status: o.status || null,
            previous_paid_at: o.paid_at || null,
            previous_amount: o.amount || null,
            previous_next_message: o.next_message || null,
            previous_reminder_24_sent: o.reminder_24_sent || false,
            previous_reminder_48_sent: o.reminder_48_sent || false,
            previous_reminder_72_sent: o.reminder_72_sent || false
          };

          // attempt Woo cancellation
          if (WC_USER && WC_PASS) {
            try {
              await axios.put(`https://visionsjersey.com/wp-json/wc/v3/orders/${orderId}`, { status: "cancelled" }, { auth: { username: WC_USER, password: WC_PASS } });
            } catch (e) {
              console.error("Woo cancel failed:", e && e.response ? e.response.data || e.message : e.message || e);
            }
          }

          // patch supabase: set cancelled + backup previous_*
          await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`, Object.assign({
            status: "cancelled",
            next_message: null,
            reminder_24_sent: true,
            reminder_48_sent: true,
            reminder_72_sent: true,
            hidden_from_today: true
          }, backup), { headers: sbHeaders });

          await safeSend(chatId, `❌ Order ${orderId} cancelled in WooCommerce (attempted) and Supabase. Restore is available.`);
        } else if (action === "restore") {
          // restore if previous_status exists
          const fetchRes = await axios.get(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`, { headers: sbHeaders });
          const rows = fetchRes.data || [];
          if (!rows.length) return safeSend(chatId, `Order ${orderId} not found.`);
          const o = rows[0];
          if (!o.previous_status) {
            return safeSend(chatId, `No previous state found for order ${orderId}. Cannot restore.`);
          }

          // attempt to restore Woo to previous_status if possible
          if (WC_USER && WC_PASS) {
            try {
              await axios.put(`https://visionsjersey.com/wp-json/wc/v3/orders/${orderId}`, { status: o.previous_status }, { auth: { username: WC_USER, password: WC_PASS } });
            } catch (e) {
              console.error("Woo restore failed:", e && e.response ? e.response.data || e.message : e.message || e);
            }
          }

          // patch Supabase to restore previous_*
          await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`, {
            status: o.previous_status,
            paid_at: o.previous_paid_at,
            amount: o.previous_amount,
            next_message: o.previous_next_message,
            reminder_24_sent: o.previous_reminder_24_sent,
            reminder_48_sent: o.previous_reminder_48_sent,
            reminder_72_sent: o.previous_reminder_72_sent,
            hidden_from_today: false,
            // clear backups
            previous_status: null,
            previous_paid_at: null,
            previous_amount: null,
            previous_next_message: null,
            previous_reminder_24_sent: null,
            previous_reminder_48_sent: null,
            previous_reminder_72_sent: null
          }, { headers: sbHeaders });

          await safeSend(chatId, `♻️ Order ${orderId} restored to previous status.`);
        } else {
          await safeSend(chatId, "Unknown cancel action.");
        }
      }

      // paidorders date buttons
      else if (data.startsWith("paidorders:")) {
        const dateKey = data.split(":")[1]; // YYYY-MM-DD
        let start, end;
        try {
          const d = DateTime.fromISO(dateKey, { zone: TIMEZONE });
          start = d.startOf("day").toUTC().toISO();
          end = d.plus({ days: 1 }).startOf("day").toUTC().toISO();
        } catch (_) {
          const d = DateTime.now();
          start = d.toISOString();
          end = new Date(d.getTime() + 24 * 3600000).toISOString();
        }

        // Primary source: paid_order_items table
        try {
          const r = await axios.get(`${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${encodeURIComponent(dateKey)}&select=order_id,name,amount,created_at`, { headers: sbHeaders });
          let rows = r.data || [];

          let header = `${dateKey} paid orders 🌼\n\n`;
          if (!rows.length) {
            header += "No paid orders on this date.";
          } else {
            rows.forEach((o, idx) => {
              let dateStr = o.created_at;
              try {
                dateStr = DateTime.fromISO(o.created_at).setZone(TIMEZONE).toFormat("dd/LL/yyyy");
              } catch (_) {}
              header += `${idx + 1}. ${o.name || ""} (${o.order_id}) 📦 # ${dateStr}\n`;
            });
          }
          await safeSend(chatId, header);
        } catch (e) {
          console.error("paidorders fetch error (paid_order_items):", e && e.response ? e.response.data || e.message : e.message || e);
          // fallback to orders table if needed
          try {
            const r2 = await axios.get(`${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${encodeURIComponent(start)}&paid_at=lt.${encodeURIComponent(end)}&select=order_id,name,amount,paid_at,hidden_from_today`, { headers: sbHeaders });
            let rows = (r2.data || []).filter((x) => !x.hidden_from_today);
            let header = `${dateKey} paid orders 🌼\n\n`;
            if (!rows.length) header += "No paid orders on this date.";
            else {
              rows.forEach((o, idx) => {
                let dateStr = o.paid_at;
                try {
                  dateStr = DateTime.fromISO(o.paid_at).setZone(TIMEZONE).toFormat("dd/LL/yyyy");
                } catch (_) {}
                header += `${idx + 1}. ${o.name || ""} (${o.order_id}) 📦 # ${dateStr}\n`;
              });
            }
            await safeSend(chatId, header);
          } catch (e2) {
            console.error("paidorders fallback error:", e2 && e2.response ? e2.response.data || e2.message : e2.message || e2);
            await safeSend(chatId, "⚠️ Failed to fetch paid orders for that date.");
          }
        }
      } else {
        // unknown callback - ack
        try { await bot.answerCallbackQuery(query.id, { text: "Action received" }); } catch (_) {}
      }
    } catch (e) {
      console.error("callback_query error:", e && e.response ? e.response.data || e.message : e.message || e);
      try { await safeSend(chatId, "⚠️ Error handling button action."); } catch (_) {}
    } finally {
      try { await bot.answerCallbackQuery(query.id); } catch (_) {}
    }
  });
}

/* ---------------------------------------------------
   CRON / REMINDERS
   - keeps behavior: 24h -> set reminder_24_sent & next_message,
                   48h -> set reminder_48_sent & discounted_amount & next_message,
                   72h -> set reminder_72_sent & status cancelled
--------------------------------------------------- */
app.get("/cron-check", async (req, res) => {
  try {
    const orders = await axios.get(`${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`, { headers: sbHeaders });
    for (const o of orders.data) {
      const h = hoursSince(o.created_at);
      if (!o.reminder_24_sent && h >= 24) {
        await patch(o.order_id, { reminder_24_sent: true, next_message: "reminder_48h" });
      }
      if (!o.reminder_48_sent && h >= 48) {
        await patch(o.order_id, { reminder_48_sent: true, discounted_amount: (o.amount || 0) - 30, next_message: "reminder_72h" });
      }
      if (!o.reminder_72_sent && h >= 72) {
        await patch(o.order_id, { reminder_72_sent: true, status: "cancelled" });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("CRON-CHECK error:", err && err.response ? err.response.data || err.message : err.message || err);
    res.status(500).send("ERROR");
  }
});

/* ---------------------------------------------------
   Night Summary
--------------------------------------------------- */
app.get("/night-summary", async (req, res) => {
  if (!bot || !SUPPLIER_CHAT_ID) return res.send("BOT DISABLED");
  const start = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();
  const paid = await axios.get(`${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${encodeURIComponent(start)}&select=*`, { headers: sbHeaders });
  let report = `📊 Daily Summary\nPaid Orders: ${paid.data.length}`;
  await safeSend(SUPPLIER_CHAT_ID, report);
  res.send("OK");
});

// ---------------- LISTEN ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
