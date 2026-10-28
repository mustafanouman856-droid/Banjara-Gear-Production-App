// Receives Shopify webhooks: "Order creation" adds the order to Pending,
// "Order cancellation" marks it cancelled so nobody makes it by mistake.
// Secrets live in Vercel Environment Variables, never in this file:
//   SHOPIFY_WEBHOOK_SECRET  - the signing secret shown in Shopify's Webhooks section
//   SUPABASE_SECRET_KEY     - the Supabase secret key (server-side only)
import crypto from "node:crypto";

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = "https://ywuldhssdqhaeqlbmpnt.supabase.co";

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

function validSignature(raw, header, secret) {
  if (!header || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function dbHeaders(key, extra = {}) {
  const h = { apikey: key, "Content-Type": "application/json", ...extra };
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`; // older JWT-style keys need this too
  return h;
}

// Shopify sends UTC timestamps; the shop works in Pakistan time
function pkDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(d);
}

export function baseNumber(order) {
  return String(order.name || order.order_number || order.id).replace(/^#/, "");
}

export function buildRows(order) {
  const base = baseNumber(order);
  const items = order.line_items || [];
  const c = order.customer || {};
  const ship = order.shipping_address || {};
  const customer =
    [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
    ship.name || order.email || "Shopify customer";

  return items.map((it, i) => {
    const props = (it.properties || []).filter((p) => p && p.name && String(p.value ?? "").trim() !== "");
    const engr = props.find((p) => /engrav/i.test(p.name));
    const others = props.filter((p) => p !== engr && !String(p.name).startsWith("_"));
    const notes = [
      ...others.map((p) => `${p.name}: ${p.value}`),
      order.note ? `Customer note: ${order.note}` : "",
    ].filter(Boolean).join("\n");
    const variant = it.variant_title && it.variant_title !== "Default Title" ? it.variant_title : "";
    return {
      order_number: items.length > 1 ? `${base}-${i + 1}` : base,
      source: "SHOPIFY",
      customer,
      order_date: pkDate(order.created_at),
      status: "pending",
      product_name: it.title || it.name || "Item",
      quantity: it.quantity || 1,
      color: variant,
      engraving_on: !!engr,
      engraving_text: engr ? String(engr.value) : "",
      notes,
      product_id: null,
      leather_type: "",
    };
  });
}

// What the customer paid for each line: price x quantity minus discounts, with shipping added to the first line.
// Shopify sends money as text like "1500.00".
export function lineAmounts(order) {
  const items = order.line_items || [];
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const shipping = num(order.total_shipping_price_set?.shop_money?.amount ?? (order.shipping_lines || []).reduce((t, l) => t + num(l.price), 0));
  return items.map((it, i) => {
    const disc = (it.discount_allocations || []).reduce((t, d) => t + num(d.amount), 0);
    const amount = Math.max(0, num(it.price) * (it.quantity || 1) - disc) + (i === 0 ? shipping : 0);
    return Math.round(amount * 100) / 100;
  });
}

// Cash on delivery or paid online? Shopify lists the payment method(s) used. Unknown stays empty (counted as COD).
export function paymentType(order) {
  const names = [...(order.payment_gateway_names || []), order.gateway || ""].map((x) => String(x));
  if (names.some((n) => /cash on delivery|\bcod\b/i.test(n))) return "cod";
  if (names.some((n) => n.trim() !== "" && !/^manual$/i.test(n.trim())) || order.financial_status === "paid") return "online";
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("POST only");

  const raw = await readRaw(req);
  if (!validSignature(raw, req.headers["x-shopify-hmac-sha256"], process.env.SHOPIFY_WEBHOOK_SECRET)) {
    return res.status(401).send("Bad signature");
  }
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) return res.status(500).send("Server not configured");

  let order;
  try { order = JSON.parse(raw.toString("utf8")); } catch (e) { return res.status(400).send("Bad JSON"); }

  const topic = String(req.headers["x-shopify-topic"] || "");

  try {
    if (topic === "orders/cancelled") {
      // Matches the order itself (1055) and its lines (1055-1, 1055-2), nothing else
      const base = baseNumber(order).replace(/[^\w-]/g, "");
      const filter = `or=(order_number.eq.${base},order_number.like.${base}-*)&cancelled_at=is.null`;
      const upd = await fetch(`${SUPABASE_URL}/rest/v1/orders?${filter}`, {
        method: "PATCH",
        headers: dbHeaders(key, { Prefer: "return=minimal" }),
        body: JSON.stringify({ cancelled_at: new Date().toISOString() }),
      });
      if (!upd.ok) {
        console.error("Cancel failed", upd.status, await upd.text());
        return res.status(500).send("Could not save cancellation"); // Shopify will retry
      }
      return res.status(200).send("OK");
    }

    const rows = buildRows(order);
    if (!rows.length) return res.status(200).send("No items");
    const amounts = lineAmounts(order);
    const amountByNumber = Object.fromEntries(rows.map((r, i) => [r.order_number, amounts[i]]));
    const payment = paymentType(order);

    // Link each item to a Product Library entry when the names match
    for (const row of rows) {
      const name = row.product_name.replace(/[*%,()\\]/g, " ").trim();
      const r = await fetch(`${SUPABASE_URL}/rest/v1/products?select=id,leather_type&name=ilike.${encodeURIComponent(name)}&limit=1`, { headers: dbHeaders(key) });
      if (r.ok) {
        const found = (await r.json())[0];
        if (found) { row.product_id = found.id; row.leather_type = found.leather_type || ""; row.product_name = ""; }
      }
    }

    // Shopify may send the same order twice; duplicates are ignored
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/orders?on_conflict=order_number&select=id,order_number`, {
      method: "POST",
      headers: dbHeaders(key, { Prefer: "resolution=ignore-duplicates,return=representation" }),
      body: JSON.stringify(rows),
    });
    if (!ins.ok) {
      console.error("Insert failed", ins.status, await ins.text());
      return res.status(500).send("Could not save order"); // Shopify will retry
    }

    // Save what each line was sold for (owner-only table). A failure here must not undo the order itself.
    try {
      const created = await ins.json();
      const fin = created
        .filter((o) => amountByNumber[o.order_number] !== undefined)
        .map((o) => ({ order_id: o.id, amount: amountByNumber[o.order_number], payment }));
      if (fin.length) {
        const f = await fetch(`${SUPABASE_URL}/rest/v1/order_finance?on_conflict=order_id`, {
          method: "POST",
          headers: dbHeaders(key, { Prefer: "resolution=ignore-duplicates,return=minimal" }),
          body: JSON.stringify(fin),
        });
        if (!f.ok) console.error("Amount save failed", f.status, await f.text());
      }
    } catch (e) { console.error("Amount save error", e); }
    return res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Error");
  }
}
