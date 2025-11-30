// index.js — VisionsJersey automation (Advanced Cancel + Restore)
// 2025-11 - Updated by assistant (implements Version B cancel/restore)
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
  const pUrl = `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(
    order_id
  )}`;
  return axios.patch(pUrl, patchBody, { headers: sbHeaders });
}

// Small safe sender — uses plain text to avoid markdown parse errors
async function safeSend(chatId, text) {
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

// ---------------- WEBHOOK INSERT (Woo → Supabase) ----------------
app.post("/woocommerce-webhook", async (req, res) => {
  try {
    const order = req.body.order;
    if (!order) return res.send("NO ORDER");

    let size = "";
    let qty = 1;
    try {
      const meta = order.line_items[0]?.meta;
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
        order.line_items[0]?.quantity ||
        1;
    } catch (_) {}

    const mapped = {
      order_id: String(order.id),
      name: order.billing_address?.first_name || "",
      phone: order.billing_address?.phone || "",
      email: order.billing_address?.email || "",
      amount: Number(order.total) || 0,
      product: order.line_items[0]?.name || "",
      sku: order.line_items[0]?.sku || "",
      size,
      address: order.billing_address?.address_1 || "",
      state: order.billing_address?.state || "",
      pincode: order.billing_address?.postcode || "",
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
      tracking_sent: false,
      hidden_from_today: false,

      // previous_* fields are null by default and filled on full cancel
      previous_status: null,
      previous_paid_at: null,
      previous_amount: null,
      previous_next_message: null,
      previous_reminder_24_sent: null,
      previous_reminder_48_sent: null,
      previous_reminder_72_sent: null
    };

    await axios.post(`${SUPABASE_URL}/rest/v1/orders`, mapped, { headers: sbHeaders });

    return res.send("OK");
  } catch (err) {
    console.error("WEBHOOK ERROR:", err.response?.data || err.message);
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
- Sends supplier format
- Sends today's paid orders list

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
--------------------------------------------------- */
async function handleMarkPaid(chatId, orderId) {
  console.log("handleMarkPaid:", orderId);

  // 1) Fetch order
  const fetchRes = await axios.get(
    `${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(orderId)}&select=*`,
    { headers: sbHeaders }
  );
  if (!fetchRes.data.length) {
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
      console.error("WooCommerce update failed:", e.response?.data || e.message);
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
        hidden_from_today: false // remove any hiding when marking paid
      },
      { headers: sbHeaders }
    );
  } catch (e) {
    console.error("Supabase patch (paid) failed:", e.response?.data || e.message);
    // continue
  }

  // 4) Send supplier format (plain text)
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
SKU ID: ${order.sku || ""}

Product: ${order.product || ""}
Size: ${order.size || ""}
Quantity: ${order.quantity || ""}

Shipment Mode: Normal`;

  // send to supplier + admin chat
  try {
    if (SUPPLIER_CHAT_ID) await safeSend(SUPPLIER_CHAT_ID, supplierText);
    await safeSend(chatId, supplierText);
  } catch (e) {
    console.error("failed to send supplier message:", e.response?.data || e.message);
  }

  // 5) Build today's paid list and send (date formatted)
  let startOfTodayISO;
  try {
    const start = DateTime.now().setZone(TIMEZONE).startOf("day");
    startOfTodayISO = start.toUTC().toISO();
  } catch (_) {
    startOfTodayISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }

  let paidRows = [];
  try {
    const paidRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${encodeURIComponent(startOfTodayISO)}&select=order_id,name,amount,paid_at,hidden_from_today`,
      { headers: sbHeaders }
    );
    paidRows = paidRes.data || [];
    // exclude hidden_from_today ones
    paidRows = paidRows.filter((r) => !r.hidden_from_today);
  } catch (e) {
    console.error("failed to fetch paidRows:", e.response?.data || e.message);
  }

  let headerDate;
  try {
    headerDate = DateTime.now().setZone(TIMEZONE).toFormat("yyyy-LL-dd");
  } catch (_) {
    headerDate = new Date().toISOString().slice(0, 10);
  }

  let listText = `${headerDate} orders 🌼\n\n`;
  if (!paidRows.length) {
    listText += "No paid orders for today yet.";
  } else {
    paidRows.forEach((r, idx) => {
      let dateStr = r.paid_at || "";
      try {
        dateStr = DateTime.fromISO(r.paid_at).setZone(TIMEZONE).toFormat("dd/LL/yyyy");
      } catch (_) {}
      listText += `${idx + 1}. ${r.name || "-"} (${r.order_id}) 📦 # ${dateStr}\n`;
    });
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
    const orderId = match[1]?.trim();
    if (!orderId) return safeSend(chatId, "❌ Use: /paid <order_id>");

    try {
      await handleMarkPaid(chatId, orderId);
    } catch (err) {
      console.error("/paid error:", err.response?.data || err.message || err);
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
    const orderId = match[1]?.trim();
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
      console.error("/order error:", e.response?.data || e.message);
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
    const id = match[1]?.trim();
    if (!id) return safeSend(chatId, "Usage: /resend_qr <order_id>");

    try {
      await axios.patch(`${SUPABASE_URL}/rest/v1/orders?order_id=eq.${encodeURIComponent(id)}`, { resend_qr_pending: true }, { headers: sbHeaders });
      await safeSend(chatId, `🔁 QR resend triggered for order ${id}.`);
    } catch (e) {
      console.error("/resend_qr error:", e.response?.data || e.message);
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
      console.error("/track error:", e.response?.data || e.message);
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
      const resp = await axios.get(`${SUPABASE_URL}/rest/v1/orders?created_at=gte.${encodeURIComponent(start)}&select=order_id,name,phone,amount,status`, { headers: sbHeaders });
      const rows = resp.data || [];
      if (!rows.length) return safeSend(chatId, "📭 No orders today.");
      let txt = "📄 Today Orders:\n\n";
      rows.forEach((o) => {
        txt += `• ${o.order_id} | ${o.name || ""} | ₹${o.amount || 0} | ${o.status || ""}\n`;
      });
      await safeSend(chatId, txt);
    } catch (e) {
      console.error("/export_today error:", e.response?.data || e.message);
      await safeSend(chatId, "⚠️ Failed to export today's orders.");
    }
  });
}

/* ---------------------------------------------------
   /today
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
      const start = DateTime.now().setZone(TIMEZONE).startOf("day").toUTC().toISO();
      const r = await axios.get(`${SUPABASE_URL}/rest/v1/orders?paid_at=gte.${encodeURIComponent(start)}&status=eq.paid&select=order_id,name,amount,hidden_from_today`, { headers: sbHeaders });
      const rows = (r.data || []).filter((x) => !x.hidden_from_today);
      if (!rows.length) return safeSend(chatId, "📭 No paid orders yet today.");
      let text = "📅 Today’s Paid Orders\n\n";
      rows.forEach((o) => { text += `• ${o.order_id} | ${o.name || ""} | ₹${o.amount || 0}\n`; });
      await safeSend(chatId, text);
    } catch (e) {
      console.error("/today error:", e.response?.data || e.message);
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
   /paidorders
   - shows date buttons D-3..D+3
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
--------------------------------------------------- */
if (bot) {
  bot.on("callback_query", async (query) => {
    const data = query.data || "";
    const chatId = query.message.chat.id;
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
              console.error("Woo cancel failed:", e.response?.data || e.message);
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
              console.error("Woo restore failed:", e.response?.data || e.message);
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

        const r = await axios.get(`${SUPABASE_URL}/rest/v1/orders?status=eq.paid&paid_at=gte.${encodeURIComponent(start)}&paid_at=lt.${encodeURIComponent(end)}&select=order_id,name,amount,paid_at,hidden_from_today`, { headers: sbHeaders });
        let rows = r.data || [];
        rows = rows.filter((x) => !x.hidden_from_today);

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
      } else {
        // unknown callback - ack
        await bot.answerCallbackQuery(query.id, { text: "Action received" });
      }
    } catch (e) {
      console.error("callback_query error:", e.response?.data || e.message || e);
      try { await safeSend(chatId, "⚠️ Error handling button action."); } catch (_) {}
    } finally {
      try { await bot.answerCallbackQuery(query.id); } catch (_) {}
    }
  });
}

/* ---------------------------------------------------
   CRON / REMINDERS
--------------------------------------------------- */
app.get("/cron-check", async (req, res) => {
  try {
    const orders = await axios.get(`${SUPABASE_URL}/rest/v1/orders?status=eq.pending_payment&select=*`, { headers: sbHeaders });
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
    console.error("CRON-CHECK error:", err.response?.data || err.message || err);
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
