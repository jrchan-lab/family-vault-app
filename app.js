// 保险箱 · app.js — screens and wiring. All text the user sees is here or in index.html.
import * as vc from './crypto.js';
import * as db from './db.js';

export const APP_VERSION = '1.0.0';
const IDLE_LOCK_MS = 60 * 1000;
const MAX_TRIES_BEFORE_WAIT = 5;
const WAIT_SECONDS = 30;

const $ = (id) => document.getElementById(id);

const state = {
  key: null,        // CryptoKey (non-extractable). null = locked.
  kdf: null,
  env: null,        // current encrypted envelope (same as in IndexedDB)
  entries: null,    // decrypted entries, only while unlocked
  meta: {},
  editingId: null,
  restoreBack: 's-setup',
  lastActive: Date.now(),
  busy: 0,
  fails: 0,
};

// ---------- small helpers ----------
function show(id) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== id;
  window.scrollTo(0, 0);
}
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function setErr(id, msg) { $(id).textContent = msg || ''; }
function ask(text) {
  const d = $('confirm');
  $('confirm-text').textContent = text;
  if (typeof d.showModal !== 'function') return Promise.resolve(window.confirm(text));
  return new Promise((resolve) => {
    const done = (v) => { d.close(); $('confirm-yes').onclick = $('confirm-no').onclick = null; resolve(v); };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
    d.oncancel = (e) => { e.preventDefault(); done(false); };
    d.showModal();
  });
}
async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label; state.busy++;
  try { return await fn(); } finally { state.busy--; btn.disabled = false; btn.textContent = old; }
}
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function errText(e, wrongMsg) {
  if (e && e.code === 'WRONG_PASSWORD') return wrongMsg || '主密码不对，再试一次。';
  if (e && e.code === 'BAD_FILE') return '这个不是保险箱的备份文件，或者文件坏了。';
  if (e && e.code === 'WEAK_PASSWORD') return `主密码太短，最少 ${vc.MIN_PASSWORD_LENGTH} 个字。`;
  if (e && e.code === 'EMPTY_PASSWORD') return '请输入主密码。';
  console.error(e);
  return '出了问题，请再试一次。如果一直这样，请找 JR。';
}

// ---------- save: encrypt everything, write in one transaction ----------
async function saveEntries(entries) {
  const env = await vc.seal(state.key, state.kdf, { entries, savedAt: Date.now() });
  const meta = { ...state.meta, changedSinceBackup: true };
  await db.putMany({ vault: env, meta });
  state.env = env; state.meta = meta; state.entries = entries;
}

function enterVault({ key, kdf, data, env, meta }) {
  state.key = key; state.kdf = kdf; state.env = env;
  state.entries = data.entries; state.meta = meta || {};
  state.fails = 0; state.lastActive = Date.now();
  renderList(); show('s-list');
}

function lock() {
  state.key = null; state.kdf = null; state.entries = null; state.editingId = null;
  for (const f of document.querySelectorAll('form')) f.reset();
  $('search').value = '';
  $('list').replaceChildren();
  for (const id of ['lock-err', 'edit-err', 'res-err', 'cp-err', 'setup-err']) setErr(id, '');
  const d = $('confirm'); if (d.open) d.close();
  db.get('vault').then((env) => {
    state.env = env || null;
    show(env ? 's-lock' : 's-setup');
  }, () => show('s-lock'));
}

// ---------- list ----------
function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const all = [...state.entries].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const hits = q ? all.filter((e) => `${e.title}\n${e.cat}\n${e.body}`.toLowerCase().includes(q)) : all;
  const ul = $('list');
  ul.replaceChildren(...hits.map((e) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'item';
    const t = document.createElement('span'); t.className = 'item-title';
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = e.cat || '其他';
    t.append(tag, document.createTextNode(e.title));
    const s = document.createElement('span'); s.className = 'item-sub';
    s.textContent = (e.body || '').split('\n')[0] || ' ';
    b.append(t, s);
    b.addEventListener('click', () => openEdit(e.id));
    li.append(b);
    return li;
  }));
  $('list-empty').hidden = all.length !== 0;
  $('list-none').hidden = !(all.length && !hits.length);
  $('backup-nag').hidden = !(state.meta.changedSinceBackup && all.length);
}

// ---------- edit ----------
function openEdit(id) {
  state.editingId = id || null;
  const e = id ? state.entries.find((x) => x.id === id) : null;
  $('edit-heading').textContent = e ? '修改' : '新增';
  $('edit-cat').value = e ? (e.cat || '其他') : '会员卡';
  $('edit-title').value = e ? e.title : '';
  $('edit-body').value = e ? e.body : '';
  $('edit-delete').hidden = !e;
  $('edit-copy').hidden = !e;
  setErr('edit-err', '');
  show('s-edit');
}

async function onSaveEntry(ev) {
  ev.preventDefault();
  const title = $('edit-title').value.trim();
  if (!title) { setErr('edit-err', '请写名字。'); return; }
  const now = Date.now();
  const fields = { title, cat: $('edit-cat').value, body: $('edit-body').value };
  const entries = state.editingId
    ? state.entries.map((e) => (e.id === state.editingId ? { ...e, ...fields, updated: now } : e))
    : [...state.entries, { id: newId(), ...fields, created: now, updated: now }];
  const btn = ev.submitter || $('f-edit').querySelector('button[type=submit]');
  try {
    await busy(btn, '正在保存…', () => saveEntries(entries));
    toast('✅ 保存好了');
    $('search').value = '';
    renderList(); show('s-list');
  } catch (e) {
    setErr('edit-err', '保存不到！资料还没存。' + errText(e));
  }
}

async function onDelete() {
  const e = state.entries.find((x) => x.id === state.editingId);
  if (!e) return;
  if (!(await ask(`真的要删除「${e.title}」？删了就没有了。`))) return;
  try {
    await busy($('edit-delete'), '正在删除…', () => saveEntries(state.entries.filter((x) => x.id !== e.id)));
    toast('已删除');
    renderList(); show('s-list');
  } catch (err) {
    setErr('edit-err', errText(err));
  }
}

async function onCopy() {
  try {
    await navigator.clipboard.writeText($('edit-body').value);
    toast('📋 已复制');
  } catch {
    toast('复制不到，请长按文字自己复制');
  }
}

// ---------- setup / unlock ----------
async function onSetup(ev) {
  ev.preventDefault();
  const p1 = $('setup-pw1').value, p2 = $('setup-pw2').value;
  if (p1 !== p2) { setErr('setup-err', '两次输入的主密码不一样。'); return; }
  if (!$('setup-ok').checked) { setErr('setup-err', '请先打勾，确认你明白。'); return; }
  try {
    vc.checkNewPassword(p1);
    const btn = $('f-setup').querySelector('button[type=submit]');
    await busy(btn, '正在设定…', async () => {
      const { key, kdf, envelope } = await vc.createVault(p1);
      const meta = { changedSinceBackup: false };
      await db.putMany({ vault: envelope, meta });
      enterVault({ key, kdf, data: { entries: [] }, env: envelope, meta });
    });
    $('f-setup').reset();
    toast('✅ 设定好了');
  } catch (e) {
    setErr('setup-err', errText(e));
  }
}

let waitTimer = 0;
async function onUnlock(ev) {
  ev.preventDefault();
  const pw = $('lock-pw').value;
  setErr('lock-err', '');
  try {
    await busy($('lock-go'), '正在打开…', async () => {
      const env = await db.get('vault');
      if (!env) { show('s-setup'); return; }
      const res = await vc.unlock(pw, env);
      const meta = (await db.get('meta')) || {};
      $('f-lock').reset();
      enterVault({ ...res, env: vc.checkEnvelope(env), meta });
    });
  } catch (e) {
    $('lock-pw').value = '';
    if (e && e.code === 'BAD_FILE') {
      setErr('lock-err', '手机里的资料好像坏了。请用备份恢复。');
      $('lock-restore').hidden = false;
      return;
    }
    state.fails++;
    setErr('lock-err', errText(e));
    if (state.fails >= MAX_TRIES_BEFORE_WAIT) startWait();
  }
}
function startWait() {
  let left = WAIT_SECONDS;
  const btn = $('lock-go');
  btn.disabled = true;
  clearInterval(waitTimer);
  const tick = () => {
    btn.textContent = `请等 ${left} 秒`;
    if (left-- <= 0) { clearInterval(waitTimer); btn.disabled = false; btn.textContent = '打开'; state.fails = 0; }
  };
  tick();
  waitTimer = setInterval(tick, 1000);
}

// ---------- backup ----------
function renderSettings() {
  $('set-last').textContent = state.meta.lastBackupAt
    ? `上次备份：${fmtDate(state.meta.lastBackupAt)}${state.meta.changedSinceBackup ? '（之后有改过，要再备份）' : ''}`
    : '还没有做过备份。';
  $('app-version').textContent = APP_VERSION;
}

function backupName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `baoxianxiang-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

async function markBackedUp() {
  const meta = { ...state.meta, lastBackupAt: Date.now(), changedSinceBackup: false };
  await db.putMany({ meta });
  state.meta = meta;
  renderSettings();
}

// Must stay synchronous up to navigator.share(): iOS only allows the
// share sheet straight after a tap.
function onExport() {
  if (!state.env) return;
  const text = vc.backupText(state.env);
  const name = backupName();
  const file = new File([text], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: '保险箱备份' }).then(
      () => markBackedUp().then(() => toast('✅ 备份做好了')),
      (e) => {
        if (e && e.name === 'AbortError') { toast('没有做备份'); return; }
        downloadFile(file);
      });
  } else {
    downloadFile(file);
  }
}
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  markBackedUp().then(() => toast('✅ 备份文件下载了'));
}

function openRestore(back) {
  state.restoreBack = back;
  $('f-restore').reset();
  setErr('res-err', '');
  show('s-restore');
}

async function onRestore(ev) {
  ev.preventDefault();
  setErr('res-err', '');
  const file = $('res-file').files[0];
  const pw = $('res-pw').value;
  if (!file) { setErr('res-err', '请先选备份文件。'); return; }
  try {
    await busy($('res-go'), '正在恢复…', async () => {
      const env = vc.readBackupText(await file.text());
      const res = await vc.unlock(pw, env);
      const n = res.data.entries.length;
      const have = state.entries ? state.entries.length : null;
      if (have !== null || (await db.get('vault'))) {
        const msg = have !== null
          ? `手机里现在的 ${have} 项资料，会换成备份里的 ${n} 项。确定？`
          : `手机里现在的资料，会换成备份里的 ${n} 项。确定？`;
        if (!(await ask(msg))) return;
      }
      const meta = { lastBackupAt: Date.now(), changedSinceBackup: false };
      await db.putMany({ vault: env, meta });
      $('f-restore').reset();
      $('lock-restore').hidden = true;
      enterVault({ ...res, env, meta });
      toast(`✅ 恢复好了：${n} 项`);
    });
  } catch (e) {
    $('res-pw').value = '';
    setErr('res-err', errText(e, '主密码不对（要用做备份时的主密码），或者文件坏了。'));
  }
}

// ---------- change master password ----------
async function onChangePw(ev) {
  ev.preventDefault();
  setErr('cp-err', '');
  const old = $('cp-old').value, n1 = $('cp-new1').value, n2 = $('cp-new2').value;
  if (n1 !== n2) { setErr('cp-err', '两次输入的新主密码不一样。'); return; }
  try {
    vc.checkNewPassword(n1);
    await busy($('cp-go'), '正在换…', async () => {
      await vc.unlock(old, state.env); // proves the old password
      const { key, kdf, envelope } = await vc.createVault(n1, { entries: state.entries, savedAt: Date.now() });
      const meta = { ...state.meta, changedSinceBackup: true };
      await db.putMany({ vault: envelope, meta });
      Object.assign(state, { key, kdf, env: envelope, meta });
    });
    $('f-changepw').reset();
    toast('✅ 主密码换好了，请做新备份');
    renderSettings(); show('s-settings');
  } catch (e) {
    setErr('cp-err', errText(e, '现在的主密码不对。'));
  }
}

// ---------- auto-lock ----------
function touch() { state.lastActive = Date.now(); }
function idleCheck() {
  if (state.key && !state.busy && Date.now() - state.lastActive > IDLE_LOCK_MS) lock();
}
for (const t of ['pointerdown', 'keydown', 'input', 'touchstart', 'scroll', 'wheel']) {
  window.addEventListener(t, touch, { passive: true, capture: true });
}
setInterval(idleCheck, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // hide content from the app-switcher snapshot
    if (state.key) $('cover').hidden = false;
  } else {
    idleCheck();
    $('cover').hidden = true;
  }
});
window.addEventListener('pageshow', () => { idleCheck(); $('cover').hidden = true; });

// ---------- wire up ----------
function wire() {
  $('f-setup').addEventListener('submit', onSetup);
  $('setup-restore').addEventListener('click', () => openRestore('s-setup'));
  $('f-lock').addEventListener('submit', onUnlock);
  $('lock-restore').addEventListener('click', () => openRestore('s-lock'));
  $('list-lock').addEventListener('click', lock);
  $('list-settings').addEventListener('click', () => { renderSettings(); show('s-settings'); });
  $('nag-go').addEventListener('click', () => { renderSettings(); show('s-settings'); });
  $('list-add').addEventListener('click', () => openEdit(null));
  $('search').addEventListener('input', renderList);
  $('edit-back').addEventListener('click', () => { renderList(); show('s-list'); });
  $('f-edit').addEventListener('submit', onSaveEntry);
  $('edit-delete').addEventListener('click', onDelete);
  $('edit-copy').addEventListener('click', onCopy);
  $('set-back').addEventListener('click', () => { renderList(); show('s-list'); });
  $('set-export').addEventListener('click', onExport);
  $('set-restore').addEventListener('click', () => openRestore('s-settings'));
  $('set-changepw').addEventListener('click', () => { $('f-changepw').reset(); setErr('cp-err', ''); show('s-changepw'); });
  $('res-back').addEventListener('click', () => {
    if (state.restoreBack === 's-settings' && state.key) { renderSettings(); show('s-settings'); }
    else lock();
  });
  $('f-restore').addEventListener('submit', onRestore);
  $('cp-back').addEventListener('click', () => { renderSettings(); show('s-settings'); });
  $('f-changepw').addEventListener('submit', onChangePw);
}

async function boot() {
  // Refuse to run inside another site's frame (clickjacking).
  if (window.top !== window.self) { document.body.textContent = ''; return; }
  wire();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline or unsupported */ });
  }
  db.askPersistent();
  try {
    const env = await db.get('vault');
    state.env = env || null;
    show(env ? 's-lock' : 's-setup');
  } catch (e) {
    console.error(e);
    $('s-loading').textContent = '这个浏览器不能存资料。请用 Safari，并且不要用「无痕浏览」。';
  }
}

boot();