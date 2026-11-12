// fees.js - monthly fees and payments (admin only)
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, collection, getDocs, query, where, orderBy, limit,
  onSnapshot, setDoc, writeBatch, serverTimestamp, increment, deleteDoc, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ================= Settings you can change ================= */
const SCHOOL_NAME = "Chand Public High School";
const CURRENCY = "Rs.";
const CLASSES = [
  "Playgroup", "Nursery", "LKG", "UKG",
  "Class 1", "Class 2", "Class 3", "Class 4", "Class 5",
  "Class 6", "Class 7", "Class 8", "Class 9", "Class 10"
];

// The WhatsApp message sent to parents. Edit the wording here.
function reminderMessage(f) {
  const balance = f.totalDue - (f.paid || 0);
  const lines = [
    "Dear Parent,",
    "",
    `${SCHOOL_NAME} ki taraf se fee ki yaad-dihani.`,
    "",
    `Student: ${f.studentName} (${f.class}, Roll ${f.rollNo})`,
    `Month: ${monthLabel(f.month)}`,
    `Monthly fee: ${money(f.monthlyFee)}`,
    f.arrears > 0 ? `Pichla baaki (arrears): ${money(f.arrears)}` : null,
    f.paid > 0 ? `Ab tak jama: ${money(f.paid)}` : null,
    `Kul baaki: ${money(balance)}`,
    "",
    "Meherbani karke fee jald jama karayein. Shukriya.",
    `- ${SCHOOL_NAME}`
  ];
  return lines.filter((l) => l !== null).join("\n");
}
/* ============================================================ */

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const dateKey = (d) => `${monthKey(d)}-${pad(d.getDate())}`;
const money = (n) => `${CURRENCY} ${Number(n || 0).toLocaleString()}`;
const classIndex = (c) => CLASSES.indexOf(c);
const naturalCompare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

function shiftMonth(key, delta) {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}
function monthsBetween(a, b) {
  const [ya, ma] = a.split("-").map(Number);
  const [yb, mb] = b.split("-").map(Number);
  return (yb - ya) * 12 + (mb - ma);
}
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}
function showMsg(el, text, type = "error") {
  el.textContent = text;
  el.className = "msg " + type;
  el.hidden = false;
}
function cell(text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

let currentUser = null;
let role = null;
let started = false;

// Shows a visible error instead of bouncing the user between pages
function showFatal(text) {
  let box = document.getElementById("fatalBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "fatalBox";
    box.setAttribute("role", "alert");
    box.style.cssText = "margin:12px;padding:12px 14px;border-radius:8px;background:#fdecea;color:#b3261e;font:16px system-ui,sans-serif";
    document.body.prepend(box);
  }
  box.textContent = text;
}

/* ================= Sign-in guard ================= */
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("index.html"); return; }
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : null;
    if (data && data.active !== false && data.role === "coordinator") {
      location.replace("attendance.html"); // coordinators only do attendance
      return;
    }
    if (!data || data.active === false || !["admin", "subadmin"].includes(data.role)) {
      await signOut(auth);
      location.replace("index.html");
      return;
    }
    currentUser = user;
    role = data.role;
    $("userName").textContent = data.name || user.email;
    if (!started) {
      started = true;
      try { startApp(); }
      catch (err) { console.error(err); showFatal("Something on this page failed to start. Refresh the page. If it keeps happening, tell the admin."); }
    }
  } catch (e) {
    console.error(e);
    showFatal("Could not load this page. Check your internet and refresh. If it keeps happening, tell the admin.");
  }
});

$("logoutBtn").addEventListener("click", async () => {
  await signOut(auth);
  location.replace("index.html");
});

function startApp() {
  startFees();
}

/* ================================================================
   FEES  (admin only)
   ================================================================ */
let feeRows = [];
let unsubFees = null;
let payTarget = null;

async function startFees() {
  const cur = monthKey(new Date());

  // Month list: this month and the previous 11
  const monthSel = $("f_month");
  for (let i = 0; i < 12; i++) {
    const k = shiftMonth(cur, -i);
    monthSel.add(new Option(monthLabel(k), k));
  }
  const classSel = $("f_class");
  classSel.add(new Option("All classes", ""));
  CLASSES.forEach((c) => classSel.add(new Option(c, c)));

  monthSel.addEventListener("change", () => subscribeFees(monthSel.value));
  ["f_class", "f_status"].forEach((id) => $(id).addEventListener("change", renderFees));
  $("f_search").addEventListener("input", renderFees);

  $("portalBtn").addEventListener("click", rebuildParentPortal);
  $("payForm").addEventListener("submit", savePayment);
  $("payCancel").addEventListener("click", () => $("payDialog").close());

  // Create this month's fee records first (new month = everyone Unpaid + arrears), then show them
  try {
    const created = await generateFees();
    if (created > 0) {
      const note = $("feeNote");
      note.textContent = `${monthLabel(cur)}: new fee records created for ${created} student${created === 1 ? "" : "s"}. Earlier unpaid amounts were added as arrears.`;
      note.hidden = false;
    }
  } catch (err) {
    console.error(err);
    const note = $("feeNote");
    note.className = "msg error";
    note.textContent = err.code === "permission-denied"
      ? "Could not create this month's fees. Check the Firestore rules (see firestore.rules)."
      : "Could not create this month's fees. Check your internet and refresh.";
    note.hidden = false;
  }
  subscribeFees(cur);
}

// Runs when the admin opens this page. For every student without a fee record
// for the current month, create one: monthly fee + any unpaid balance from before.
async function generateFees() {
  const cur = monthKey(new Date());
  const [stuSnap, curSnap] = await Promise.all([
    getDocs(collection(db, "students")),
    getDocs(query(collection(db, "fees"), where("month", "==", cur)))
  ]);
  const have = new Set(curSnap.docs.map((d) => d.data().studentId));
  const missing = stuSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => s.status !== "inactive" && !have.has(s.id));
  if (missing.length === 0) return 0;

  // Find each student's most recent earlier record (look back up to 12 months)
  const last = new Map();
  const pending = new Set(missing.map((s) => s.id));
  let m = cur;
  for (let i = 0; i < 12 && pending.size > 0; i++) {
    m = shiftMonth(m, -1);
    const snap = await getDocs(query(collection(db, "fees"), where("month", "==", m)));
    snap.docs.forEach((d) => {
      const f = d.data();
      if (pending.has(f.studentId)) {
        last.set(f.studentId, { month: m, balance: Math.max(0, (f.totalDue || 0) - (f.paid || 0)) });
        pending.delete(f.studentId);
      }
    });
  }

  const writes = missing.map((s) => {
    const fee = Number(s.monthlyFee) || 0;
    const prev = last.get(s.id);
    const skipped = prev ? Math.max(0, monthsBetween(prev.month, cur) - 1) : 0;
    const arrears = prev ? prev.balance + skipped * fee : 0;
    return {
      id: `${s.id}_${cur}`,
      data: {
        studentId: s.id,
        studentName: s.name, fatherName: s.fatherName,
        class: s.class, rollNo: s.rollNo, parentPhone: s.parentPhone,
        month: cur,
        monthlyFee: fee, arrears, totalDue: fee + arrears, paid: 0,
        createdAt: serverTimestamp()
      }
    };
  });

  for (let i = 0; i < writes.length; i += 400) {
    const batch = writeBatch(db);
    writes.slice(i, i + 400).forEach((w) => batch.set(doc(db, "fees", w.id), w.data));
    await batch.commit();
  }
  return writes.length;
}

function subscribeFees(month) {
  if (unsubFees) unsubFees();
  unsubFees = onSnapshot(
    query(collection(db, "fees"), where("month", "==", month)),
    (snap) => {
      feeRows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderFees();
    },
    (err) => {
      console.error(err);
      $("feeEmpty").textContent = "Could not load fees. Check the Firestore rules.";
      $("feeEmpty").hidden = false;
    }
  );
}

function feeStatus(f) {
  const balance = f.totalDue - (f.paid || 0);
  if (balance <= 0) return "paid";
  return (f.paid || 0) > 0 ? "partial" : "unpaid";
}

function renderFees() {
  const cls = $("f_class").value;
  const st = $("f_status").value;
  const term = $("f_search").value.trim().toLowerCase();

  const rows = feeRows
    .filter((f) => (!cls || f.class === cls) && (!st || feeStatus(f) === st) &&
      (!term || (f.studentName || "").toLowerCase().includes(term) || String(f.rollNo).toLowerCase().includes(term)))
    .sort((a, b) => classIndex(a.class) - classIndex(b.class) || naturalCompare(a.rollNo, b.rollNo));

  let due = 0, paid = 0;
  const body = $("feeRows");
  body.innerHTML = "";
  rows.forEach((f) => {
    due += f.totalDue; paid += f.paid || 0;
    const balance = f.totalDue - (f.paid || 0);
    const status = feeStatus(f);
    const tr = document.createElement("tr");

    const tdStatus = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "badge " + status;
    badge.textContent = { unpaid: "Unpaid", partial: "Partly paid", paid: "Paid" }[status];
    tdStatus.appendChild(badge);

    const tdAct = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";
    if (status !== "paid") {
      const payBtn = document.createElement("button");
      payBtn.type = "button";
      payBtn.className = "btn alt small";
      payBtn.textContent = "Record payment";
      payBtn.addEventListener("click", () => openPay(f));
      wrap.appendChild(payBtn);

      if (f.parentPhone) {
        const wa = document.createElement("a");
        wa.className = "wa";
        wa.textContent = "Send WhatsApp";
        wa.target = "_blank";
        wa.rel = "noopener noreferrer";
        wa.href = `https://wa.me/${f.parentPhone}?text=${encodeURIComponent(reminderMessage(f))}`;
        wrap.appendChild(wa);
      }
    }
    tdAct.appendChild(wrap);

    tr.append(
      cell(f.class), cell(f.rollNo), cell(f.studentName),
      cell(money(f.monthlyFee), "num"), cell(f.arrears > 0 ? money(f.arrears) : "-", "num"),
      cell(money(f.totalDue), "num"), cell(money(f.paid || 0), "num"), cell(money(balance), "num"),
      tdStatus, tdAct
    );
    body.appendChild(tr);
  });

  $("sumDue").textContent = money(due);
  $("sumPaid").textContent = money(paid);
  $("sumBal").textContent = money(due - paid);

  const empty = $("feeEmpty");
  if (rows.length === 0) {
    empty.textContent = feeRows.length === 0 ? "No fee records for this month yet." : "No students match these filters.";
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
}

/* ---- Record a payment ---- */
function openPay(f) {
  payTarget = f;
  const balance = f.totalDue - (f.paid || 0);
  $("payWho").textContent = `${f.studentName} · ${f.class} · Balance ${money(balance)}`;
  $("payAmount").value = balance;
  $("payMsg").hidden = true;
  $("payDialog").showModal();
  $("payAmount").select();
}

async function savePayment(e) {
  e.preventDefault();
  const f = payTarget;
  const msg = $("payMsg");
  msg.hidden = true;
  const amount = Number($("payAmount").value);
  const balance = f.totalDue - (f.paid || 0);
  if (!(amount > 0)) { msg.textContent = "Enter the amount received."; msg.hidden = false; return; }
  if (amount > balance) { msg.textContent = `The amount is more than the balance (${money(balance)}).`; msg.hidden = false; return; }

  const btn = $("paySave");
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "fees", f.id), { paid: increment(amount), lastPaymentAt: serverTimestamp() });
    batch.set(doc(collection(db, "feePayments")), {
      feeId: f.id, studentId: f.studentId, studentName: f.studentName,
      class: f.class, month: f.month, amount,
      receivedBy: currentUser.uid, paidAt: serverTimestamp()
    });
    await batch.commit();
    $("payDialog").close();
  } catch (err) {
    console.error(err);
    msg.textContent = err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not save the payment. Check your internet and try again.";
    msg.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/* ================================================================
   PARENT PORTAL SUPPORT
   The parent page opens one record by phone number. Staff can rebuild those links here.
   ================================================================ */

async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach((o) => batch.set(o.ref, o.data));
    await batch.commit();
  }
}

// Admin tool: rebuild the phone number -> children links from the students list
async function rebuildParentPortal() {
  const msg = $("portalMsg");
  const btn = $("portalBtn");
  btn.disabled = true;
  showMsg(msg, "Updating the parent page data…", "info");
  try {
    const stuSnap = await getDocs(collection(db, "students"));
    const students = stuSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.status !== "inactive");

    const byPhone = new Map();
    students.forEach((s) => {
      if (!s.parentPhone) return;
      if (!byPhone.has(s.parentPhone)) byPhone.set(s.parentPhone, []);
      byPhone.get(s.parentPhone).push({ id: s.id, name: s.name, class: s.class, rollNo: s.rollNo });
    });
    const ops = [];
    byPhone.forEach((children, phone) => {
      ops.push({ ref: doc(db, "parentIndex", phone), data: { phone, children, updatedAt: serverTimestamp() } });
    });
    await commitInChunks(ops);
    showMsg(msg, `Done. ${byPhone.size} parent number${byPhone.size === 1 ? "" : "s"} linked.`, "ok");
  } catch (err) {
    console.error(err);
    showMsg(msg, err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not update. Check your internet and try again.");
  } finally {
    btn.disabled = false;
  }
}
