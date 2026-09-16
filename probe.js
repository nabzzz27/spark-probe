// Throwaway probe for ticket 18. Every observation lands in the on-page log.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, writeBatch, onSnapshot,
  getDocsFromServer, getDocsFromCache, serverTimestamp, query, where, limit,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import config from "./firebase-config.js";

const app = initializeApp(config);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// ── log ────────────────────────────────────────────────────────────────
const logEl = document.getElementById("log");
const LOG_KEY = "probe-log";
const stamp = () => {
  const d = new Date();
  const sgt = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Singapore" });
  const pt = d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${d.toISOString()} | SGT ${sgt} | PT ${pt}`;
};
function log(msg, isErr = false) {
  const line = `${stamp()} | ${msg}`;
  try { localStorage.setItem(LOG_KEY, (localStorage.getItem(LOG_KEY) || "") + line + "\n"); } catch {}
  const div = document.createElement("div");
  div.textContent = line;
  if (isErr) div.className = "err";
  logEl.prepend(div);
}
const describe = (e) => `code=${e.code ?? "-"} name=${e.name} message=${e.message}`;
try { for (const l of (localStorage.getItem(LOG_KEY) || "").trim().split("\n").filter(Boolean)) {
  const div = document.createElement("div"); div.textContent = l; logEl.prepend(div);
} } catch {}

// Client-side read tally, keyed by Pacific date so it lines up with the quota day.
const ptDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
function tally(n) {
  const key = `reads-${ptDay()}`;
  let total = n;
  try { total = Number(localStorage.getItem(key) || 0) + n; localStorage.setItem(key, total); } catch {}
  document.getElementById("tally").textContent = total;
}
tally(0);

// One-shot calls get a timeout so a silent hang is observable, not invisible.
const withTimeout = (p, ms = 30000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`no answer after ${ms / 1000}s`), { code: "probe-timeout" })), ms))]);

const uid = () => auth.currentUser?.uid ?? "anon";
const device = navigator.userAgent.includes("iPhone") ? "iphone" : "desktop";

// ── actions ────────────────────────────────────────────────────────────
const actions = {
  async signInPopup() { const r = await signInWithPopup(auth, new GoogleAuthProvider()); log(`popup sign-in ok: ${r.user.email}`); },
  async signInRedirect() { log("redirect sign-in starting"); await signInWithRedirect(auth, new GoogleAuthProvider()); },
  async signOutNow() { await signOut(auth); log("signed out"); },

  async seed() {
    for (let start = 0; start < 1000; start += 500) {
      const batch = writeBatch(db);
      for (let i = start; i < start + 500; i++) batch.set(doc(db, "burn", `d${String(i).padStart(4, "0")}`), { i });
      await withTimeout(batch.commit());
    }
    log("seeded 1,000 docs in burn/ (1,000 writes)");
  },

  async burnReads() {
    const t0 = Date.now();
    // Firestore caps limit() at 10,000; a random base per run keeps every pass a new query.
    const base = 1001 + Math.floor(Math.random() * 8900);
    for (let pass = 1; pass <= 80; pass++) {
      try {
        // A distinct query each pass: re-running the same query resumes from the cache and
        // the server bills only changed docs, which is why the first burn barely moved the quota.
        const q = query(collection(db, "burn"), where("i", ">=", 0), limit(base + pass));
        const snap = await withTimeout(getDocsFromServer(q));
        tally(snap.size);
        if (pass % 5 === 0) log(`burn pass ${pass}: ${snap.size} docs`);
      } catch (e) {
        log(`BURN FAILED on pass ${pass} after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${describe(e)}`, true);
        return;
      }
    }
    log("burn: 80 passes finished without failure");
  },

  async probe() {
    const ref = doc(db, "probe", `${device}-${Date.now()}`);
    const run = async (label, fn) => {
      const t0 = Date.now();
      try { await withTimeout(fn(), 20000); log(`probe ${label}: OK (${Date.now() - t0} ms)`); }
      catch (e) { log(`probe ${label}: FAILED (${Date.now() - t0} ms) ${describe(e)}`, true); }
    };
    await run("read", async () => { const s = await getDocsFromServer(collection(db, "gate")); tally(Math.max(1, s.size)); });
    await run("write", () => setDoc(ref, { at: serverTimestamp() }));
    await run("delete", () => deleteDoc(ref));
  },

  listen() {
    let n = 0;
    onSnapshot(collection(db, "probe"), { includeMetadataChanges: true },
      (s) => { n++; tally(s.docChanges().length); log(`listener snapshot #${n}: size=${s.size} fromCache=${s.metadata.fromCache} pending=${s.metadata.hasPendingWrites}`); },
      (e) => log(`listener ERROR after ${n} snapshots: ${describe(e)}`, true));
    log("listener attached to probe/");
  },

  async rulesGet() {
    await setDoc(doc(db, "gate", "open"), { ok: true });
    for (let i = 0; i < 200; i++) await setDoc(doc(db, "ruletest", `r${i}`), { i, at: Date.now() });
    log("rulesGet: 1 gate write + 200 ruletest writes done. Expect 200 extra billed reads from get(); compare with the usage dashboard.");
  },

  async readCache() {
    try {
      const s = await getDocsFromCache(collection(db, "offline"));
      log(`cache read offline/: ${s.size} docs (no network used)`);
    } catch (e) { log(`cache read FAILED: ${describe(e)}`, true); }
  },

  async writeOffline() {
    const tag = Date.now();
    for (let i = 0; i < 5; i++) {
      setDoc(doc(db, "offline", `${device}-${tag}-${i}`), { tag, i, writtenAt: new Date().toISOString() })
        .then(() => log(`offline doc ${tag}-${i} acknowledged by server`))
        .catch((e) => log(`offline doc ${tag}-${i} FAILED: ${describe(e)}`, true));
    }
    log(`queued 5 writes tagged ${tag}; online=${navigator.onLine}`);
  },

  async checkServer() {
    const s = await withTimeout(getDocsFromServer(collection(db, "offline")));
    tally(s.size);
    const tags = {};
    s.forEach((d) => { const t = d.data().tag; tags[t] = (tags[t] || 0) + 1; });
    log(`server offline/: ${s.size} docs, by tag ${JSON.stringify(tags)}`);
  },

  async storageInfo() {
    const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : "n/a";
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : "n/a";
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    log(`storage: indexedDB=${JSON.stringify(dbs)} persisted=${persisted} usage=${est.usage ?? "n/a"} standalone=${matchMedia("(display-mode: standalone)").matches}`);
  },

  async copyLog() {
    const text = localStorage.getItem(LOG_KEY) || "";
    try { await navigator.clipboard.writeText(text); log(`log copied (${text.split("\n").length - 1} lines)`); }
    catch { prompt("Copy the log:", text); }
  },
  clearLog() { try { localStorage.removeItem(LOG_KEY); } catch {} logEl.textContent = ""; },
};

document.body.addEventListener("click", async (ev) => {
  const act = ev.target.closest("button")?.dataset.act;
  if (!act) return;
  try { await actions[act](); } catch (e) { log(`${act} FAILED: ${describe(e)}`, true); }
});

onAuthStateChanged(auth, (u) => { document.getElementById("who").textContent = u ? u.email : "no"; });
getRedirectResult(auth)
  .then((r) => { if (r) log(`redirect sign-in ok: ${r.user.email}`); })
  .catch((e) => log(`redirect sign-in FAILED: ${describe(e)}`, true));
log(`page loaded on ${device}; project=${config.projectId}; online=${navigator.onLine}`);
