// parent-dashboard.js - logic for parent-dashboard.html
// Parents do not sign in. They type their phone number; the app opens the
// matching record by its exact id. Nothing can be listed or browsed.
import { db } from "./firebase-config.js";
import {
  doc, getDoc, collection, getDocs, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ============ Settings you can change ============ */
const DEFAULT_COUNTRY_CODE = "91";   // added when a parent types a 10-digit number
const CURRENCY = "Rs.";
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
  const a = await getDoc(doc(db, "attendanceSummary", `${child.id}_${cur}`));
  return { child, fee, feeMonth, att: a.exists() ? a.data() : null, attMonth: cur };
}

/* ---------- Rendering ---------- */
function row(dl, label, value, cls) {
  const dt = el("dt", cls, label);
  const dd = el("dd", cls, value);
  dl.append(dt, dd);
}

function renderChild({ child, fee, feeMonth, att, attMonth }) {
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

  // Attendance block
  const attBlock = el("div", "block");
  attBlock.append(el("h3", null, `Attendance · ${monthLabel(attMonth)}`));
  if (att && att.total > 0) {
    const stats = el("div", "stats");
    [["Present", att.present], ["Absent", att.absent], ["Leave", att.leave]].forEach(([label, n]) => {
      const d = el("div");
      d.append(el("strong", null, String(n)), el("span", null, label));
      stats.append(d);
    });
    attBlock.append(stats);
    const pct = Math.round((att.present / att.total) * 100);
    attBlock.append(el("p", "note", `Present on ${att.present} of ${att.total} school days marked (${pct}%).`));
    const bar = el("div", "bar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${pct}% attendance`);
    const fill = el("div");
    fill.style.width = pct + "%";
    bar.append(fill);
    attBlock.append(bar);
  } else {
    attBlock.append(el("p", "note", "No attendance has been recorded for this month yet."));
  }
  card.append(attBlock);
  return card;
}

/* ---------- Lookup ---------- */
$("lookupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("lookupMsg").hidden = true;
  $("results").innerHTML = "";

  const raw = $("phone").value;
  if (phoneCandidates(raw).length === 0) return showMsg("Enter the phone number you gave the school.");

  const btn = $("goBtn");
  btn.disabled = true;
  btn.textContent = "Looking…";
  try {
    const family = await findFamily(raw);
    if (!family || !Array.isArray(family.children) || family.children.length === 0) {
      return showMsg("No student found for this number. Please check the number, or contact the school office.");
    }
    const children = [...family.children].sort((a, b) => a.name.localeCompare(b.name));
    const data = await Promise.all(children.map(loadChild));
    data.forEach((d) => $("results").append(renderChild(d)));
    $("results").firstChild.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err);
    showMsg(err.code === "permission-denied"
      ? "This page is not set up yet. Please ask the school office."
      : "Could not load. Check your internet and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "View";
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
