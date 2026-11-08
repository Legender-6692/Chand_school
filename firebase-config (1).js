// firebase-config.js
// Firebase connection for the whole School Management System.
// Every other page will import { auth, db } from this file.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBRt99EV47_8spZF2QMRZ-u0at7SSok1xw",
  authDomain: "school-app-9defa.firebaseapp.com",
  projectId: "school-app-9defa",
  storageBucket: "school-app-9defa.firebasestorage.app",
  messagingSenderId: "376885563109",
  appId: "1:376885563109:web:3f8b38cf52a09f1bea0e0c",
  measurementId: "G-LBQ9EYQM0V"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
