// teacher-dashboard.js - logic for teacher-dashboard.html
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, collection, getDocs, query, where, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const CLASSES = [
  "Playgroup", "Nursery", "LKG", "UKG",
  "Class 1", "Class 2", "Class 3", "Class 4", "Class 5",
  "Class 6", "Class 7", "Class 8", "Class 9", "Class 10"
];

const $ = (id) => document.getElementById(id);
const classIndex = (c) => CLASSES.indexOf(c);
const naturalCompare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
function cell(text, cls, label) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  if (label) td.dataset.label = label;
  return td;
}
// Students whose fee is still unpaid are listed from the day AFTER this day of the month
const DEFAULTER_AFTER_DAY = 10;
const CURRENCY = "Rs.";
let started = false;
let defaulters = [];

/* ---------- Sign-in guard: teachers (and admin) only ---------- */
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("index.html"); return; }
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : null;
    if (!data || data.active === false || !["teacher", "admin"].includes(data.role)) {
      await signOut(auth);
      location.replace("index.html");
      return;
    }
    $("userName").textContent = data.name || user.email;
    if (!started) { started = true; start(); }
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
    ["students", "defaulters", "notices"].forEach((v) => {
      $("view-" + v).hidden = btn.dataset.view !== v;
    });
  });
});

function start() {
  const sel = $("s_class");
  sel.innerHTML = '<option value="" disabled selected>Choose class</option>';
  CLASSES.forEach((c) => sel.add(new Option(c, c)));
  sel.addEventListener("change", loadStudents);
  loadNotices();
  setupDefaulters();
}

/* ---------- Class list ---------- */
async function loadStudents() {
  const cls = $("s_class").value;
  const body = $("studentRows");
  const empty = $("studentEmpty");
  body.innerHTML = "";
  try {
    const snap = await getDocs(query(collection(db, "students"), where("class", "==", cls)));
    const rows = snap.docs.map((d) => d.data())
      .filter((s) => s.status !== "inactive")
      .sort((a, b) => naturalCompare(a.rollNo, b.rollNo));
    rows.forEach((s) => {
      const tr = document.createElement("tr");
      tr.append(cell(s.rollNo, "", "Roll"), cell(s.name, "", "Student"), cell(s.fatherName || "", "", "Father"),
                cell(s.parentPhone ? "+" + s.parentPhone : "", "", "Parent number"));
      body.appendChild(tr);
    });
    empty.textContent = rows.length === 0 ? `No students in ${cls} yet.` : `${rows.length} students in ${cls}.`;
    empty.hidden = false;
  } catch (err) {
    console.error(err);
    empty.textContent = "Could not load students. Check the Firestore rules.";
    empty.hidden = false;
  }
}

/* ---------- Notices ---------- */
async function loadNotices() {
  const box = $("notices");
  try {
    const snap = await getDocs(query(collection(db, "notices"), orderBy("createdAt", "desc"), limit(10)));
    box.innerHTML = "";
    if (snap.empty) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No notices right now.";
      box.appendChild(p);
      return;
    }
    snap.docs.forEach((d) => {
      const n = d.data();
      const item = document.createElement("article");
      item.className = "notice";
      const h = document.createElement("h3"); h.textContent = n.title;
      const tm = document.createElement("time"); tm.textContent = n.date || "";
      const p = document.createElement("p"); p.textContent = n.body;
      item.append(h, tm, p);
      box.appendChild(item);
    });
  } catch (err) {
    console.error(err);
    box.innerHTML = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Notices could not be loaded right now.";
    box.appendChild(p);
  }
}

/* ---------- Defaulters: this month's fee still unpaid after the 10th ---------- */
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

function setupDefaulters() {
  const sel = $("d_class");
  sel.add(new Option("All classes", ""));
  CLASSES.forEach((c) => sel.add(new Option(c, c)));
  sel.addEventListener("change", renderDefaulters);
  loadDefaulters();
}

async function loadDefaulters() {
  const info = $("d_info");
  const empty = $("defEmpty");
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  if (now.getDate() <= DEFAULTER_AFTER_DAY) {
    info.textContent = `The defaulters list appears after the ${DEFAULTER_AFTER_DAY}th of each month. It will show here from the ${DEFAULTER_AFTER_DAY + 1}th.`;
    info.hidden = false;
    return;
  }
  try {
    const snap = await getDocs(query(collection(db, "fees"), where("month", "==", month)));
    if (snap.empty) {
      info.textContent = `Fee records for ${monthLabel(month)} have not been created yet. Please ask the admin to open the Fees page.`;
      info.hidden = false;
      return;
    }
    defaulters = snap.docs.map((d) => d.data())
      .filter((f) => f.totalDue - (f.paid || 0) > 0)
      .sort((a, b) => classIndex(a.class) - classIndex(b.class) || naturalCompare(a.rollNo, b.rollNo));
    info.hidden = true;
    renderDefaulters();
  } catch (err) {
    console.error(err);
    empty.textContent = "Could not load defaulters. Check the Firestore rules.";
    empty.hidden = false;
  }
}

function renderDefaulters() {
  const cls = $("d_class").value;
  const rows = defaulters.filter((f) => !cls || f.class === cls);
  const body = $("defRows");
  const empty = $("defEmpty");
  body.innerHTML = "";
  let owed = 0;
  rows.forEach((f) => {
    const balance = f.totalDue - (f.paid || 0);
    owed += balance;
    const tr = document.createElement("tr");
    tr.append(cell(f.class, "", "Class"), cell(f.rollNo, "", "Roll"), cell(f.studentName, "", "Student"),
              cell(f.fatherName || "", "", "Father"),
              cell(f.parentPhone ? "+" + f.parentPhone : "", "", "Parent number"),
              cell(`${CURRENCY} ${balance.toLocaleString()}`, "num", "Balance"));
    body.appendChild(tr);
  });
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  empty.textContent = rows.length === 0
    ? `No defaulters${cls ? " in " + cls : ""} for ${monthLabel(month)}.`
    : `${rows.length} student${rows.length === 1 ? "" : "s"} with unpaid fee for ${monthLabel(month)}. Total pending: ${CURRENCY} ${owed.toLocaleString()}.`;
  empty.hidden = false;
}
