// index.js — VisionsJersey automation (Final: robust multi-item, webhook/polling safe)
// 2025-12 - Finalized: handles multi-item orders, sizes & technique extraction,
// inserts into paid_order_items, robust fallbacks when columns differ.
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
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || null;
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID || null;
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";
const BASE_URL = process.env.BASE_URL || null; // if set, we use webhook mode for Telegram

// WooCommerce Keys (optional)
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

// ---------------- Telegram setup (webhook preferred) ----------------
let bot = null;
if (TELEGRAM_TOKEN) {
  if (BASE_URL) {
    bot = new TelegramBot(TELEGRAM_TOKEN);
    const hookUrl = `${BASE_URL.replace(/\/$/, "")}/telegram-webhook`;
    bot
      .setWebHook(hookUrl)
      .then(() => console.log("✅ Telegram webhook set:", hookUrl))
      .catch((err) => console.warn("⚠️ Failed to set Telegram webhook:", err?.message || err));
    console.log("🤖 Telegram Bot Ready (webhook mode)");
  } else {
    // polling fallback with safer error handling
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    bot.on("polling_error", (err) => {
      console.error("Telegram polling_error:", err?.response?.body || err?.code || err?.message || err);
      // don't crash; log only
    });
    console.log("🤖 Telegram Bot Ready (polling mode)");
  }
} else {
  console.warn("⚠️ TELEGRAM_TOKEN missing — bot disabled.");
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
app.get("/", (req, res) => res.send("🔥 WC → Supabase Automation Live (final)"));

/* -------------------
   Utilities: parse incoming order items robustly
   Returns array of items: { sku, name, quantity, size, technique }
---------------------*/
function extractItemsFromIncoming(order) {
  // Try multiple shapes: order.items (JSON string), order.line_items array, or nested structures.
  let rawItems = [];

  try {
    if (order.items) {
      // items might already be JSON string or array
      if (typeof order.items === "string") {
        try {
          rawItems = JSON.parse(order.items) || [];
        } catch (_) {
          // fallback: maybe it's already a stringified array with single quotes — ignore
          rawItems = [];
        }
      } else if (Array.isArray(order.items)) {
        rawItems = order.items;
      }
    }
  } catch (_) { rawItems = []; }

  // fallback to known Woo structures
  if (!rawItems.length && Array.isArray(order.line_items)) rawItems = order.line_items;

  if (!rawItems.length && Array.isArray(order.line_items_data)) rawItems = order.line_items_data;

  // Final fallback: if body itself looks like a woo 'order' with 'line_items' inside nested shapes
  if (!rawItems.length && order?.order && Array.isArray(order.order.line_items)) rawItems = order.order.line_items;

  // Map each raw item to our normalized shape
  const items = (rawItems || []).map((it) => {
    const name = it.name || it.product_name || it.title || "";
    const sku = it.sku || it.sku_id || (it.skuId ? String(it.skuId) : "") || "";
    const quantity = Number(it.quantity || it.qty || 1);
    let size = "";
    let technique = "";

    // meta / meta_data may be array or object
    const metaCandidates = it.meta || it.meta_data || it.metaData || it.meta_items || [];
    const metas = Array.isArray(metaCandidates) ? metaCandidates : [];

    metas.forEach((m) => {
      const key = ((m.key || m.name || m.label || "") + "").toLowerCase();
      const val = (m.value || m.display_value || m.option || m.label || "") + "";
      if (!val) return;
      if (key.includes("size") || key === "pa_sizes" || key === "sizes") {
        if (!size) size = val;
      } else if (key.includes("technique") || key === "technique") {
        if (!technique) technique = val;
      } else {
        // some plugins store attributes as {name: 'Attribute', option: 'L'} etc.
        if ((m.name || "").toLowerCase().includes("size") && !size) size = m.option || m.value || "";
        if ((m.name || "").toLowerCase().includes("technique") && !technique) technique = m.option || m.value || "";
      }
    });

    // Some shops put attributes on item.attributes array
    const attrs = it.attributes || it.variation || it.attributes_data || [];
    if (!size && Array.isArray(attrs)) {
      attrs.forEach((a) => {
        const aKey = ((a.name || a.key || "") + "").toLowerCase();
        const aVal = (a.option || a.value || "") + "";
        if (!aVal) return;
        if (aKey.includes("size") && !size) size = aVal;
        if (aKey.includes("technique") && !technique) technique = aVal;
      });
    }

    // final attempt: if item has 'options' or 'display' strings
    if (!size && it.display && it.display.toLowerCase().includes("size:")) {
      const m = it.display.match(/size:\s*([^\n,;]+)/i);
      if (m) size = m[1].trim();
    }

    return {
      sku: (sku + "").trim(),
      name: (name + "").trim(),
      quantity: quantity || 1,
      size: (size + "").trim(),
      technique: (technique + "").trim()
    };
  });

  return items;
}

/* -------------------------------
   /woocommerce-webhook
   Accepts Woo order JSON, maps to orders table with items JSON, sizes, technique aggregated.
---------------------------------*/
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    const order = req.body.order || req.body || {}; // support both shapes
    if (!order) return res.status(200).send("NO ORDER");

    const items = extractItemsFromIncoming(order) || [];

    // Gather aggregated fields
    const productNames = items.map((it) => it.name).filter(Boolean);
    const skus = items.map((it) => it.sku).filter(Boolean);
    const sizesSet = new Set(items.map((it) => it.size).filter(Boolean));
    const techniqueSet = new Set(items.map((it) => it.technique).filter(Boolean));
    const totalQty = items.reduce((s, it) => s + (it.quantity || 1), 0);

    // billing extraction flexible
    const billing = order.billing_address || order.billing || order.billing_address || {};

    const mapped = {
      order_id: String(order.id || order.order_id || order.number || ""),
      name: (billing.first_name || billing.name || billing.full_name || "") + "",
      phone: (billing.phone || billing.phone_number || "") + "",
      email: (billing.email || "") + "",
      amount: Number(order.total || order.total_amount || order.order_total || 0) || 0,
      product: productNames.join(" | "),
      sku: skus.join(" | "),
      sizes: Array.from(sizesSet).join(", "),
      technique: Array.from(techniqueSet).join(", "),
      address: billing.address_1 || billing.address || "",
      state: billing.state || "",
      pincode: billing.postcode || billing.postal_code || "",
      quantity: totalQty,

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

      previous_status: null,
      previous_paid_at: null,
      previous_amount: null,
      previous_next_message: null,
      previous_reminder_24_sent: null,
      previous_reminder_48_sent: null,
      previous_reminder_72_sent: null,

      // Save raw items for auditing (string)
      items: JSON.stringify(items)
    };

    // Attempt insert
    try {
      await axios.post(`${SUPABASE_URL}/rest/v1/orders`, mapped, { headers: sbHeaders });
    } catch (insertErr) {
      console.error("Supabase insert (orders) error:", insertErr?.response?.data || insertErr?.message || insertErr);
      // still ACK Woo
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("WEBHOOK ERROR:", err?.response?.data || err?.message || err);
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

/order <order_id> - show order panel
/paid <order_id> - mark paid, woo->processing, send supplier format & today's list
/resend_qr <order_id> - flag for AutoJS
/track <order_id> <phone> <tracking_id>
/export_today - list today's orders (created_at)
/today - list today's paid orders (paid_order_items)
/clear_today - hide today's paid view (local only)
/paidorders - choose date (D-3..D+3)

/delete_today_preview - preview which paid_order_items will be deleted (safe)
/delete_today_confirm - permanently delete today's paid_order_items (and related orders)
`;
    await safeSend(chatId, text);
  });
}

/* ---------------------------------------------------
   Core: mark paid logic
--------------------------------------------------- */
async function handleMarkPaid(chatId, orderId) {
  console.log("handleMarkPaid:", orderId);
  // 1) Fetch order (robust)
  let fetchRes;
  try {
    fetchRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`,
      { headers: sbHeaders }
    );
  } catch (err) {
    console.error("fetch order error:", err?.response?.data || err?.message || err);
    await safeSend(chatId, `❌ Failed fetching ${orderId}.`);
    return;
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
  } else {
    console.log("WC credentials not configured; skipping Woo update.");
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

  // Normalize items either from order fields or parse saved items JSON
  let items = [];
  try {
    if (order.items) {
      try { items = JSON.parse(order.items); } catch (_) { items = extractItemsFromIncoming(order); }
    } else {
      // if order.product/sku contain delimited values, attempt to recreate
      items = extractItemsFromIncoming(order);
    }
    if (!items.length && order.product && order.sku) {
      // try splitting by '|' or ',' heuristics
      const prods = (order.product + "").split("|").map(s => s.trim()).filter(Boolean);
      const sks = (order.sku + "").split("|").map(s => s.trim()).filter(Boolean);
      const sizes = (order.sizes || "").split(",").map(s => s.trim()).filter(Boolean);
      const techs = (order.technique || "").split(",").map(s => s.trim()).filter(Boolean);
      for (let i = 0; i < Math.max(prods.length, sks.length); i++) {
        items.push({
          name: prods[i] || "",
          sku: sks[i] || "",
          quantity: 1,
          size: sizes[i] || sizes[0] || "",
          technique: techs[i] || techs[0] || ""
        });
      }
    }
  } catch (e) {
    console.error("items normalization error:", e);
    items = [];
  }

  // 4) Insert into paid_order_items (day = today)
  try {
    let dayKey;
    try { dayKey = DateTime.now().setZone(TIMEZONE).toISODate(); } catch (_) { dayKey = new Date().toISOString().slice(0, 10); }

    // We insert a single row summarizing the order into paid_order_items.
    const paidItem = {
      day: dayKey,
      order_id: order.order_id || String(orderId),
      name: order.name || "",
      amount: order.amount || 0,
      sku: (items.map(i => i.sku).filter(Boolean).join(" | ")) || (order.sku || ""),
      sizes: (items.map(i => i.size).filter(Boolean).join(", ")) || (order.sizes || ""),
      technique: (items.map(i => i.technique).filter(Boolean).join(", ")) || (order.technique || ""),
      created_at: nowISO()
    };

    await axios.post(`${SUPABASE_URL}/rest/v1/paid_order_items`, paidItem, { headers: sbHeaders });
  } catch (e) {
    console.error("Insert paid_order_items failed:", e?.response?.data || e?.message || e);
  }

  // 5) Build supplier format EXACT requested layout
  try {
    // Build SKU list numbered formatted exactly like "1.VJ90" (no extra space after dot) per your example
    const skuLines = [];
    const productLines = [];
    // If items empty but order.product present, attempt splitting again
    if (!items.length && order.product) {
      const prods = (order.product + "").split("|").map(s => s.trim()).filter(Boolean);
      const sks = (order.sku + "").split("|").map(s => s.trim()).filter(Boolean);
      const sizesArr = (order.sizes || "").split(",").map(s => s.trim()).filter(Boolean);
      const techArr = (order.technique || "").split(",").map(s => s.trim()).filter(Boolean);
      for (let i = 0; i < Math.max(prods.length, sks.length); i++) {
        skuLines.push(`${i + 1}.${(sks[i] || "-")}`); // e.g. "1.VJ90"
        const sizeTxt = (sizesArr[i] || sizesArr[0] || "").toUpperCase();
        const techTxt = (techArr[i] || "").replace(/-/g, " ");
        productLines.push(`${i + 1}. ${prods[i] || "-"} • size: ${sizeTxt} • Technique: ${techTxt}`);
      }
    } else {
      items.forEach((it, idx) => {
        skuLines.push(`${idx + 1}.${(it.sku || "-")}`); // "1.VJ90"
        const sizeFmt = (it.size || "").toString() ? ` • size: ${String(it.size).toUpperCase()}` : "";
        const techFmt = (it.technique || "").toString() ? ` • Technique: ${it.technique.replace(/-/g, " ")}` : "";
        productLines.push(`${idx + 1}. ${it.name || "-"}${sizeFmt}${techFmt}`);
      });
    }

    // Join product lines with a blank line between items (per your example)
    const supplierText =
`📦 NEW PAID ORDER

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
${skuLines.length ? skuLines.join("\n") : (order.sku || "-")}

Product:
${productLines.length ? productLines.join("\n\n") : (order.product || "-")}

Quantity: ${order.quantity || items.reduce((s, it) => s + (it.quantity || 1), 0) || 1}

Shipment Mode: Normal
`;

    // send to supplier + admin chat (safe)
    if (SUPPLIER_CHAT_ID) await safeSend(SUPPLIER_CHAT_ID, supplierText);
    // send to caller/chatId
    await safeSend(chatId, supplierText);
  } catch (e) {
    console.error("Failed to build/send supplier text:", e?.message || e);
  }

  // 6) Build today's paid list (source: paid_order_items table)
  try {
    let dayKey;
    try { dayKey = DateTime.now().setZone(TIMEZONE).toISODate(); } catch (_) { dayKey = new Date().toISOString().slice(0, 10); }

    const paidItemsRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${encodeURIComponent(dayKey)}&select=order_id,name,amount,created_at,sku,sizes,technique`,
      { headers: sbHeaders, timeout: 10000 }
    );
    const saved = paidItemsRes.data || [];

    let headerDate;
    try { headerDate = DateTime.now().setZone(TIMEZONE).toFormat("yyyy-LL-dd"); } catch (_) { headerDate = new Date().toISOString().slice(0, 10); }

    let listText = `${headerDate} orders 🌼\n\n`;
    if (!saved.length) {
      listText += "No paid orders for today yet.";
    } else {
      saved.forEach((r, idx) => {
        let dateStr = r.created_at || "";
        try { dateStr = DateTime.fromISO(r.created_at).setZone(TIMEZONE).toFormat("dd/LL/yyyy"); } catch (_) {}
        listText += `${idx + 1}. ${r.name || "-"} (${r.order_id}) ₹${r.amount || 0} | SKU: ${r.sku || "-"} | Size: ${r.sizes || "-"} | Tech: ${r.technique || "-"} — ${dateStr}\n`;
      });
    }
    await safeSend(chatId, listText);
  } catch (e) {
    console.error("Failed to build today's list:", e?.response?.data || e?.message || e);
    await safeSend(chatId, "Today's paid list couldn't be loaded from DB.");
  }

  // final confirmation
  await safeSend(chatId, `✅ Order ${orderId} marked paid.\nWooCommerce → processing (attempted)\nSupabase updated.\nCustomer thank-you will be sent automatically by AutoJS.`);
}

/* ---------------------------------------------------
   /paid command (Telegram)
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
   Other helper commands (order panel, resend_qr, track, today, paidorders)
   Keep behaviors consistent with paid_order_items as source where appropriate.
--------------------------------------------------- */

// /order (panel)
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
          [{ text: "✅ Mark Paid", callback_data: `order_paid:${o.order_id}` }, { text: "🔁 Resend QR", callback_data: `order_resend:${o.order_id}` }],
          [{ text: "📦 Track", callback_data: `order_track:${o.order_id}` }, { text: "❌ Cancel", callback_data: `order_cancel:${o.order_id}` }]
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

// /today - show today's paid orders (paid_order_items primary)
if (bot) {
  bot.onText(/\/today/i, async (msg) => {
    const chatId = msg.chat.id;
    let todayKey;
    try { todayKey = DateTime.now().setZone(TIMEZONE).toISODate(); } catch (_) { todayKey = new Date().toISOString().slice(0,10); }
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
let clearedTodayDate = null;
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
      const d = base.plus({ days: i }); row1.push({ text: d.toFormat("dd/MM"), callback_data: `paidorders:${d.toISODate()}` });
    }
    buttons.push(row1);
    buttons.push([{ text: "Today", callback_data: `paidorders:${base.toISODate()}` }]);
    const row3 = [];
    for (let i = 1; i <= 3; i++) {
      const d = base.plus({ days: i }); row3.push({ text: d.toFormat("dd/MM"), callback_data: `paidorders:${d.toISODate()}` });
    }
    buttons.push(row3);
    await bot.sendMessage(chatId, "📅 Choose a date to view paid orders:", { reply_markup: { inline_keyboard: buttons } });
  });
}

// callback handler
if (bot) {
  bot.on("callback_query", async (query) => {
    const data = query.data || "";
    const chatId = query.message?.chat?.id;
    try {
      if (data.startsWith("order_paid:")) {
        const orderId = data.split(":")[1]; await handleMarkPaid(chatId, orderId);
      } else if (data.startsWith("order_resend:")) {
        const orderId = data.split(":")[1];
        await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}`, { resend_qr_pending: true }, { headers: sbHeaders });
        await safeSend(chatId, `🔁 QR resend triggered for order ${orderId}.`);
      } else if (data.startsWith("paidorders:")) {
        const dateKey = data.split(":")[1];
        try {
          const r = await axios.get(`${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${encodeURIComponent(dateKey)}&select=order_id,name,amount,created_at,sku,sizes,technique`, { headers: sbHeaders });
          const rows = r.data || [];
          let header = `${dateKey} paid orders 🌼\n\n`;
          if (!rows.length) header += "No paid orders on this date.";
          else {
            rows.forEach((o, idx) => {
              let dateStr=o.created_at||"";
              try { dateStr = DateTime.fromISO(o.created_at).setZone(TIMEZONE).toFormat("dd/LL/yyyy"); } catch (_) {}
              header += `${idx+1}. ${o.name||""} (${o.order_id}) ₹${o.amount||0} | SKU:${o.sku||"-"} | Size:${o.sizes||"-"} | Tech:${o.technique||"-"} — ${dateStr}\n`;
            });
          }
          await safeSend(chatId, header);
        } catch (e) {
          console.error("paidorders callback error:", e?.response?.data || e?.message || e);
          await safeSend(chatId, "⚠️ Failed to fetch paid orders for that date.");
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

// If webhook mode: accept telegram webhook route
if (BASE_URL) {
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
}

/* --------------------
   Delete-today helpers (preview + confirm)
   - preview shows number of rows and a sample
   - confirm deletes paid_order_items for today and also deletes orders rows that match those order_ids
---------------------*/
async function fetchPaidItemsForDay(dayKey) {
  const r = await axios.get(`${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${encodeURIComponent(dayKey)}&select=id,order_id,name,amount,sku,created_at`, { headers: sbHeaders });
  return r.data || [];
}

if (bot) {
  // preview
  bot.onText(/\/delete_today_preview/i, async (msg) => {
    const chatId = msg.chat.id;
    let dayKey;
    try { dayKey = DateTime.now().setZone(TIMEZONE).toISODate(); } catch (_) { dayKey = new Date().toISOString().slice(0,10); }
    try {
      const rows = await fetchPaidItemsForDay(dayKey);
      if (!rows.length) return safeSend(chatId, `No paid_order_items found for today (${dayKey}).`);
      // show count + first 5 rows as sample
      let sample = rows.slice(0, 5).map((r, idx) => `${idx+1}. ${r.name} (${r.order_id}) ₹${r.amount}`).join("\n");
      await safeSend(chatId, `Preview delete for ${dayKey}:\nTotal rows: ${rows.length}\n\nSample:\n${sample}\n\nIf OK run /delete_today_confirm to delete permanently.`);
    } catch (e) {
      console.error("/delete_today_preview error:", e?.response?.data || e?.message || e);
      await safeSend(chatId, "⚠️ Failed to preview today's paid_order_items.");
    }
  });

  // confirm - perform deletion
  bot.onText(/\/delete_today_confirm/i, async (msg) => {
    const chatId = msg.chat.id;
    let dayKey;
    try { dayKey = DateTime.now().setZone(TIMEZONE).toISODate(); } catch (_) { dayKey = new Date().toISOString().slice(0,10); }
    try {
      const rows = await fetchPaidItemsForDay(dayKey);
      if (!rows.length) return safeSend(chatId, `No paid_order_items found for today (${dayKey}). Nothing to delete.`);

      // collect order_ids to also delete from orders (if present)
      const orderIds = Array.from(new Set(rows.map(r => r.order_id).filter(Boolean)));

      // 1) delete paid_order_items rows for today
      // Supabase REST supports DELETE with filter
      const delPaidUrl = `${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${encodeURIComponent(dayKey)}`;
      await axios.delete(delPaidUrl, { headers: sbHeaders });
      // 2) delete matching orders rows (best-effort) — delete orders where order_id IN (...) and paid_at is today OR status=paid
      let deletedOrdersCount = 0;
      if (orderIds.length) {
        // loop delete each order_id (safer than trying a complex REST filter)
        for (const oid of orderIds) {
          try {
            // delete from orders where order_id=oid
            await axios.delete(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(oid)}`, { headers: sbHeaders });
            deletedOrdersCount++;
          } catch (e) {
            // continue even if some deletes fail
            console.warn("Failed to delete order", oid, e?.response?.data || e?.message || e);
          }
        }
      }

      await safeSend(chatId, `✅ Deleted ${rows.length} paid_order_items rows for ${dayKey}. Deleted ${deletedOrdersCount} matching orders (attempted).`);
    } catch (e) {
      console.error("/delete_today_confirm error:", e?.response?.data || e?.message || e);
      await safeSend(chatId, "⚠️ Failed to delete today's paid_order_items.");
    }
  });
}

/* ---------------- CRON / REMINDERS (manual GET trigger) ---------------- */
app.get("/cron-check", async (req, res) => {
  try {
    const orders = await axios.get(`${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`, { headers: sbHeaders, timeout: 15000 });
    for (const o of orders.data || []) {
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

// Night summary
app.get("/night-summary", async (req, res) => {
  if (!bot || !SUPPLIER_CHAT_ID) return res.send("BOT DISABLED");
  try {
    const start = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();
    const paid = await axios.get(`${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${encodeURIComponent(start)}&select=*`, { headers: sbHeaders });
    let report = `📊 Daily Summary\nPaid Orders: ${paid.data.length}`;
    await safeSend(SUPPLIER_CHAT_ID, report);
    res.send("OK");
  } catch (e) {
    console.error("night-summary error:", e?.response?.data || e?.message || e);
    res.status(500).send("ERR");
  }
});

// ---------------- LISTEN ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));