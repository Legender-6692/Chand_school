// admin.js - logic for admin-dashboard.html
import { app, auth, db } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, deleteUser, signInWithEmailAndPassword, updatePassword
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, collection, addDoc, query, where, limit, getDocs,
  onSnapshot, serverTimestamp, writeBatch, deleteDoc, arrayUnion, orderBy
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Class list. Edit this list if your school uses different class names.
const CLASSES = [
  "Playgroup", "Nursery", "LKG", "UKG",
  "Class 1", "Class 2", "Class 3", "Class 4", "Class 5",
  "Class 6", "Class 7", "Class 8", "Class 9", "Class 10"
];

const $ = (id) => document.getElementById(id);
let allStudents = [];
let started = false;

/* ---------- Helpers ---------- */
function showMsg(el, text, type = "error") {
  el.textContent = text;
  el.className = "msg " + type;
  el.hidden = false;
}
function hideMsg(el) { el.hidden = true; }

function digitsOnly(s) { return (s || "").replace(/\D/g, ""); }

// Builds a full phone number like 919876543210 from country code + number.
// Returns null if the number looks wrong.
function buildPhone(codeRaw, numberRaw) {
  const code = digitsOnly(codeRaw);
  let number = digitsOnly(numberRaw).replace(/^0+/, "");
  if (!code) return null;
  if (code === "91" && number.length !== 10) return null;
  if (number.length < 7 || number.length > 12) return null;
  return code + number;
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function fillClassSelects() {
  const form = $("s_class");
  form.innerHTML = '<option value="" disabled selected>Choose class</option>';
  CLASSES.forEach((c) => form.add(new Option(c, c)));
  const filter = $("s_filter");
  filter.innerHTML = "";
  filter.add(new Option("All classes", ""));
  CLASSES.forEach((c) => filter.add(new Option(c, c)));
}

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

/* ---------- Sign-in guard: only admins may stay on this page ---------- */
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("index.html"); return; }
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : null;
    if (!data || data.role !== "admin" || data.active === false) {
      await signOut(auth);
      location.replace("index.html");
      return;
    }
    $("adminName").textContent = data.name || user.email;
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

/* ---------- Sidebar navigation ---------- */
document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((b) => b.removeAttribute("aria-current"));
    btn.setAttribute("aria-current", "page");
    ["students", "teachers", "notices", "parents"].forEach((v) => {
      $("view-" + v).hidden = btn.dataset.view !== v;
    });
  });
});

function startApp() {
  fillClassSelects();
  listenStudents();
  listenTeachers();
  listenNotices();
  $("noticeForm").addEventListener("submit", postNotice);
  listenParents();
  $("p_createAll").addEventListener("click", createMissingLogins);
  $("studentCancel").addEventListener("click", exitStudentEdit);
  $("teacherCancel").addEventListener("click", exitTeacherEdit);
  $("studentForm").addEventListener("submit", saveStudent);
  $("teacherForm").addEventListener("submit", saveTeacher);
  $("s_search").addEventListener("input", renderStudents);
  $("s_filter").addEventListener("change", renderStudents);
}

/* ---------- Students ---------- */
async function saveStudent(e) {
  e.preventDefault();
  const msg = $("studentMsg");
  hideMsg(msg);

  const name = $("s_name").value.trim();
  const fatherName = $("s_father").value.trim();
  const cls = $("s_class").value;
  const rollNo = $("s_roll").value.trim();
  const parentPhone = buildPhone($("s_code").value, $("s_phone").value);
  const monthlyFee = Number($("s_fee").value);

  if (!name || !fatherName) return showMsg(msg, "Fill in the student and father names.");
  if (!cls) return showMsg(msg, "Choose the class.");
  if (!rollNo) return showMsg(msg, "Enter the roll number.");
  if (!parentPhone) return showMsg(msg, "The WhatsApp number looks wrong. Check the country code and number.");
  if ($("s_fee").value === "" || !(monthlyFee >= 0)) return showMsg(msg, "Enter the monthly fee amount.");

  const btn = $("studentBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    // Same roll number must not repeat inside one class
    const dup = await getDocs(query(
      collection(db, "students"),
      where("class", "==", cls), where("rollNo", "==", rollNo), limit(2)
    ));
    const clash = dup.docs.some((d) => !editingStudent || d.id !== editingStudent.id);
    if (clash) {
      showMsg(msg, `Roll number ${rollNo} already exists in ${cls}.`);
      return;
    }

    if (editingStudent) {
      await updateStudentRecord(editingStudent, { name, fatherName, cls, rollNo, parentPhone, monthlyFee });
      exitStudentEdit();
      showMsg(msg, `${name} updated.`, "ok");
      return;
    }

    const studentRef = doc(collection(db, "students"));
    const batch = writeBatch(db);
    batch.set(studentRef, {
      name, fatherName,
      class: cls, rollNo, parentPhone, monthlyFee,
      status: "active",
      createdAt: serverTimestamp()
    });
    // Parent corner: link this phone number to the child
    batch.set(doc(db, "parentIndex", parentPhone), {
      phone: parentPhone,
      children: arrayUnion({ id: studentRef.id, name, class: cls, rollNo })
    }, { merge: true });
    await batch.commit();

    $("studentForm").reset();
    $("s_class").value = cls; // keep the class for faster entry of the next student
    let loginNote = "";
    try {
      if (await ensureParentLogin(parentPhone)) loginNote = " A parent login was created (see the Parents tab).";
    } catch (loginErr) {
      console.error(loginErr);
      loginNote = " The parent login could not be created automatically. Use the Parents tab.";
    }
    showMsg(msg, `${name} saved.${loginNote}`, "ok");
  } catch (err) {
    console.error(err);
    showMsg(msg, err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not save. Check your internet and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = editingStudent ? "Save changes" : "Save student";
  }
}

function listenStudents() {
  onSnapshot(collection(db, "students"), (snap) => {
    allStudents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    $("studentCount").textContent = allStudents.length;
    renderStudents();
  }, (err) => {
    console.error(err);
    const empty = $("studentEmpty");
    empty.textContent = "Could not load students. Check the Firestore rules.";
    empty.hidden = false;
  });
}

function renderStudents() {
  const term = $("s_search").value.trim().toLowerCase();
  const cls = $("s_filter").value;

  const rows = allStudents
    .filter((s) => (!cls || s.class === cls) &&
      (!term || (s.name || "").toLowerCase().includes(term) || (s.rollNo || "").toLowerCase().includes(term)))
    .sort((a, b) =>
      CLASSES.indexOf(a.class) - CLASSES.indexOf(b.class) ||
      String(a.rollNo).localeCompare(String(b.rollNo), undefined, { numeric: true }));

  const body = $("studentRows");
  body.innerHTML = "";
  rows.forEach((s) => {
    const tr = document.createElement("tr");
    [s.class, s.rollNo, s.name, s.fatherName,
     "+" + s.parentPhone, Number(s.monthlyFee).toLocaleString()]
      .forEach((v) => tr.appendChild(cell(v)));
    tr.appendChild(actionsCell(() => startEditStudent(s), () => deleteStudent(s)));
    body.appendChild(tr);
  });

  const empty = $("studentEmpty");
  if (rows.length === 0) {
    empty.textContent = allStudents.length === 0
      ? "No students yet. Add the first student using the form above."
      : "No students match your search.";
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
}

/* ---------- Teachers ---------- */
async function saveTeacher(e) {
  e.preventDefault();
  const msg = $("teacherMsg");
  hideMsg(msg);

  const name = $("t_name").value.trim();
  const subject = $("t_subject").value.trim();
  const qualification = $("t_qual").value.trim();
  const phone = buildPhone($("t_code").value, $("t_phone").value);
  const email = $("t_email").value.trim().toLowerCase();
  const password = $("t_pass").value;

  if (!name || !subject) return showMsg(msg, "Fill in the teacher's name and subject.");
  if (!phone) return showMsg(msg, "The phone number looks wrong. Check the country code and number.");
  if (editingTeacher) return updateTeacherRecord(name, subject, qualification, phone);
  if (!email) return showMsg(msg, "Enter the login email.");
  if (password.length < 6) return showMsg(msg, "The password needs at least 6 characters.");

  const btn = $("teacherBtn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  // A second Firebase app is used to create the teacher's login,
  // so the admin does not get signed out.
  const secApp = initializeApp(app.options, "secondary-" + Date.now());
  const secAuth = getAuth(secApp);
  let newUser = null;
  try {
    const cred = await createUserWithEmailAndPassword(secAuth, email, password);
    newUser = cred.user;

    const batch = writeBatch(db);
    batch.set(doc(db, "users", newUser.uid), { name, email, role: "teacher", active: true });
    batch.set(doc(db, "teachers", newUser.uid), {
      name, subject, qualification, phone, email,
      uid: newUser.uid, status: "active",
      createdAt: serverTimestamp()
    });
    await batch.commit();

    $("teacherForm").reset();
    $("t_code").value = "+91";
    showMsg(msg, `${name} saved. They can sign in with ${email}.`, "ok");
  } catch (err) {
    console.error(err);
    // If the login was created but saving failed, remove the login again
    if (newUser) { try { await deleteUser(newUser); } catch (_) {} }
    const text = {
      "auth/email-already-in-use": "This email already has an account. Use a different email.",
      "auth/invalid-email": "That email address doesn't look right.",
      "auth/weak-password": "The password is too weak. Use at least 6 characters.",
      "auth/operation-not-allowed": "Email/Password sign-in is turned off in Firebase Authentication.",
      "permission-denied": "Not allowed. Check the Firestore rules (see firestore.rules)."
    }[err.code] || "Could not save. Check your internet and try again.";
    showMsg(msg, text);
  } finally {
    try { await signOut(secAuth); } catch (_) {}
    try { await deleteApp(secApp); } catch (_) {}
    btn.disabled = false;
    btn.textContent = "Save teacher";
  }
}

function listenTeachers() {
  onSnapshot(collection(db, "teachers"), (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    $("teacherCount").textContent = rows.length;

    const body = $("teacherRows");
    body.innerHTML = "";
    rows.forEach((t) => {
      const tr = document.createElement("tr");
      [t.name, t.subject, t.qualification || "-", "+" + t.phone, t.email]
        .forEach((v) => tr.appendChild(cell(v)));
      tr.appendChild(actionsCell(() => startEditTeacher(t), () => deleteTeacher(t)));
      body.appendChild(tr);
    });

    const empty = $("teacherEmpty");
    empty.textContent = "No teachers yet. Add the first teacher using the form above.";
    empty.hidden = rows.length > 0;
  }, (err) => {
    console.error(err);
    const empty = $("teacherEmpty");
    empty.textContent = "Could not load teachers. Check the Firestore rules.";
    empty.hidden = false;
  });
}

/* ---------- Notices (shown to parents on parent-dashboard.html) ---------- */
async function postNotice(e) {
  e.preventDefault();
  const msg = $("noticeMsg");
  hideMsg(msg);
  const title = $("n_title").value.trim();
  const body = $("n_body").value.trim();
  if (!title || !body) return showMsg(msg, "Write a title and the notice text.");

  const btn = $("noticeBtn");
  btn.disabled = true;
  btn.textContent = "Posting…";
  try {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    await addDoc(collection(db, "notices"), { title, body, date, createdAt: serverTimestamp() });
    $("noticeForm").reset();
    showMsg(msg, "Notice posted. Parents can see it now.", "ok");
  } catch (err) {
    console.error(err);
    showMsg(msg, err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not post. Check your internet and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Post notice";
  }
}

function listenNotices() {
  onSnapshot(query(collection(db, "notices"), orderBy("createdAt", "desc")), (snap) => {
    $("noticeCount").textContent = snap.size;
    const body = $("noticeRows");
    body.innerHTML = "";
    snap.docs.forEach((d) => {
      const n = d.data();
      const tr = document.createElement("tr");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn alt small";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!confirm(`Delete the notice "${n.title}"?`)) return;
        try { await deleteDoc(doc(db, "notices", d.id)); }
        catch (err) { console.error(err); alert("Could not delete. Try again."); }
      });
      const tdDel = document.createElement("td");
      tdDel.appendChild(del);
      tr.append(cell(n.date || ""), cell(n.title), cell(n.body.length > 90 ? n.body.slice(0, 90) + "…" : n.body), tdDel);
      body.appendChild(tr);
    });
    const empty = $("noticeEmpty");
    empty.textContent = "No notices yet. Post the first one using the form above.";
    empty.hidden = !snap.empty;
  }, (err) => {
    console.error(err);
    $("noticeEmpty").textContent = "Could not load notices. Check the Firestore rules.";
    $("noticeEmpty").hidden = false;
  });
}

/* ---------- Delete student / teacher ---------- */
function deleteCell(onClick) {
  const td = document.createElement("td");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn alt small";
  btn.textContent = "Delete";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try { await onClick(); } finally { btn.disabled = false; }
  });
  td.appendChild(btn);
  return td;
}

// Removes the student and all their fee records,
// and unlinks them from the parent's phone number.
// (Payment history in "feePayments" is kept as an accounts record.)
async function deleteStudent(s) {
  if (!confirm(`Delete ${s.name} (${s.class}, Roll ${s.rollNo})?\n\nTheir fee records will also be deleted. This cannot be undone.`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "students", s.id));

    const fees = await getDocs(query(collection(db, "fees"), where("studentId", "==", s.id)));
    fees.docs.forEach((d) => batch.delete(d.ref));

    // Remove this child from the parent's phone link
    if (s.parentPhone) {
      const idxRef = doc(db, "parentIndex", s.parentPhone);
      const idx = await getDoc(idxRef);
      if (idx.exists()) {
        const rest = (idx.data().children || []).filter((c) => c.id !== s.id);
        if (rest.length) batch.update(idxRef, { children: rest });
        else batch.delete(idxRef);
      }
    }
    await batch.commit();
  } catch (err) {
    console.error(err);
    alert(err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not delete. Check your internet and try again.");
  }
}

// Removes the teacher's record and their access to the app.
// The sign-in account itself stays in Firebase Authentication (see note on screen).
async function deleteTeacher(t) {
  if (!confirm(`Delete ${t.name}?\n\nThey will no longer be able to use the app. This cannot be undone.`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "teachers", t.id));
    batch.delete(doc(db, "users", t.id));
    await batch.commit();
    alert(`${t.name} removed.\n\nIf you want to add this email again later, first delete it in Firebase Console > Authentication > Users.`);
  } catch (err) {
    console.error(err);
    alert(err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not delete. Check your internet and try again.");
  }
}

/* ---------- Edit student / teacher ---------- */
let editingStudent = null;
let editingTeacher = null;

function actionsCell(onEdit, onDelete) {
  const td = document.createElement("td");
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "8px";
  [["Edit", onEdit], ["Delete", onDelete]].forEach(([label, fn]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn alt small";
    b.textContent = label;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await fn(); } finally { b.disabled = false; }
    });
    wrap.appendChild(b);
  });
  td.appendChild(wrap);
  return td;
}

// Stored phone is digits only, e.g. 919876543210 -> code 91, number 9876543210
function splitPhone(full) {
  const s = String(full || "");
  if (s.length > 10) return [s.slice(0, s.length - 10), s.slice(-10)];
  return [s.slice(0, 2), s.slice(2)];
}

/* --- Student --- */
function startEditStudent(s) {
  editingStudent = s;
  const [code, num] = splitPhone(s.parentPhone);
  $("s_name").value = s.name || "";
  $("s_father").value = s.fatherName || "";
  $("s_class").value = s.class || "";
  $("s_roll").value = s.rollNo || "";
  $("s_code").value = "+" + code;
  $("s_phone").value = num;
  $("s_fee").value = s.monthlyFee;
  $("studentFormTitle").textContent = `Edit ${s.name}`;
  $("studentBtn").textContent = "Save changes";
  $("studentCancel").hidden = false;
  hideMsg($("studentMsg"));
  $("studentForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

function exitStudentEdit() {
  editingStudent = null;
  $("studentForm").reset();
  $("s_code").value = "+91";
  $("studentFormTitle").textContent = "Add new student";
  $("studentBtn").textContent = "Save student";
  $("studentCancel").hidden = true;
  hideMsg($("studentMsg"));
}

// Saves the changes and keeps the parent link and fee records in step
async function updateStudentRecord(old, n) {
  const id = old.id;
  const batch = writeBatch(db);
  batch.update(doc(db, "students", id), {
    name: n.name, fatherName: n.fatherName,
    class: n.cls, rollNo: n.rollNo, parentPhone: n.parentPhone, monthlyFee: n.monthlyFee
  });

  // Parent phone link: replace this child's entry, and move it if the phone changed
  const newRef = doc(db, "parentIndex", n.parentPhone);
  const newSnap = await getDoc(newRef);
  const kids = (newSnap.exists() ? newSnap.data().children || [] : []).filter((c) => c.id !== id);
  kids.push({ id, name: n.name, class: n.cls, rollNo: n.rollNo });
  batch.set(newRef, { phone: n.parentPhone, children: kids }, { merge: true });

  if (old.parentPhone && old.parentPhone !== n.parentPhone) {
    const oldRef = doc(db, "parentIndex", old.parentPhone);
    const oldSnap = await getDoc(oldRef);
    if (oldSnap.exists()) {
      const rest = (oldSnap.data().children || []).filter((c) => c.id !== id);
      if (rest.length) batch.update(oldRef, { children: rest });
      else batch.delete(oldRef);
    }
  }

  // Fee records: refresh the copied details; this month's fee follows a changed monthly fee
  const now = new Date();
  const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const fees = await getDocs(query(collection(db, "fees"), where("studentId", "==", id)));
  fees.docs.forEach((d) => {
    const f = d.data();
    const upd = {
      studentName: n.name, fatherName: n.fatherName,
      class: n.cls, rollNo: n.rollNo, parentPhone: n.parentPhone
    };
    if (f.month === cur && Number(f.monthlyFee) !== n.monthlyFee) {
      upd.monthlyFee = n.monthlyFee;
      upd.totalDue = n.monthlyFee + (f.arrears || 0);
    }
    batch.update(d.ref, upd);
  });

  await batch.commit();
}

/* --- Teacher (the login email and password are not changed here) --- */
function startEditTeacher(t) {
  editingTeacher = t;
  const [code, num] = splitPhone(t.phone);
  $("t_name").value = t.name || "";
  $("t_subject").value = t.subject || "";
  $("t_qual").value = t.qualification || "";
  $("t_code").value = "+" + code;
  $("t_phone").value = num;
  $("t_email").value = t.email || "";
  $("t_email").disabled = true;
  $("t_pass").value = "";
  $("t_pass").disabled = true;
  $("t_pass").placeholder = "Not changed here";
  $("teacherFormTitle").textContent = `Edit ${t.name}`;
  $("teacherBtn").textContent = "Save changes";
  $("teacherCancel").hidden = false;
  hideMsg($("teacherMsg"));
  $("teacherForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

function exitTeacherEdit() {
  editingTeacher = null;
  $("teacherForm").reset();
  $("t_code").value = "+91";
  $("t_email").disabled = false;
  $("t_pass").disabled = false;
  $("t_pass").placeholder = "";
  $("teacherFormTitle").textContent = "Add new teacher";
  $("teacherBtn").textContent = "Save teacher";
  $("teacherCancel").hidden = true;
  hideMsg($("teacherMsg"));
}

async function updateTeacherRecord(name, subject, qualification, phone) {
  const msg = $("teacherMsg");
  const btn = $("teacherBtn");
  const id = editingTeacher.id;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "teachers", id), { name, subject, qualification, phone });
    batch.update(doc(db, "users", id), { name });
    await batch.commit();
    exitTeacherEdit();
    showMsg(msg, `${name} updated.`, "ok");
  } catch (err) {
    console.error(err);
    btn.textContent = "Save changes";
    showMsg(msg, err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not save. Check your internet and try again.");
  } finally {
    btn.disabled = false;
  }
}


/* ---------- Parents: logins for the parent page ---------- */
// Each parent phone number is a username: <phone>@parents.chandschool.app (never shown to parents).
const PARENT_EMAIL_DOMAIN = "parents.chandschool.app";
const parentEmail = (phone) => `${phone}@${PARENT_EMAIL_DOMAIN}`;
let parentIndexDocs = {};   // phone -> { children: [...] }
let parentLoginDocs = {};   // phone -> { password, uid }

function randomPassword() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(100000 + (n[0] % 900000));
}

function loginMessage(phone, password) {
  const link = new URL("parent-dashboard.html", location.href).href;
  return [
    "Dear Parent,",
    "",
    "Chand School parent login:",
    `Username: +${phone}`,
    `Password: ${password}`,
    `Login page: ${link}`,
    "",
    "Yahan aap apne bachche ki fee ki halat aur school ke notices dekh sakte hain."
  ].join("\n");
}

// Creating or changing another person's login needs a second Firebase app,
// so the admin does not get signed out.
async function withSecondaryAuth(fn) {
  const secApp = initializeApp(app.options, "parent-" + Date.now() + "-" + Math.floor(Math.random() * 1e6));
  const secAuth = getAuth(secApp);
  try {
    return await fn(secAuth);
  } finally {
    try { await signOut(secAuth); } catch (_) { /* ignore */ }
    try { await deleteApp(secApp); } catch (_) { /* ignore */ }
  }
}

async function createParentLogin(phone, password) {
  await withSecondaryAuth(async (secAuth) => {
    const cred = await createUserWithEmailAndPassword(secAuth, parentEmail(phone), password);
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, "parentLogins", phone), { phone, password, uid: cred.user.uid, createdAt: serverTimestamp() });
      await batch.commit();
    } catch (err) {
      try { await deleteUser(cred.user); } catch (_) { /* ignore */ }
      throw err;
    }
  });
}

async function changeParentPassword(phone, oldPassword, newPassword) {
  await withSecondaryAuth(async (secAuth) => {
    const cred = await signInWithEmailAndPassword(secAuth, parentEmail(phone), oldPassword);
    await updatePassword(cred.user, newPassword);
    const batch = writeBatch(db);
    batch.update(doc(db, "parentLogins", phone), { password: newPassword, updatedAt: serverTimestamp() });
    await batch.commit();
  });
}

// Used when a student is added: give a brand-new parent number a login straight away
async function ensureParentLogin(phone) {
  const snap = await getDoc(doc(db, "parentLogins", phone));
  if (snap.exists()) return false;
  const typed = $("p_default").value.trim();
  await createParentLogin(phone, typed.length >= 6 ? typed : randomPassword());
  return true;
}

function allParentPhones() {
  return [...new Set([...Object.keys(parentIndexDocs), ...Object.keys(parentLoginDocs)])].sort();
}

function listenParents() {
  const failed = (err) => {
    console.error(err);
    $("p_empty").textContent = "Could not load parents. Check the Firestore rules.";
    $("p_empty").hidden = false;
  };
  onSnapshot(collection(db, "parentIndex"), (snap) => {
    parentIndexDocs = {};
    snap.docs.forEach((d) => { parentIndexDocs[d.id] = d.data(); });
    renderParents();
  }, failed);
  onSnapshot(collection(db, "parentLogins"), (snap) => {
    parentLoginDocs = {};
    snap.docs.forEach((d) => { parentLoginDocs[d.id] = d.data(); });
    renderParents();
  }, failed);
  $("p_search").addEventListener("input", renderParents);
}

function renderParents() {
  const term = $("p_search").value.trim().toLowerCase();
  const phones = allParentPhones();
  $("parentCount").textContent = phones.length;

  const body = $("p_rows");
  body.innerHTML = "";
  let shown = 0;
  phones.forEach((phone) => {
    const kids = (parentIndexDocs[phone]?.children || []).map((c) => `${c.name} (${c.class})`);
    const text = kids.join(", ");
    if (term && !phone.includes(term.replace(/\D/g, "") || "\u0000") && !text.toLowerCase().includes(term)) return;
    shown++;
    const login = parentLoginDocs[phone];
    const tr = document.createElement("tr");
    tr.append(cell("+" + phone), cell(text || "-"));

    const tdPw = document.createElement("td");
    if (login) {
      const span = document.createElement("span");
      span.textContent = "••••••";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "btn alt small";
      toggle.style.marginLeft = "8px";
      toggle.textContent = "Show";
      toggle.addEventListener("click", () => {
        const hidden = span.textContent === "••••••";
        span.textContent = hidden ? login.password : "••••••";
        toggle.textContent = hidden ? "Hide" : "Show";
      });
      tdPw.append(span, toggle);
    } else {
      tdPw.textContent = "No login yet";
    }

    const tdAct = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
    const set = document.createElement("button");
    set.type = "button";
    set.className = "btn alt small";
    set.textContent = login ? "Change password" : "Create login";
    set.addEventListener("click", async () => { set.disabled = true; try { await setParentPassword(phone); } finally { set.disabled = false; } });
    wrap.appendChild(set);
    if (login) {
      const wa = document.createElement("a");
      wa.className = "btn small";
      wa.textContent = "Send on WhatsApp";
      wa.target = "_blank";
      wa.rel = "noopener noreferrer";
      wa.href = `https://wa.me/${phone}?text=${encodeURIComponent(loginMessage(phone, login.password))}`;
      wrap.appendChild(wa);
    }
    tdAct.appendChild(wrap);
    tr.append(tdPw, tdAct);
    body.appendChild(tr);
  });

  const empty = $("p_empty");
  empty.textContent = phones.length === 0
    ? "No parent numbers yet. They appear when you add students (or after Update parent portal on the Fees page)."
    : "No parent matches your search.";
  empty.hidden = shown > 0;
}

async function setParentPassword(phone) {
  const msg = $("p_msg");
  const login = parentLoginDocs[phone];
  const pw = prompt(`${login ? "New password" : "Password"} for +${phone}\n(at least 6 characters)`, "");
  if (pw === null) return;
  if (pw.trim().length < 6) { alert("The password needs at least 6 characters."); return; }
  try {
    if (login) await changeParentPassword(phone, login.password, pw.trim());
    else await createParentLogin(phone, pw.trim());
    showMsg(msg, `Password saved for +${phone}.`, "ok");
  } catch (err) {
    console.error(err);
    showMsg(msg, {
      "auth/email-already-in-use": `+${phone} already has a login that this app does not know. In Firebase > Authentication > Users, delete ${parentEmail(phone)}, then try again.`,
      "auth/weak-password": "The password is too weak. Use at least 6 characters.",
      "auth/operation-not-allowed": "Email/Password sign-in is turned off in Firebase Authentication.",
      "permission-denied": "Not allowed. Check the Firestore rules (see firestore.rules)."
    }[err.code] || "Could not save the password. Check your internet and try again.");
  }
}

async function createMissingLogins() {
  const msg = $("p_msg");
  const typed = $("p_default").value.trim();
  if (typed && typed.length < 6) return showMsg(msg, "The password needs at least 6 characters.");
  const missing = allParentPhones().filter((p) => !parentLoginDocs[p]);
  if (missing.length === 0) return showMsg(msg, "Every parent number already has a login.", "ok");
  if (!confirm(`Create ${missing.length} parent login${missing.length === 1 ? "" : "s"}?\n\n${typed ? "All of them will get the password you typed." : "Each one gets a different random 6-digit password."}`)) return;

  const btn = $("p_createAll");
  btn.disabled = true;
  let done = 0, failed = 0;
  for (const phone of missing) {
    try { await createParentLogin(phone, typed || randomPassword()); done++; }
    catch (err) { console.error(err); failed++; }
    showMsg(msg, `Creating logins… ${done + failed} of ${missing.length}`, "info");
  }
  btn.disabled = false;
  showMsg(msg, `Done. ${done} created${failed ? `, ${failed} failed. Use Create login on those rows to see why.` : "."}`, failed ? "warn" : "ok");
}
