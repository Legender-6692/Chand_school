// parent-dashboard.js - logic for parent-dashboard.html
// Parents sign in with their phone number (username) and the common school password.
// Under the hood one shared "parent" account is used, and the phone number
// opens the matching family record by its exact id. Nothing can be listed or browsed.
import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, collection, getDocs, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ============ Settings you can change ============ */
const DEFAULT_COUNTRY_CODE = "91";   // added when a parent types a 10-digit number
const CURRENCY = "Rs.";
// The shared parent account you create in Firebase Authentication (see setup steps).
// Parents never see or type this email.
const SHARED_PARENT_EMAIL = "parents@chandschool.app";
/* ================================================== */

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const money = (n) => `${CURRENCY} ${Number(n || 0).toLocaleString()}`;

function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function showMsg(text, type = "error") {
  const m = $("lookupMsg");
  m.textContent = text;
  m.className = "msg " + type;
  m.hidden = false;
}

/* ---------- Phone number -> possible record ids ---------- */
function phoneCandidates(raw) {
  const d = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (d.length < 7) return [];
  if (d.length <= 10 && DEFAULT_COUNTRY_CODE) return [DEFAULT_COUNTRY_CODE + d, d];
  return [d];
}

async function findFamily(raw) {
  for (const id of phoneCandidates(raw)) {
    const snap = await getDoc(doc(db, "parentIndex", id));
    if (snap.exists()) return snap.data();
  }
  return null;
}

async function loadChild(child) {
  const cur = monthKey(new Date());
  let fee = null, feeMonth = cur;
  for (const m of [cur, shiftMonth(cur, -1)]) {
    const s = await getDoc(doc(db, "fees", `${child.id}_${m}`));
    if (s.exists()) { fee = s.data(); feeMonth = m; break; }
  }
  return { child, fee, feeMonth };
}

/* ---------- Rendering ---------- */
function row(dl, label, value, cls) {
  const dt = el("dt", cls, label);
  const dd = el("dd", cls, value);
  dl.append(dt, dd);
}

function renderChild({ child, fee, feeMonth }) {
  const card = el("section", "card child");
  card.append(el("h2", null, child.name));
  card.append(el("p", "meta", `${child.class} · Roll no. ${child.rollNo}`));

  // Fee block
  const feeBlock = el("div", "block");
  const h = el("h3", null, "Fee");
  if (fee) {
    const balance = fee.totalDue - (fee.paid || 0);
    const status = balance <= 0 ? "paid" : (fee.paid || 0) > 0 ? "partial" : "unpaid";
    const badge = el("span", "badge " + status, { paid: "Paid", partial: "Partly paid", unpaid: "Unpaid" }[status]);
    h.append(badge);
    feeBlock.append(h);
    const dl = el("dl");
    row(dl, "Month", monthLabel(feeMonth));
    row(dl, "Monthly fee", money(fee.monthlyFee));
    row(dl, "Arrears (earlier unpaid)", fee.arrears > 0 ? money(fee.arrears) : "None");
    row(dl, "Total due", money(fee.totalDue));
    row(dl, "Paid so far", money(fee.paid || 0));
    row(dl, "Balance to pay", money(Math.max(0, balance)), "total");
    feeBlock.append(dl);
    if (feeMonth !== monthKey(new Date())) {
      feeBlock.append(el("p", "note", `This month's fee has not been added yet. Showing ${monthLabel(feeMonth)}.`));
    }
  } else {
    feeBlock.append(h);
    feeBlock.append(el("p", "note", "Fee details are not available yet. Please contact the school office."));
  }
  card.append(feeBlock);

  return card;
}

/* ---------- Sign in and show the family ---------- */
const SAVED_KEY = "chandParentPhone";
let busy = false;

function savedPhone() {
  try { return localStorage.getItem(SAVED_KEY) || sessionStorage.getItem(SAVED_KEY); }
  catch (e) { return null; }
}
function savePhone(id, remember) {
  try {
    localStorage.removeItem(SAVED_KEY); sessionStorage.removeItem(SAVED_KEY);
    (remember ? localStorage : sessionStorage).setItem(SAVED_KEY, id);
  } catch (e) { /* storage not available: they will just sign in again next time */ }
}
function forgetPhone() {
  try { localStorage.removeItem(SAVED_KEY); sessionStorage.removeItem(SAVED_KEY); } catch (e) { /* ignore */ }
}

function showSignedIn(signedIn, phoneId) {
  $("loginForm").hidden = signedIn;
  $("signedBar").hidden = !signedIn;
  if (phoneId) $("signedPhone").textContent = "+" + phoneId;
}

async function isParentUser(user) {
  const s = await getDoc(doc(db, "users", user.uid));
  return s.exists() && s.data().role === "parent" && s.data().active !== false;
}

// Shows the children linked to this phone number. Returns false if there are none.
async function showFamily(phoneId) {
  const snap = await getDoc(doc(db, "parentIndex", phoneId));
  if (!snap.exists() || !Array.isArray(snap.data().children) || snap.data().children.length === 0) return false;
  const children = [...snap.data().children].sort((a, b) => a.name.localeCompare(b.name));
  const data = await Promise.all(children.map(loadChild));
  $("results").innerHTML = "";
  data.forEach((d) => $("results").append(renderChild(d)));
  return true;
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("lookupMsg").hidden = true;
  $("results").innerHTML = "";

  const candidates = phoneCandidates($("phone").value);
  const password = $("password").value;
  if (candidates.length === 0) return showMsg("Enter the phone number you gave the school.");
  if (!password) return showMsg("Enter the password.");

  const btn = $("goBtn");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  busy = true;
  try {
    const remember = $("remember").checked;
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    const cred = await signInWithEmailAndPassword(auth, SHARED_PARENT_EMAIL, password);
    if (!(await isParentUser(cred.user))) {
      await signOut(auth);
      return showMsg("Parent login is not set up yet. Please ask the school office.");
    }
    let matched = null;
    for (const id of candidates) {
      if (await showFamily(id)) { matched = id; break; }
    }
    if (!matched) {
      await signOut(auth);
      return showMsg("No student found for this number. Please check it, or contact the school office.");
    }
    savePhone(matched, remember);
    $("password").value = "";
    showSignedIn(true, matched);
  } catch (err) {
    console.error(err);
    const text = {
      "auth/invalid-credential": "The password is not correct. Please ask the school office.",
      "auth/wrong-password": "The password is not correct. Please ask the school office.",
      "auth/user-not-found": "Parent login is not set up yet. Please ask the school office.",
      "auth/too-many-requests": "Too many attempts. Please wait a few minutes and try again.",
      "auth/network-request-failed": "No internet connection. Check your network and try again.",
      "permission-denied": "This page is not set up yet. Please ask the school office."
    }[err.code] || "Could not sign in. Please try again.";
    showMsg(text);
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

$("logoutBtn").addEventListener("click", async () => {
  forgetPhone();
  await signOut(auth);
  $("results").innerHTML = "";
  showSignedIn(false);
});

// Come back later: if still signed in on this phone, show the family straight away
onAuthStateChanged(auth, async (user) => {
  if (!user || busy) return;
  const saved = savedPhone();
  if (!saved) return;
  try {
    if (!(await isParentUser(user))) return;
    if (await showFamily(saved)) showSignedIn(true, saved);
  } catch (err) {
    console.error(err);
  }
});

/* ---------- Notices ---------- */
async function loadNotices() {
  const box = $("notices");
  try {
    const snap = await getDocs(query(collection(db, "notices"), orderBy("createdAt", "desc"), limit(10)));
    box.innerHTML = "";
    if (snap.empty) {
      box.append(el("p", "empty", "No notices right now."));
      return;
    }
    snap.docs.forEach((d) => {
      const n = d.data();
      const item = el("article", "notice");
      item.append(el("h3", null, n.title));
      item.append(el("time", null, n.date || ""));
      item.append(el("p", null, n.body));
      box.append(item);
    });
  } catch (err) {
    console.error(err);
    box.innerHTML = "";
    box.append(el("p", "empty", "Notices could not be loaded right now."));
  }
}
loadNotices();
