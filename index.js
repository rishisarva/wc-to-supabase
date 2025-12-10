// index.js — VisionsJersey automation (Final: webhook mode, multi-item, technique/sizes)
// 2025-12 - Finalized
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { DateTime } = require("luxon");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

// ---------------- ENV ----------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID || null;
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";
const BASE_URL = process.env.BASE_URL || null; // e.g. https://wc-to-supabase.onrender.com

// WooCommerce Keys (optional)
const WC_USER = process.env.WC_KEY || "";
const WC_PASS = process.env.WC_SECRET || "";

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_ANON environment variable.");
  process.exit(1);
}
if (!TELEGRAM_TOKEN) {
  console.warn("⚠️ TELEGRAM_TOKEN not set — Telegram functionality disabled.");
}

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

// in-memory flag to "clear" today's orders from /today (does NOT touch DB)
let clearedTodayDate = null;

// ---------------- Telegram (webhook mode) ----------------
let bot = null;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN);
  if (!BASE_URL) {
    console.warn("⚠️ BASE_URL not set — Telegram webhook will not be registered automatically. Set BASE_URL env to register webhook.");
  } else {
    const hookUrl = `${BASE_URL.replace(/\/$/, "")}/telegram-webhook`;
    bot
      .setWebHook(hookUrl)
      .then(() => console.log("✅ Telegram webhook set:", hookUrl))
      .catch((err) => console.warn("⚠️ Failed to set Telegram webhook:", err?.message || err));
  }
  console.log("🤖 Telegram Bot Ready (webhook mode)");
}

// ---------------- Helpers ----------------
function nowISO() {
  return new Date().toISOString();
}
function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}
async function patch(order_id, patchBody) {
  const pUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(order_id)}`;
  return axios.patch(pUrl, patchBody, { headers: sbHeaders });
}
async function safeSend(chatId, text) {
  if (!bot) return;
  try {
    return await bot.sendMessage(chatId, text);
  } catch (e) {
    console.error("safeSend error:", e?.response?.data || e?.message || e);
    try {
      return await bot.sendMessage(chatId, String(text));
    } catch (_) {}
  }
}

// ---------------- HEALTH ----------------
app.get("/", (req, res) => res.send("🔥 WC → Supabase Automation Live (webhook mode)"));

// ---------------- TELEGRAM WEBHOOK RECEIVER ----------------
app.post("/telegram-webhook", (req, res) => {
  if (!bot) return res.sendStatus(501);
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("telegram webhook processUpdate error:", e?.message || e);
    res.sendStatus(500);
  }
});

// ---------------- WEBHOOK INSERT (Woo → Supabase) ----------------
/*
  Expect WooCommerce to POST JSON with `order` object in body.
  This handler maps multi-line items, extracts `sizes` and `technique` from item meta,
  and stores `items` JSON into orders table.
*/
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    const order = req.body.order || req.body; // accept both shapes
    if (!order) return res.status(200).send("NO ORDER");

    // extract line_items which might be array
    const items = Array.isArray(order.line_items) ? order.line_items : [];

    // build flattened product names, skus and gather sizes/technique values (if present)
    const productNames = [];
    const skus = [];
    const sizesFound = new Set();
    const techniqueFound = new Set();

    items.forEach((it) => {
      try {
        productNames.push(it.name || "");
        if (it.sku) skus.push(it.sku);
        // meta may be in different shapes
        const meta = it.meta || it.meta_data || it.meta_data || [];
        const metaItems = Array.isArray(meta) ? meta : [];
        metaItems.forEach((m) => {
          const k = (m.key || m.name || "").toString().toLowerCase();
          const v = (m.value || m.display_value || m.option || m.label || "").toString();
          if (!v) return;
          if (k.includes("size") || k === "pa_sizes" || k === "sizes") {
            sizesFound.add(v);
          }
          if (k.includes("technique") || k === "technique") {
            techniqueFound.add(v);
          }
        });
      } catch (_) {}
    });

    const mapped = {
      order_id: String(order.id || order.order_id || ""),
      name: (order.billing_address?.first_name || order.billing?.first_name || order.billing?.name || "").toString(),
      phone: (order.billing_address?.phone || order.billing?.phone || "").toString(),
      email: (order.billing_address?.email || order.billing?.email || "").toString(),
      amount: Number(order.total || order.total_amount || 0),
      product: productNames.join(" | "),
      sku: skus.join(" | "),
      // sizes & technique fields are aggregated as comma separated
      sizes: Array.from(sizesFound).join(", "),
      technique: Array.from(techniqueFound).join(", "),
      // address fields if present
      address: (order.billing_address?.address_1 || order.billing?.address_1 || "").toString(),
      state: (order.billing_address?.state || order.billing?.state || "").toString(),
      pincode: (order.billing_address?.postcode || order.billing?.postcode || "").toString(),
      quantity: order.total_line_items_quantity || items.reduce((s, it) => s + (it.quantity || 0), 0) || 1,

      // status fields
      status: "pending_payment",
      created_at: nowISO(),

      // messaging flags
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
      previous_reminder_72_sent: null,

      // save full items JSON for auditing
      items: JSON.stringify(items)
    };

    // Insert into Supabase orders table
    await axios.post(`${SUPABASE_URL}/rest/v1/orders`, mapped, { headers: sbHeaders });

    return res.status(200).send("OK");
  } catch (err) {
    console.error("WEBHOOK ERROR:", err?.response?.data || err?.message || err);
    // return 200 to acknowledge Woo but log details
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
- Show panel with actions: Mark Paid / Resend QR / Track / Cancel

/paid <order_id>
- Mark order as paid
- WooCommerce → processing
- Supabase → status paid + thank-you pending
- Sends supplier format
- Saves paid item to paid_order_items (today) and sends today's paid list

/resend_qr <order_id>
- Trigger AutoJS to resend QR + pending message

/track <order_id> <phone> <tracking_id>
- Mark order completed in Supabase and reply tracking text

/export_today - list today's orders
/today - show today's paid orders
/clear_today - hide today's paid orders from /today (view only)
/paidorders - choose date (D-3..D+3) to view paid orders
`;
    await safeSend(chatId, text);
  });
}

/* ---------------------------------------------------
   Core: mark paid logic (shared)
   Insert into paid_order_items table using day = YYYY-MM-DD (TimeZone)
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
  } catch (e) {
    console.error("fetch order error:", e?.response?.data || e?.message || e);
    return safeSend(chatId, `❌ Failed fetching ${orderId}.`);
  }

  if (!fetchRes?.data?.length) {
    await safeSend(chatId, `❌ Order ${orderId} not found in Supabase.`);
    return;
  }
  const order = fetchRes.data[0];

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
      console.error("WooCommerce update failed:", e?.response?.data || e?.message || e);
    }
  }

  // 3) Update Supabase -> mark paid
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
    console.error("Supabase patch (paid) failed:", e?.response?.data || e?.message || e);
  }

  // 4) Insert into paid_order_items (day = today)
  try {
    let dayKey;
    try {
      dayKey = DateTime.now().setZone(TIMEZONE).toISODate();
    } catch (_) {
      dayKey = new Date().toISOString().slice(0, 10);
    }

    const paidItem = {
      day: dayKey,
      order_id: order.order_id || String(orderId),
      name: order.name || "",
      amount: order.amount || 0,
      sku: order.sku || "",
      sizes: order.sizes || "",
      technique: order.technique || "",
      created_at: nowISO()
    };

    await axios.post(`${SUPABASE_URL}/rest/v1/paid_order_items`, paidItem, { headers: sbHeaders });
  } catch (e) {
    console.error("Insert paid_order_items failed:", e?.response?.data || e?.message || e);
  }

  // 5) Send supplier format and today's list
  // -------------------------------------------
// Build supplier format using multi-item arrays
// -------------------------------------------
let skuList = [];
let productList = [];

try {
  const skus = (order.sku || "").split(",");        // ["VJ90","VJ10"]
  const products = (order.product || "").split("|"); // ["P1","P2"]
  const sizes = (order.size || "").split(",");       // ["l","m"]
  const techs = (order.technique || "").split(",");  // ["emb","emb"]

  for (let i = 0; i < skus.length; i++) {
    const s = skus[i]?.trim() || "";
    const p = products[i]?.trim() || "";
    const size = sizes[i]?.trim() || "";
    const tech = techs[i]?.trim() || "";

    skuList.push(`${i + 1}. ${s}`);
    productList.push(
      `${i + 1}. ${p} • size: ${size.toUpperCase()} • Technique: ${tech}`
    );
  }
} catch (err) {
  console.log("Multi-item format error:", err);
}

const supplierText = `
📦 NEW PAID ORDER

From:
Vision Jerseys
+91 93279 05965

To:
Name: ${order.name || ""}
Address: ${order.address || ""}
State: ${order.state || ""}
Pincode: ${order.pincode || ""}
Phone: ${order.phone || ""}

SKU ID:
${skuList.join("\n")}

Product:
${productList.join("\n")}

Quantity: ${order.quantity || 1}

Shipment Mode: Normal
`;
  // 6) Build today's paid list from paid_order_items (primary source)
  let listText = "";
  try {
    let dayKey;
    try {
      dayKey = DateTime.now().setZone(TIMEZONE).toISODate();
    } catch (_) {
      dayKey = new Date().toISOString().slice(0, 10);
    }

    const paidItemsRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${encodeURIComponent(dayKey)}&select=order_id,name,amount,created_at,sku,sizes,technique`,
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
        listText += `${idx + 1}. ${r.name || "-"} (${r.order_id}) ₹${r.amount} | SKU:${r.sku || "-"} | Size:${r.sizes || "-"} | Tech:${r.technique || "-"} — ${dateStr}\n`;
      });
    }
  } catch (e) {
    console.error("Failed to build today's list from paid_order_items:", e?.response?.data || e?.message || e);
    listText = "Today's paid list couldn't be loaded from DB.";
  }

  await safeSend(chatId, listText);

  // confirmation
  await safeSend(chatId, `✅ Order ${orderId} marked paid.\nWooCommerce → processing (attempted)\nSupabase updated.\nCustomer thank-you will be sent automatically by AutoJS.`);
}

/* ---------------------------------------------------
   /paid command
--------------------------------------------------- */
if (bot) {
  bot.onText(/\/paid\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1]?.trim();
    if (!orderId) return safeSend(chatId, "❌ Use: /paid <order_id>");
    try {
      await handleMarkPaid(chatId, orderId);
    } catch (err) {
      console.error("/paid error:", err?.response?.data || err?.message || err);
      await safeSend(chatId, "⚠️ Error processing /paid. Check logs.");
    }
  });
}

/* ---------------------------------------------------
   /order and other commands (kept as before)
   For brevity, only /order and /resend_qr /track /today /paidorders /clear_today /export_today
   are included exactly as previous — but note they use paid_order_items now where appropriate.
--------------------------------------------------- */
// /order
if (bot) {
  bot.onText(/\/order\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const orderId = match[1]?.trim();
    if (!orderId) return safeSend(chatId, "Usage: /order <order_id>");

    try {
      const resp = await axios.get(
        `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`,
        { headers: sbHeaders }
      );
      if (!resp.data.length) return safeSend(chatId, `❌ Order ${orderId} not found.`);
      const o = resp.data[0];
      const text = `📦 Order #${o.order_id}\n\nName: ${o.name || ""}\nAmount: ₹${o.amount || 0}\nProduct: ${o.product || ""}\nSize: ${o.sizes || ""}\nTechnique: ${o.technique || ""}`;
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
      console.error("/order error:", e?.response?.data || e?.message || e);
      await safeSend(chatId, "⚠️ Failed to load order.");
    }
  });
}

// /resend_qr
if (bot) {
  bot.onText(/\/resend_qr\s+(.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const id = match[1]?.trim();
    if (!id) return safeSend(chatId, "Usage: /resend_qr <order_id>");
    try {
      await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(id)}`, { resend_qr_pending: true }, { headers: sbHeaders });
      await safeSend(chatId, `🔁 QR resend triggered for order ${id}.`);
    } catch (e) {
      console.error("/resend_qr error:", e?.response?.data || e?.message || e);
      await safeSend(chatId, "⚠️ Failed to set resend flag.");
    }
  });
}

// /track
if (bot) {
  bot.onText(/\/track\s+(\S+)\s+(\S+)\s+(\S+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const [_, orderId, phone, tracking] = match;
    try {
      await patch(orderId, { tracking_sent: true, status: "completed" });
      await safeSend(chatId, `📦 Tracking set:\nOrder: ${orderId}\nPhone: ${phone}\nTracking ID: ${tracking}`);
    } catch (e) {
      console.error("/track error:", e?.response?.data || e?.message || e);
      await safeSend(chatId, "⚠️ Failed to update tracking.");
    }
  });
}

// /today - use paid_order_items primary source
if (bot) {
  bot.onText(/\/today/i, async (msg) => {
    const chatId = msg.chat.id;
    let todayKey;
    try { todayKey = DateTime.now().setZone(TIMEZONE).toISODate(); } catch (_) { todayKey = new Date().toISOString().slice(0,10); }
    if (clearedTodayDate === todayKey) return safeSend(chatId, "✅ Today's orders were cleared from /today view.");

    try {
      const r = await axios.get(`${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${encodeURIComponent(todayKey)}&select=order_id,name,amount,sku,sizes,technique,created_at`, { headers: sbHeaders });
      const rows = r.data || [];
      if (!rows.length) return safeSend(chatId, "📭 No paid orders yet today.");
      let text = "📅 Today’s Paid Orders\n\n";
      rows.forEach((o) => { text += `• ${o.order_id} | ${o.name || ""} | ₹${o.amount || 0} | SKU:${o.sku||"-"} | Size:${o.sizes||"-"} | Tech:${o.technique||"-"}\n`; });
      await safeSend(chatId, text);
    } catch (e) {
      console.error("/today error:", e?.response?.data || e?.message || e);
      await safeSend(chatId, "⚠️ Failed to fetch today's paid orders.");
    }
  });
}

// /clear_today
if (bot) {
  bot.onText(/\/clear_today/i, async (msg) => {
    let todayKey;
    try { todayKey = DateTime.now().setZone(TIMEZONE).toISODate(); } catch (_) { todayKey = new Date().toISOString().slice(0,10); }
    clearedTodayDate = todayKey;
    await safeSend(msg.chat.id, "✅ Cleared today's paid orders from /today view (DB not changed).");
  });
}

// /paidorders (date buttons)
if (bot) {
  bot.onText(/\/paidorders/i, async (msg) => {
    const chatId = msg.chat.id;
    let base;
    try { base = DateTime.now().setZone(TIMEZONE).startOf("day"); } catch (_) { base = DateTime.now(); }
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

// callback handler for inline keyboard actions (paid, resend, cancel, paidorders date)
if (bot) {
  bot.on("callback_query", async (query) => {
    const data = query.data || "";
    const chatId = query.message.chat.id;
    try {
      if (data.startsWith("order_paid:")) {
        const orderId = data.split(":")[1]; await handleMarkPaid(chatId, orderId);
      } else if (data.startsWith("order_resend:")) {
        const orderId = data.split(":")[1];
        await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`, { resend_qr_pending: true }, { headers: sbHeaders });
        await safeSend(chatId, `🔁 QR resend triggered for order ${orderId}.`);
      } else if (data.startsWith("order_track:")) {
        const orderId = data.split(":")[1]; await safeSend(chatId, `To set tracking, use:\n/track ${orderId} <phone> <tracking_id>`);
      } else if (data.startsWith("order_cancel:")) {
        const orderId = data.split(":")[1];
        const keyboard = { inline_keyboard: [
          [{ text: "🗂 Cancel only in today list", callback_data: `order_cancel_action:${orderId}:only_list` },
           { text: "❌ Cancel in Woo+Supabase", callback_data: `order_cancel_action:${orderId}:full` }],
          [{ text: "♻️ Restore (if cancelled)", callback_data: `order_cancel_action:${orderId}:restore` }]
        ]};
        await bot.sendMessage(chatId, `Choose cancel action for order ${orderId}:`, { reply_markup: keyboard });
      } else if (data.startsWith("order_cancel_action:")) {
        const parts = data.split(":");
        const orderId = parts[1];
        const action = parts[2];
        if (action === "only_list") {
          await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`, { hidden_from_today: true }, { headers: sbHeaders });
          await safeSend(chatId, `✅ Order ${orderId} hidden from today's list.`);
        } else if (action === "full") {
          const fetchRes = await axios.get(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`, { headers: sbHeaders });
          const rows = fetchRes.data || [];
          if (!rows.length) return safeSend(chatId, `Order ${orderId} not found.`);
          const o = rows[0];
          const backup = {
            previous_status: o.status || null,
            previous_paid_at: o.paid_at || null,
            previous_amount: o.amount || null,
            previous_next_message: o.next_message || null,
            previous_reminder_24_sent: o.reminder_24_sent || false,
            previous_reminder_48_sent: o.reminder_48_sent || false,
            previous_reminder_72_sent: o.reminder_72_sent || false
          };
          if (WC_USER && WC_PASS) {
            try { await axios.put(`https://visionsjersey.com/wp-json/wc/v3/orders/${orderId}`, { status: "cancelled" }, { auth: { username: WC_USER, password: WC_PASS } }); } catch (e) { console.error("Woo cancel failed:", e?.message||e); }
          }
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
          const fetchRes = await axios.get(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`, { headers: sbHeaders });
          const rows = fetchRes.data || [];
          if (!rows.length) return safeSend(chatId, `Order ${orderId} not found.`);
          const o = rows[0];
          if (!o.previous_status) return safeSend(chatId, `No previous state found for order ${orderId}. Cannot restore.`);
          if (WC_USER && WC_PASS) {
            try { await axios.put(`https://visionsjersey.com/wp-json/wc/v3/orders/${orderId}`, { status: o.previous_status }, { auth: { username: WC_USER, password: WC_PASS } }); } catch (e) { console.error("Woo restore failed:", e?.message||e); }
          }
          await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`, {
            status: o.previous_status,
            paid_at: o.previous_paid_at,
            amount: o.previous_amount,
            next_message: o.previous_next_message,
            reminder_24_sent: o.previous_reminder_24_sent,
            reminder_48_sent: o.previous_reminder_48_sent,
            reminder_72_sent: o.previous_reminder_72_sent,
            hidden_from_today: false,
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
      } else if (data.startsWith("paidorders:")) {
        const dateKey = data.split(":")[1];
        let start, end;
        try {
          const d = DateTime.fromISO(dateKey, { zone: TIMEZONE });
          start = d.startOf("day").toUTC().toISO(); end = d.plus({ days: 1 }).startOf("day").toUTC().toISO();
        } catch (_) { const d = DateTime.now(); start = d.toISO(); end = d.plus({ days: 1 }).toISO(); }
        // primary source: paid_order_items
        try {
          const r = await axios.get(`${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${encodeURIComponent(dateKey)}&select=order_id,name,amount,created_at,sku,sizes,technique`, { headers: sbHeaders });
          const rows = r.data || [];
          let header = `${dateKey} paid orders 🌼\n\n`;
          if (!rows.length) header += "No paid orders on this date.";
          else {
            rows.forEach((o, idx) => {
              let dateStr = o.created_at; try { dateStr = DateTime.fromISO(o.created_at).setZone(TIMEZONE).toFormat("dd/LL/yyyy"); } catch (_) {}
              header += `${idx + 1}. ${o.name || ""} (${o.order_id}) ₹${o.amount} | SKU:${o.sku||"-"} | Size:${o.sizes||"-"} | Tech:${o.technique||"-"} — ${dateStr}\n`;
            });
          }
          await safeSend(chatId, header);
        } catch (e) {
          console.error("paidorders fetch error (paid_order_items):", e?.response?.data || e?.message || e);
          // fallback to orders table
          try {
            const r2 = await axios.get(`${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${encodeURIComponent(start)}&paid_at=lt.${encodeURIComponent(end)}&select=order_id,name,amount,paid_at,hidden_from_today`, { headers: sbHeaders });
            let rows = (r2.data || []).filter((x) => !x.hidden_from_today);
            let header = `${dateKey} paid orders 🌼\n\n`;
            if (!rows.length) header += "No paid orders on this date.";
            else {
              rows.forEach((o, idx) => {
                let dateStr = o.paid_at; try { dateStr = DateTime.fromISO(o.paid_at).setZone(TIMEZONE).toFormat("dd/LL/yyyy"); } catch (_) {}
                header += `${idx + 1}. ${o.name || ""} (${o.order_id}) 📦 # ${dateStr}\n`;
              });
            }
            await safeSend(chatId, header);
          } catch (e2) {
            console.error("paidorders fallback error:", e2?.response?.data || e2?.message || e2);
            await safeSend(chatId, "⚠️ Failed to fetch paid orders for that date.");
          }
        }
      } else {
        await bot.answerCallbackQuery(query.id, { text: "Action received" });
      }
    } catch (e) {
      console.error("callback_query error:", e?.response?.data || e?.message || e);
      try { await safeSend(chatId, "⚠️ Error handling button action."); } catch (_) {}
    } finally {
      try { await bot.answerCallbackQuery(query.id); } catch (_) {}
    }
  });
}

/* ---------------------------------------------------
   CRON / REMINDERS — run via your cron hitting /cron-check
   It patches reminder flags and cancels at 72h
--------------------------------------------------- */
app.get("/cron-check", async (req, res) => {
  try {
    const orders = await axios.get(`${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`, { headers: sbHeaders });
    for (const o of orders.data) {
      const h = hoursSince(o.created_at);
      if (!o.reminder_24_sent && h >= 24) await patch(o.order_id, { reminder_24_sent: true, next_message: "reminder_48h" });
      if (!o.reminder_48_sent && h >= 48) await patch(o.order_id, { reminder_48_sent: true, discounted_amount: (o.amount || 0) - 30, next_message: "reminder_72h" });
      if (!o.reminder_72_sent && h >= 72) await patch(o.order_id, { reminder_72_sent: true, status: "cancelled" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("CRON-CHECK error:", err?.response?.data || err?.message || err);
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
