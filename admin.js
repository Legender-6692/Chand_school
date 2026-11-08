// admin.js - logic for admin-dashboard.html
import { app, auth, db } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut,
  createUserWithEmailAndPassword, deleteUser
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

/* ---------- Sidebar navigation ---------- */
document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((b) => b.removeAttribute("aria-current"));
    btn.setAttribute("aria-current", "page");
    ["students", "teachers", "notices"].forEach((v) => {
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
  const motherName = $("s_mother").value.trim();
  const cls = $("s_class").value;
  const rollNo = $("s_roll").value.trim();
  const parentPhone = buildPhone($("s_code").value, $("s_phone").value);
  const monthlyFee = Number($("s_fee").value);

  if (!name || !fatherName || !motherName) return showMsg(msg, "Fill in the student, father and mother names.");
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
      where("class", "==", cls), where("rollNo", "==", rollNo), limit(1)
    ));
    if (!dup.empty) {
      showMsg(msg, `Roll number ${rollNo} already exists in ${cls}.`);
      return;
    }

    const studentRef = doc(collection(db, "students"));
    const batch = writeBatch(db);
    batch.set(studentRef, {
      name, fatherName, motherName,
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
    showMsg(msg, `${name} saved.`, "ok");
  } catch (err) {
    console.error(err);
    showMsg(msg, err.code === "permission-denied"
      ? "Not allowed. Check the Firestore rules (see firestore.rules)."
      : "Could not save. Check your internet and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save student";
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
    [s.class, s.rollNo, s.name, s.fatherName, s.motherName,
     "+" + s.parentPhone, Number(s.monthlyFee).toLocaleString()]
      .forEach((v) => tr.appendChild(cell(v)));
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
