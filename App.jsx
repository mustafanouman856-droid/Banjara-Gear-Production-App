import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  Home, Clock, Factory, CheckCircle2, Truck, PackageCheck, Boxes, User, LogOut,
  Settings as SettingsIcon, Users, Plus, X, ChevronRight, ChevronLeft, Search,
  AlertTriangle, Zap, Image as ImageIcon, Edit2, Archive, ShoppingBag, Tag,
  Calendar, MapPin, ClipboardList, Check, ArrowLeft, Eye, EyeOff, Loader2, Printer, Calculator
} from "lucide-react";

/* ----------------------------- Supabase connection ----------------------------- */
const SUPABASE_URL = "https://ywuldhssdqhaeqlbmpnt.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_qRjtWKM6isqxwe5hECExpQ_PjSF4OrO";
const REFRESH_KEY = "banjara_refresh_token";
const PHOTO_BUCKET = "product-photos";

// Current login session, held in memory. The refresh token is also kept in the
// browser so staff stay signed in after closing the tab.
let session = null; // { accessToken, refreshToken }

function saveRefreshToken(token) {
  try { localStorage.setItem(REFRESH_KEY, token); } catch (e) { /* ignore */ }
}
function clearRefreshToken() {
  try { localStorage.removeItem(REFRESH_KEY); } catch (e) { /* ignore */ }
}

function setSessionFromAuth(data) {
  session = { accessToken: data.access_token, refreshToken: data.refresh_token };
  saveRefreshToken(data.refresh_token);
}

const OFFLINE_MESSAGE = "Can't reach the server. Check your internet connection and try again.";
async function safeFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (e) {
    throw new Error(OFFLINE_MESSAGE);
  }
}

async function refreshSession() {
  if (!session?.refreshToken) throw new Error("Not signed in.");
  const res = await safeFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) {
    session = null;
    clearRefreshToken();
    throw new Error("Your session expired. Please sign in again.");
  }
  setSessionFromAuth(data);
  return data;
}

// Every request after login goes through here. If the login has expired it
// renews it once and retries.
async function authedFetch(url, options = {}, retry = true) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.accessToken}`,
    ...(options.headers || {}),
  };
  const res = await safeFetch(url, { ...options, headers });
  if (res.status === 401 && retry) {
    await refreshSession();
    return authedFetch(url, options, false);
  }
  return res;
}

async function loadUserWithProfile(authUser) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${authUser.id}&select=name,role`);
  const profiles = await res.json();
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  return {
    id: authUser.id,
    email: authUser.email,
    name: profile?.name || authUser.email,
    role: profile?.role || "production",
  };
}

async function supabaseSignIn(email, password) {
  const res = await safeFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.msg || "Incorrect email or password.");
  }
  setSessionFromAuth(data);
  return loadUserWithProfile(data.user);
}

// Called when the app opens: if this browser was signed in before, resume.
async function restoreSession() {
  let token = null;
  try { token = localStorage.getItem(REFRESH_KEY); } catch (e) { /* ignore */ }
  if (!token) return null;
  session = { accessToken: null, refreshToken: token };
  try {
    const data = await refreshSession();
    return await loadUserWithProfile(data.user);
  } catch (e) {
    return null;
  }
}

async function supabaseSignOut() {
  const token = session?.accessToken;
  session = null;
  clearRefreshToken();
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
  } catch (e) { /* non-blocking */ }
}

async function fetchProfiles() {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/profiles?select=id,name,role&order=name`);
  if (!res.ok) return [];
  return res.json();
}

/* ----------------------------- Product data ----------------------------- */
function mapProduct(row) {
  return {
    id: row.id,
    name: row.name,
    leatherType: row.leather_type || "",
    colors: row.colors || [],
    engravingAvailable: row.engraving_available !== false,
    instructions: row.instructions || "",
    archived: !!row.archived,
    photos: (row.product_photos || [])
      .slice()
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
      .map((p) => ({ id: p.id, url: p.url, label: p.label || "" })),
  };
}

async function readError(res, fallback) {
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  const msg = (body && (body.message || body.error)) || "";
  if ((body && body.code === "23505") || /duplicate key/i.test(msg)) return "That order number already exists.";
  if (/row-level security/i.test(msg) || res.status === 403) return "You don't have permission to do that.";
  return msg || fallback;
}

async function loadProducts() {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/products?select=*,product_photos(*)&order=name`);
  if (!res.ok) throw new Error(await readError(res, "Couldn't load products."));
  const rows = await res.json();
  return rows.map(mapProduct);
}

// Shrinks a photo to at most 1200px on its longest side before uploading, so
// pages stay fast on phones.
async function compressImage(file, maxSize = 1200, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process that photo."))), "image/jpeg", quality)
  );
}

async function uploadProductPhoto(productId, file) {
  return uploadPhoto(productId, file);
}

async function uploadPhoto(folder, file) {
  const blob = await compressImage(file);
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const res = await authedFetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  if (!res.ok) throw new Error(await readError(res, "Photo upload failed."));
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`;
}

async function deletePhotoFile(url) {
  const marker = `/${PHOTO_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return;
  const path = url.slice(idx + marker.length);
  try {
    await authedFetch(`${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`, { method: "DELETE" });
  } catch (e) { /* best effort */ }
}

async function saveProduct({ id, fields, removedPhotos, newPhotos, existingCount }) {
  const body = {
    name: fields.name,
    leather_type: fields.leatherType,
    colors: fields.colors,
    engraving_available: fields.engravingAvailable,
    instructions: fields.instructions,
  };
  let productId = id;
  if (id) {
    const res = await authedFetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await readError(res, "Couldn't save the product."));
  } else {
    const res = await authedFetch(`${SUPABASE_URL}/rest/v1/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await readError(res, "Couldn't create the product."));
    const rows = await res.json();
    productId = rows[0].id;
  }

  for (const photo of removedPhotos) {
    const res = await authedFetch(`${SUPABASE_URL}/rest/v1/product_photos?id=eq.${photo.id}`, { method: "DELETE" });
    if (res.ok) deletePhotoFile(photo.url);
  }

  let order = existingCount;
  for (const np of newPhotos) {
    const url = await uploadProductPhoto(productId, np.file);
    const res = await authedFetch(`${SUPABASE_URL}/rest/v1/product_photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: productId, url, label: np.label, sort_order: order++ }),
    });
    if (!res.ok) throw new Error(await readError(res, "Couldn't attach a photo."));
  }
  return productId;
}

async function setProductArchived(id, archived) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't update the product."));
}

/* ----------------------------- Order data ----------------------------- */
const ORDER_COLUMNS = "id,order_number,source,customer,order_date,due_date,expected_delivery,status,product_id,product_name,quantity,color,leather_type,engraving_on,engraving_text,notes,created_at,cancelled_at,channel,held_at,hold_reason,production_started_at";
const ACTIVE_STATUSES = "pending,production,completed,dispatched";
const DELIVERED_PAGE = 30;

function mapOrder(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    source: row.source,
    customer: row.customer || "",
    orderDate: row.order_date,
    dueDate: row.due_date || null,
    expectedDelivery: row.expected_delivery || null,
    status: row.status,
    productId: row.product_id || null,
    productName: row.product_name || "",
    quantity: row.quantity || 1,
    color: row.color || "",
    leatherType: row.leather_type || "",
    engraving: { on: !!row.engraving_on, text: row.engraving_text || "" },
    notes: row.notes || "",
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at || null,
    channel: row.channel || "",
    heldAt: row.held_at || null,
    holdReason: row.hold_reason || "",
    startedAt: row.production_started_at || null,
  };
}

function orderToRow(f) {
  const row = {};
  if ("orderNumber" in f) row.order_number = f.orderNumber;
  if ("customer" in f) row.customer = f.customer;
  if ("orderDate" in f) row.order_date = f.orderDate;
  if ("dueDate" in f) row.due_date = f.dueDate || null;
  if ("expectedDelivery" in f) row.expected_delivery = f.expectedDelivery || null;
  if ("productId" in f) row.product_id = f.productId || null;
  if ("productName" in f) row.product_name = f.productName;
  if ("quantity" in f) row.quantity = Number(f.quantity) || 1;
  if ("color" in f) row.color = f.color;
  if ("leatherType" in f) row.leather_type = f.leatherType;
  if ("engravingOn" in f) row.engraving_on = !!f.engravingOn;
  if ("engravingText" in f) row.engraving_text = f.engravingOn === false ? "" : f.engravingText;
  if ("notes" in f) row.notes = f.notes;
  if ("channel" in f) row.channel = f.channel || null;
  return row;
}

async function loadActiveOrders() {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/orders?select=${ORDER_COLUMNS}&status=in.(${ACTIVE_STATUSES})&order=created_at.asc&limit=500`);
  if (!res.ok) throw new Error(await readError(res, "Couldn't load orders."));
  return (await res.json()).map(mapOrder);
}

// Delivered orders pile up over time, so they're fetched a page at a time
async function loadDeliveredOrders({ offset = 0, query = "" } = {}) {
  const clean = query.trim().replace(/[,()*%\\"]/g, " ").trim();
  const term = encodeURIComponent(clean);
  const search = clean ? `&or=(order_number.ilike.*${term}*,customer.ilike.*${term}*)` : "";
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/orders?select=${ORDER_COLUMNS}&status=eq.delivered${search}&order=created_at.desc&limit=${DELIVERED_PAGE + 1}&offset=${offset}`);
  if (!res.ok) throw new Error(await readError(res, "Couldn't load delivered orders."));
  const rows = await res.json();
  return { orders: rows.slice(0, DELIVERED_PAGE).map(mapOrder), hasMore: rows.length > DELIVERED_PAGE };
}

async function loadStats() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/rpc/dashboard_stats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ since: since.toISOString() }),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't load the dashboard numbers."));
  return res.json();
}

async function loadSettings() {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/settings?id=eq.1&select=production_days,courier_days,working_days`);
  if (!res.ok) throw new Error(await readError(res, "Couldn't load settings."));
  const rows = await res.json();
  if (!rows[0]) return null;
  return { productionDays: rows[0].production_days, courierDays: rows[0].courier_days, workingDays: rows[0].working_days };
}

async function saveSettings(s) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/settings?id=eq.1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ production_days: s.productionDays, courier_days: s.courierDays, working_days: s.workingDays }),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't save settings."));
  const rows = await res.json();
  if (!rows.length) throw new Error("You don't have permission to change settings.");
  return { productionDays: rows[0].production_days, courierDays: rows[0].courier_days, workingDays: rows[0].working_days };
}

// History and extra photos are only fetched when an order is opened
/* ----------------------------- Money (owner only) ----------------------------- */
// All of this lives in owner-only database tables; production's logins are refused by the database itself.
async function financeRpc(name, args) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't load the money numbers."));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const fetchRangeFinance = (from, to, by) => financeRpc("range_finance", { p_from: from, p_to: to, p_by: by });
const setOrderReturned = (orderId, returned) => financeRpc("set_order_returned", { p_order: orderId, p_returned: returned });

async function financeGet(path, fallback) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/${path}`);
  if (!res.ok) throw new Error(await readError(res, fallback));
  return res.json();
}
async function financeUpsert(table, conflict, body, fallback) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflict}`, {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, fallback));
}
const fetchProductFinance = () => financeGet("product_finance?select=product_id,sell_price,cost", "Couldn't load product prices.");
const saveProductFinance = (productId, patch) => financeUpsert("product_finance", "product_id", { product_id: productId, ...patch }, "Couldn't save that price.");
const saveOrderAmount = (orderId, amount) => financeUpsert("order_finance", "order_id", { order_id: orderId, amount }, "Couldn't save that amount.");
const saveAdTotal = (from, to, amount) => financeUpsert("ad_totals", "from_date,to_date", { from_date: from, to_date: to, amount }, "Couldn't save ad spend.");
const saveOrderPayment = (orderId, payment) => financeUpsert("order_finance", "order_id", { order_id: orderId, payment }, "Couldn't save how it was paid.");
const fetchOrderFinance = async (orderId) => { const r = await financeGet(`order_finance?order_id=eq.${orderId}&select=amount,returned_at`, "Couldn't load order money."); return r[0] || null; };
async function saveLeopardsPct(pct) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/finance_settings?id=eq.1`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ leopards_pct: pct }),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't save the percentage."));
}

async function loadOrderExtras(orderId) {
  const [h, p] = await Promise.all([
    authedFetch(`${SUPABASE_URL}/rest/v1/order_history?order_id=eq.${orderId}&select=event,by_name,created_at&order=created_at.asc`),
    authedFetch(`${SUPABASE_URL}/rest/v1/order_photos?order_id=eq.${orderId}&select=id,url,label&order=created_at.asc`),
  ]);
  if (!h.ok) throw new Error(await readError(h, "Couldn't load the order history."));
  const history = (await h.json()).map((r) => ({ event: r.event, by: r.by_name || "", at: r.created_at }));
  const photos = p.ok ? await p.json() : [];
  return { history, photos };
}

// Only succeeds if the order is still in the status the person saw. If someone
// else moved it first, nothing changes and we say so.
async function advanceOrderStatus(orderId, fromStatus, toStatus) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&status=eq.${fromStatus}&select=${ORDER_COLUMNS}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ status: toStatus }),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't update the order."));
  const rows = await res.json();
  if (!rows.length) {
    const err = new Error("Someone else already updated this order. The list has been refreshed.");
    err.code = "CONFLICT";
    throw err;
  }
  return mapOrder(rows[0]);
}

// Put an order on hold (with a reason) or take it off hold. Only works while it is in production.
async function setOrderHold(orderId, reason) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&status=eq.production&select=${ORDER_COLUMNS}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(reason ? { held_at: new Date().toISOString(), hold_reason: reason } : { held_at: null, hold_reason: null }),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't update the order."));
  const rows = await res.json();
  if (!rows.length) {
    const err = new Error("This order is no longer in production. The list has been refreshed.");
    err.code = "CONFLICT";
    throw err;
  }
  return mapOrder(rows[0]);
}

async function createOrderRecord(fields) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/orders?select=${ORDER_COLUMNS}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ ...orderToRow(fields), source: "CUSTOM", status: "pending" }),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't create the order."));
  const rows = await res.json();
  return mapOrder(rows[0]);
}

async function updateOrderDetails(orderId, fields) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}&select=${ORDER_COLUMNS}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(orderToRow(fields)),
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't save the changes."));
  const rows = await res.json();
  if (!rows.length) throw new Error("You don't have permission to edit this order.");
  return mapOrder(rows[0]);
}

async function deleteOrderRecord(orderId, photos = []) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/orders?id=eq.${orderId}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  if (!res.ok) throw new Error(await readError(res, "Couldn't delete the order."));
  const rows = await res.json();
  if (!rows.length) throw new Error("You don't have permission to delete this order.");
  photos.forEach((p) => deletePhotoFile(p.url));
}

async function addOrderPhotos(orderId, files) {
  const added = [];
  for (const f of files) {
    const url = await uploadPhoto(`orders/${orderId}`, f.file);
    const res = await authedFetch(`${SUPABASE_URL}/rest/v1/order_photos?select=id,url,label`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ order_id: orderId, url, label: f.label || "" }),
    });
    if (!res.ok) throw new Error(await readError(res, "Couldn't attach a photo."));
    added.push((await res.json())[0]);
  }
  return added;
}

async function removeOrderPhoto(photo) {
  const res = await authedFetch(`${SUPABASE_URL}/rest/v1/order_photos?id=eq.${photo.id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await readError(res, "Couldn't remove the photo."));
  deletePhotoFile(photo.url);
}

/* ----------------------------- Design tokens ----------------------------- */
const TOKENS = {
  ink: "#241C15",
  hide: "#F4EEE3",
  paper: "#FBF8F2",
  saddle: "#A35A2A",
  saddleDark: "#7E4420",
  line: "#E4D9C6",
  status: {
    pending:    { bg: "#FBEBD3", fg: "#8A5A16", dot: "#D89A3E" },
    production: { bg: "#DCE7F0", fg: "#2B5578", dot: "#4C7EA8" },
    completed:  { bg: "#DDEBDE", fg: "#2E6B3E", dot: "#54935F" },
    dispatched: { bg: "#E5DEF0", fg: "#5B3E8A", dot: "#8467B8" },
    delivered:  { bg: "#D9EDE7", fg: "#1F6C5A", dot: "#3F9C86" },
  },
};

/* ----------------------------- Dates & settings ----------------------------- */
// Dates are plain calendar days ("2026-10-15"), handled in local time so a late-night
// order never lands on the wrong day.
const pad2 = (n) => String(n).padStart(2, "0");
const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayISO = () => toISODate(new Date());
const parseDate = (str) => {
  const [y, m, d] = String(str).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 12);
};
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmt = (str) => {
  if (!str) return "—";
  return parseDate(str).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const dayName = (str) => (str ? DOW_NAMES[parseDate(str).getDay()] : "");
const fmtDateTime = (iso) => {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

// Working-day maths for estimates shown on the screen (the database does the real due dates)
const addWorkingDaysISO = (startISO, n, days) => {
  const d = parseDate(startISO);
  if (!days || !days.length) { d.setDate(d.getDate() + n); return toISODate(d); }
  let added = 0, guard = 0;
  while (added < n && guard < 1000) {
    d.setDate(d.getDate() + 1);
    guard += 1;
    if (days.includes(d.getDay())) added += 1;
  }
  return toISODate(d);
};
const hoursSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 36e5)) : 0);
const waitLabel = (h) => (h < 48 ? `${h}h` : `${Math.floor(h / 24)}d ${h % 24}h`);
const WAIT_WARN_HOURS = 24;
const WAIT_LATE_HOURS = 48;
const DEFAULT_SETTINGS = { productionDays: 3, courierDays: 3, workingDays: [1, 2, 3, 4, 5, 6] }; // Mon-Sat

const STATUS_META = {
  pending:    { label: "New orders", icon: Clock,        nav: "New orders" },
  production: { label: "Production", icon: Factory,      nav: "Production" },
  completed:  { label: "Completed",  icon: CheckCircle2, nav: "Completed" },
  dispatched: { label: "Dispatched", icon: Truck,         nav: "Dispatched" },
  delivered:  { label: "Delivered",  icon: PackageCheck,  nav: "Delivered" },
};

/* ----------------------------- Small UI atoms ----------------------------- */
function Badge({ status }) {
  const s = TOKENS.status[status];
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ backgroundColor: s.bg, color: s.fg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.dot }} />
      {meta.label}
    </span>
  );
}

function SourceTag({ source }) {
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide"
      style={{
        backgroundColor: source === "SHOPIFY" ? "#EAF1EC" : "#F1EAE0",
        color: source === "SHOPIFY" ? "#3D7A52" : "#8A5A2E",
      }}
    >
      {source}
    </span>
  );
}

function EngravingTag({ engraving }) {
  if (!engraving?.on) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ backgroundColor: "#FBEAD3", color: "#9A5A12" }}>
      <Zap size={10} strokeWidth={2.5} /> ENGRAVE
    </span>
  );
}

function Avatar({ name, size = 28 }) {
  const initials = name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div
      className="flex items-center justify-center rounded-full font-bold text-white shrink-0"
      style={{ width: size, height: size, backgroundColor: TOKENS.saddle, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}

/* ----------------------------- Login screen ----------------------------- */
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setError("");
    try {
      const user = await supabaseSignIn(email.trim(), password);
      onLogin(user);
    } catch (err) {
      setError(err.message || "Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-5" style={{ backgroundColor: TOKENS.ink }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ backgroundColor: TOKENS.saddle }}>
            <Boxes className="text-white" size={26} />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Banjara Gear</h1>
          <p className="text-sm mt-1" style={{ color: "#C9BCA8" }}>Production Console</p>
        </div>
        <div className="rounded-2xl p-5" style={{ backgroundColor: TOKENS.paper }}>
          <p className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: "#8A7B65" }}>Sign in</p>

          <label className="block mb-3">
            <span className="block text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: "#8A7B65" }}>Email</span>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@banjaragear.com"
              className="w-full rounded-xl border px-3 py-2.5 text-sm outline-none"
              style={{ borderColor: TOKENS.line, backgroundColor: "white", color: TOKENS.ink }}
            />
          </label>

          <label className="block mb-4">
            <span className="block text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: "#8A7B65" }}>Password</span>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(e); }}
                placeholder="••••••••"
                className="w-full rounded-xl border px-3 py-2.5 pr-10 text-sm outline-none"
                style={{ borderColor: TOKENS.line, backgroundColor: "white", color: TOKENS.ink }}
              />
              <button type="button" onClick={() => setShowPassword((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2">
                {showPassword ? <EyeOff size={16} style={{ color: "#A8977F" }} /> : <Eye size={16} style={{ color: "#A8977F" }} />}
              </button>
            </div>
          </label>

          {error && (
            <div className="mb-4 rounded-lg px-3 py-2 text-xs font-medium" style={{ backgroundColor: "#FBEAE5", color: "#B23A22" }}>
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={!email || !password || loading}
            className="w-full flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white transition disabled:opacity-40"
            style={{ backgroundColor: TOKENS.saddle }}
          >
            {loading ? <><Loader2 size={16} className="animate-spin" /> Signing in…</> : "Sign in"}
          </button>
          <p className="mt-3 text-center text-[11px]" style={{ color: "#A8977F" }}>Production access only. Contact the owner if you need an account.</p>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Navigation ----------------------------- */
const NAV_ITEMS = [
  { key: "dashboard", label: "Dashboard", icon: Home, roles: ["owner", "production"] },
  { key: "pending", label: "New orders", icon: Clock, roles: ["owner", "production"] },
  { key: "production", label: "Production", icon: Factory, roles: ["owner", "production"] },
  { key: "completed", label: "Completed", icon: CheckCircle2, roles: ["owner", "production"] },
  { key: "dispatched", label: "Dispatched", icon: Truck, roles: ["owner", "production"] },
  { key: "delivered", label: "Delivered", icon: PackageCheck, roles: ["owner", "production"] },
  { key: "print", label: "Print list", icon: Printer, roles: ["owner", "production"] },
  { key: "products", label: "Products", icon: Boxes, roles: ["owner", "production"] },
  { key: "finance", label: "Finance", icon: Calculator, roles: ["owner"] },
  { key: "members", label: "Members", icon: Users, roles: ["owner"] },
  { key: "settings", label: "Settings", icon: SettingsIcon, roles: ["owner"] },
  { key: "account", label: "Account", icon: User, roles: ["owner", "production"] },
];
const MOBILE_KEYS = ["dashboard", "pending", "production", "completed", "more"];

function SidebarNav({ page, setPage, user, onLogout }) {
  const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role));
  return (
    <div className="hidden md:flex md:w-60 md:flex-col md:shrink-0 border-r" style={{ borderColor: TOKENS.line, backgroundColor: TOKENS.ink }}>
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ backgroundColor: TOKENS.saddle }}>
          <Boxes className="text-white" size={18} />
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-tight">Banjara Gear</p>
          <p className="text-[11px]" style={{ color: "#A8977F" }}>Production</p>
        </div>
      </div>
      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        {items.map((it) => {
          const Icon = it.icon;
          const active = page === it.key;
          return (
            <button
              key={it.key}
              onClick={() => setPage(it.key)}
              className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition"
              style={{
                backgroundColor: active ? "rgba(163,90,42,0.25)" : "transparent",
                color: active ? "#F0DCC4" : "#C9BCA8",
              }}
            >
              <Icon size={17} />
              {it.label}
            </button>
          );
        })}
      </nav>
      <div className="px-3 py-4 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
        <div className="flex items-center gap-2.5 px-2 mb-2">
          <Avatar name={user.name} size={30} />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white truncate">{user.name}</p>
            <p className="text-[11px] capitalize" style={{ color: "#A8977F" }}>{user.role}</p>
          </div>
        </div>
        <button onClick={onLogout} className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium" style={{ color: "#C9BCA8" }}>
          <LogOut size={14} /> Log out
        </button>
      </div>
    </div>
  );
}

function MobileTopBar({ user, onLogout }) {
  return (
    <div className="md:hidden flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: TOKENS.line, backgroundColor: TOKENS.paper }}>
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: TOKENS.saddle }}>
          <Boxes className="text-white" size={14} />
        </div>
        <p className="text-sm font-bold" style={{ color: TOKENS.ink }}>Banjara Gear</p>
      </div>
      <button onClick={onLogout}><LogOut size={17} style={{ color: "#8A7B65" }} /></button>
    </div>
  );
}

function MobileBottomNav({ page, setPage, user, moreOpen, setMoreOpen }) {
  const iconFor = { dashboard: Home, pending: Clock, production: Factory, completed: CheckCircle2, more: ChevronRight };
  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 border-t flex" style={{ borderColor: TOKENS.line, backgroundColor: "white" }}>
      {MOBILE_KEYS.map((k) => {
        const Icon = iconFor[k];
        const active = k === "more" ? moreOpen : page === k && !moreOpen;
        const label = k === "more" ? "More" : NAV_ITEMS.find((i) => i.key === k).label;
        return (
          <button
            key={k}
            onClick={() => (k === "more" ? setMoreOpen(true) : (setMoreOpen(false), setPage(k)))}
            className="flex-1 flex flex-col items-center gap-0.5 py-2.5"
            style={{ color: active ? TOKENS.saddle : "#A8977F" }}
          >
            <Icon size={19} />
            <span className="text-[10px] font-medium">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function MoreSheet({ open, onClose, page, setPage, user }) {
  if (!open) return null;
  const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role) && !MOBILE_KEYS.includes(i.key));
  return (
    <div className="md:hidden fixed inset-0 z-40 flex items-end" style={{ backgroundColor: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <div className="w-full rounded-t-2xl p-4 pb-8" style={{ backgroundColor: "white" }} onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full" style={{ backgroundColor: TOKENS.line }} />
        <div className="grid grid-cols-3 gap-2">
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <button key={it.key} onClick={() => { setPage(it.key); onClose(); }} className="flex flex-col items-center gap-1.5 rounded-xl py-3" style={{ backgroundColor: page === it.key ? TOKENS.hide : "transparent" }}>
                <Icon size={20} style={{ color: TOKENS.saddle }} />
                <span className="text-xs font-medium" style={{ color: TOKENS.ink }}>{it.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Order actions ----------------------------- */
const ORDER_ACTIONS = {
  start: {
    to: "production", ownerOnly: false, button: "Start Production", rowLabel: "Start Production",
    confirm: (n) => `Start production on #${n}?`, question: "This moves the order out of New orders and into the Production queue now.",
    tone: TOKENS.status.production.fg,
  },
  complete: {
    to: "completed", ownerOnly: false, button: "Mark as Completed", rowLabel: "Mark Completed",
    confirm: (n) => `Complete Order #${n}?`, question: "Are you sure this order has been completed?",
    tone: TOKENS.status.completed.fg,
  },
  dispatch: {
    to: "dispatched", ownerOnly: true, button: "Mark as Dispatched", rowLabel: "Mark Dispatched",
    confirm: (n) => `Dispatch Order #${n}?`, question: "Confirm this order has left for the courier.",
    tone: TOKENS.status.dispatched.fg,
  },
  deliver: {
    to: "delivered", ownerOnly: true, button: "Mark as Delivered", rowLabel: "Mark Delivered",
    confirm: (n) => `Mark Order #${n} delivered?`, question: "Confirm this order has reached the customer.",
    tone: TOKENS.status.delivered.fg,
  },
};
const nextActionKey = (status) => ({ pending: "start", production: "complete", completed: "dispatch", dispatched: "deliver" })[status] || null;
const canDoAction = (key, role) => !!key && (!ORDER_ACTIONS[key].ownerOnly || role === "owner");

/* ----------------------------- Dashboard ----------------------------- */
function Dashboard({ orders, stats, setPage, settings, user }) {
  const today = todayISO();
  const n = (k) => (stats ? stats[k] : "–");

  const overdue = orders.filter((o) => o.status === "production" && o.dueDate && o.dueDate < today).length;
  const dueToday = orders.filter((o) => o.status === "production" && o.dueDate === today).length;
  const waitingLong = orders.filter((o) => o.status === "pending" && !o.cancelledAt && hoursSince(o.createdAt) >= WAIT_WARN_HOURS).length;
  const heldOrders = orders.filter((o) => o.status === "production" && o.heldAt && !o.cancelledAt).length;
  const cancelledOrders = orders.filter((o) => o.cancelledAt && o.status !== "delivered").length;
  const engravingOrders = orders.filter((o) => o.engraving.on && (o.status === "pending" || o.status === "production")).length;

  const cards = [
    { key: "pending", label: "New orders", icon: Clock },
    { key: "production", label: "Production", icon: Factory },
    { key: "completed", label: "Completed", icon: CheckCircle2 },
    { key: "dispatched", label: "Dispatched", icon: Truck },
    { key: "delivered", label: "Delivered", icon: PackageCheck },
  ];

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <h1 className="text-xl md:text-2xl font-bold" style={{ color: TOKENS.ink }}>Welcome back, {user.name.split(" ")[0]}</h1>
      <p className="text-sm mt-1" style={{ color: "#8A7B65" }}>Here's where every order stands today.</p>

      <div className="mt-5 grid grid-cols-2 md:grid-cols-5 gap-3">
        {cards.map((c) => {
          const s = TOKENS.status[c.key];
          const Icon = c.icon;
          return (
            <button key={c.key} onClick={() => setPage(c.key)} className="rounded-2xl p-4 text-left transition hover:-translate-y-0.5" style={{ backgroundColor: s.bg }}>
              <Icon size={18} style={{ color: s.fg }} />
              <p className="mt-3 text-2xl font-bold" style={{ color: s.fg }}>{n(c.key)}</p>
              <p className="text-xs font-semibold" style={{ color: s.fg }}>{c.label}</p>
            </button>
          );
        })}
      </div>

      <div className="mt-6 grid md:grid-cols-2 gap-3">
        <div className="rounded-2xl border p-4" style={{ borderColor: TOKENS.line }}>
          <p className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: "#8A7B65" }}>Needs attention</p>
          <div className="space-y-2.5">
            {waitingLong > 0 && (
              <button onClick={() => setPage("pending")} className="w-full flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-semibold" style={{ color: "#9A5A12" }}><AlertTriangle size={15} /> New orders waiting over 24h</span>
                <span className="font-bold" style={{ color: "#9A5A12" }}>{waitingLong}</span>
              </button>
            )}
            {heldOrders > 0 && (
              <button onClick={() => setPage("production")} className="w-full flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-semibold" style={{ color: TOKENS.ink }}><Clock size={15} /> On hold in production</span>
                <span className="font-bold" style={{ color: TOKENS.ink }}>{heldOrders}</span>
              </button>
            )}
            {cancelledOrders > 0 && (
              <button onClick={() => setPage("pending")} className="w-full flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-semibold" style={{ color: "#C24A2E" }}><X size={15} /> Cancelled in Shopify — don't make</span>
                <span className="font-bold" style={{ color: "#C24A2E" }}>{cancelledOrders}</span>
              </button>
            )}
            <button onClick={() => setPage("production")} className="w-full flex items-center justify-between text-sm">
              <span className="flex items-center gap-2" style={{ color: TOKENS.ink }}><AlertTriangle size={15} style={{ color: "#C24A2E" }} /> Overdue in production</span>
              <span className="font-bold" style={{ color: overdue ? "#C24A2E" : "#8A7B65" }}>{overdue}</span>
            </button>
            <button onClick={() => setPage("production")} className="w-full flex items-center justify-between text-sm">
              <span className="flex items-center gap-2" style={{ color: TOKENS.ink }}><Calendar size={15} style={{ color: TOKENS.saddle }} /> Due today</span>
              <span className="font-bold" style={{ color: TOKENS.ink }}>{dueToday}</span>
            </button>
            <button onClick={() => setPage("production")} className="w-full flex items-center justify-between text-sm">
              <span className="flex items-center gap-2" style={{ color: TOKENS.ink }}><Zap size={15} style={{ color: "#9A5A12" }} /> Laser engraving orders</span>
              <span className="font-bold" style={{ color: TOKENS.ink }}>{engravingOrders}</span>
            </button>
          </div>
        </div>
        <div className="rounded-2xl border p-4" style={{ borderColor: TOKENS.line }}>
          <p className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: "#8A7B65" }}>Flow today</p>
          <div className="space-y-2.5 text-sm">
            <div className="flex items-center justify-between"><span style={{ color: TOKENS.ink }}>Completed today</span><span className="font-bold" style={{ color: TOKENS.ink }}>{n("completed_today")}</span></div>
            <div className="flex items-center justify-between"><span style={{ color: TOKENS.ink }}>Awaiting dispatch</span><span className="font-bold" style={{ color: TOKENS.ink }}>{n("completed")}</span></div>
            <div className="flex items-center justify-between"><span style={{ color: TOKENS.ink }}>With courier</span><span className="font-bold" style={{ color: TOKENS.ink }}>{n("dispatched")}</span></div>
          </div>
          <p className="mt-3 text-[11px]" style={{ color: "#A8977F" }}>Standard cycle: {settings.productionDays} production days + {settings.courierDays} courier days, {settings.workingDays.length}-day work week.</p>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Order list ----------------------------- */
function OrderRow({ order, productName, isOwner, settings, onOpen, onStartProduction, onQuickAction, busy }) {
  const cancelled = !!order.cancelledAt;
  const isOverdue = !cancelled && order.status === "production" && !!order.dueDate && order.dueDate < todayISO();
  const hoursWaiting = order.status === "pending" ? hoursSince(order.createdAt) : 0;
  const waitLevel = order.status === "pending" && !cancelled ? (hoursWaiting >= WAIT_LATE_HOURS ? "late" : hoursWaiting >= WAIT_WARN_HOURS ? "warn" : "ok") : "ok";
  const estDue = order.status === "pending" && settings ? addWorkingDaysISO(todayISO(), settings.productionDays, settings.workingDays) : null;
  const quickKey = isOwner && !cancelled ? (order.status === "completed" ? "dispatch" : order.status === "dispatched" ? "deliver" : null) : null;
  const quick = quickKey ? ORDER_ACTIONS[quickKey] : null;
  return (
    <div className="w-full text-left rounded-2xl border p-3.5 flex items-center gap-3 transition hover:shadow-sm" style={{
      borderColor: isOverdue || cancelled || waitLevel === "late" ? "#E3B2A0" : waitLevel === "warn" ? "#E8CFA0" : TOKENS.line,
      backgroundColor: isOverdue || cancelled || waitLevel === "late" ? "#FDF4F1" : waitLevel === "warn" ? "#FDF8EC" : "white",
    }}>
      <button onClick={() => onOpen(order)} className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-bold" style={{ color: TOKENS.ink }}>#{order.orderNumber}</p>
          <SourceTag source={order.source} />
          <EngravingTag engraving={order.engraving} />
          {cancelled && <span className="rounded-full px-2 py-0.5 text-[11px] font-bold text-white" style={{ backgroundColor: "#C24A2E" }}>CANCELLED · don't make</span>}
          {order.heldAt && !cancelled && <span className="rounded-full px-2 py-0.5 text-[11px] font-bold text-white" style={{ backgroundColor: TOKENS.ink }}>ON HOLD</span>}
        </div>
        <p className="text-sm mt-0.5 truncate" style={{ color: "#5A4E3F" }}>{productName} · Qty {order.quantity}{order.color ? ` · ${order.color}` : ""}</p>
        <p className="text-xs mt-1" style={{ color: isOverdue ? "#C24A2E" : "#A8977F" }}>
          {order.status === "production"
            ? `Due ${fmt(order.dueDate)}${isOverdue ? " · overdue" : ""}`
            : order.status === "pending"
              ? `Waiting ${waitLabel(hoursWaiting)} · entered ${fmt(order.orderDate)}`
              : `Ordered ${fmt(order.orderDate)}`}
        </p>
        {order.heldAt && !cancelled && <p className="text-xs mt-0.5 font-semibold" style={{ color: TOKENS.ink }}>Reason: {order.holdReason}</p>}
        {order.status === "pending" && !cancelled && (
          <p className="text-xs mt-0.5" style={{ color: "#A8977F" }}>Est. due {fmt(estDue)} if started today</p>
        )}
        {waitLevel !== "ok" && (
          <p className="text-xs mt-1 font-bold flex items-center gap-1" style={{ color: waitLevel === "late" ? "#C24A2E" : "#9A5A12" }}>
            <AlertTriangle size={12} /> Not started after {waitLabel(hoursWaiting)} — start production
          </p>
        )}
      </button>
      {order.status === "pending" && !cancelled && onStartProduction && (
        <button onClick={() => onStartProduction(order)} disabled={busy} className="shrink-0 rounded-lg px-3 py-2 text-xs font-bold text-white disabled:opacity-50" style={{ backgroundColor: TOKENS.status.production.fg }}>
          {busy ? "Starting…" : "Start Production"}
        </button>
      )}
      {quick && onQuickAction && (
        <button onClick={() => onQuickAction(order, quickKey)} className="shrink-0 rounded-lg px-3 py-2 text-xs font-bold text-white" style={{ backgroundColor: quick.tone }}>
          {quick.rowLabel}
        </button>
      )}
      {(order.status !== "pending" || cancelled) && !quick && <button onClick={() => onOpen(order)}><ChevronRight size={18} style={{ color: "#C9BCA8" }} className="shrink-0" /></button>}
    </div>
  );
}

function ListSearch({ value, onChange }) {
  return (
    <div className="relative">
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#A8977F" }} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Search order #, customer or product" className="w-full rounded-xl border pl-9 pr-3 py-2.5 text-sm outline-none" style={{ borderColor: TOKENS.line }} />
    </div>
  );
}

function OrderListPage({ status, orders, productNameFor, isOwner, settings, loading, error, onRetry, onOpen, onStartProduction, onQuickAction, busyId }) {
  const [q, setQ] = useState("");
  const [engravingOnly, setEngravingOnly] = useState(false);
  const meta = STATUS_META[status];
  const needle = q.trim().toLowerCase();
  const list = orders
    .filter((o) => o.status === status)
    .filter((o) => !engravingOnly || o.engraving.on)
    .filter((o) => !needle || o.orderNumber.toLowerCase().includes(needle) || o.customer.toLowerCase().includes(needle) || productNameFor(o).toLowerCase().includes(needle))
    .sort((a, b) => {
      const ka = status === "pending" ? (a.createdAt || "") : (a.dueDate || a.orderDate || "");
      const kb = status === "pending" ? (b.createdAt || "") : (b.dueDate || b.orderDate || "");
      if (ka !== kb) return ka < kb ? -1 : 1;
      return (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
    });

  return (
    <div className="p-4 md:p-8 max-w-3xl">
      <div className="flex items-center gap-2.5">
        <meta.icon size={20} style={{ color: TOKENS.saddle }} />
        <h1 className="text-xl font-bold" style={{ color: TOKENS.ink }}>{meta.label}</h1>
        <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ backgroundColor: TOKENS.hide, color: "#8A7B65" }}>{list.length}</span>
      </div>
      {status === "pending" && (
        <p className="mt-2 text-xs" style={{ color: "#A8977F" }}>New orders from Shopify and custom orders. Tap Start Production when work begins. Orders waiting more than 24 hours are flagged.</p>
      )}
      <div className="mt-4"><ListSearch value={q} onChange={setQ} /></div>
      <div className="mt-2.5">
        <button onClick={() => setEngravingOnly((v) => !v)} className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold" style={{ backgroundColor: engravingOnly ? "#FBEAD3" : TOKENS.hide, color: engravingOnly ? "#9A5A12" : "#8A7B65" }}>
          <Zap size={12} /> Engraving only
        </button>
      </div>
      {error && (
        <div className="mt-4 rounded-xl p-3 text-sm" style={{ backgroundColor: "#FBEAE5", color: "#B23A22" }}>
          {error} <button onClick={onRetry} className="font-bold underline ml-1">Try again</button>
        </div>
      )}
      <div className="mt-4 space-y-2.5">
        {loading && orders.length === 0 && <p className="text-sm py-10 text-center" style={{ color: "#A8977F" }}>Loading orders…</p>}
        {!loading && !error && list.length === 0 && <p className="text-sm py-10 text-center" style={{ color: "#A8977F" }}>{needle || engravingOnly ? "No orders match." : "Nothing here right now."}</p>}
        {list.map((o) => (
          <OrderRow key={o.id} order={o} productName={productNameFor(o)} isOwner={isOwner} settings={settings} busy={busyId === o.id}
            onOpen={onOpen} onStartProduction={onStartProduction} onQuickAction={onQuickAction} />
        ))}
      </div>
    </div>
  );
}

// Delivered orders keep piling up, so this page fetches them a page at a time
function DeliveredPage({ productNameFor, total, refreshKey, onOpen }) {
  const meta = STATUS_META.delivered;
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const reqId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  const loadFirst = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError("");
    try {
      const r = await loadDeliveredOrders({ query: debounced });
      if (id !== reqId.current) return;
      setItems(r.orders);
      setHasMore(r.hasMore);
    } catch (e) {
      if (id === reqId.current) setError(e.message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [debounced]);

  useEffect(() => { loadFirst(); }, [loadFirst, refreshKey]);

  const loadMore = async () => {
    const id = reqId.current;
    setLoadingMore(true);
    try {
      const r = await loadDeliveredOrders({ query: debounced, offset: items.length });
      if (id !== reqId.current) return;
      setItems((prev) => [...prev, ...r.orders]);
      setHasMore(r.hasMore);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-3xl">
      <div className="flex items-center gap-2.5">
        <meta.icon size={20} style={{ color: TOKENS.saddle }} />
        <h1 className="text-xl font-bold" style={{ color: TOKENS.ink }}>{meta.label}</h1>
        {typeof total === "number" && <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ backgroundColor: TOKENS.hide, color: "#8A7B65" }}>{total}</span>}
      </div>
      <div className="mt-4"><ListSearch value={q} onChange={setQ} /></div>
      {error && (
        <div className="mt-4 rounded-xl p-3 text-sm" style={{ backgroundColor: "#FBEAE5", color: "#B23A22" }}>
          {error} <button onClick={loadFirst} className="font-bold underline ml-1">Try again</button>
        </div>
      )}
      <div className="mt-4 space-y-2.5">
        {loading && <p className="text-sm py-10 text-center" style={{ color: "#A8977F" }}>Loading orders…</p>}
        {!loading && !error && items.length === 0 && <p className="text-sm py-10 text-center" style={{ color: "#A8977F" }}>{debounced ? "No orders match." : "Nothing delivered yet."}</p>}
        {!loading && items.map((o) => <OrderRow key={o.id} order={o} productName={productNameFor(o)} isOwner={false} onOpen={onOpen} />)}
      </div>
      {!loading && hasMore && (
        <button onClick={loadMore} disabled={loadingMore} className="mt-4 w-full rounded-xl border py-2.5 text-sm font-semibold disabled:opacity-60" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}>
          {loadingMore ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}

/* ----------------------------- Order detail ----------------------------- */
function ConfirmBar({ label, question, onConfirm, onCancel, tone = TOKENS.saddle, busy = false }) {
  return (
    <div className="rounded-xl border p-3.5" style={{ borderColor: tone, backgroundColor: "#FBF3EA" }}>
      <p className="text-sm font-semibold" style={{ color: TOKENS.ink }}>{label}</p>
      <p className="text-xs mt-0.5 mb-3" style={{ color: "#5A4E3F" }}>{question}</p>
      <div className="flex gap-2">
        <button onClick={onCancel} disabled={busy} className="flex-1 rounded-lg border py-2 text-sm font-semibold" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}>Cancel</button>
        <button onClick={onConfirm} disabled={busy} className="flex-1 rounded-lg py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: tone }}>{busy ? "Working…" : "Yes, confirm"}</button>
      </div>
    </div>
  );
}

function PhotoGrid({ photos, onRemove }) {
  const [zoom, setZoom] = useState(null);
  return (
    <>
      <div className="grid grid-cols-3 gap-1.5">
        {photos.map((ph) => (
          <div key={ph.key} className="relative">
            <button onClick={() => setZoom(ph)} className="block w-full text-left">
              <img src={ph.url} loading="lazy" decoding="async" className="h-24 w-full object-cover rounded-lg" alt={ph.label} />
              <p className="text-[10px] mt-1 text-center truncate" style={{ color: "#8A7B65" }}>{ph.label}</p>
            </button>
            {ph.removable && onRemove && (
              <button onClick={() => onRemove(ph)} aria-label="Remove photo" className="absolute top-1 right-1 rounded-full p-1" style={{ backgroundColor: "rgba(0,0,0,0.55)" }}>
                <X size={12} color="white" />
              </button>
            )}
          </div>
        ))}
      </div>
      {zoom && (
        <div className="fixed inset-0 z-[80] flex flex-col items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.9)" }} onClick={() => setZoom(null)}>
          <button className="absolute top-4 right-4"><X size={24} color="white" /></button>
          <img src={zoom.url} alt={zoom.label} className="max-h-[80vh] max-w-full object-contain rounded-lg" />
          <p className="mt-3 text-sm text-white">{zoom.label}</p>
        </div>
      )}
    </>
  );
}

function OrderDetail({ order, product, productName, settings, user, onClose, onAdvance, onHold, onSave, onDelete, initialConfirm }) {
  const isOwner = user.role === "owner";
  const actionKey = nextActionKey(order.status);
  const action = actionKey ? ORDER_ACTIONS[actionKey] : null;
  const cancelled = !!order.cancelledAt;
  const onHoldNow = !!order.heldAt;
  const allowed = !cancelled && !onHoldNow && canDoAction(actionKey, user.role);

  const [confirming, setConfirming] = useState(initialConfirm || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [extras, setExtras] = useState({ history: [], photos: [] });
  const [extrasLoading, setExtrasLoading] = useState(true);
  const [extrasError, setExtrasError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [holdReason, setHoldReason] = useState("");
  const [holdBusy, setHoldBusy] = useState(false);
  const [fin, setFin] = useState(null);
  const [finBusy, setFinBusy] = useState(false);
  const canSeeMoney = isOwner && (order.status === "dispatched" || order.status === "delivered") && !order.cancelledAt;

  const isOverdue = order.status === "production" && !!order.dueDate && order.dueDate < todayISO();
  const leatherType = order.leatherType || product?.leatherType || "—";

  // History and extra photos load when the order is opened (and again after it changes status)
  useEffect(() => {
    let cancelled = false;
    setExtrasLoading(true);
    loadOrderExtras(order.id)
      .then((r) => { if (!cancelled) { setExtras(r); setExtrasError(""); } })
      .catch((e) => { if (!cancelled) setExtrasError(e.message); })
      .finally(() => { if (!cancelled) setExtrasLoading(false); });
    return () => { cancelled = true; };
  }, [order.id, order.status, order.createdAt, order.notes, order.quantity, order.color, order.dueDate, order.expectedDelivery]);

  useEffect(() => {
    if (!canSeeMoney) { setFin(null); return undefined; }
    let gone = false;
    fetchOrderFinance(order.id).then((r) => { if (!gone) setFin(r || {}); }).catch(() => { if (!gone) setFin(null); });
    return () => { gone = true; };
  }, [order.id, canSeeMoney]);
  const toggleReturned = async () => {
    setFinBusy(true);
    setError("");
    try {
      await setOrderReturned(order.id, !fin?.returned_at);
      setFin(await fetchOrderFinance(order.id) || {});
      loadOrderExtras(order.id).then(setExtras).catch(() => {});
    } catch (e) {
      setError(e.message);
    } finally {
      setFinBusy(false);
    }
  };

  const act = async () => {
    setBusy(true);
    setError("");
    try {
      await onAdvance(order, action.to);
    } catch (e) {
      setError(e.message);
    } finally {
      setConfirming(null);
      setBusy(false);
    }
  };

  const submitHold = async (reason) => {
    setHoldBusy(true);
    setError("");
    try {
      await onHold(order, reason);
      setHoldOpen(false);
      setHoldReason("");
    } catch (e) {
      setError(e.message);
    } finally {
      setHoldBusy(false);
    }
  };

  const startEdit = () => {
    setDraft({
      customer: order.customer,
      channel: order.channel,
      productName: order.productName,
      quantity: order.quantity,
      color: order.color,
      leatherType: order.leatherType || product?.leatherType || "",
      engravingOn: order.engraving.on,
      engravingText: order.engraving.text,
      notes: order.notes,
      dueDate: order.dueDate || "",
      expectedDelivery: order.expectedDelivery || "",
    });
    setEditError("");
    setEditing(true);
  };
  const setD = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const saveEdit = async () => {
    setSaving(true);
    setEditError("");
    try {
      const fields = {
        customer: draft.customer, channel: draft.channel, quantity: draft.quantity, color: draft.color, leatherType: draft.leatherType,
        engravingOn: draft.engravingOn, engravingText: draft.engravingText, notes: draft.notes,
        dueDate: draft.dueDate, expectedDelivery: draft.expectedDelivery,
      };
      if (!order.productId) fields.productName = draft.productName;
      await onSave(order.id, fields);
      setEditing(false);
    } catch (e) {
      setEditError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const onPickPhotos = async (e) => {
    const files = Array.from(e.target.files || []).map((file) => ({ file, label: "Other" }));
    e.target.value = "";
    if (!files.length) return;
    setUploading(true);
    setError("");
    try {
      const added = await addOrderPhotos(order.id, files);
      setExtras((x) => ({ ...x, photos: [...x.photos, ...added] }));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };
  const removePhoto = async (ph) => {
    try {
      await removeOrderPhoto(ph.raw);
      setExtras((x) => ({ ...x, photos: x.photos.filter((p) => p.id !== ph.raw.id) }));
    } catch (err) {
      setError(err.message);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    setError("");
    try {
      await onDelete(order, extras.photos);
    } catch (e) {
      setError(e.message);
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const allPhotos = [
    ...(product?.photos || []).map((p) => ({ key: `p-${p.id}`, url: p.url, label: p.label || "Product" })),
    ...extras.photos.map((p) => ({ key: `o-${p.id}`, url: p.url, label: p.label || "Order photo", removable: isOwner, raw: p })),
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ backgroundColor: "rgba(0,0,0,0.45)" }}>
      <div className="h-full w-full md:w-[480px] overflow-y-auto" style={{ backgroundColor: TOKENS.paper }}>
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3.5 border-b" style={{ borderColor: TOKENS.line, backgroundColor: TOKENS.paper }}>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="md:hidden"><ArrowLeft size={19} style={{ color: TOKENS.ink }} /></button>
            <p className="text-base font-bold" style={{ color: TOKENS.ink }}>Order #{order.orderNumber}</p>
          </div>
          <button onClick={onClose} className="hidden md:block"><X size={19} style={{ color: TOKENS.ink }} /></button>
        </div>

        <div className="p-4 space-y-5 pb-28">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge status={order.status} />
            <SourceTag source={order.source} />
            <EngravingTag engraving={order.engraving} />
            {isOverdue && <span className="text-xs font-bold" style={{ color: "#C24A2E" }}>Overdue</span>}
          </div>

          {order.status === "production" && !cancelled && (
            <Section title="Production status">
              {onHoldNow ? (
                <div>
                  <span className="inline-block rounded px-2 py-0.5 text-xs font-bold text-white" style={{ backgroundColor: TOKENS.ink }}>ON HOLD</span>
                  <p className="mt-2 text-sm font-semibold" style={{ color: TOKENS.ink }}>{order.holdReason}</p>
                  <p className="mt-0.5 text-[11px]" style={{ color: "#A8977F" }}>Since {fmtDateTime(order.heldAt)}. Mark it ready when work can continue.</p>
                  <button onClick={() => submitHold("")} disabled={holdBusy} className="mt-3 w-full rounded-xl py-2.5 text-sm font-bold text-white disabled:opacity-50" style={{ backgroundColor: TOKENS.status.production.fg }}>
                    {holdBusy ? "Saving…" : "Ready — resume production"}
                  </button>
                </div>
              ) : holdOpen ? (
                <div>
                  <p className="text-sm font-semibold" style={{ color: TOKENS.ink }}>Why is this order on hold?</p>
                  <textarea value={holdReason} onChange={(e) => setHoldReason(e.target.value)} rows={2} placeholder="e.g. Waiting for leather stock" className="input mt-2" />
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => { setHoldOpen(false); setHoldReason(""); }} disabled={holdBusy} className="flex-1 rounded-lg border py-2 text-sm font-semibold" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}>Cancel</button>
                    <button onClick={() => submitHold(holdReason.trim())} disabled={holdBusy || !holdReason.trim()} className="flex-1 rounded-lg py-2 text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: TOKENS.ink }}>
                      {holdBusy ? "Saving…" : "Put on hold"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm" style={{ color: "#5A4E3F" }}>In progress.</p>
                  <button onClick={() => setHoldOpen(true)} className="rounded-lg border px-3 py-1.5 text-xs font-bold" style={{ borderColor: TOKENS.ink, color: TOKENS.ink }}>Put on hold</button>
                </div>
              )}
            </Section>
          )}
          {canSeeMoney && fin && (
            <Section title="Money (owner only)">
              <Row label="Sold for" value={fin.amount != null ? rs(fin.amount) : "Not set (uses product price)"} />
              {fin.returned_at ? (
                <div>
                  <span className="inline-block rounded px-2 py-0.5 text-xs font-bold text-white" style={{ backgroundColor: TOKENS.ink }}>RETURNED</span>
                  <p className="mt-1 text-[11px]" style={{ color: "#A8977F" }}>Not counted in revenue, Leopards deduction or cost.</p>
                  <button onClick={toggleReturned} disabled={finBusy} className="mt-2 w-full rounded-lg border py-2 text-sm font-semibold disabled:opacity-50" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}>{finBusy ? "Saving…" : "Undo return"}</button>
                </div>
              ) : (
                <button onClick={toggleReturned} disabled={finBusy} className="w-full rounded-lg border py-2 text-sm font-bold disabled:opacity-50" style={{ borderColor: TOKENS.ink, color: TOKENS.ink }}>{finBusy ? "Saving…" : "Mark as returned"}</button>
              )}
            </Section>
          )}
          {order.status === "pending" && !cancelled && hoursSince(order.createdAt) >= WAIT_WARN_HOURS && (
            <div className="rounded-xl px-3 py-2.5 text-sm font-semibold" style={{ backgroundColor: "#FBEAD3", color: "#9A5A12" }}>
              This order has been waiting {waitLabel(hoursSince(order.createdAt))} without starting production.
            </div>
          )}
          {cancelled && (
            <div className="rounded-xl px-3 py-2.5 text-sm font-semibold" style={{ backgroundColor: "#FBEAE5", color: "#B23A22" }}>
              This order was cancelled in Shopify. Do not make or ship it.{isOwner ? " You can delete it below once you've checked." : " Please tell the owner."}
            </div>
          )}

          {!editing && (
            <>
              <Section title="Order information">
                <Row label="Order date" value={`${fmt(order.orderDate)} (${dayName(order.orderDate)})`} />
                <Row label="Due / production date" value={order.dueDate ? `${fmt(order.dueDate)} (${dayName(order.dueDate)})` : order.status === "pending" && settings ? `Set when production starts (est. ${fmt(addWorkingDaysISO(todayISO(), settings.productionDays, settings.workingDays))})` : "—"} />
                <Row label="Expected delivery" value={order.expectedDelivery ? `${fmt(order.expectedDelivery)} (${dayName(order.expectedDelivery)})` : "—"} />
                <Row label="Customer" value={order.customer || "—"} />
                <Row label="Source" value={order.channel || order.source} />
              </Section>

              <Section
                title="Product"
                action={isOwner && (
                  <button onClick={startEdit} className="flex items-center gap-1 text-xs font-semibold" style={{ color: TOKENS.saddle }}>
                    <Edit2 size={12} /> Edit
                  </button>
                )}
              >
                <Row label="Product" value={productName} />
                <Row label="Quantity" value={order.quantity} />
                <Row label="Leather color" value={order.color || "—"} />
                <Row label="Leather type" value={leatherType} />
              </Section>

              <Section
                title="Customization"
                action={isOwner && (
                  <button onClick={startEdit} className="flex items-center gap-1 text-xs font-semibold" style={{ color: TOKENS.saddle }}>
                    <Edit2 size={12} /> Edit
                  </button>
                )}
              >
                <Row label="Laser engraving" value={order.engraving.on ? "Yes" : "No"} highlight={order.engraving.on} />
                {order.engraving.on && <Row label="Engraving text" value={order.engraving.text || "—"} />}
                <Row label="Special instructions" value={order.notes || "None"} />
              </Section>
            </>
          )}

          {editing && draft && (
            <Section title="Edit order">
              <Field label="Customer"><input value={draft.customer} onChange={(e) => setD("customer", e.target.value)} className="input" /></Field>
              {order.source === "CUSTOM" && (
                <Field label="Order came from">
                  <select value={draft.channel || ""} onChange={(e) => setD("channel", e.target.value)} className="input">
                    <option value="">Not set</option>
                    {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
              )}
              {!order.productId && <Field label="Product name"><input value={draft.productName} onChange={(e) => setD("productName", e.target.value)} className="input" /></Field>}
              <Field label="Quantity"><input type="number" min={1} value={draft.quantity} onChange={(e) => setD("quantity", e.target.value)} className="input" /></Field>
              <Field label="Leather color">
                <input list="order-colors" value={draft.color} onChange={(e) => setD("color", e.target.value)} className="input" />
                <datalist id="order-colors">{(product?.colors || []).map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="Leather type"><input value={draft.leatherType} onChange={(e) => setD("leatherType", e.target.value)} placeholder="e.g. Oily Pull-Up" className="input" /></Field>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold" style={{ color: TOKENS.ink }}>Laser engraving</span>
                <button onClick={() => setD("engravingOn", !draft.engravingOn)} className="rounded-full px-3 py-1 text-xs font-bold" style={{ backgroundColor: draft.engravingOn ? TOKENS.status.pending.bg : TOKENS.hide, color: draft.engravingOn ? TOKENS.status.pending.fg : "#8A7B65" }}>
                  {draft.engravingOn ? "Yes" : "No"}
                </button>
              </div>
              {draft.engravingOn && <Field label="Engraving text"><input value={draft.engravingText} onChange={(e) => setD("engravingText", e.target.value)} className="input" /></Field>}
              <Field label="Special instructions"><textarea value={draft.notes} onChange={(e) => setD("notes", e.target.value)} rows={3} className="input" /></Field>
              <Field label="Due / production date"><input type="date" value={draft.dueDate} onChange={(e) => setD("dueDate", e.target.value)} className="input" /></Field>
              <Field label="Expected delivery date"><input type="date" value={draft.expectedDelivery} onChange={(e) => setD("expectedDelivery", e.target.value)} className="input" /></Field>
              <p className="text-[11px]" style={{ color: "#A8977F" }}>Dates fill in automatically. Change them here only to override for this one order.</p>
              {editError && <div className="rounded-lg px-3 py-2 text-xs font-medium" style={{ backgroundColor: "#FBEAE5", color: "#B23A22" }}>{editError}</div>}
              <div className="flex gap-2 pt-1">
                <button onClick={() => setEditing(false)} disabled={saving} className="flex-1 rounded-lg border py-2 text-sm font-semibold" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}>Cancel</button>
                <button onClick={saveEdit} disabled={saving} className="flex-1 flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ backgroundColor: TOKENS.saddle }}>
                  {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : "Save changes"}
                </button>
              </div>
            </Section>
          )}

          {(allPhotos.length > 0 || isOwner) && (
            <Section
              title="Photos"
              action={isOwner && (
                <label className="flex items-center gap-1 text-xs font-semibold cursor-pointer" style={{ color: TOKENS.saddle }}>
                  {uploading ? <><Loader2 size={12} className="animate-spin" /> Uploading…</> : <><Plus size={12} /> Add photos</>}
                  <input type="file" accept="image/*" multiple onChange={onPickPhotos} disabled={uploading} className="hidden" />
                </label>
              )}
            >
              {allPhotos.length === 0
                ? <p className="text-xs" style={{ color: "#A8977F" }}>No photos for this order.</p>
                : <PhotoGrid photos={allPhotos} onRemove={removePhoto} />}
            </Section>
          )}

          {product?.instructions && (
            <Section title="Production notes">
              <p className="text-sm whitespace-pre-wrap" style={{ color: "#5A4E3F" }}>{product.instructions}</p>
            </Section>
          )}

          <Section title="History">
            {extrasLoading && extras.history.length === 0 && <p className="text-xs" style={{ color: "#A8977F" }}>Loading…</p>}
            {extrasError && <p className="text-xs" style={{ color: "#B23A22" }}>{extrasError}</p>}
            <div className="space-y-2">
              {extras.history.map((h, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <div className="mt-1 h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: TOKENS.saddle }} />
                  <p style={{ color: "#5A4E3F" }}><span className="font-semibold" style={{ color: TOKENS.ink }}>{h.event}</span> · {h.by} · {fmtDateTime(h.at)}</p>
                </div>
              ))}
            </div>
          </Section>

          {isOwner && !editing && (
            confirmDelete ? (
              <ConfirmBar label={`Delete Order #${order.orderNumber}?`} question="This permanently removes the order, its photos and its history. It can't be undone." onCancel={() => setConfirmDelete(false)} onConfirm={doDelete} tone="#C24A2E" busy={deleting} />
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="text-xs font-semibold" style={{ color: "#C24A2E" }}>Delete this order</button>
            )
          )}
        </div>

        <div className="sticky bottom-0 p-4 border-t" style={{ borderColor: TOKENS.line, backgroundColor: TOKENS.paper }}>
          {error && <div className="mb-3 rounded-lg px-3 py-2 text-xs font-medium" style={{ backgroundColor: "#FBEAE5", color: "#B23A22" }}>{error}</div>}
          {action && !cancelled && onHoldNow && canDoAction(actionKey, user.role) && (
            <p className="text-xs text-center font-medium" style={{ color: "#9A5A12" }}>This order is on hold. Mark it ready before completing it.</p>
          )}
          {action && allowed && confirming !== actionKey && (
            <button onClick={() => setConfirming(actionKey)} disabled={editing} className="w-full rounded-xl py-3 text-sm font-bold text-white disabled:opacity-50" style={{ backgroundColor: action.tone }}>
              {action.button}
            </button>
          )}
          {action && allowed && confirming === actionKey && (
            <ConfirmBar label={action.confirm(order.orderNumber)} question={action.question} onCancel={() => setConfirming(null)} onConfirm={act} tone={action.tone} busy={busy} />
          )}
          {order.status === "completed" && !isOwner && (
            <p className="text-center text-xs" style={{ color: "#A8977F" }}>Waiting on the owner to dispatch this order.</p>
          )}
          {order.status === "delivered" && (
            <p className="text-center text-xs" style={{ color: "#A8977F" }}>This order has been delivered.</p>
          )}
          {order.status === "dispatched" && !isOwner && (
            <p className="text-center text-xs" style={{ color: "#A8977F" }}>With the courier.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children, action }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#8A7B65" }}>{title}</p>
        {action}
      </div>
      <div className="rounded-xl border p-3 space-y-2" style={{ borderColor: TOKENS.line, backgroundColor: "white" }}>{children}</div>
    </div>
  );
}
function Row({ label, value, highlight }) {
  return (
    <div className="flex items-center justify-between text-sm gap-3">
      <span style={{ color: "#8A7B65" }}>{label}</span>
      <span className="font-semibold text-right" style={{ color: highlight ? "#9A5A12" : TOKENS.ink }}>{value}</span>
    </div>
  );
}

/* ----------------------------- Products ----------------------------- */
const PHOTO_LABELS = ["Main", "Back", "Inside", "Hardware / details", "Other"];

function PhotoPlaceholder({ className = "h-32" }) {
  return (
    <div className={`${className} w-full flex items-center justify-center`} style={{ backgroundColor: TOKENS.hide }}>
      <ImageIcon size={22} style={{ color: "#C9BCA8" }} />
    </div>
  );
}

function ProductCard({ product, onOpen }) {
  return (
    <button onClick={() => onOpen(product)} className="text-left rounded-2xl border overflow-hidden transition hover:shadow-sm" style={{ borderColor: TOKENS.line, backgroundColor: "white", opacity: product.archived ? 0.6 : 1 }}>
      {product.photos[0]
        ? <img src={product.photos[0].url} loading="lazy" decoding="async" className="h-32 w-full object-cover" alt={product.name} />
        : <PhotoPlaceholder />}
      <div className="p-3">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-bold truncate" style={{ color: TOKENS.ink }}>{product.name}</p>
          {product.archived && <span className="text-[10px] font-bold rounded px-1.5 py-0.5" style={{ backgroundColor: TOKENS.hide, color: "#8A7B65" }}>ARCHIVED</span>}
        </div>
        <p className="text-xs mt-0.5" style={{ color: "#8A7B65" }}>{product.leatherType || "No leather type set"}</p>
        <div className="flex items-center gap-1 mt-2 flex-wrap">
          {product.colors.map((c) => <span key={c} className="text-[10px] rounded px-1.5 py-0.5" style={{ backgroundColor: TOKENS.hide, color: "#5A4E3F" }}>{c}</span>)}
        </div>
      </div>
    </button>
  );
}

function ProductsPage({ products, loading, error, user, onOpenProduct, onAdd, onRetry }) {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const isOwner = user.role === "owner";
  const list = products.filter((p) => (showArchived ? true : !p.archived) && p.name.toLowerCase().includes(q.toLowerCase()));
  const archivedCount = products.filter((p) => p.archived).length;

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold" style={{ color: TOKENS.ink }}>Product Library</h1>
        {isOwner && (
          <button onClick={onAdd} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-white" style={{ backgroundColor: TOKENS.saddle }}>
            <Plus size={14} /> Add product
          </button>
        )}
      </div>
      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <div className="relative w-full max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#A8977F" }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products" className="w-full rounded-xl border pl-9 pr-3 py-2.5 text-sm outline-none" style={{ borderColor: TOKENS.line }} />
        </div>
        {isOwner && archivedCount > 0 && (
          <button onClick={() => setShowArchived((s) => !s)} className="text-xs font-semibold" style={{ color: TOKENS.saddle }}>
            {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
          </button>
        )}
      </div>

      {loading && <p className="mt-8 text-sm text-center" style={{ color: "#A8977F" }}>Loading products…</p>}
      {error && (
        <div className="mt-6 rounded-xl p-4 text-sm" style={{ backgroundColor: "#FBEAE5", color: "#B23A22" }}>
          {error} <button onClick={onRetry} className="font-bold underline ml-1">Try again</button>
        </div>
      )}
      {!loading && !error && products.filter((p) => !p.archived).length === 0 && (
        <div className="mt-10 text-center">
          <Boxes size={28} className="mx-auto mb-3" style={{ color: "#C9BCA8" }} />
          <p className="text-sm font-semibold" style={{ color: TOKENS.ink }}>No products yet</p>
          <p className="text-xs mt-1" style={{ color: "#A8977F" }}>
            {isOwner ? "Add your first product to start building the library." : "The owner hasn't added any products yet."}
          </p>
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-3">
        {list.map((p) => <ProductCard key={p.id} product={p} onOpen={onOpenProduct} />)}
      </div>
    </div>
  );
}

function ProductDetail({ product, user, onClose, onEdit, onToggleArchive }) {
  const [zoom, setZoom] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      await onToggleArchive(product);
      setConfirming(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ backgroundColor: "rgba(0,0,0,0.45)" }}>
      <div className="h-full w-full md:w-[480px] overflow-y-auto" style={{ backgroundColor: TOKENS.paper }}>
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3.5 border-b" style={{ borderColor: TOKENS.line, backgroundColor: TOKENS.paper }}>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="md:hidden"><ArrowLeft size={19} style={{ color: TOKENS.ink }} /></button>
            <p className="text-base font-bold" style={{ color: TOKENS.ink }}>{product.name}</p>
          </div>
          <button onClick={onClose} className="hidden md:block"><X size={19} style={{ color: TOKENS.ink }} /></button>
        </div>
        <div className="p-4 space-y-5 pb-10">
          {product.archived && (
            <div className="rounded-lg px-3 py-2 text-xs font-medium" style={{ backgroundColor: TOKENS.hide, color: "#8A7B65" }}>
              This product is archived. It's hidden from the library but past orders still show it.
            </div>
          )}
          {product.photos.length === 0 ? (
            <div className="rounded-xl overflow-hidden"><PhotoPlaceholder className="h-32" /></div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {product.photos.map((ph) => (
                <button key={ph.id} onClick={() => setZoom(ph)} className="text-left">
                  <img src={ph.url} loading="lazy" decoding="async" className="h-24 w-full object-cover rounded-lg" alt={ph.label} />
                  <p className="text-[10px] mt-1 text-center truncate" style={{ color: "#8A7B65" }}>{ph.label}</p>
                </button>
              ))}
            </div>
          )}
          <Section title="Leather">
            <Row label="Type" value={product.leatherType || "—"} />
            <Row label="Colors" value={product.colors.length ? product.colors.join(", ") : "—"} />
            <Row label="Engraving" value={product.engravingAvailable ? "Available" : "Not offered"} />
          </Section>
          <Section title="Production instructions">
            <p className="text-sm whitespace-pre-wrap" style={{ color: "#5A4E3F" }}>{product.instructions || "No instructions added."}</p>
          </Section>

          {user.role === "owner" && !confirming && (
            <div className="flex gap-2">
              <button onClick={() => onEdit(product)} className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border py-2.5 text-sm font-semibold" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}><Edit2 size={14} /> Edit</button>
              {product.archived ? (
                <button onClick={toggle} disabled={busy} className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border py-2.5 text-sm font-semibold" style={{ borderColor: TOKENS.line, color: TOKENS.saddle }}>
                  {busy ? "Restoring…" : "Restore"}
                </button>
              ) : (
                <button onClick={() => setConfirming(true)} className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border py-2.5 text-sm font-semibold" style={{ borderColor: TOKENS.line, color: "#C24A2E" }}><Archive size={14} /> Archive</button>
              )}
            </div>
          )}
          {confirming && (
            <ConfirmBar label={`Archive ${product.name}?`} question="It will be hidden from the library. Past orders keep working, and you can restore it later." onCancel={() => setConfirming(false)} onConfirm={toggle} tone="#C24A2E" />
          )}
          {error && <p className="text-xs" style={{ color: "#B23A22" }}>{error}</p>}
        </div>
      </div>

      {zoom && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.9)" }} onClick={() => setZoom(null)}>
          <button className="absolute top-4 right-4"><X size={24} color="white" /></button>
          <img src={zoom.url} alt={zoom.label} className="max-h-[80vh] max-w-full object-contain rounded-lg" />
          <p className="mt-3 text-sm text-white">{zoom.label}</p>
        </div>
      )}
    </div>
  );
}

function ProductForm({ product, onClose, onSaved }) {
  const editing = !!product;
  const [name, setName] = useState(product?.name || "");
  const [leatherType, setLeatherType] = useState(product?.leatherType || "");
  const [colorsText, setColorsText] = useState(product?.colors?.join(", ") || "");
  const [engraving, setEngraving] = useState(product?.engravingAvailable ?? true);
  const [instructions, setInstructions] = useState(product?.instructions || "");
  const [existingPhotos, setExistingPhotos] = useState(product?.photos || []);
  const [removedPhotos, setRemovedPhotos] = useState([]);
  const [newPhotos, setNewPhotos] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []);
    const added = files.map((file, i) => ({
      key: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      file,
      preview: URL.createObjectURL(file),
      label: existingPhotos.length + newPhotos.length + i === 0 ? "Main" : "Other",
    }));
    setNewPhotos((prev) => [...prev, ...added]);
    e.target.value = "";
  };

  const removeExisting = (photo) => {
    setExistingPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    setRemovedPhotos((prev) => [...prev, photo]);
  };
  const removeNew = (key) => setNewPhotos((prev) => prev.filter((p) => p.key !== key));
  const setNewLabel = (key, label) => setNewPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, label } : p)));

  const save = async () => {
    if (!name.trim()) { setError("Give the product a name."); return; }
    setSaving(true);
    setError("");
    try {
      await saveProduct({
        id: product?.id,
        fields: {
          name: name.trim(),
          leatherType: leatherType.trim(),
          colors: colorsText.split(",").map((c) => c.trim()).filter(Boolean),
          engravingAvailable: engraving,
          instructions: instructions.trim(),
        },
        removedPhotos,
        newPhotos,
        existingCount: existingPhotos.length,
      });
      await onSaved();
    } catch (e) {
      setError(e.message || "Something went wrong. Try again.");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[55] flex justify-end" style={{ backgroundColor: "rgba(0,0,0,0.45)" }}>
      <div className="h-full w-full md:w-[480px] overflow-y-auto" style={{ backgroundColor: TOKENS.paper }}>
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3.5 border-b" style={{ borderColor: TOKENS.line, backgroundColor: TOKENS.paper }}>
          <p className="text-base font-bold" style={{ color: TOKENS.ink }}>{editing ? "Edit product" : "Add product"}</p>
          <button onClick={onClose} disabled={saving}><X size={19} style={{ color: TOKENS.ink }} /></button>
        </div>
        <div className="p-4 space-y-4 pb-10">
          <Field label="Product name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aviator Bag" className="input" /></Field>
          <Field label="Leather type"><input value={leatherType} onChange={(e) => setLeatherType(e.target.value)} placeholder="e.g. Oily Pull-Up" className="input" /></Field>
          <Field label="Available colors">
            <input value={colorsText} onChange={(e) => setColorsText(e.target.value)} placeholder="Tan, Brown, Black" className="input" />
            <span className="block text-[11px] mt-1" style={{ color: "#A8977F" }}>Separate colors with commas.</span>
          </Field>
          <div className="flex items-center justify-between rounded-xl border p-3" style={{ borderColor: TOKENS.line }}>
            <span className="text-sm font-semibold" style={{ color: TOKENS.ink }}>Laser engraving available</span>
            <button onClick={() => setEngraving((v) => !v)} className="rounded-full px-3 py-1 text-xs font-bold" style={{ backgroundColor: engraving ? TOKENS.status.pending.bg : TOKENS.hide, color: engraving ? TOKENS.status.pending.fg : "#8A7B65" }}>
              {engraving ? "Yes" : "No"}
            </button>
          </div>
          <Field label="Production instructions">
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5} placeholder="Anything the production team should know when making this" className="input" />
          </Field>

          <div>
            <span className="block text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: "#8A7B65" }}>Photos</span>
            <div className="grid grid-cols-2 gap-2">
              {existingPhotos.map((p) => (
                <div key={p.id} className="rounded-xl border overflow-hidden bg-white" style={{ borderColor: TOKENS.line }}>
                  <img src={p.url} className="h-24 w-full object-cover" alt={p.label} loading="lazy" />
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <span className="text-[11px] truncate" style={{ color: "#5A4E3F" }}>{p.label}</span>
                    <button onClick={() => removeExisting(p)} disabled={saving}><X size={14} style={{ color: "#C24A2E" }} /></button>
                  </div>
                </div>
              ))}
              {newPhotos.map((p) => (
                <div key={p.key} className="rounded-xl border overflow-hidden bg-white" style={{ borderColor: TOKENS.saddle }}>
                  <img src={p.preview} className="h-24 w-full object-cover" alt="New" />
                  <div className="flex items-center gap-1 px-1.5 py-1.5">
                    <select value={p.label} onChange={(e) => setNewLabel(p.key, e.target.value)} className="flex-1 min-w-0 text-[11px] bg-transparent outline-none" style={{ color: "#5A4E3F" }}>
                      {PHOTO_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                    <button onClick={() => removeNew(p.key)} disabled={saving}><X size={14} style={{ color: "#C24A2E" }} /></button>
                  </div>
                </div>
              ))}
              <label className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed h-[132px] cursor-pointer" style={{ borderColor: TOKENS.line, color: "#8A7B65" }}>
                <Plus size={20} />
                <span className="text-xs font-semibold mt-1">Add photos</span>
                <input type="file" accept="image/*" multiple onChange={onPickFiles} className="hidden" />
              </label>
            </div>
            <span className="block text-[11px] mt-1.5" style={{ color: "#A8977F" }}>Photos are shrunk automatically so the app stays fast on phones.</span>
          </div>

          {error && <div className="rounded-lg px-3 py-2 text-xs font-medium" style={{ backgroundColor: "#FBEAE5", color: "#B23A22" }}>{error}</div>}

          <div className="flex gap-2 pt-1">
            <button onClick={onClose} disabled={saving} className="flex-1 rounded-xl border py-3 text-sm font-semibold" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}>Cancel</button>
            <button onClick={save} disabled={saving} className="flex-1 flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white disabled:opacity-60" style={{ backgroundColor: TOKENS.saddle }}>
              {saving ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : editing ? "Save changes" : "Add product"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Printable production list ----------------------------- */
const MAKE_BY_DAYS = 2; // an order should be made within this many working days of being placed
const CHANNELS = ["WhatsApp", "Instagram", "Walk-in", "Phone call", "Other"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtShort = (iso) => {
  if (!iso) return "—";
  const d = parseDate(iso);
  return `${DOW_NAMES[d.getDay()]} ${pad2(d.getDate())} ${MONTHS[d.getMonth()]}`;
};
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sourceLabel = (o) => o.channel || (o.source === "SHOPIFY" ? "Shopify" : "Custom");

function printableOrders(orders, settings) {
  return orders
    .filter((o) => o.status === "pending" && !o.cancelledAt)
    .map((o) => ({ ...o, makeBy: addWorkingDaysISO(o.orderDate, MAKE_BY_DAYS, settings.workingDays) }))
    .sort((a, b) => (a.makeBy !== b.makeBy ? (a.makeBy < b.makeBy ? -1 : 1) : (a.createdAt || "") < (b.createdAt || "") ? -1 : 1));
}

// Orders being made now. Cancelled ones stay on the list (marked) so nobody finishes them by mistake.
function productionOrders(orders) {
  const startedOn = (o) => (o.startedAt ? toISODate(new Date(o.startedAt)) : null);
  return orders
    .filter((o) => o.status === "production")
    .map((o) => ({ ...o, startedOn: startedOn(o) }))
    .sort((a, b) => ((a.dueDate || "9999") !== (b.dueDate || "9999") ? ((a.dueDate || "9999") < (b.dueDate || "9999") ? -1 : 1) : (a.createdAt || "") < (b.createdAt || "") ? -1 : 1));
}

// The sheet is plain HTML so the screen preview and the printed page are identical.
// Nothing depends on color alone: late orders also say LATE in text, held orders say ON HOLD.
function buildPrintHtml(list, { user, productNameFor, mode }) {
  const prod = mode === "production";
  const today = todayISO();
  const dueOf = (o) => (prod ? o.dueDate : o.makeBy);
  const late = list.filter((o) => dueOf(o) && dueOf(o) < today && !o.cancelledAt).length;
  const held = list.filter((o) => o.heldAt && !o.cancelledAt).length;
  const printedAt = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const rows = list.map((o) => {
    const due = dueOf(o);
    const isLate = !!due && due < today && !o.cancelledAt;
    const isToday = due === today;
    const flag = isLate ? '<span class="flag">LATE</span>' : isToday ? '<span class="flag today">TODAY</span>' : "";
    const engr = o.engraving.on
      ? `<span class="yes">YES</span><div class="et">&ldquo;${esc(o.engraving.text)}&rdquo;</div>`
      : '<span class="no">No</span>';
    const status = o.cancelledAt
      ? '<div class="hold">CANCELLED</div><div class="reason">Do not make &mdash; cancelled in Shopify</div>'
      : o.heldAt
        ? `<div class="hold">ON HOLD</div><div class="reason">${esc(o.holdReason)}</div>`
        : '<div class="line"></div><div class="line"></div>';
    return `<tr class="${isLate ? "late" : ""} ${o.heldAt || o.cancelledAt ? "held" : ""}">
      <td class="chk"><div class="box"></div></td>
      <td class="num">#${esc(o.orderNumber)}</td>
      <td><span class="src">${esc(sourceLabel(o).toUpperCase())}</span></td>
      ${prod ? `<td>${fmtShort(o.startedOn || o.orderDate)}</td>` : `<td>${fmtShort(o.orderDate)}</td>`}
      <td class="mb">${fmtShort(due)}${flag}</td>
      <td><b>${esc(productNameFor(o))}</b></td>
      <td>${esc(o.color) || "&mdash;"}</td>
      <td class="c">${esc(o.quantity)}</td>
      <td class="c">${engr}</td>
      <td>${esc(o.notes)}</td>
      ${prod ? `<td class="st">${status}</td>` : `<td>${esc(o.customer)}</td>`}
    </tr>`;
  }).join("");
  const heads = prod
    ? "<th></th><th>Order</th><th>From</th><th>Started</th><th>Due</th><th>Product</th><th>Color / variant</th><th>Qty</th><th>Laser engraving</th><th>Special notes</th><th>Status / reason</th>"
    : "<th></th><th>Order</th><th>From</th><th>Ordered</th><th>Make by</th><th>Product</th><th>Color / variant</th><th>Qty</th><th>Laser engraving</th><th>Special notes</th><th>Customer</th>";
  const pills = prod
    ? `<div class="pill"><b>${list.length}</b> orders in production</div><div class="pill dark"><b>${held}</b> on hold</div>${late ? `<div class="pill red"><b>${late}</b> past their due date</div>` : ""}`
    : `<div class="pill"><b>${list.length}</b> orders to start</div>${late ? `<div class="pill red"><b>${late}</b> past their make-by date</div>` : ""}<div class="pill">Make by = order date + ${MAKE_BY_DAYS} working days</div>`;
  const empty = prod ? "No orders in production. Nothing to print." : "No new orders waiting. Nothing to print.";
  const foot = prod
    ? "Sorted by due date, most urgent first. Tick the box when finished. Write any status or reason on the lines in the last column."
    : "Sorted by make-by date, most urgent first. Tick the box when production starts.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Production list ${today}</title><style>
@page { size: A4 landscape; margin: 10mm 10mm 14mm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: Arial, Helvetica, sans-serif; color: #1F1710; font-size: 10.5px; margin: 0; background: #fff; }
@media screen { body { min-width: 1020px; padding: 14px 18px; } }
.top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #1F1710; padding-bottom: 7px; }
h1 { margin: 0; font-size: 22px; letter-spacing: 1px; } .sub { font-size: 11px; color: #4A3F31; margin-top: 2px; }
.meta { text-align: right; font-size: 11px; line-height: 1.5; } .meta b { font-size: 13px; }
.sum { display: flex; gap: 10px; margin: 9px 0; } .pill { border: 1px solid #8A7B65; border-radius: 6px; padding: 5px 10px; font-size: 11px; } .pill b { font-size: 14px; }
.pill.red { border: 2px solid #B23A22; color: #B23A22; background: #FDF1EE; } .pill.dark { border: 2px solid #1F1710; }
table { width: 100%; border-collapse: collapse; } thead { display: table-header-group; } tr { page-break-inside: avoid; }
th { background: #1F1710; color: #fff; text-align: left; font-size: 9.5px; letter-spacing: .5px; text-transform: uppercase; padding: 6px; }
td { padding: 7px 6px; border-bottom: 1px solid #B9AC96; vertical-align: top; }
tr.late td { background: #F3E3DE; } tr.late td.mb { color: #B23A22; } tr.held td { background: #EDEDED; } tr.late.held td { background: #EDE0DC; }
.box { width: 15px; height: 15px; border: 1.8px solid #1F1710; border-radius: 3px; } .chk { width: 26px; }
.num { font-weight: 700; font-size: 12px; white-space: nowrap; } .c { text-align: center; } .mb { white-space: nowrap; font-weight: 700; }
.flag { display: inline-block; margin-left: 5px; border: 1.5px solid #B23A22; color: #B23A22; background: #fff; font-size: 8px; font-weight: 700; padding: 1px 4px; border-radius: 3px; vertical-align: 1px; }
.flag.today { border-color: #1F1710; color: #1F1710; }
.yes { background: #1F1710; color: #fff; font-weight: 700; padding: 2px 7px; border-radius: 3px; font-size: 10px; } .no { color: #6B5D49; }
.et { font-weight: 700; margin-top: 3px; font-size: 11px; }
.src { font-size: 8.5px; font-weight: 700; padding: 2px 6px; border-radius: 3px; border: 1px solid #1F1710; }
.st { width: 190px; } .line { border-bottom: 1px solid #8A7B65; height: 15px; }
.hold { display: inline-block; background: #1F1710; color: #fff; font-weight: 700; font-size: 10px; padding: 2px 8px; border-radius: 3px; } .reason { margin-top: 4px; font-weight: 700; font-size: 11px; }
.foot { margin-top: 10px; font-size: 9px; color: #4A3F31; } .empty { padding: 40px; text-align: center; font-size: 14px; color: #6B5D49; }
</style></head><body>
<div class="top"><div><h1>BANJARA GEAR</h1><div class="sub">Production list &mdash; ${prod ? "Orders in production" : "New orders (not started yet)"}</div></div>
<div class="meta"><b>Printed: ${esc(fmtShort(today))} ${today.slice(0, 4)}, ${printedAt}</b><br>Printed by: ${esc(user.name)}</div></div>
<div class="sum">${pills}</div>
${list.length ? `<table><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${empty}</div>`}
<div class="foot">${foot}</div>
</body></html>`;
}

function PrintListPage({ orders, settings, user, productNameFor, loading, error, onRetry }) {
  const frame = useRef(null);
  const [mode, setMode] = useState("new");
  const list = useMemo(() => (mode === "production" ? productionOrders(orders) : printableOrders(orders, settings)), [orders, settings, mode]);
  const html = useMemo(() => buildPrintHtml(list, { user, productNameFor, mode }), [list, user, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const print = () => {
    const w = frame.current && frame.current.contentWindow;
    if (!w) return;
    const old = document.title;
    document.title = `Production-list-${mode === "production" ? "in-production" : "new-orders"}-${todayISO()}`; // becomes the PDF file name
    const restore = () => { document.title = old; window.removeEventListener("afterprint", restore); };
    window.addEventListener("afterprint", restore);
    w.focus();
    w.print();
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Printer size={20} style={{ color: TOKENS.saddle }} />
          <h1 className="text-xl font-bold" style={{ color: TOKENS.ink }}>Print list</h1>
        </div>
        <button onClick={print} disabled={loading && orders.length === 0} className="rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50" style={{ backgroundColor: TOKENS.saddle }}>
          Print / Save as PDF
        </button>
      </div>
      <div className="mt-3 inline-flex rounded-xl p-1" style={{ backgroundColor: TOKENS.hide }}>
        {[["new", "New orders"], ["production", "In production"]].map(([k, label]) => (
          <button key={k} onClick={() => setMode(k)} className="rounded-lg px-4 py-1.5 text-sm font-semibold" style={{ backgroundColor: mode === k ? "white" : "transparent", color: mode === k ? TOKENS.ink : "#8A7B65" }}>
            {label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs" style={{ color: "#A8977F" }}>
        {mode === "production" ? "Orders being made now, most urgent first. Orders on hold show their reason." : "All new orders that haven't started production, most urgent first."} In the print window, choose "Save as PDF" to download it.
      </p>
      {error && (
        <div className="mt-4 rounded-xl p-3 text-sm" style={{ backgroundColor: "#FBEAE5", color: "#B23A22" }}>
          {error} <button onClick={onRetry} className="font-bold underline ml-1">Try again</button>
        </div>
      )}
      <div className="mt-4 rounded-2xl border overflow-hidden bg-white" style={{ borderColor: TOKENS.line }}>
        <iframe ref={frame} title="Production list" srcDoc={html} className="w-full block" style={{ height: "68vh", border: 0 }} />
      </div>
    </div>
  );
}

/* ----------------------------- Custom order form ----------------------------- */
function CustomOrderForm({ products, settings, onClose, onCreate }) {
  const active = products.filter((p) => !p.archived);
  const first = active[0];
  const [form, setForm] = useState({
    orderNumber: "", customer: "", productId: first ? first.id : "", productName: "", quantity: 1,
    color: first?.colors[0] || "", leatherType: first?.leatherType || "", engravingOn: false, engravingText: "", notes: "",
    orderDate: todayISO(), dueDate: "", channel: "WhatsApp",
  });
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const product = active.find((p) => p.id === form.productId);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const canSubmit = form.orderNumber.trim() && (form.productId || form.productName.trim()) && !saving;

  const pickProduct = (id) => {
    const np = active.find((p) => p.id === id);
    setForm((f) => ({ ...f, productId: id, leatherType: np?.leatherType || "", color: np?.colors[0] || "" }));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError("");
    try {
      await onCreate({
        orderNumber: form.orderNumber.trim(),
        customer: form.customer.trim() || "Walk-in",
        orderDate: form.orderDate || todayISO(),
        dueDate: form.dueDate,
        channel: form.channel,
        productId: form.productId || null,
        productName: form.productId ? "" : form.productName.trim(),
        quantity: form.quantity,
        color: form.color,
        leatherType: form.leatherType,
        engravingOn: form.engravingOn,
        engravingText: form.engravingText,
        notes: form.notes,
      }, files);
      onClose();
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ backgroundColor: "rgba(0,0,0,0.45)" }}>
      <div className="h-full w-full md:w-[480px] overflow-y-auto" style={{ backgroundColor: TOKENS.paper }}>
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3.5 border-b" style={{ borderColor: TOKENS.line, backgroundColor: TOKENS.paper }}>
          <p className="text-base font-bold" style={{ color: TOKENS.ink }}>Add custom order</p>
          <button onClick={onClose}><X size={19} style={{ color: TOKENS.ink }} /></button>
        </div>
        <div className="p-4 space-y-4 pb-10">
          <Field label="Order number"><input value={form.orderNumber} onChange={(e) => set("orderNumber", e.target.value)} placeholder="e.g. 10530" className="input" /></Field>
          <Field label="Order came from">
            <select value={form.channel} onChange={(e) => set("channel", e.target.value)} className="input">
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Customer name (optional)"><input value={form.customer} onChange={(e) => set("customer", e.target.value)} placeholder="Walk-in — name" className="input" /></Field>
          <Field label="Product">
            <select value={form.productId} onChange={(e) => pickProduct(e.target.value)} className="input">
              {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="">Other (not in Product Library)</option>
            </select>
          </Field>
          {!form.productId && (
            <Field label="Product name"><input value={form.productName} onChange={(e) => set("productName", e.target.value)} placeholder="e.g. Custom wallet" className="input" /></Field>
          )}
          <Field label="Quantity"><input type="number" min={1} value={form.quantity} onChange={(e) => set("quantity", e.target.value)} className="input" /></Field>
          <Field label="Leather color">
            <input list="order-colors" value={form.color} onChange={(e) => set("color", e.target.value)} placeholder="e.g. Tan" className="input" />
            <datalist id="order-colors">{(product?.colors || []).map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Leather type"><input value={form.leatherType} onChange={(e) => set("leatherType", e.target.value)} placeholder="e.g. Oily Pull-Up" className="input" /></Field>
          <div className="flex items-center justify-between rounded-xl border p-3" style={{ borderColor: TOKENS.line }}>
            <span className="text-sm font-semibold" style={{ color: TOKENS.ink }}>Laser engraving</span>
            <button onClick={() => set("engravingOn", !form.engravingOn)} className="rounded-full px-3 py-1 text-xs font-bold" style={{ backgroundColor: form.engravingOn ? TOKENS.status.pending.bg : TOKENS.hide, color: form.engravingOn ? TOKENS.status.pending.fg : "#8A7B65" }}>
              {form.engravingOn ? "Yes" : "No"}
            </button>
          </div>
          {form.engravingOn && <Field label="Engraving text"><input value={form.engravingText} onChange={(e) => set("engravingText", e.target.value)} placeholder="Text to engrave" className="input" /></Field>}
          <Field label="Special instructions"><textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} className="input" /></Field>
          <Field label="Order date"><input type="date" value={form.orderDate} onChange={(e) => set("orderDate", e.target.value)} className="input" /></Field>
          <Field label="Due date (optional)"><input type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} className="input" /></Field>
          <p className="text-[11px] -mt-2" style={{ color: "#A8977F" }}>If left empty, the due date is set automatically ({settings.productionDays} production working days) when production starts.</p>
          <Field label="Photos (optional)">
            <input type="file" accept="image/*" multiple onChange={(e) => { const picked = Array.from(e.target.files || []).map((file) => ({ file, label: "Other" })); setFiles((f) => [...f, ...picked]); e.target.value = ""; }} className="text-xs" />
            {files.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {files.map((f, i) => (
                  <span key={i} className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px]" style={{ backgroundColor: TOKENS.hide, color: TOKENS.ink }}>
                    {f.file.name.slice(0, 18)}
                    <button onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}><X size={11} /></button>
                  </span>
                ))}
              </div>
            )}
          </Field>
          {error && <p className="text-sm" style={{ color: "#C24A2E" }}>{error}</p>}
          <button onClick={submit} disabled={!canSubmit} className="w-full rounded-xl py-3 text-sm font-bold text-white disabled:opacity-40 flex items-center justify-center gap-2" style={{ backgroundColor: TOKENS.saddle }}>
            {saving && <Loader2 size={15} className="animate-spin" />} {saving ? "Creating…" : "Create order"}
          </button>
        </div>
      </div>
    </div>
  );
}
function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: "#8A7B65" }}>{label}</span>
      {children}
    </label>
  );
}

/* ----------------------------- Members / Settings / Account ----------------------------- */
/* ----------------------------- Finance (owner only) ----------------------------- */
const rs = (n) => `${Number(n) < 0 ? "−" : ""}Rs ${Math.abs(Math.round(Number(n) || 0)).toLocaleString("en-US")}`;
const weekStartOf = (iso) => { const d = parseDate(iso); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return toISODate(d); }; // Monday
const shiftDays = (iso, n) => { const d = parseDate(iso); d.setDate(d.getDate() + n); return toISODate(d); };
const monthStartOf = (iso) => `${iso.slice(0, 8)}01`;
const addMonths = (iso, n) => { const d = parseDate(iso); d.setMonth(d.getMonth() + n, 1); return toISODate(d); };
const monthEndOf = (iso) => shiftDays(addMonths(monthStartOf(iso), 1), -1);

// A number box that saves when you tap away from it
function MoneyInput({ value, onCommit, placeholder, label }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(value == null ? "" : String(value)); }, [value]);
  const commit = async () => {
    const clean = text.trim();
    if (clean === (value == null ? "" : String(value))) return;
    const n = clean === "" ? null : Number(clean);
    if (n !== null && (!Number.isFinite(n) || n < 0)) { setText(value == null ? "" : String(value)); return; }
    setBusy(true);
    try { await onCommit(n); } finally { setBusy(false); }
  };
  return (
    <input type="number" inputMode="decimal" min="0" aria-label={label} value={text} placeholder={placeholder} disabled={busy}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      className="input" style={{ padding: "0.4rem 0.6rem", textAlign: "right" }} />
  );
}

// The printable report. Plain HTML like the print list; nothing depends on color.
function buildFinanceReportHtml(d, { user }) {
  const by = d.by === "delivered" ? "delivered" : "dispatched";
  const range = `${fmtShort(d.from)} ${d.from.slice(0, 4)} – ${fmtShort(d.to)} ${d.to.slice(0, 4)}`;
  const printedAt = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const cols = [["Shopify orders", d.shopify], ["Custom orders", d.custom], ["All orders", d.total]];
  const line = (label, f, bold) => `<tr class="${bold ? "tot" : ""}"><td>${label}</td>${cols.map(([, g]) => `<td class="n">${f(g)}</td>`).join("")}</tr>`;
  const returned = d.orders.filter((o) => o.returned);
  const counted = d.orders.filter((o) => !o.returned);
  const orderRow = (o) => `<tr class="${o.returned ? "ret" : ""}"><td class="b">#${esc(o.order_number)}</td><td>${esc(o.grp === "custom" ? (o.channel || "Custom") : "Shopify")}</td><td>${esc(o.product)} &times; ${esc(o.quantity)}</td><td>${fmtShort(o.on_date)}</td><td>${o.payment === "online" ? "Paid online" : "COD"}</td><td class="n">${o.amount == null ? "&mdash;" : esc(rs(o.amount))}</td><td class="n">${o.cost == null ? "&mdash;" : esc(rs(o.cost))}</td><td>${o.returned ? "<b>RETURNED</b>" : ""}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Finance report</title><style>
@page { size: A4 portrait; margin: 12mm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: Arial, Helvetica, sans-serif; color: #1F1710; font-size: 11px; margin: 0; background: #fff; }
@media screen { body { min-width: 640px; padding: 14px 18px; } }
.top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #1F1710; padding-bottom: 7px; }
h1 { margin: 0; font-size: 22px; letter-spacing: 1px; } .sub { font-size: 11px; color: #4A3F31; margin-top: 2px; }
.meta { text-align: right; font-size: 11px; line-height: 1.5; }
h2 { font-size: 12px; letter-spacing: .6px; text-transform: uppercase; margin: 16px 0 6px; }
table { width: 100%; border-collapse: collapse; } thead { display: table-header-group; } tr { page-break-inside: avoid; }
th { background: #1F1710; color: #fff; text-align: left; font-size: 9.5px; letter-spacing: .5px; text-transform: uppercase; padding: 6px; }
th.n, td.n { text-align: right; }
td { padding: 6px; border-bottom: 1px solid #B9AC96; vertical-align: top; } td.b { font-weight: 700; white-space: nowrap; }
tr.tot td { font-weight: 700; font-size: 12.5px; border-top: 2px solid #1F1710; border-bottom: 2px solid #1F1710; }
tr.ret td { background: #EDEDED; }
.box { border: 2px solid #1F1710; border-radius: 6px; padding: 8px 10px; margin-top: 10px; font-size: 12px; } .box b { font-size: 14px; }
.small { font-size: 9.5px; color: #4A3F31; margin-top: 4px; } .foot { margin-top: 14px; font-size: 9px; color: #4A3F31; }
</style></head><body>
<div class="top"><div><h1>BANJARA GEAR</h1><div class="sub">Finance report &mdash; ${esc(range)}</div><div class="sub">Orders counted by the day they were ${by}</div></div>
<div class="meta"><b>Printed: ${esc(fmtShort(todayISO()))} ${todayISO().slice(0, 4)}, ${printedAt}</b><br>Printed by: ${esc(user.name)}<br>Owner only</div></div>
<h2>Summary</h2>
<table><thead><tr><th></th>${cols.map(([n]) => `<th class="n">${n}</th>`).join("")}</tr></thead><tbody>
${line("Orders counted", (g) => esc(g.sold_count))}
${line("Sales (revenue)", (g) => esc(rs(g.revenue)))}
${line("&nbsp;&nbsp;of which cash on delivery", (g) => esc(rs(g.cod_revenue)))}
${line("&nbsp;&nbsp;of which paid online", (g) => esc(rs(g.online_revenue)))}
${line(`Leopards deduction (${esc(d.leopards_pct)}% of COD)`, (g) => `&minus; ${esc(rs(g.leopards))}`)}
${line("Cost of making", (g) => `&minus; ${esc(rs(g.cost))}`)}
${line("Ads money spent", (g) => (g === d.custom ? "&mdash;" : `&minus; ${esc(rs(g.ads))}`))}
${line("Profit", (g) => esc(rs(g.profit)), true)}
</tbody></table>
<div class="box"><b>${esc(d.total.returned_count)}</b> order${d.total.returned_count === 1 ? " was" : "s were"} returned (${esc(rs(d.total.returned_amount))}). Returned orders are not counted in sales, the Leopards deduction or cost.</div>
${d.total.missing_price || d.total.missing_cost ? `<div class="small">Note: ${d.total.missing_price ? esc(d.total.missing_price) + " order(s) have no price. " : ""}${d.total.missing_cost ? esc(d.total.missing_cost) + " order(s) have no cost of making. " : ""}Profit is higher than it really is until these are filled in.</div>` : ""}
${returned.length ? `<h2>Returned orders</h2><table><thead><tr><th>Order</th><th>From</th><th>Product</th><th>${by === "delivered" ? "Delivered" : "Dispatched"}</th><th>Paid</th><th class="n">Amount</th><th class="n">Cost</th><th></th></tr></thead><tbody>${returned.map(orderRow).join("")}</tbody></table>` : ""}
<h2>Orders counted (${counted.length})</h2>
${counted.length ? `<table><thead><tr><th>Order</th><th>From</th><th>Product</th><th>${by === "delivered" ? "Delivered" : "Dispatched"}</th><th>Paid</th><th class="n">Amount</th><th class="n">Cost</th><th></th></tr></thead><tbody>${counted.map(orderRow).join("")}</tbody></table>` : "<p>No orders in these dates.</p>"}
<div class="foot">Leopards deduction applies to cash-on-delivery orders only. Ads money is entered for these exact dates and counts against Shopify orders only.</div>
</body></html>`;
}

function FinanceReport({ data, user, onClose }) {
  const frame = useRef(null);
  const html = useMemo(() => buildFinanceReportHtml(data, { user }), [data, user]);
  const print = () => {
    const w = frame.current && frame.current.contentWindow;
    if (!w) return;
    const old = document.title;
    document.title = `Finance-report-${data.from}-to-${data.to}`; // becomes the PDF file name
    const restore = () => { document.title = old; window.removeEventListener("afterprint", restore); };
    window.addEventListener("afterprint", restore);
    w.focus();
    w.print();
  };
  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ backgroundColor: "rgba(36,28,21,0.6)" }}>
      <div className="flex items-center justify-between gap-3 p-3" style={{ backgroundColor: TOKENS.paper }}>
        <button onClick={onClose} className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: TOKENS.ink }}><ArrowLeft size={16} /> Back</button>
        <button onClick={print} className="rounded-xl px-4 py-2 text-sm font-bold text-white" style={{ backgroundColor: TOKENS.saddle }}>Print / Save as PDF</button>
      </div>
      <iframe ref={frame} title="Finance report" srcDoc={html} className="flex-1 w-full bg-white" style={{ border: 0 }} />
    </div>
  );
}

function FinancePage({ products, user }) {
  const [mode, setMode] = useState("month"); // week | month | custom
  const [by, setBy] = useState("dispatched"); // which date decides if an order counts
  const [weekStart, setWeekStart] = useState(() => weekStartOf(todayISO()));
  const [monthStart, setMonthStart] = useState(() => monthStartOf(todayISO()));
  const [customFrom, setCustomFrom] = useState(() => monthStartOf(todayISO()));
  const [customTo, setCustomTo] = useState(() => todayISO());
  const [data, setData] = useState(null);
  const [prodFin, setProdFin] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reportOpen, setReportOpen] = useState(false);

  const [from, to] = mode === "week" ? [weekStart, shiftDays(weekStart, 6)] : mode === "month" ? [monthStart, monthEndOf(monthStart)] : [customFrom, customTo];
  const load = useCallback(async () => {
    if (!from || !to) return;
    try {
      setData(await fetchRangeFinance(from, to, by));
      setError("");
    } catch (e) {
      setData(null);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [from, to, by]);
  useEffect(() => { setLoading(true); load(); }, [load]);
  useEffect(() => {
    fetchProductFinance().then((rows) => setProdFin(Object.fromEntries(rows.map((r) => [r.product_id, { sell: r.sell_price, cost: r.cost }])))).catch((e) => setError(e.message));
  }, []);

  const run = async (fn) => { try { await fn(); await load(); } catch (e) { setError(e.message); } };
  const thisWeek = weekStartOf(todayISO());
  const thisMonth = monthStartOf(todayISO());
  const range = mode === "month"
    ? parseDate(monthStart).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : `${fmtShort(from)} ${from.slice(0, 4) === to.slice(0, 4) ? "" : from.slice(0, 4) + " "}– ${fmtShort(to)} ${to.slice(0, 4)}`;
  const periodWord = mode === "week" ? "week" : mode === "month" ? "month" : "period";
  const atNow = mode === "week" ? weekStart >= thisWeek : monthStart >= thisMonth;
  const step = (dir) => (mode === "week" ? setWeekStart(shiftDays(weekStart, 7 * dir)) : setMonthStart(addMonths(monthStart, dir)));
  const d = data;
  const pct = d ? Number(d.leopards_pct) : 4;

  const setProductValue = async (id, key, v) => {
    const cur = prodFin[id] || {};
    const next = { ...cur, [key]: v };
    setProdFin((m) => ({ ...m, [id]: next }));
    await run(() => saveProductFinance(id, { sell_price: next.sell ?? null, cost: next.cost ?? null }));
  };

  const seg = ({ value, onChange, items }) => (
    <div className="inline-flex rounded-xl p-1" style={{ backgroundColor: TOKENS.hide }}>
      {items.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)} className="rounded-lg px-3.5 py-1.5 text-sm font-semibold" style={{ backgroundColor: value === k ? "white" : "transparent", color: value === k ? TOKENS.ink : "#8A7B65" }}>{label}</button>
      ))}
    </div>
  );
  const group = ({ title, g, adsBox }) => (
    <Section title={title}>
      <Row label={`Sales (${g.sold_count} order${g.sold_count === 1 ? "" : "s"})`} value={rs(g.revenue)} />
      <Row label="of which cash on delivery (COD)" value={rs(g.cod_revenue)} />
      <Row label="of which paid online (no deduction)" value={rs(g.online_revenue)} />
      <Row label={`Leopards deduction (${pct}% of COD)`} value={`− ${rs(g.leopards)}`} />
      <Row label="Cost of making" value={`− ${rs(g.cost)}`} />
      {adsBox ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span style={{ color: "#8A7B65" }}>Ads money spent (these dates)</span>
          <div className="w-32"><MoneyInput label="Ads money spent" value={d.ads || null} placeholder="0" onCommit={(n) => run(() => saveAdTotal(from, to, n ?? 0))} /></div>
        </div>
      ) : (
        <Row label="Ads money spent" value="none" />
      )}
      <div className="border-t pt-2" style={{ borderColor: TOKENS.line }}><Row label="Profit" value={rs(g.profit)} /></div>
    </Section>
  );

  return (
    <div className="p-4 md:p-8 max-w-3xl">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Calculator size={20} style={{ color: TOKENS.saddle }} />
          <h1 className="text-xl font-bold" style={{ color: TOKENS.ink }}>Finance</h1>
          <span className="text-[11px] font-semibold rounded px-1.5 py-0.5" style={{ backgroundColor: TOKENS.hide, color: "#8A7B65" }}>Owner only</span>
        </div>
        <button onClick={() => setReportOpen(true)} disabled={!d} className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ backgroundColor: TOKENS.saddle }}><Printer size={15} /> Print report</button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {seg({ value: mode, onChange: setMode, items: [["week", "Week"], ["month", "Month"], ["custom", "Pick dates"]] })}
      </div>

      {mode === "custom" ? (
        <div className="mt-3 grid grid-cols-2 gap-3 rounded-xl border p-3" style={{ borderColor: TOKENS.line, backgroundColor: "white" }}>
          <label className="text-xs font-semibold" style={{ color: "#8A7B65" }}>From
            <input type="date" aria-label="From date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} className="input mt-1" />
          </label>
          <label className="text-xs font-semibold" style={{ color: "#8A7B65" }}>To
            <input type="date" aria-label="To date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} className="input mt-1" />
          </label>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border p-2" style={{ borderColor: TOKENS.line, backgroundColor: "white" }}>
          <button aria-label={`Previous ${periodWord}`} onClick={() => step(-1)} className="p-2 rounded-lg"><ChevronLeft size={18} /></button>
          <div className="text-center">
            <p className="text-sm font-bold" style={{ color: TOKENS.ink }}>{range}</p>
            <p className="text-[11px]" style={{ color: "#A8977F" }}>{atNow ? `This ${periodWord}` : <button onClick={() => (mode === "week" ? setWeekStart(thisWeek) : setMonthStart(thisMonth))} className="underline font-semibold">Go to this {periodWord}</button>}</p>
          </div>
          <button aria-label={`Next ${periodWord}`} onClick={() => step(1)} disabled={atNow} className="p-2 rounded-lg disabled:opacity-30"><ChevronRight size={18} /></button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold" style={{ color: "#8A7B65" }}>Count orders by the day they were</span>
        {seg({ value: by, onChange: setBy, items: [["dispatched", "Dispatched"], ["delivered", "Delivered"]] })}
      </div>

      {error && <div className="mt-3 rounded-xl p-3 text-sm" style={{ backgroundColor: "#FBEAE5", color: "#B23A22" }}>{error}</div>}
      {loading && !d && <p className="mt-4 text-sm" style={{ color: "#A8977F" }}>Loading…</p>}

      {d && (
        <>
          <div className="mt-4 rounded-2xl p-4 text-white" style={{ backgroundColor: TOKENS.ink }}>
            <p className="text-xs uppercase tracking-wide" style={{ color: "#C9BCA8" }}>Total profit · {range}</p>
            <p className="text-3xl font-bold mt-1" data-testid="profit">{rs(d.total.profit)}</p>
            <p className="text-xs mt-1" style={{ color: "#C9BCA8" }}>
              Sales {rs(d.total.revenue)} · {d.total.sold_count} order{d.total.sold_count === 1 ? "" : "s"} counted
            </p>
            {d.total.returned_count > 0 && (
              <p className="text-xs mt-1 font-semibold" style={{ color: "#F0E4D0" }}>{d.total.returned_count} order{d.total.returned_count === 1 ? " was" : "s were"} returned ({rs(d.total.returned_amount)}), not counted</p>
            )}
          </div>

          {(d.total.missing_price > 0 || d.total.missing_cost > 0) && (
            <div className="mt-3 rounded-xl px-3 py-2.5 text-sm font-semibold" style={{ backgroundColor: "#FBEAD3", color: "#9A5A12" }}>
              {d.total.missing_price > 0 && <p>{d.total.missing_price} order{d.total.missing_price === 1 ? " has" : "s have"} no price yet. Type it in the list below.</p>}
              {d.total.missing_cost > 0 && <p>{d.total.missing_cost} order{d.total.missing_cost === 1 ? " has" : "s have"} no cost of making. Set it under Product prices and costs.</p>}
              <p className="text-xs font-normal mt-0.5">Profit is higher than it really is until these are filled in.</p>
            </div>
          )}

          <div className="mt-4">{group({ title: "Shopify orders", g: d.shopify, adsBox: true })}</div>
          <div className="mt-4">{group({ title: "Custom orders (no ads)", g: d.custom })}</div>
          <div className="mt-4">
            <Section title="All orders together">
              <Row label="Sales" value={rs(d.total.revenue)} />
              <Row label="Leopards deduction" value={`− ${rs(d.total.leopards)}`} />
              <Row label="Cost of making" value={`− ${rs(d.total.cost)}`} />
              <Row label="Ads money spent" value={`− ${rs(d.total.ads)}`} />
              <div className="border-t pt-2" style={{ borderColor: TOKENS.line }}><Row label="Profit" value={rs(d.total.profit)} /></div>
            </Section>
          </div>

          <div className="mt-4">
            <Section title={`Orders in these dates (${d.orders.length})`}>
              {d.orders.length === 0 && <p className="text-sm" style={{ color: "#A8977F" }}>No orders were {by} in this period.</p>}
              {d.orders.map((o) => (
                <div key={o.id} className="py-2 border-b last:border-b-0" style={{ borderColor: TOKENS.line }}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold" style={{ color: TOKENS.ink }}>#{o.order_number} <span className="text-[11px] font-semibold" style={{ color: "#8A7B65" }}>{o.grp === "custom" ? (o.channel || "Custom") : "Shopify"}</span> {o.returned && <span className="ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold text-white" style={{ backgroundColor: TOKENS.ink }}>RETURNED</span>}</p>
                    <p className="text-[11px] shrink-0" style={{ color: "#8A7B65" }}>{by} {fmtShort(o.on_date)}</p>
                  </div>
                  <p className="text-xs truncate" style={{ color: "#8A7B65" }}>{o.product} × {o.quantity}{o.cost != null ? ` · cost ${rs(o.cost)}` : " · no cost set"}</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="w-28"><MoneyInput label={`Amount for order ${o.order_number}`} value={o.amount} placeholder="Price" onCommit={(n) => run(() => saveOrderAmount(o.id, n))} /></div>
                    <button onClick={() => run(() => saveOrderPayment(o.id, o.payment === "cod" ? "online" : "cod"))} aria-label={`Payment for order ${o.order_number}`} className="rounded-lg border px-2.5 py-1.5 text-[11px] font-bold whitespace-nowrap" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}>{o.payment === "cod" ? "COD" : "Paid online"}</button>
                    <button onClick={() => run(() => setOrderReturned(o.id, !o.returned))} className="ml-auto rounded-lg border px-2.5 py-1.5 text-[11px] font-bold whitespace-nowrap" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}>{o.returned ? "Undo return" : "Returned"}</button>
                  </div>
                </div>
              ))}
              <p className="text-[11px]" style={{ color: "#A8977F" }}>Tap COD / Paid online to switch how an order was paid. Only COD orders get the Leopards deduction.</p>
            </Section>
          </div>
        </>
      )}

      <details className="mt-4 rounded-xl border bg-white" style={{ borderColor: TOKENS.line }}>
        <summary className="cursor-pointer p-3 text-sm font-bold" style={{ color: TOKENS.ink }}>Product prices and costs</summary>
        <div className="px-3 pb-3">
          <p className="text-xs mb-2" style={{ color: "#A8977F" }}>Cost of making is used for every order. Selling price is used only when an order has no price of its own (old orders and custom orders).</p>
          <div className="grid grid-cols-[1fr_6rem_6rem] gap-2 text-[11px] font-semibold uppercase" style={{ color: "#8A7B65" }}>
            <span>Product</span><span className="text-right">Sell price</span><span className="text-right">Cost</span>
          </div>
          {products.map((p) => (
            <div key={p.id} className="grid grid-cols-[1fr_6rem_6rem] gap-2 items-center mt-1.5">
              <span className="text-sm truncate" style={{ color: TOKENS.ink }}>{p.name}</span>
              <MoneyInput label={`${p.name} selling price`} value={prodFin[p.id]?.sell ?? null} placeholder="—" onCommit={(n) => setProductValue(p.id, "sell", n)} />
              <MoneyInput label={`${p.name} cost`} value={prodFin[p.id]?.cost ?? null} placeholder="—" onCommit={(n) => setProductValue(p.id, "cost", n)} />
            </div>
          ))}
          <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3" style={{ borderColor: TOKENS.line }}>
            <span className="text-sm" style={{ color: "#8A7B65" }}>Leopards deduction (%)</span>
            <div className="w-24"><MoneyInput label="Leopards deduction percent" value={pct} onCommit={(n) => run(() => saveLeopardsPct(n ?? 4))} /></div>
          </div>
        </div>
      </details>
      <p className="mt-3 text-[11px]" style={{ color: "#A8977F" }}>Returned orders are left out of sales, the Leopards deduction and cost. Ads money is saved for the exact dates you picked and counts against Shopify orders only.</p>
      {reportOpen && d && <FinanceReport data={d} user={user} onClose={() => setReportOpen(false)} />}
    </div>
  );
}

function MembersPage({ user }) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchProfiles()
      .then((rows) => setMembers(rows))
      .catch(() => setError("Couldn't load members right now."));
  }, [user.id]);

  return (
    <div className="p-4 md:p-8 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold" style={{ color: TOKENS.ink }}>Members</h1>
        <button className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-white" style={{ backgroundColor: TOKENS.saddle }}><Plus size={14} /> Add member</button>
      </div>
      <p className="mt-1 text-xs" style={{ color: "#A8977F" }}>New accounts are created in Supabase for now — this list reflects real logins.</p>
      <div className="mt-4 space-y-2">
        {error && <p className="text-sm" style={{ color: "#C24A2E" }}>{error}</p>}
        {members === null && !error && <p className="text-sm" style={{ color: "#A8977F" }}>Loading…</p>}
        {members?.map((u) => (
          <div key={u.id} className="flex items-center gap-3 rounded-xl border p-3" style={{ borderColor: TOKENS.line }}>
            <Avatar name={u.name || "?"} />
            <div className="flex-1">
              <p className="text-sm font-semibold" style={{ color: TOKENS.ink }}>{u.name}</p>
              <p className="text-xs capitalize" style={{ color: "#8A7B65" }}>{u.role}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsPage({ settings, onSave }) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState({ text: "", bad: false });
  useEffect(() => { setDraft(settings); }, [settings]);
  const toggleDay = (d) => {
    setDraft((s) => ({ ...s, workingDays: s.workingDays.includes(d) ? s.workingDays.filter((x) => x !== d) : [...s.workingDays, d].sort() }));
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const save = async () => {
    if (!draft.workingDays.length) { setMsg({ text: "Pick at least one working day.", bad: true }); return; }
    setSaving(true);
    setMsg({ text: "", bad: false });
    try {
      await onSave(draft);
      setMsg({ text: "Saved.", bad: false });
    } catch (e) {
      setMsg({ text: e.message, bad: true });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="p-4 md:p-8 max-w-lg">
      <h1 className="text-xl font-bold" style={{ color: TOKENS.ink }}>Settings</h1>
      <div className="mt-5 space-y-5">
        <Field label="Production days">
          <input type="number" min={1} value={draft.productionDays} onChange={(e) => setDraft((s) => ({ ...s, productionDays: Number(e.target.value) || 1 }))} className="input" />
        </Field>
        <Field label="Courier days">
          <input type="number" min={1} value={draft.courierDays} onChange={(e) => setDraft((s) => ({ ...s, courierDays: Number(e.target.value) || 1 }))} className="input" />
        </Field>
        <Field label="Working days">
          <div className="flex gap-1.5 flex-wrap">
            {DOW_NAMES.map((name, i) => (
              <button key={i} onClick={() => toggleDay(i)} className="rounded-lg px-3 py-2 text-xs font-bold" style={{ backgroundColor: draft.workingDays.includes(i) ? TOKENS.saddle : TOKENS.hide, color: draft.workingDays.includes(i) ? "white" : "#8A7B65" }}>
                {name}
              </button>
            ))}
          </div>
        </Field>
        <p className="text-xs" style={{ color: "#A8977F" }}>These apply to orders from now on (due dates are worked out when production starts and when an order is dispatched). The owner can still change dates on any order.</p>
        {msg.text && <p className="text-sm" style={{ color: msg.bad ? "#C24A2E" : "#3F7D4E" }}>{msg.text}</p>}
        <button onClick={save} disabled={!dirty || saving} className="w-full rounded-xl py-3 text-sm font-bold text-white disabled:opacity-40" style={{ backgroundColor: TOKENS.saddle }}>{saving ? "Saving…" : "Save settings"}</button>
      </div>
    </div>
  );
}

function AccountPage({ user }) {
  return (
    <div className="p-4 md:p-8 max-w-md">
      <h1 className="text-xl font-bold mb-5" style={{ color: TOKENS.ink }}>Account</h1>
      <div className="rounded-2xl border p-4 flex items-center gap-3" style={{ borderColor: TOKENS.line }}>
        <Avatar name={user.name} size={44} />
        <div>
          <p className="text-sm font-bold" style={{ color: TOKENS.ink }}>{user.name}</p>
          <p className="text-xs" style={{ color: "#8A7B65" }}>{user.email}</p>
          <p className="text-xs capitalize mt-0.5" style={{ color: "#8A7B65" }}>{user.role === "owner" ? "Owner · full access" : "Production member"}</p>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- App root ----------------------------- */
export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [page, setPage] = useState("dashboard");
  const [moreOpen, setMoreOpen] = useState(false);
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState("");
  const [stats, setStats] = useState(null);
  const [deliveredKey, setDeliveredKey] = useState(0);
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState("");
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState("");
  const [editingProduct, setEditingProduct] = useState(null); // null | "new" | product
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [initialConfirm, setInitialConfirm] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [showCustomForm, setShowCustomForm] = useState(false);

  // Resume a previous login (so staff aren't asked to sign in every time they open the app)
  useEffect(() => {
    let cancelled = false;
    restoreSession().then((u) => {
      if (cancelled) return;
      if (u) setUser(u);
      setBooting(false);
    });
    return () => { cancelled = true; };
  }, []);

  const refreshProducts = useCallback(async () => {
    setProductsLoading(true);
    setProductsError("");
    try {
      setProducts(await loadProducts());
    } catch (e) {
      setProductsError(e.message || "Couldn't load products.");
    } finally {
      setProductsLoading(false);
    }
  }, []);

  // `quiet` = background refresh: no spinner, and errors don't wipe what's on screen
  const refreshOrders = useCallback(async (quiet = false) => {
    if (!quiet) { setOrdersLoading(true); setOrdersError(""); }
    try {
      const [list, st] = await Promise.all([loadActiveOrders(), loadStats()]);
      setOrders(list);
      setStats(st);
      setOrdersError("");
      setDeliveredKey((k) => k + 1);
    } catch (e) {
      if (!quiet) setOrdersError(e.message || "Couldn't load orders.");
    } finally {
      if (!quiet) setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    refreshProducts();
    refreshOrders();
    loadSettings().then((s) => { if (s) setSettings(s); }).catch(() => {});
    // Pick up changes made by other people every 45 seconds, only while the tab is visible
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshOrders(true);
    }, 45000);
    return () => clearInterval(timer);
  }, [user, refreshProducts, refreshOrders]);

  const logout = () => {
    supabaseSignOut();
    setUser(null);
    setProducts([]);
    setOrders([]);
    setStats(null);
    setSelectedProduct(null);
    setEditingProduct(null);
    setSelectedOrder(null);
    setNotice("");
    setPage("dashboard");
  };

  const toggleArchive = async (product) => {
    await setProductArchived(product.id, !product.archived);
    await refreshProducts();
  };

  const showNotice = (text) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? "" : n)), 6000);
  };

  // Move an order forward. Throws on failure so the caller (detail panel) can show the message.
  const advanceOrder = useCallback(async (order, toStatus) => {
    try {
      const updated = await advanceOrderStatus(order.id, order.status, toStatus);
      setSelectedOrder((o) => (o && o.id === order.id ? (toStatus === "delivered" ? null : updated) : o));
      await refreshOrders(true);
      if (toStatus === "delivered") showNotice(`Order #${order.orderNumber} marked delivered.`);
    } catch (e) {
      if (e.code === "CONFLICT") { setSelectedOrder(null); await refreshOrders(true); }
      throw e;
    }
  }, [refreshOrders]);

  const changeHold = async (order, reason) => {
    try {
      const updated = await setOrderHold(order.id, reason);
      setSelectedOrder(updated);
      await refreshOrders(true);
    } catch (e) {
      if (e.code === "CONFLICT") { setSelectedOrder(null); await refreshOrders(true); }
      throw e;
    }
  };

  // Same thing from a list row: errors show in the banner instead
  const advanceFromList = async (order, toStatus) => {
    setBusyId(order.id);
    try {
      await advanceOrder(order, toStatus);
    } catch (e) {
      showNotice(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const createCustomOrder = async (fields, files) => {
    const created = await createOrderRecord(fields);
    if (files.length) {
      try { await addOrderPhotos(created.id, files); }
      catch (e) { showNotice(`Order created, but a photo didn't upload: ${e.message}`); }
    }
    await refreshOrders(true);
  };

  const saveOrderChanges = async (orderId, fields) => {
    const updated = await updateOrderDetails(orderId, fields);
    setSelectedOrder(updated);
    await refreshOrders(true);
  };

  const removeOrder = async (order, photos) => {
    await deleteOrderRecord(order.id, photos);
    setSelectedOrder(null);
    await refreshOrders(true);
  };

  const saveSettingsChanges = async (s) => {
    setSettings(await saveSettings(s));
  };

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: TOKENS.ink }}>
        <Loader2 size={22} className="animate-spin" style={{ color: "#C9BCA8" }} />
      </div>
    );
  }
  if (!user) return <LoginScreen onLogin={setUser} />;

  const isOwner = user.role === "owner";
  const productFor = (o) => products.find((p) => p.id === o.productId);
  const productNameFor = (o) => productFor(o)?.name || o.productName || "Custom item";
  const freshSelectedProduct = selectedProduct ? (products.find((p) => p.id === selectedProduct.id) || selectedProduct) : null;
  const openOrder = (o) => { setSelectedOrder(o); setInitialConfirm(null); };
  const listProps = {
    productNameFor, isOwner, settings, onOpen: openOrder,
    onStartProduction: (o) => advanceFromList(o, "production"),
    onQuickAction: (o, action) => { setSelectedOrder(o); setInitialConfirm(action); },
    busyId,
  };

  let content;
  if (page === "dashboard") content = <Dashboard orders={orders} stats={stats} setPage={setPage} settings={settings} user={user} />;
  else if (page === "delivered") content = <DeliveredPage productNameFor={productNameFor} total={stats ? stats.delivered : null} refreshKey={deliveredKey} onOpen={openOrder} />;
  else if (["pending", "production", "completed", "dispatched"].includes(page)) content = <OrderListPage status={page} orders={orders} loading={ordersLoading} error={ordersError} onRetry={() => refreshOrders()} {...listProps} />;
  else if (page === "print") content = <PrintListPage orders={orders} settings={settings} user={user} productNameFor={productNameFor} loading={ordersLoading} error={ordersError} onRetry={() => refreshOrders()} />;
  else if (page === "products") content = <ProductsPage products={products} loading={productsLoading} error={productsError} user={user} onOpenProduct={setSelectedProduct} onAdd={() => setEditingProduct("new")} onRetry={refreshProducts} />;
  else if (page === "finance" && isOwner) content = <FinancePage products={products} user={user} />;
  else if (page === "members" && isOwner) content = <MembersPage user={user} />;
  else if (page === "settings" && isOwner) content = <SettingsPage settings={settings} onSave={saveSettingsChanges} />;
  else if (page === "account") content = <AccountPage user={user} />;
  else content = <Dashboard orders={orders} stats={stats} setPage={setPage} settings={settings} user={user} />;

  const liveSelected = selectedOrder ? (orders.find((o) => o.id === selectedOrder.id) || selectedOrder) : null;

  return (
    <div className="flex min-h-screen" style={{ backgroundColor: TOKENS.paper, fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif" }}>
      <style>{`.input { width:100%; border-radius:0.75rem; border:1px solid ${TOKENS.line}; padding:0.6rem 0.75rem; font-size:0.875rem; outline:none; background:white; color:${TOKENS.ink}; }`}</style>
      <SidebarNav page={page} setPage={setPage} user={user} onLogout={logout} />
      <div className="flex-1 min-w-0 flex flex-col">
        <MobileTopBar user={user} onLogout={logout} />
        {notice && (
          <div className="mx-4 md:mx-8 mt-3 flex items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-sm" style={{ backgroundColor: TOKENS.status.pending.bg, color: TOKENS.ink }}>
            <span>{notice}</span>
            <button onClick={() => setNotice("")}><X size={15} /></button>
          </div>
        )}
        <div className="flex-1 pb-20 md:pb-0">{content}</div>
      </div>

      {isOwner && page !== "account" && !selectedOrder && !selectedProduct && !editingProduct && (
        <button onClick={() => setShowCustomForm(true)} className="fixed bottom-20 md:bottom-6 right-4 md:right-8 flex items-center gap-1.5 rounded-full px-4 py-3 text-sm font-bold text-white shadow-lg z-30" style={{ backgroundColor: TOKENS.saddle }}>
          <Plus size={16} /> Custom order
        </button>
      )}

      <MobileBottomNav page={page} setPage={setPage} user={user} moreOpen={moreOpen} setMoreOpen={setMoreOpen} />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} page={page} setPage={setPage} user={user} />

      {liveSelected && (
        <OrderDetail
          key={liveSelected.id}
          order={liveSelected}
          product={productFor(liveSelected)}
          productName={productNameFor(liveSelected)}
          settings={settings}
          user={user}
          onClose={() => { setSelectedOrder(null); setInitialConfirm(null); }}
          onAdvance={advanceOrder}
          onHold={changeHold}
          onSave={saveOrderChanges}
          onDelete={removeOrder}
          initialConfirm={initialConfirm}
        />
      )}
      {freshSelectedProduct && (
        <ProductDetail
          product={freshSelectedProduct}
          user={user}
          onClose={() => setSelectedProduct(null)}
          onEdit={(p) => setEditingProduct(p)}
          onToggleArchive={toggleArchive}
        />
      )}
      {editingProduct && (
        <ProductForm
          product={editingProduct === "new" ? null : editingProduct}
          onClose={() => setEditingProduct(null)}
          onSaved={async () => { await refreshProducts(); setEditingProduct(null); }}
        />
      )}
      {showCustomForm && <CustomOrderForm products={products} settings={settings} onClose={() => setShowCustomForm(false)} onCreate={createCustomOrder} />}
    </div>
  );
}
