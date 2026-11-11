// attendance-fees.js - logic for attendance-fees.html
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, collection, getDocs, query, where, orderBy, limit,
  onSnapshot, setDoc, writeBatch, serverTimestamp, increment, deleteDoc, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/* ================= Settings you can change ================= */
const SCHOOL_NAME = "Chand School";
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
    if (!data || data.active === false || !["admin", "coordinator"].includes(data.role)) {
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

document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((b) => b.removeAttribute("aria-current"));
    btn.setAttribute("aria-current", "page");
    $("view-attendance").hidden = btn.dataset.view !== "attendance";
    $("view-fees").hidden = btn.dataset.view !== "fees";
  });
});

function startApp() {
  startAttendance();
  if (role === "admin") {
    $("navFees").hidden = false;
    $("navAdmin").hidden = false;
    startFees();
  }
}

/* ================================================================
   ATTENDANCE  (class totals only - no student names are saved)
   Slip format:  TS = total, PS = present, AS = absent, LS = leave
   ================================================================ */
let entryDate = "";
let entryClass = "";
let entrySource = "manual";
let entryText = "";
let unsubAtt = null;

function startAttendance() {
  $("a_date").value = dateKey(new Date());
  const sel = $("a_class");
  sel.innerHTML = '<option value="" disabled selected>Choose class</option>';
  CLASSES.forEach((c) => sel.add(new Option(c, c)));

  $("a_file").addEventListener("change", () => {
    const file = $("a_file").files[0];
    const img = $("preview");
    if (!file) { img.hidden = true; return; }
    img.src = URL.createObjectURL(file);
    img.hidden = false;
  });
  $("readBtn").addEventListener("click", readSlip);
  $("manualBtn").addEventListener("click", () => openEntry({}, "manual", ""));
  ["r_total", "r_present", "r_absent", "r_leave"].forEach((id) => $(id).addEventListener("input", checkTotals));
  $("saveAttBtn").addEventListener("click", saveAttendance);
  $("h_date").addEventListener("change", subscribeAttendance);
  $("h_clear").addEventListener("click", () => { $("h_date").value = ""; subscribeAttendance(); });
  subscribeAttendance();
}

/* ---- Image preparation: shrink big phone photos, make grey, add contrast ---- */
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const target = 1800;
  const scale = bmp.width > target ? target / bmp.width : (bmp.width < 1000 ? 1500 / bmp.width : 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.filter = "grayscale(1) contrast(1.35)"; // ignored by browsers that don't support it
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res) => canvas.toBlob(res, "image/png"));
}

/* ---- Find TS / PS / AS / LS numbers in the text read from the slip ---- */
function parseSlipNumbers(text) {
  const toNum = (s) => {
    const n = parseInt(s.replace(/[Oo]/g, "0").replace(/[lI|]/g, "1"), 10);
    return Number.isNaN(n) ? null : n;
  };
  // label, then optional "=" or ":" or "-", then the number
  const grab = (label) => {
    const re = new RegExp(label + "\\s*[=:\\-\u2013\u2014_~]*\\s*([0-9OolI|]{1,3})(?![0-9A-Za-z])", "i");
    const m = text.match(re);
    return m ? toNum(m[1]) : null;
  };
  return {
    total:   grab("\\bT\\s*\\.?\\s*S\\s*\\.?")   ?? grab("total(?:\\s*students?)?"),
    present: grab("\\bP\\s*\\.?\\s*S\\s*\\.?")   ?? grab("present(?:\\s*students?)?"),
    absent:  grab("\\bA\\s*\\.?\\s*S\\s*\\.?")   ?? grab("absent(?:\\s*students?)?"),
    leave:   grab("\\bL\\s*\\.?\\s*S\\s*\\.?")   ?? grab("leave(?:\\s*students?)?")
  };
}

async function readSlip() {
  const msg = $("readMsg");
  msg.hidden = true;
  const date = $("a_date").value;
  const cls = $("a_class").value;
  const file = $("a_file").files[0];
  if (!date) return showMsg(msg, "Choose the date.");
  if (!cls) return showMsg(msg, "Choose the class.");
  if (!file) return showMsg(msg, "Choose the slip photo first.");
  if (typeof Tesseract === "undefined") return showMsg(msg, "The reading tool could not load. Check your internet and refresh the page.");

  const btn = $("readBtn");
  btn.disabled = true;
  $("manualBtn").disabled = true;
  $("progress").hidden = false;
  $("progressBar").style.width = "0%";
  showMsg(msg, "Reading the slip. This can take up to a minute.", "info");

  try {
    const blob = await prepareImage(file);
    const result = await Tesseract.recognize(blob, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text") {
          $("progressBar").style.width = Math.round(m.progress * 100) + "%";
        }
      }
    });
    const text = result.data.text || "";
    const nums = parseSlipNumbers(text);
    const found = Object.values(nums).filter((v) => v !== null).length;
    await openEntry(nums, "ocr", text);
    if (found === 0) {
      showMsg(msg, "Could not find TS, PS, AS or LS on this slip. Type the numbers below, or try a clearer photo.", "warn");
    } else {
      showMsg(msg, `Read ${found} of 4 numbers. Please check them before saving.`, "ok");
    }
  } catch (err) {
    console.error(err);
    showMsg(msg, "Could not read the slip. Try a clearer photo, or use Type numbers.");
  } finally {
    btn.disabled = false;
    $("manualBtn").disabled = false;
    $("progress").hidden = true;
  }
}

// Opens the box with the four numbers (from the slip, or empty for typing)
async function openEntry(values, source, text) {
  const msg = $("readMsg");
  const date = $("a_date").value;
  const cls = $("a_class").value;
  if (!date) return showMsg(msg, "Choose the date.");
  if (!cls) return showMsg(msg, "Choose the class.");
  msg.hidden = true;
  entryDate = date; entryClass = cls; entrySource = source; entryText = text || "";

  // How many students are added in the system for this class (used when the slip total is missing)
  let sys = null;
  try {
    const c = await getCountFromServer(query(collection(db, "students"), where("class", "==", cls)));
    sys = c.data().count;
  } catch (e) { console.error(e); }

  $("reviewTitle").textContent = `${cls} · ${date}`;
  $("sysHint").textContent = sys === null ? "" : `Students added in the system for ${cls}: ${sys}`;
  $("r_total").value = values.total ?? (sys || "");
  $("r_present").value = values.present ?? "";
  $("r_absent").value = values.absent ?? "";
  $("r_leave").value = values.leave ?? "";
  $("saveMsg").hidden = true;
  $("rawBox").hidden = !entryText;
  $("rawText").textContent = entryText;
  $("reviewCard").hidden = false;
  checkTotals();
  $("reviewCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function readNum(id) {
  const v = $(id).value.trim();
  return v === "" ? null : Number(v);
}

function checkTotals() {
  const el = $("checkMsg");
  const t = readNum("r_total"), p = readNum("r_present"), a = readNum("r_absent");
  const l = readNum("r_leave") ?? 0;
  if (t === null || p === null || a === null) { el.hidden = true; return; }
  const sum = p + a + l;
  if (sum === t) showMsg(el, `Present + absent + leave = ${sum}. Matches the total.`, "ok");
  else showMsg(el, `Present + absent + leave = ${sum}, but the total is ${t}. Please check.`, "warn");
}

async function saveAttendance() {
  const msg = $("saveMsg");
  msg.hidden = true;
  const total = readNum("r_total"), present = readNum("r_present"), absent = readNum("r_absent");
  const leave = readNum("r_leave") ?? 0;
  if (total === null || present === null || absent === null) {
    return showMsg(msg, "Fill in total, present and absent. Leave can stay empty if nobody is on leave.");
  }
  if ([total, present, absent, leave].some((n) => !Number.isInteger(n) || n < 0)) {
    return showMsg(msg, "Use whole numbers, zero or more.");
  }
  const sum = present + absent + leave;
  if (sum !== total && !confirm(`Present + absent + leave = ${sum}, but the total is ${total}.\n\nSave anyway?`)) return;

  const id = `${entryDate}_${entryClass.replace(/\s+/g, "-").toLowerCase()}`;
  const btn = $("saveAttBtn");
  btn.disabled = true;
  try {
    const existing = await getDoc(doc(db, "attendance", id));
    if (existing.exists() && !confirm(`Attendance for ${entryClass} on ${entryDate} is already saved. Replace it?`)) return;
    await setDoc(doc(db, "attendance", id), {
      date: entryDate,
      month: entryDate.slice(0, 7),
      class: entryClass,
      total, present, absent, leave,
      source: entrySource,
      slipText: entryText.slice(0, 3000),
      enteredBy: currentUser.uid,
      enteredByName: $("userName").textContent,
      createdAt: serverTimestamp()
    });
    showMsg(msg, `Saved. ${entryClass}: total ${total}, present ${present}, absent ${absent}, leave ${leave}.`, "ok");
  } catch (err) {
    console.error(err);
    showMsg(msg, err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not save. Check your internet and try again.");
  } finally {
    btn.disabled = false;
  }
}

/* ---- Saved attendance: latest records, or every class for one date ---- */
function subscribeAttendance() {
  if (unsubAtt) unsubAtt();
  const day = $("h_date").value;
  const q = day
    ? query(collection(db, "attendance"), where("date", "==", day))
    : query(collection(db, "attendance"), orderBy("date", "desc"), limit(60));
  unsubAtt = onSnapshot(q, (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .map((a) => ({ ...a, total: a.total ?? ((a.present || 0) + (a.absent || 0) + (a.leave || 0)) }))
      .sort((a, b) => b.date.localeCompare(a.date) || classIndex(a.class) - classIndex(b.class));

    const body = $("historyRows");
    body.innerHTML = "";
    let t = 0, p = 0, ab = 0, l = 0;
    rows.forEach((a) => {
      t += a.total; p += a.present || 0; ab += a.absent || 0; l += a.leave || 0;
      const tr = document.createElement("tr");
      tr.append(cell(a.date), cell(a.class), cell(a.total, "num"), cell(a.present || 0, "num"),
                cell(a.absent || 0, "num"), cell(a.leave || 0, "num"), cell(a.enteredByName || "-"));

      const tdAct = document.createElement("td");
      const wrap = document.createElement("div");
      wrap.className = "row-actions";
      const edit = document.createElement("button");
      edit.type = "button"; edit.className = "btn alt small"; edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        $("a_date").value = a.date;
        $("a_class").value = a.class;
        openEntry({ total: a.total, present: a.present || 0, absent: a.absent || 0, leave: a.leave || 0 }, "manual", "");
      });
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn alt small"; del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete the attendance of ${a.class} for ${a.date}?`)) return;
        try { await deleteDoc(doc(db, "attendance", a.id)); }
        catch (err) { console.error(err); alert("Could not delete. Try again."); }
      });
      wrap.append(edit, del);
      tdAct.appendChild(wrap);
      tr.appendChild(tdAct);
      body.appendChild(tr);
    });

    const totals = $("historyTotals");
    if (day && rows.length > 0) {
      totals.textContent = `All classes on ${day}: total ${t}, present ${p}, absent ${ab}, leave ${l}`;
      totals.hidden = false;
    } else {
      totals.hidden = true;
    }
    const empty = $("historyEmpty");
    empty.textContent = day ? "No attendance saved for this date." : "No attendance saved yet.";
    empty.hidden = rows.length > 0;
  }, (err) => {
    console.error(err);
    $("historyEmpty").textContent = "Could not load attendance. Check the Firestore rules.";
    $("historyEmpty").hidden = false;
  });
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
