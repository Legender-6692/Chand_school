// attendance-fees.js - logic for attendance-fees.html
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, collection, getDocs, query, where, orderBy, limit,
  onSnapshot, setDoc, writeBatch, serverTimestamp, increment
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
    if (!started) { started = true; startApp(); }
  } catch (e) {
    console.error(e);
    location.replace("index.html");
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
   ATTENDANCE
   ================================================================ */
let reviewRows = [];     // [{ student, status, line }]
let reviewSource = "manual";
let reviewText = "";
let reviewClass = "";
let reviewDate = "";

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
  $("manualBtn").addEventListener("click", () => prepareReview(false));
  $("allPresentBtn").addEventListener("click", () => {
    reviewRows.forEach((r) => (r.status = "P"));
    renderReview();
  });
  $("unreadPresentBtn").addEventListener("click", () => {
    reviewRows.forEach((r) => { if (!r.status) r.status = "P"; });
    renderReview();
  });
  $("saveAttBtn").addEventListener("click", saveAttendance);

  onSnapshot(
    query(collection(db, "attendance"), orderBy("date", "desc"), limit(15)),
    (snap) => {
      const body = $("recentRows");
      body.innerHTML = "";
      snap.docs.forEach((d) => {
        const a = d.data();
        const tr = document.createElement("tr");
        tr.append(cell(a.date), cell(a.class), cell(a.present, "num"), cell(a.absent, "num"),
                  cell(a.leave, "num"), cell(a.enteredByName || "-"));
        body.appendChild(tr);
      });
      $("recentEmpty").hidden = !snap.empty;
    },
    (err) => { console.error(err); $("recentEmpty").textContent = "Could not load attendance. Check the Firestore rules."; $("recentEmpty").hidden = false; }
  );
}

async function loadClassStudents(cls) {
  const snap = await getDocs(query(collection(db, "students"), where("class", "==", cls)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => s.status !== "inactive")
    .sort((a, b) => naturalCompare(a.rollNo, b.rollNo));
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
    const students = await loadClassStudents(cls);
    if (students.length === 0) return showMsg(msg, `No students found in ${cls}. Add students first.`);

    const parsed = parseSlip(text, students, $("a_mode").value);
    const found = Object.keys(parsed).length;
    buildReview(students, parsed, "ocr", text, cls, date);
    if (found === 0) {
      showMsg(msg, "Could not match any students on this slip. Fill in the attendance below, or try a clearer photo.", "warn");
    } else {
      showMsg(msg, `Matched ${found} of ${students.length} students. Please check every row before saving.`, "ok");
    }
  } catch (err) {
    console.error(err);
    showMsg(msg, "Could not read the slip. Try a clearer photo, or use Mark manually.");
  } finally {
    btn.disabled = false;
    $("manualBtn").disabled = false;
    $("progress").hidden = true;
  }
}

async function prepareReview(fromOcr) {
  const msg = $("readMsg");
  msg.hidden = true;
  const date = $("a_date").value;
  const cls = $("a_class").value;
  if (!date) return showMsg(msg, "Choose the date.");
  if (!cls) return showMsg(msg, "Choose the class.");
  try {
    const students = await loadClassStudents(cls);
    if (students.length === 0) return showMsg(msg, `No students found in ${cls}. Add students first.`);
    buildReview(students, {}, "manual", "", cls, date);
  } catch (err) {
    console.error(err);
    showMsg(msg, "Could not load the students. Check the Firestore rules.");
  }
}

/* ---- Turn the OCR text into attendance ---- */
function rollKey(r) {
  const s = String(r).trim();
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : s.toLowerCase();
}

function detectStatus(text) {
  if (/[✓✔√]/.test(text)) return "P";
  const tokens = text.split(/[^A-Za-z×]+/).filter(Boolean).map((t) => t.toLowerCase());
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (["p", "pr", "present"].includes(t)) return "P";
    if (["a", "ab", "abs", "absent", "x", "×"].includes(t)) return "A";
    if (["l", "lv", "leave"].includes(t)) return "L";
  }
  return null;
}

function parseSlip(text, students, mode) {
  const out = {};
  const byRoll = new Map(students.map((s) => [rollKey(s.rollNo), s]));

  if (mode === "absent") {
    // Slip lists only absent roll numbers. Everyone else is present.
    const cleaned = text
      .split(/\r?\n/)
      .filter((l) => !/class|date|total|teacher|day/i.test(l))
      .join(" ")
      .replace(/\b\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}\b/g, " ");
    const absentKeys = new Set(cleaned.split(/[^A-Za-z0-9]+/).filter(Boolean).map(rollKey));
    students.forEach((s) => {
      const isAbsent = absentKeys.has(rollKey(s.rollNo));
      out[s.id] = { status: isAbsent ? "A" : "P", line: isAbsent ? "Roll number found on slip" : "Not on absent list" };
    });
    return out;
  }

  // Slip lists every student: "1 Ali P", "2 Sara A" ...
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line) => {
    const m = line.match(/^\W*(\d{1,3})\b/);
    let student = m ? byRoll.get(rollKey(m[1])) : null;
    if (!student) {
      // No roll number: try to find exactly one student by first name
      const lower = line.toLowerCase();
      const hits = students.filter((s) => {
        const first = (s.name || "").split(/\s+/)[0].toLowerCase();
        return first.length >= 3 && lower.includes(first);
      });
      if (hits.length === 1) student = hits[0];
    }
    if (!student) return;
    const rest = m ? line.slice(m[0].length) : line;
    const status = detectStatus(rest);
    if (status && !out[student.id]) out[student.id] = { status, line };
  });
  return out;
}

function buildReview(students, parsed, source, text, cls, date) {
  reviewRows = students.map((s) => ({
    student: s,
    status: parsed[s.id] ? parsed[s.id].status : "",
    line: parsed[s.id] ? parsed[s.id].line : ""
  }));
  reviewSource = source;
  reviewText = text;
  reviewClass = cls;
  reviewDate = date;
  $("reviewTitle").textContent = `${cls} · ${date}`;
  $("saveMsg").hidden = true;
  $("rawBox").hidden = !text;
  $("rawText").textContent = text;
  $("reviewCard").hidden = false;
  renderReview();
  $("reviewCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderReview() {
  const body = $("reviewRows");
  body.innerHTML = "";
  reviewRows.forEach((r) => {
    const tr = document.createElement("tr");
    if (!r.status) tr.className = "needs";
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `Status for ${r.student.name}`);
    [["", "Choose"], ["P", "Present"], ["A", "Absent"], ["L", "Leave"]].forEach(([v, t]) => sel.add(new Option(t, v)));
    sel.value = r.status;
    sel.addEventListener("change", () => {
      r.status = sel.value;
      tr.className = r.status ? "" : "needs";
    });
    const tdSel = document.createElement("td");
    tdSel.appendChild(sel);
    const tdLine = cell(r.line || "Not found on slip");
    tdLine.className = "slipline";
    tr.append(cell(r.student.rollNo), cell(r.student.name), tdSel, tdLine);
    body.appendChild(tr);
  });
}

async function saveAttendance() {
  const msg = $("saveMsg");
  msg.hidden = true;
  if (reviewRows.some((r) => !r.status)) {
    return showMsg(msg, "Choose a status for every student. Yellow rows are still empty.");
  }
  const records = {};
  let present = 0, absent = 0, leave = 0;
  reviewRows.forEach((r) => {
    records[r.student.id] = r.status;
    if (r.status === "P") present++;
    else if (r.status === "A") absent++;
    else leave++;
  });

  const id = `${reviewDate}_${reviewClass.replace(/\s+/g, "-").toLowerCase()}`;
  const btn = $("saveAttBtn");
  btn.disabled = true;
  try {
    const existing = await getDoc(doc(db, "attendance", id));
    if (existing.exists() && !confirm(`Attendance for ${reviewClass} on ${reviewDate} is already saved. Replace it?`)) {
      return;
    }
    await setDoc(doc(db, "attendance", id), {
      date: reviewDate,
      month: reviewDate.slice(0, 7),
      class: reviewClass,
      records, present, absent, leave,
      source: reviewSource,
      slipText: reviewText.slice(0, 5000),
      enteredBy: currentUser.uid,
      enteredByName: $("userName").textContent,
      createdAt: serverTimestamp()
    });
    try {
      await updateAttendanceSummaries(reviewClass, reviewDate.slice(0, 7), reviewRows.map((r) => r.student));
      showMsg(msg, `Saved. Present ${present}, absent ${absent}, leave ${leave}.`, "ok");
    } catch (sumErr) {
      console.error(sumErr);
      showMsg(msg, "Attendance saved, but the parent page totals could not be updated. An admin can use Update parent portal on the Fees tab.", "warn");
    }
  } catch (err) {
    console.error(err);
    showMsg(msg, err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not save. Check your internet and try again.");
  } finally {
    btn.disabled = false;
  }
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
   The parent page reads small summary records, never the full lists.
   ================================================================ */

async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach((o) => {
      if (o.op === "update") batch.update(o.ref, o.data);
      else batch.set(o.ref, o.data);
    });
    await batch.commit();
  }
}

// After attendance is saved: recount this month for the class and store each student's totals
async function updateAttendanceSummaries(cls, month, students) {
  const snap = await getDocs(query(
    collection(db, "attendance"),
    where("class", "==", cls), where("month", "==", month)
  ));
  const counts = {};
  snap.docs.forEach((d) => {
    Object.entries(d.data().records || {}).forEach(([sid, st]) => {
      if (!counts[sid]) counts[sid] = { present: 0, absent: 0, leave: 0 };
      if (st === "P") counts[sid].present++;
      else if (st === "A") counts[sid].absent++;
      else if (st === "L") counts[sid].leave++;
    });
  });
  const ops = students.map((s) => {
    const c = counts[s.id] || { present: 0, absent: 0, leave: 0 };
    return {
      op: "set",
      ref: doc(db, "attendanceSummary", `${s.id}_${month}`),
      data: { studentId: s.id, month, ...c, total: c.present + c.absent + c.leave, updatedAt: serverTimestamp() }
    };
  });
  await commitInChunks(ops);
}

// Admin tool: rebuild phone -> children links and this month's attendance totals from scratch
async function rebuildParentPortal() {
  const msg = $("portalMsg");
  const btn = $("portalBtn");
  btn.disabled = true;
  showMsg(msg, "Updating the parent page data…", "info");
  try {
    const stuSnap = await getDocs(collection(db, "students"));
    const students = stuSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.status !== "inactive");
    const ops = [];

    // 1. Which children belong to which phone number
    const byPhone = new Map();
    students.forEach((s) => {
      if (!s.parentPhone) return;
      if (!byPhone.has(s.parentPhone)) byPhone.set(s.parentPhone, []);
      byPhone.get(s.parentPhone).push({ id: s.id, name: s.name, class: s.class, rollNo: s.rollNo });
    });
    byPhone.forEach((children, phone) => {
      ops.push({ op: "set", ref: doc(db, "parentIndex", phone), data: { phone, children, updatedAt: serverTimestamp() } });
    });

    // 2. This month's attendance totals (also adds the month field to older records)
    const m = monthKey(new Date());
    const attSnap = await getDocs(query(
      collection(db, "attendance"),
      where("date", ">=", `${m}-01`), where("date", "<=", `${m}-31`)
    ));
    const counts = {};
    attSnap.docs.forEach((d) => {
      const a = d.data();
      if (!a.month) ops.push({ op: "update", ref: d.ref, data: { month: a.date.slice(0, 7) } });
      Object.entries(a.records || {}).forEach(([sid, st]) => {
        if (!counts[sid]) counts[sid] = { present: 0, absent: 0, leave: 0 };
        if (st === "P") counts[sid].present++;
        else if (st === "A") counts[sid].absent++;
        else if (st === "L") counts[sid].leave++;
      });
    });
    const known = new Set(students.map((s) => s.id));
    Object.entries(counts).forEach(([sid, c]) => {
      if (!known.has(sid)) return;
      ops.push({
        op: "set",
        ref: doc(db, "attendanceSummary", `${sid}_${m}`),
        data: { studentId: sid, month: m, ...c, total: c.present + c.absent + c.leave, updatedAt: serverTimestamp() }
      });
    });

    await commitInChunks(ops);
    showMsg(msg, `Done. ${byPhone.size} parent number${byPhone.size === 1 ? "" : "s"} linked, attendance totals updated for ${Object.keys(counts).length} students.`, "ok");
  } catch (err) {
    console.error(err);
    showMsg(msg, err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not update. Check your internet and try again.");
  } finally {
    btn.disabled = false;
  }
}
