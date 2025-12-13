// index.js — VisionsJersey automation (Final clean version)
// Fixes: /today reads paid_order_items only, delete_today_confirm works,
// supplier format unchanged, no duplicate handlers.

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { DateTime } = require("luxon");

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

/* ---------------- ENV ---------------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPPLIER_CHAT_ID = process.env.SUPPLIER_CHAT_ID;
const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";
const BASE_URL = process.env.BASE_URL || null;

const WC_USER = process.env.WC_KEY || "";
const WC_PASS = process.env.WC_SECRET || "";

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.error("❌ Missing Supabase credentials.");
  process.exit(1);
}

const sbHeaders = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  "Content-Type": "application/json",
  Prefer: "return=representation"
};

/* ---------------- Telegram Init ---------------- */
let bot = null;

if (TELEGRAM_TOKEN) {
  if (BASE_URL) {
    bot = new TelegramBot(TELEGRAM_TOKEN);
    const hookUrl = `${BASE_URL.replace(/\/$/, "")}/telegram-webhook`;
    bot.setWebHook(hookUrl)
      .then(() => console.log("Webhook set:", hookUrl))
      .catch(err => console.log(err));
  } else {
    bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    bot.on("polling_error", (err) => console.log("polling_error:", err.message));
  }
} else {
  console.log("⚠️ No Telegram token.");
}

/* ---------------- Helper Functions ---------------- */
function nowISO() { return new Date().toISOString(); }

async function safeSend(chatId, msg) {
  if (!bot) return;
  try { return await bot.sendMessage(chatId, msg); }
  catch (e) { console.log("send error", e.message); }
}

/* ---------------- Health Check ---------------- */
app.get("/", (_, res) => res.send("🔥 Bot Running"));

/* ---------------- Telegram Webhook ---------------- */
app.post("/telegram-webhook", (req, res) => {
  if (!bot) return res.sendStatus(501);
  try { bot.processUpdate(req.body); res.sendStatus(200); }
  catch (e) { console.log(e); res.sendStatus(500); }
});

/* ---------------- Extract Woo Items ---------------- */
function extractItemsFromIncoming(order) {
  let items = [];

  let raw = order.items || order.line_items || order.line_items_data || [];
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = []; }
  }
  if (!Array.isArray(raw)) raw = [];

  return raw.map(it => {
    let name = it.name || "";
    let sku = it.sku || "";
    let qty = Number(it.quantity || 1);
    let size = "";
    let tech = "";

    const meta = it.meta_data || it.meta || [];
    if (Array.isArray(meta)) {
      meta.forEach(m => {
        const k = (m.key || "").toLowerCase();
        const v = (m.value || "").toString();
        if (!v) return;
        if (k.includes("size")) size = v;
        if (k.includes("technique")) tech = v;
      });
    }

    return {
      name,
      sku,
      quantity: qty,
      size,
      technique: tech
    };
  });
}

/* ---------------- Woo Webhook ---------------- */
app.post("/woocommerce-webhook", async (req, res) => {
  const order = req.body.order || req.body || {};
  if (!order.id) return res.send("NO ORDER ID");

  const items = extractItemsFromIncoming(order);
  const billing = order.billing || order.billing_address || {};

  const mapped = {
    order_id: String(order.id),
    wc_order_id: order.id,

    name:
      billing.first_name && billing.last_name
        ? `${billing.first_name} ${billing.last_name}`
        : billing.first_name || billing.name || "",

    phone: billing.phone || billing.phone_number || "",
    email: billing.email || "",

    amount: Number(order.total || 0),
    product: items.map(i => i.name).join(" | "),
    sku: items.map(i => i.sku).join(" | "),
    sizes: [...new Set(items.map(i => i.size).filter(Boolean))].join(", "),
    technique: [...new Set(items.map(i => i.technique).filter(Boolean))].join(", "),
    quantity: items.reduce((s, i) => s + (i.quantity || 1), 0),

    address: [billing.address_1, billing.address_2, billing.city]
      .filter(Boolean)
      .join(", "),
    state: billing.state || "",
    pincode: billing.postcode || billing.postal_code || "",

    status: "pending_payment",
    created_at: nowISO(),
    items: JSON.stringify(items)
  };

  try {
    const existing = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${order.id}&select=order_id`,
      { headers: sbHeaders }
    );

    if (existing.data.length) {
      console.log("ℹ️ Order already exists:", order.id);
      return res.send("ALREADY EXISTS");
    }

    await axios.post(
      `${SUPABASE_URL}/rest/v1/orders`,
      mapped,
      { headers: sbHeaders }
    );
  } catch (e) {
    console.log("insert error", e.response?.data || e.message);
  }

  res.send("OK");
});

/* ---------------- /paid ---------------- */
if (bot) {
  bot.onText(/\/paid\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const oid = match[1].trim();

    let r = await axios.get(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${oid}&select=*`, { headers: sbHeaders });
    if (!r.data.length) return safeSend(chatId, "❌ Order not found");
    const order = r.data[0];

    const items = JSON.parse(order.items || "[]");

    // Insert into paid_order_items
    const today = DateTime.now().setZone(TIMEZONE).toISODate();

    const paidRow = {
      day: today,
      order_id: order.order_id,
      name: order.name,
      amount: order.amount,
      sku: order.sku,
      sizes: order.sizes,
      technique: order.technique,
      created_at: nowISO()
    };

    await axios.post(`${SUPABASE_URL}/rest/v1/paid_order_items`, paidRow, { headers: sbHeaders });

    // Supplier format
    const skuLines = items.map((it, i) => `${i + 1}.${it.sku}`);
    const prodLines = items.map((it, i) =>
      `${i + 1}. ${it.name} • size: ${(it.size || "").toUpperCase()} • Technique: ${(it.technique || "").replace(/-/g, " ")}`
    );

    const supplierText =
`📦 NEW PAID ORDER

From:
Vision Jerseys 
+91 93279 05965

To:
Name: ${order.name}
Address: ${order.address}
State: ${order.state}
Pincode: ${order.pincode}
Phone: ${order.phone}

SKU ID:
${skuLines.join("\n")}

Product:
${prodLines.join("\n\n")}

Quantity: ${order.quantity}
Shipment Mode: Normal`;

    if (SUPPLIER_CHAT_ID) safeSend(SUPPLIER_CHAT_ID, supplierText);
    safeSend(chatId, supplierText);

    safeSend(chatId, `✅ Order ${oid} marked paid.`);
  });
}

/* ---------------- /today (READS ONLY paid_order_items) ---------------- */
if (bot) {
  bot.onText(/\/today/, async (msg) => {
    const chatId = msg.chat.id;

    let today = DateTime.now().setZone(TIMEZONE).toISODate();

    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/paid_order_items?day=eq.${today}&select=order_id,name,created_at`,
      { headers: sbHeaders }
    );

    const rows = r.data || [];
    let header = DateTime.now().setZone(TIMEZONE).toFormat("yyyy-LL-dd");

    if (!rows.length) return safeSend(chatId, `${header} orders 🌼\n\nNo paid orders for today.`);

    let out = `${header} orders 🌼\n\n`;
    rows.forEach((it, i) => {
      const d = DateTime.fromISO(it.created_at).setZone(TIMEZONE).toFormat("dd/LL/yyyy");
      out += `${i + 1}. ${it.name} (${it.order_id}) 📦  # ${d}\n`;
    });

    safeSend(chatId, out);
  });
}
/* ---------------- DELETE TODAY (FINAL WORKING VERSION) ---------------- */
if (bot) {

  // Preview today's rows based on created_at timestamp
  bot.onText(/\/delete_today_preview/, async (msg) => {
    const chatId = msg.chat.id;

    let today;
    try { today = DateTime.now().setZone(TIMEZONE).toISODate(); }
    catch (_) { today = new Date().toISOString().slice(0, 10); }

    const start = `${today}T00:00:00Z`;
    const end   = `${today}T23:59:59Z`;

    try {
      const r = await axios.get(
        `${SUPABASE_URL}/rest/v1/paid_order_items?created_at=gte.${start}&created_at=lt.${end}&select=id,order_id,name,created_at`,
        { headers: sbHeaders }
      );

      const rows = r.data || [];
      if (!rows.length)
        return safeSend(chatId, `📭 No paid orders for ${today}.`);

      let out = `Preview delete for ${today}:\n\n`;
      rows.forEach((x, i) => {
        out += `${i + 1}. ${x.name} | Order:${x.order_id}\n`;
      });

      out += `\nRun /delete_today_confirm to delete permanently.`;

      await safeSend(chatId, out);

    } catch (e) {
      console.error("delete_preview error", e?.response?.data || e);
      await safeSend(chatId, "⚠️ Could not load preview.");
    }
  });

  // Permanently delete today's rows
  bot.onText(/\/delete_today_confirm/, async (msg) => {
    const chatId = msg.chat.id;

    let today;
    try { today = DateTime.now().setZone(TIMEZONE).toISODate(); }
    catch (_) { today = new Date().toISOString().slice(0, 10); }

    const start = `${today}T00:00:00Z`;
    const end   = `${today}T23:59:59Z`;

    try {
      await axios.delete(
        `${SUPABASE_URL}/rest/v1/paid_order_items?created_at=gte.${start}&created_at=lt.${end}`,
        { headers: sbHeaders }
      );

      await safeSend(chatId, `🗑️ Cleared ALL paid orders for ${today}.\nRun /today to verify.`);

    } catch (e) {
      console.error("delete_confirm error", e?.response?.data || e);
      await safeSend(chatId, "⚠️ Delete failed.");
    }
  });

}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Running on", PORT));