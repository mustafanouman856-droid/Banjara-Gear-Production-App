import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  Home, Clock, Factory, CheckCircle2, Truck, PackageCheck, Boxes, User, LogOut,
  Settings as SettingsIcon, Users, Plus, X, ChevronRight, ChevronLeft, Search,
  AlertTriangle, Zap, Image as ImageIcon, Edit2, Archive, ShoppingBag, Tag,
  Calendar, MapPin, ClipboardList, Check, ArrowLeft, Eye, EyeOff, Loader2
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

async function refreshSession() {
  if (!session?.refreshToken) throw new Error("Not signed in.");
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
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
  const res = await fetch(url, { ...options, headers });
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
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
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
  try {
    const body = await res.json();
    return body.message || body.error || fallback;
  } catch (e) {
    return fallback;
  }
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
  const blob = await compressImage(file);
  const path = `${productId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
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

/* ----------------------------- Sample data (products/orders are still demo data — real login is live) ----------------------------- */

/* USERS is no longer used for login — real accounts live in Supabase. Kept here only as a fallback label list. */


const SAMPLE_PRODUCTS = [
  {
    id: "p1", name: "Aviator Bag", leatherType: "Oily Pull-Up",
    colors: ["Tan", "Brown", "Black"], engravingAvailable: true,
    photos: [
      { label: "Main", url: "https://images.unsplash.com/photo-1547949003-9792a18a2645?w=600&q=60" },
      { label: "Back", url: "https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=600&q=60" },
      { label: "Hardware", url: "https://images.unsplash.com/photo-1590874103328-eac38a683ce7?w=600&q=60" },
    ],
    instructions: "Skive edges to 1.2mm before folding. Hand-stitch handles with 1mm waxed thread, 6 stitches/inch. Burnish all visible edges twice.",
    archived: false,
  },
  {
    id: "p2", name: "Weekender Duffel", leatherType: "Vegetable Tan",
    colors: ["Chestnut", "Black"], engravingAvailable: true,
    photos: [
      { label: "Main", url: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=600&q=60" },
      { label: "Inside", url: "https://images.unsplash.com/photo-1526178613658-3f1622045557?w=600&q=60" },
    ],
    instructions: "Line interior with waxed canvas before assembling gussets. Reinforce strap tabs with 4-point box stitch.",
    archived: false,
  },
  {
    id: "p3", name: "Minimalist Cardholder", leatherType: "Chromexcel",
    colors: ["Tan", "Burgundy", "Black", "Olive"], engravingAvailable: true,
    photos: [
      { label: "Main", url: "https://images.unsplash.com/photo-1627123424574-724758594e93?w=600&q=60" },
    ],
    instructions: "Single fold, contrast stitch optional per order note. Corner-round all edges with 3mm punch.",
    archived: false,
  },
  {
    id: "p4", name: "Classic Belt", leatherType: "Bridle Leather",
    colors: ["Black", "Brown", "Tan"], engravingAvailable: false,
    photos: [
      { label: "Main", url: "https://images.unsplash.com/photo-1624222247344-550fb60583dc?w=600&q=60" },
    ],
    instructions: "Cut to spec width 3.5cm. Nickel buckle standard unless order specifies brass.",
    archived: false,
  },
];

const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, n) => {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const addWorkingDays = (dateStr, n, workingDays) => {
  let d = new Date(dateStr);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay(); // 0 = Sun
    if (workingDays.includes(dow)) added++;
  }
  return d.toISOString().slice(0, 10);
};
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmt = (dateStr) => {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const dayName = (dateStr) => DOW_NAMES[new Date(dateStr).getDay()];

const mkOrder = (o) => {
  const base = {
    history: [{ event: "Order created", by: "Shopify", at: o.orderDate }],
    ...o,
  };
  return base;
};

const today = todayISO();
const INITIAL_ORDERS = [
  mkOrder({ id: "o1", orderNumber: "10501", source: "SHOPIFY", customer: "Sana Farooq", orderDate: addDays(today, -6), status: "pending", productId: "p1", quantity: 1, color: "Tan", engraving: { on: true, text: "SANA" }, notes: "", }),
  mkOrder({ id: "o2", orderNumber: "10502", source: "SHOPIFY", customer: "Hamza Iqbal", orderDate: addDays(today, -5), status: "production", productId: "p2", quantity: 2, color: "Chestnut", engraving: { on: false, text: "" }, notes: "Customer wants matching gift box.", }),
  mkOrder({ id: "o3", orderNumber: "10503", source: "CUSTOM", customer: "Walk-in — Faisal", orderDate: addDays(today, -4), status: "production", productId: "p3", quantity: 5, color: "Black", engraving: { on: true, text: "F.K." }, notes: "Corporate gift order, rush requested.", }),
  mkOrder({ id: "o4", orderNumber: "10504", source: "SHOPIFY", customer: "Ayesha Malik", orderDate: addDays(today, -3), status: "completed", productId: "p4", quantity: 1, color: "Brown", engraving: { on: false, text: "" }, notes: "", }),
  mkOrder({ id: "o5", orderNumber: "10505", source: "SHOPIFY", customer: "Zainab Sheikh", orderDate: addDays(today, -9), status: "dispatched", productId: "p1", quantity: 1, color: "Black", engraving: { on: true, text: "Z.S." }, notes: "", }),
  mkOrder({ id: "o6", orderNumber: "10506", source: "SHOPIFY", customer: "Omar Siddiqui", orderDate: addDays(today, -14), status: "delivered", productId: "p2", quantity: 1, color: "Black", engraving: { on: false, text: "" }, notes: "", }),
  mkOrder({ id: "o7", orderNumber: "10507", source: "CUSTOM", customer: "Walk-in — Nadia", orderDate: addDays(today, -1), status: "pending", productId: "p3", quantity: 3, color: "Olive", engraving: { on: false, text: "" }, notes: "", }),
  mkOrder({ id: "o8", orderNumber: "10508", source: "SHOPIFY", customer: "Bilal Ahmed", orderDate: addDays(today, -2), status: "production", productId: "p4", quantity: 1, color: "Tan", engraving: { on: false, text: "" }, notes: "", }),
];

const DEFAULT_SETTINGS = { productionDays: 3, courierDays: 3, workingDays: [1, 2, 3, 4, 5, 6] }; // Mon-Sat

const STATUS_META = {
  pending:    { label: "Pending",    icon: Clock,        nav: "Pending" },
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
  { key: "pending", label: "Pending", icon: Clock, roles: ["owner", "production"] },
  { key: "production", label: "Production", icon: Factory, roles: ["owner", "production"] },
  { key: "completed", label: "Completed", icon: CheckCircle2, roles: ["owner", "production"] },
  { key: "dispatched", label: "Dispatched", icon: Truck, roles: ["owner", "production"] },
  { key: "delivered", label: "Delivered", icon: PackageCheck, roles: ["owner", "production"] },
  { key: "products", label: "Products", icon: Boxes, roles: ["owner", "production"] },
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

/* ----------------------------- Dashboard ----------------------------- */
function Dashboard({ orders, setPage, settings, user }) {
  const counts = useMemo(() => {
    const c = { pending: 0, production: 0, completed: 0, dispatched: 0, delivered: 0 };
    orders.forEach((o) => c[o.status]++);
    return c;
  }, [orders]);

  const overdue = orders.filter((o) => o.status === "production" && o.dueDate < today).length;
  const dueToday = orders.filter((o) => o.status === "production" && o.dueDate === today).length;
  const engravingOrders = orders.filter((o) => o.engraving?.on && ["pending", "production"].includes(o.status)).length;
  const completedToday = orders.filter((o) => o.status === "completed" && o.history.some(h => h.event === "Marked completed" && h.at === today)).length;

  const cards = [
    { key: "pending", label: "Pending", count: counts.pending, icon: Clock },
    { key: "production", label: "Production", count: counts.production, icon: Factory },
    { key: "completed", label: "Completed", count: counts.completed, icon: CheckCircle2 },
    { key: "dispatched", label: "Dispatched", count: counts.dispatched, icon: Truck },
    { key: "delivered", label: "Delivered", count: counts.delivered, icon: PackageCheck },
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
              <p className="mt-3 text-2xl font-bold" style={{ color: s.fg }}>{c.count}</p>
              <p className="text-xs font-semibold" style={{ color: s.fg }}>{c.label}</p>
            </button>
          );
        })}
      </div>

      <div className="mt-6 grid md:grid-cols-2 gap-3">
        <div className="rounded-2xl border p-4" style={{ borderColor: TOKENS.line }}>
          <p className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: "#8A7B65" }}>Needs attention</p>
          <div className="space-y-2.5">
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
            <div className="flex items-center justify-between"><span style={{ color: TOKENS.ink }}>Completed today</span><span className="font-bold" style={{ color: TOKENS.ink }}>{completedToday}</span></div>
            <div className="flex items-center justify-between"><span style={{ color: TOKENS.ink }}>Awaiting dispatch</span><span className="font-bold" style={{ color: TOKENS.ink }}>{counts.completed}</span></div>
            <div className="flex items-center justify-between"><span style={{ color: TOKENS.ink }}>With courier</span><span className="font-bold" style={{ color: TOKENS.ink }}>{counts.dispatched}</span></div>
          </div>
          <p className="mt-3 text-[11px]" style={{ color: "#A8977F" }}>Standard cycle: {settings.productionDays} production days + {settings.courierDays} courier days, {settings.workingDays.length}-day work week.</p>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Order list ----------------------------- */
function OrderRow({ order, product, onOpen, onStartProduction, onQuickAction }) {
  const isOverdue = order.status === "production" && order.dueDate < today;
  const hoursWaiting = order.status === "pending" ? Math.floor((Date.now() - new Date(order.orderDate).getTime()) / 36e5) : 0;
  const quickAction = order.status === "completed" ? { key: "dispatch", label: "Mark Dispatched", color: TOKENS.status.dispatched.fg }
    : order.status === "dispatched" ? { key: "deliver", label: "Mark Delivered", color: TOKENS.status.delivered.fg }
    : null;
  return (
    <div className="w-full text-left rounded-2xl border p-3.5 flex items-center gap-3 transition hover:shadow-sm" style={{ borderColor: isOverdue ? "#E3B2A0" : TOKENS.line, backgroundColor: isOverdue ? "#FDF4F1" : "white" }}>
      <button onClick={() => onOpen(order)} className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-bold" style={{ color: TOKENS.ink }}>#{order.orderNumber}</p>
          <SourceTag source={order.source} />
          <EngravingTag engraving={order.engraving} />
        </div>
        <p className="text-sm mt-0.5 truncate" style={{ color: "#5A4E3F" }}>{product?.name || "Unknown product"} · Qty {order.quantity} · {order.color}</p>
        <p className="text-xs mt-1" style={{ color: isOverdue ? "#C24A2E" : "#A8977F" }}>
          {order.status === "production" ? `Due ${fmt(order.dueDate)}${isOverdue ? " · overdue" : ""}` : order.status === "pending" ? `Waiting ${hoursWaiting}h · entered ${fmt(order.orderDate)}` : `Ordered ${fmt(order.orderDate)}`}
        </p>
      </button>
      {order.status === "pending" && onStartProduction && (
        <button onClick={() => onStartProduction(order)} className="shrink-0 rounded-lg px-3 py-2 text-xs font-bold text-white" style={{ backgroundColor: TOKENS.status.production.fg }}>
          Start Production
        </button>
      )}
      {quickAction && onQuickAction && (
        <button onClick={() => onQuickAction(order, quickAction.key)} className="shrink-0 rounded-lg px-3 py-2 text-xs font-bold text-white" style={{ backgroundColor: quickAction.color }}>
          {quickAction.label}
        </button>
      )}
      {order.status !== "pending" && !quickAction && <button onClick={() => onOpen(order)}><ChevronRight size={18} style={{ color: "#C9BCA8" }} className="shrink-0" /></button>}
    </div>
  );
}

function OrderListPage({ status, orders, products, onOpen, onStartProduction, onQuickAction }) {
  const [q, setQ] = useState("");
  const meta = STATUS_META[status];
  const list = orders
    .filter((o) => o.status === status)
    .filter((o) => !q || o.orderNumber.includes(q) || o.customer.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.dueDate || a.orderDate) < (b.dueDate || b.orderDate) ? -1 : 1);

  return (
    <div className="p-4 md:p-8 max-w-3xl">
      <div className="flex items-center gap-2.5">
        <meta.icon size={20} style={{ color: TOKENS.saddle }} />
        <h1 className="text-xl font-bold" style={{ color: TOKENS.ink }}>{meta.label}</h1>
        <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ backgroundColor: TOKENS.hide, color: "#8A7B65" }}>{list.length}</span>
      </div>
      {status === "pending" && (
        <p className="mt-2 text-xs" style={{ color: "#A8977F" }}>Orders normally move to Production automatically after 24 hours. Anyone can start one early.</p>
      )}
      <div className="mt-4 relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#A8977F" }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order # or customer" className="w-full rounded-xl border pl-9 pr-3 py-2.5 text-sm outline-none" style={{ borderColor: TOKENS.line }} />
      </div>
      <div className="mt-4 space-y-2.5">
        {list.length === 0 && <p className="text-sm py-10 text-center" style={{ color: "#A8977F" }}>Nothing here right now.</p>}
        {list.map((o) => <OrderRow key={o.id} order={o} product={products.find((p) => p.id === o.productId)} onOpen={onOpen} onStartProduction={onStartProduction} onQuickAction={onQuickAction} />)}
      </div>
    </div>
  );
}

/* ----------------------------- Order detail ----------------------------- */
function ConfirmBar({ label, question, onConfirm, onCancel, tone = TOKENS.saddle }) {
  return (
    <div className="rounded-xl border p-3.5" style={{ borderColor: tone, backgroundColor: "#FBF3EA" }}>
      <p className="text-sm font-semibold" style={{ color: TOKENS.ink }}>{label}</p>
      <p className="text-xs mt-0.5 mb-3" style={{ color: "#5A4E3F" }}>{question}</p>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-lg border py-2 text-sm font-semibold" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}>Cancel</button>
        <button onClick={onConfirm} className="flex-1 rounded-lg py-2 text-sm font-semibold text-white" style={{ backgroundColor: tone }}>Yes, confirm</button>
      </div>
    </div>
  );
}

function OrderDetail({ order, product, user, onClose, onAdvance, onUpdate, initialConfirm }) {
  const [confirming, setConfirming] = useState(initialConfirm || null); // 'complete' | 'dispatch' | 'deliver' | 'start'
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const isOverdue = order.status === "production" && order.dueDate < today;
  const effectiveLeatherType = order.leatherType || product?.leatherType || "—";

  const act = (action, event) => {
    onAdvance(order.id, action, event, user.name);
    setConfirming(null);
  };

  const startEdit = () => {
    setDraft({
      quantity: order.quantity,
      color: order.color,
      leatherType: effectiveLeatherType,
      engravingOn: !!order.engraving?.on,
      engravingText: order.engraving?.text || "",
      notes: order.notes || "",
    });
    setEditing(true);
  };
  const saveEdit = () => {
    onUpdate(order.id, {
      quantity: Number(draft.quantity) || 1,
      color: draft.color,
      leatherType: draft.leatherType,
      engraving: { on: draft.engravingOn, text: draft.engravingText },
      notes: draft.notes,
    }, user.name);
    setEditing(false);
  };

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

          {product && (
            <div className="rounded-2xl overflow-hidden border" style={{ borderColor: TOKENS.line }}>
              <div className="grid grid-cols-3 gap-0.5">
                {product.photos.slice(0, 3).map((ph, i) => (
                  <img key={i} src={ph.url} alt={ph.label} loading="lazy" className="h-24 w-full object-cover" />
                ))}
              </div>
              <div className="p-3">
                <p className="text-sm font-bold" style={{ color: TOKENS.ink }}>{product.name}</p>
                <p className="text-xs mt-0.5" style={{ color: "#8A7B65" }}>{product.leatherType}</p>
              </div>
            </div>
          )}

          <Section title="Order information">
            <Row label="Order date" value={`${fmt(order.orderDate)} (${dayName(order.orderDate)})`} />
            <Row label="Due / production date" value={order.dueDate ? `${fmt(order.dueDate)} (${dayName(order.dueDate)})` : "—"} />
            <Row label="Expected delivery" value={order.expectedDelivery ? fmt(order.expectedDelivery) : "—"} />
            <Row label="Customer" value={order.customer} />
            <Row label="Source" value={order.source} />
          </Section>

          <Section
            title="Product"
            action={user.role === "owner" && !editing && (
              <button onClick={startEdit} className="flex items-center gap-1 text-xs font-semibold" style={{ color: TOKENS.saddle }}>
                <Edit2 size={12} /> Edit
              </button>
            )}
          >
            {!editing ? (
              <>
                <Row label="Quantity" value={order.quantity} />
                <Row label="Leather color" value={order.color} />
                <Row label="Leather type" value={effectiveLeatherType} />
              </>
            ) : (
              <>
                <Field label="Quantity"><input type="number" min={1} value={draft.quantity} onChange={(e) => setDraft((d) => ({ ...d, quantity: e.target.value }))} className="input" /></Field>
                <Field label="Leather color">
                  {product ? (
                    <select value={draft.color} onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))} className="input">
                      {product.colors.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : (
                    <input value={draft.color} onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))} className="input" />
                  )}
                </Field>
                <Field label="Leather type"><input value={draft.leatherType} onChange={(e) => setDraft((d) => ({ ...d, leatherType: e.target.value }))} placeholder="e.g. Oily Pull-Up" className="input" /></Field>
              </>
            )}
          </Section>

          <Section title="Customization">
            {!editing ? (
              <>
                <Row label="Laser engraving" value={order.engraving?.on ? "Yes" : "No"} highlight={order.engraving?.on} />
                {order.engraving?.on && <Row label="Engraving text" value={order.engraving.text || "—"} />}
                <Row label="Special instructions" value={order.notes || "None"} />
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold" style={{ color: TOKENS.ink }}>Laser engraving</span>
                  <button onClick={() => setDraft((d) => ({ ...d, engravingOn: !d.engravingOn }))} className="rounded-full px-3 py-1 text-xs font-bold" style={{ backgroundColor: draft.engravingOn ? TOKENS.status.pending.bg : TOKENS.hide, color: draft.engravingOn ? TOKENS.status.pending.fg : "#8A7B65" }}>
                    {draft.engravingOn ? "Yes" : "No"}
                  </button>
                </div>
                {draft.engravingOn && <Field label="Engraving text"><input value={draft.engravingText} onChange={(e) => setDraft((d) => ({ ...d, engravingText: e.target.value }))} className="input" /></Field>}
                <Field label="Special instructions"><textarea value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} rows={3} className="input" /></Field>
                <div className="flex gap-2 pt-1">
                  <button onClick={() => setEditing(false)} className="flex-1 rounded-lg border py-2 text-sm font-semibold" style={{ borderColor: TOKENS.line, color: TOKENS.ink }}>Cancel</button>
                  <button onClick={saveEdit} className="flex-1 rounded-lg py-2 text-sm font-semibold text-white" style={{ backgroundColor: TOKENS.saddle }}>Save changes</button>
                </div>
              </>
            )}
          </Section>

          {product?.instructions && (
            <Section title="Production notes">
              <p className="text-sm" style={{ color: "#5A4E3F" }}>{product.instructions}</p>
            </Section>
          )}

          <Section title="History">
            <div className="space-y-2">
              {order.history.map((h, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <div className="mt-1 h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: TOKENS.saddle }} />
                  <p style={{ color: "#5A4E3F" }}><span className="font-semibold" style={{ color: TOKENS.ink }}>{h.event}</span> · {h.by} · {fmt(h.at)}</p>
                </div>
              ))}
            </div>
          </Section>
        </div>

        <div className="sticky bottom-0 p-4 border-t" style={{ borderColor: TOKENS.line, backgroundColor: TOKENS.paper }}>
          {order.status === "pending" && !confirming && (
            <button onClick={() => setConfirming("start")} className="w-full rounded-xl py-3 text-sm font-bold text-white" style={{ backgroundColor: TOKENS.status.production.fg }}>
              Start Production
            </button>
          )}
          {order.status === "production" && !confirming && (
            <button onClick={() => setConfirming("complete")} className="w-full rounded-xl py-3 text-sm font-bold text-white" style={{ backgroundColor: TOKENS.status.completed.fg }}>
              Mark as Completed
            </button>
          )}
          {order.status === "completed" && user.role === "owner" && !confirming && (
            <button onClick={() => setConfirming("dispatch")} className="w-full rounded-xl py-3 text-sm font-bold text-white" style={{ backgroundColor: TOKENS.status.dispatched.fg }}>
              Mark as Dispatched
            </button>
          )}
          {order.status === "dispatched" && user.role === "owner" && !confirming && (
            <button onClick={() => setConfirming("deliver")} className="w-full rounded-xl py-3 text-sm font-bold text-white" style={{ backgroundColor: TOKENS.status.delivered.fg }}>
              Mark as Delivered
            </button>
          )}
          {order.status === "completed" && user.role !== "owner" && (
            <p className="text-center text-xs" style={{ color: "#A8977F" }}>Waiting on the owner to dispatch this order.</p>
          )}

          {confirming === "start" && (
            <ConfirmBar label={`Start production on #${order.orderNumber}?`} question="This moves the order out of Pending and into the Production queue now." onCancel={() => setConfirming(null)} onConfirm={() => act("production", "Started production")} tone={TOKENS.status.production.fg} />
          )}
          {confirming === "complete" && (
            <ConfirmBar label={`Complete Order #${order.orderNumber}?`} question="Are you sure this order has been completed?" onCancel={() => setConfirming(null)} onConfirm={() => act("completed", "Marked completed")} tone={TOKENS.status.completed.fg} />
          )}
          {confirming === "dispatch" && (
            <ConfirmBar label={`Dispatch Order #${order.orderNumber}?`} question="Confirm this order has left for the courier." onCancel={() => setConfirming(null)} onConfirm={() => act("dispatched", "Marked dispatched")} tone={TOKENS.status.dispatched.fg} />
          )}
          {confirming === "deliver" && (
            <ConfirmBar label={`Mark Order #${order.orderNumber} delivered?`} question="Confirm this order has reached the customer." onCancel={() => setConfirming(null)} onConfirm={() => act("delivered", "Marked delivered")} tone={TOKENS.status.delivered.fg} />
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

/* ----------------------------- Custom order form ----------------------------- */
function CustomOrderForm({ products, settings, onClose, onCreate }) {
  const active = products.filter((p) => !p.archived);
  const [form, setForm] = useState({
    orderNumber: "", customer: "", productId: active[0]?.id, quantity: 1,
    color: active[0]?.colors[0] || "", leatherType: active[0]?.leatherType || "", engravingOn: false, engravingText: "", notes: "",
  });
  const product = active.find((p) => p.id === form.productId);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () => {
    if (!form.orderNumber) return;
    onCreate({
      id: `custom-${Date.now()}`,
      orderNumber: form.orderNumber,
      source: "CUSTOM",
      customer: form.customer || "Walk-in",
      orderDate: today,
      status: "pending",
      productId: form.productId,
      quantity: Number(form.quantity) || 1,
      color: form.color,
      leatherType: form.leatherType,
      engraving: { on: form.engravingOn, text: form.engravingText },
      notes: form.notes,
      history: [{ event: "Custom order created", by: "Owner", at: today }],
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ backgroundColor: "rgba(0,0,0,0.45)" }}>
      <div className="h-full w-full md:w-[480px] overflow-y-auto" style={{ backgroundColor: TOKENS.paper }}>
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3.5 border-b" style={{ borderColor: TOKENS.line, backgroundColor: TOKENS.paper }}>
          <p className="text-base font-bold" style={{ color: TOKENS.ink }}>Add custom order</p>
          <button onClick={onClose}><X size={19} style={{ color: TOKENS.ink }} /></button>
        </div>
        {active.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm font-semibold" style={{ color: TOKENS.ink }}>Add a product first</p>
            <p className="text-xs mt-1" style={{ color: "#A8977F" }}>Custom orders pick from the Product Library, and it's empty right now. Add at least one product, then come back.</p>
          </div>
        ) : (
        <div className="p-4 space-y-4 pb-10">
          <Field label="Order number"><input value={form.orderNumber} onChange={(e) => set("orderNumber", e.target.value)} placeholder="e.g. 10530" className="input" /></Field>
          <Field label="Customer name (optional)"><input value={form.customer} onChange={(e) => set("customer", e.target.value)} placeholder="Walk-in — name" className="input" /></Field>
          <Field label="Product">
            <select value={form.productId} onChange={(e) => { const np = active.find(p => p.id === e.target.value); setForm((f) => ({ ...f, productId: e.target.value, leatherType: np?.leatherType || "", color: np?.colors[0] || "" })); }} className="input">
              {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Quantity"><input type="number" min={1} value={form.quantity} onChange={(e) => set("quantity", e.target.value)} className="input" /></Field>
          <Field label="Leather color">
            <select value={form.color} onChange={(e) => set("color", e.target.value)} className="input">
              {product?.colors.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Leather type"><input value={form.leatherType} onChange={(e) => set("leatherType", e.target.value)} placeholder="e.g. Oily Pull-Up" className="input" /></Field>
          <p className="text-[11px] -mt-2" style={{ color: "#A8977F" }}>Pre-filled from the Product Library — change it here if this order needs something different.</p>
          <div className="flex items-center justify-between rounded-xl border p-3" style={{ borderColor: TOKENS.line }}>
            <span className="text-sm font-semibold" style={{ color: TOKENS.ink }}>Laser engraving</span>
            <button onClick={() => set("engravingOn", !form.engravingOn)} className="rounded-full px-3 py-1 text-xs font-bold" style={{ backgroundColor: form.engravingOn ? TOKENS.status.pending.bg : TOKENS.hide, color: form.engravingOn ? TOKENS.status.pending.fg : "#8A7B65" }}>
              {form.engravingOn ? "Yes" : "No"}
            </button>
          </div>
          {form.engravingOn && <Field label="Engraving text"><input value={form.engravingText} onChange={(e) => set("engravingText", e.target.value)} placeholder="Text to engrave" className="input" /></Field>}
          <Field label="Special instructions"><textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} className="input" /></Field>
          <p className="text-[11px]" style={{ color: "#A8977F" }}>Due date will auto-calculate: {settings.productionDays} production working days from today, once it enters production.</p>
          <button onClick={submit} disabled={!form.orderNumber} className="w-full rounded-xl py-3 text-sm font-bold text-white disabled:opacity-40" style={{ backgroundColor: TOKENS.saddle }}>Create order</button>
        </div>
        )}
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

function SettingsPage({ settings, setSettings }) {
  const toggleDay = (d) => {
    setSettings((s) => ({ ...s, workingDays: s.workingDays.includes(d) ? s.workingDays.filter((x) => x !== d) : [...s.workingDays, d].sort() }));
  };
  return (
    <div className="p-4 md:p-8 max-w-lg">
      <h1 className="text-xl font-bold" style={{ color: TOKENS.ink }}>Settings</h1>
      <div className="mt-5 space-y-5">
        <Field label="Production days">
          <input type="number" min={1} value={settings.productionDays} onChange={(e) => setSettings((s) => ({ ...s, productionDays: Number(e.target.value) || 1 }))} className="input" />
        </Field>
        <Field label="Courier days">
          <input type="number" min={1} value={settings.courierDays} onChange={(e) => setSettings((s) => ({ ...s, courierDays: Number(e.target.value) || 1 }))} className="input" />
        </Field>
        <Field label="Working days">
          <div className="flex gap-1.5 flex-wrap">
            {DOW_NAMES.map((name, i) => (
              <button key={i} onClick={() => toggleDay(i)} className="rounded-lg px-3 py-2 text-xs font-bold" style={{ backgroundColor: settings.workingDays.includes(i) ? TOKENS.saddle : TOKENS.hide, color: settings.workingDays.includes(i) ? "white" : "#8A7B65" }}>
                {name}
              </button>
            ))}
          </div>
        </Field>
        <p className="text-xs" style={{ color: "#A8977F" }}>These defaults apply to every new order. The owner can still override dates on individual orders.</p>
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
  const [orders, setOrders] = useState(INITIAL_ORDERS);
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

  // Load the real product library whenever someone is signed in
  useEffect(() => {
    if (user) refreshProducts();
  }, [user, refreshProducts]);

  const logout = () => {
    supabaseSignOut();
    setUser(null);
    setProducts([]);
    setSelectedProduct(null);
    setEditingProduct(null);
    setSelectedOrder(null);
    setPage("dashboard");
  };

  const toggleArchive = async (product) => {
    await setProductArchived(product.id, !product.archived);
    await refreshProducts();
  };

  const advanceOrder = useCallback((orderId, newStatus, event, by) => {
    setOrders((prev) => prev.map((o) => {
      if (o.id !== orderId) return o;
      const updated = { ...o, status: newStatus, history: [...o.history, { event, by, at: today }] };
      if (newStatus === "production") updated.dueDate = addWorkingDays(today, settings.productionDays, settings.workingDays);
      if (newStatus === "dispatched") updated.expectedDelivery = addWorkingDays(today, settings.courierDays, settings.workingDays);
      return updated;
    }));
    setSelectedOrder((o) => o && o.id === orderId ? { ...o, status: newStatus, history: [...o.history, { event, by, at: today }] } : o);
  }, [settings]);

  const createCustomOrder = (order) => setOrders((prev) => [order, ...prev]);

  const updateOrder = useCallback((orderId, changes, by) => {
    setOrders((prev) => prev.map((o) => o.id !== orderId ? o : {
      ...o, ...changes,
      history: [...o.history, { event: "Order details edited", by, at: today }],
    }));
    setSelectedOrder((o) => o && o.id === orderId ? { ...o, ...changes, history: [...o.history, { event: "Order details edited", by, at: today }] } : o);
  }, []);

  // ensure production/pending orders carry a computed due date based on current settings
  const ordersComputed = useMemo(() => orders.map((o) => {
    if (o.status === "production" && !o.dueDate) {
      return { ...o, dueDate: addWorkingDays(o.orderDate, settings.productionDays, settings.workingDays) };
    }
    if (!o.dueDate && o.status !== "pending") {
      return { ...o, dueDate: addWorkingDays(o.orderDate, settings.productionDays, settings.workingDays) };
    }
    return o;
  }), [orders, settings]);

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: TOKENS.ink }}>
        <Loader2 size={22} className="animate-spin" style={{ color: "#C9BCA8" }} />
      </div>
    );
  }
  if (!user) return <LoginScreen onLogin={setUser} />;

  // Orders can point at real products or (until orders move to the database) the demo ones
  const lookupProducts = [...products, ...SAMPLE_PRODUCTS];
  const productFor = (o) => lookupProducts.find((p) => p.id === o.productId);
  const freshSelectedProduct = selectedProduct ? (products.find((p) => p.id === selectedProduct.id) || selectedProduct) : null;

  let content;
  if (page === "dashboard") content = <Dashboard orders={ordersComputed} setPage={setPage} settings={settings} user={user} />;
  else if (["pending", "production", "completed", "dispatched", "delivered"].includes(page)) content = <OrderListPage status={page} orders={ordersComputed} products={lookupProducts} onOpen={(o) => { setSelectedOrder(o); setInitialConfirm(null); }} onStartProduction={(o) => advanceOrder(o.id, "production", "Started production", user.name)} onQuickAction={(o, action) => { setSelectedOrder(o); setInitialConfirm(action); }} />;
  else if (page === "products") content = <ProductsPage products={products} loading={productsLoading} error={productsError} user={user} onOpenProduct={setSelectedProduct} onAdd={() => setEditingProduct("new")} onRetry={refreshProducts} />;
  else if (page === "members" && user.role === "owner") content = <MembersPage user={user} />;
  else if (page === "settings" && user.role === "owner") content = <SettingsPage settings={settings} setSettings={setSettings} />;
  else if (page === "account") content = <AccountPage user={user} />;
  else content = <Dashboard orders={ordersComputed} setPage={setPage} settings={settings} user={user} />;

  return (
    <div className="flex min-h-screen" style={{ backgroundColor: TOKENS.paper, fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif" }}>
      <style>{`.input { width:100%; border-radius:0.75rem; border:1px solid ${TOKENS.line}; padding:0.6rem 0.75rem; font-size:0.875rem; outline:none; background:white; color:${TOKENS.ink}; }`}</style>
      <SidebarNav page={page} setPage={setPage} user={user} onLogout={logout} />
      <div className="flex-1 min-w-0 flex flex-col">
        <MobileTopBar user={user} onLogout={logout} />
        <div className="flex-1 pb-20 md:pb-0">{content}</div>
      </div>

      {user.role === "owner" && page !== "account" && !selectedOrder && !selectedProduct && !editingProduct && (
        <button onClick={() => setShowCustomForm(true)} className="fixed bottom-20 md:bottom-6 right-4 md:right-8 flex items-center gap-1.5 rounded-full px-4 py-3 text-sm font-bold text-white shadow-lg z-30" style={{ backgroundColor: TOKENS.saddle }}>
          <Plus size={16} /> Custom order
        </button>
      )}

      <MobileBottomNav page={page} setPage={setPage} user={user} moreOpen={moreOpen} setMoreOpen={setMoreOpen} />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} page={page} setPage={setPage} user={user} />

      {selectedOrder && (
        <OrderDetail order={ordersComputed.find(o => o.id === selectedOrder.id) || selectedOrder} product={productFor(selectedOrder)} user={user} onClose={() => { setSelectedOrder(null); setInitialConfirm(null); }} onAdvance={advanceOrder} onUpdate={updateOrder} initialConfirm={initialConfirm} />
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
