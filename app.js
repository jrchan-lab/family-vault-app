// 保险箱 · app.js — screens, sheets and gestures.
// Security core (crypto.js, db.js, backup format, auto-lock) is unchanged from 1.0.0.
import * as vc from './crypto.js';
import * as db from './db.js';

export const APP_VERSION = '1.1.0';
const IDLE_LOCK_MS = 60 * 1000;
const MAX_TRIES_BEFORE_WAIT = 5;
const WAIT_SECONDS = 30;
const SVGNS = 'http://www.w3.org/2000/svg';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, REDUCED ? 0 : ms));

const state = {
  key: null,        // CryptoKey (non-extractable). null = locked.
  kdf: null,
  env: null,        // current encrypted envelope (same as in IndexedDB)
  entries: null,    // decrypted entries, only while unlocked
  meta: {},
  editingId: null,
  filter: '全部',
  lastActive: Date.now(),
  busy: 0,
  fails: 0,
};

// ---------- categories & icons ----------
const ICONS = {
  card: 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10.5h18M7 15h4',
  cake: 'M4 20h16M5.5 20v-6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6M5.5 15.5c2.2 1.4 4.3 1.4 6.5 0s4.3-1.4 6.5 0M12 12V8.5M12 4.5c1 1.2 1 2.2 0 3-1-.8-1-1.8 0-3z',
  house: 'M3.5 11 12 4l8.5 7M6 9.5V20h12V9.5M10 20v-5.5h4V20',
  phone: 'M7 3.5h2.6l1.6 4.4-2.1 1.4a10.5 10.5 0 0 0 5.6 5.6l1.4-2.1 4.4 1.6V17a3 3 0 0 1-3 3A15.5 15.5 0 0 1 4 7a3 3 0 0 1 3-3.5z',
  note: 'M6.5 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5zM14 3.5V8h4.5M9 12.5h6.5M9 16h4.5',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  trash: 'M4.5 7h15M10 11v6M14 11v6M6.5 7l1 13h9l1-13M9.5 7V4.5h5V7',
  chev: 'M9 6l6 6-6 6',
};
const CATS = [
  { name: '会员卡', tone: 't-violet', icon: 'card' },
  { name: '生日', tone: 't-rose', icon: 'cake' },
  { name: '地址', tone: 't-teal', icon: 'house' },
  { name: '电话', tone: 't-blue', icon: 'phone' },
  { name: '其他', tone: 't-slate', icon: 'note' },
];
const catOf = (name) => CATS.find((c) => c.name === name) || CATS[4];

function icon(name, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', ICONS[name]);
  s.append(p);
  return s;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function tile(cat) {
  const t = el('span', `tile ${cat.tone}`);
  t.append(icon(cat.icon));
  return t;
}

// ---------- the brass dial ----------
let dialSeq = 0;
function buildDial(host) {
  const n = ++dialSeq;
  const s = (tag, attrs, parent) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.append(e);
    return e;
  };
  const svg = s('svg', { viewBox: '0 0 200 200', 'aria-hidden': 'true' });
  const defs = s('defs', {}, svg);
  const rim = s('linearGradient', { id: `rim${n}`, x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
  s('stop', { offset: '0', class: 'stop-rim-1' }, rim);
  s('stop', { offset: '1', class: 'stop-rim-2' }, rim);
  const face = s('radialGradient', { id: `face${n}`, cx: '.35', cy: '.3', r: '.8' }, defs);
  s('stop', { offset: '0', class: 'stop-face-1' }, face);
  s('stop', { offset: '1', class: 'stop-face-2' }, face);
  const knob = s('linearGradient', { id: `knob${n}`, x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
  s('stop', { offset: '0', class: 'stop-rim-1' }, knob);
  s('stop', { offset: '1', class: 'stop-rim-2' }, knob);

  s('circle', { cx: 100, cy: 100, r: 97, fill: `url(#rim${n})` }, svg);
  s('circle', { cx: 100, cy: 100, r: 86, fill: `url(#face${n})` }, svg);
  const rot = s('g', { class: 'rot' }, svg);
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 * Math.PI) / 180;
    const major = i % 5 === 0;
    const r1 = major ? 64 : 70, r2 = 79;
    s('line', {
      x1: (100 + r1 * Math.sin(a)).toFixed(2), y1: (100 - r1 * Math.cos(a)).toFixed(2),
      x2: (100 + r2 * Math.sin(a)).toFixed(2), y2: (100 - r2 * Math.cos(a)).toFixed(2),
      class: major ? 'tick major' : 'tick',
    }, rot);
  }
  s('circle', { cx: 100, cy: 100, r: 44, fill: `url(#knob${n})` }, svg);
  const handle = s('g', { class: 'handle' }, svg);
  s('rect', { x: 93, y: 62, width: 14, height: 76, rx: 7, class: 'handle-bar' }, handle);
  s('circle', { cx: 100, cy: 100, r: 5, class: 'index' }, handle);
  s('path', { d: 'M100 17 l-6 -10 h12 z', class: 'index' }, svg);
  host.replaceChildren(svg);
}

const dial = {
  spin: null,
  host: null,
  parts(host) { return { rot: host.querySelector('.rot'), handle: host.querySelector('.handle') }; },
  start(host) {
    this.stop();
    this.host = host;
    if (REDUCED || !host.animate) return;
    const { rot } = this.parts(host);
    this.spin = rot.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 1800, iterations: Infinity, easing: 'linear' });
  },
  angle() {
    if (!this.spin) return 0;
    const t = Number(this.spin.currentTime) || 0;
    return ((t % 1800) / 1800) * 360;
  },
  stop() { if (this.spin) { this.spin.cancel(); this.spin = null; } },
  async open(host) {
    const from = this.angle();
    this.stop();
    if (REDUCED || !host.animate) return;
    const { rot, handle } = this.parts(host);
    rot.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${from + 420}deg)` }],
      { duration: 700, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'forwards' });
    await sleep(380);
    handle.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }],
      { duration: 360, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'forwards' });
    await sleep(420);
  },
  fail(host) {
    const from = this.angle();
    this.stop();
    if (REDUCED || !host.animate) return;
    const { rot } = this.parts(host);
    rot.animate([{ transform: `rotate(${from}deg)` }, { transform: 'rotate(0deg)' }],
      { duration: 450, easing: 'cubic-bezier(.2,.9,.25,1)' });
    host.classList.remove('shake');
    void host.offsetWidth;
    host.classList.add('shake');
  },
  reset(host) {
    this.stop();
    for (const a of host.getAnimations ? host.getAnimations({ subtree: true }) : []) a.cancel();
    host.classList.remove('shake');
  },
};

// ---------- screens, sheets, toast, action sheet ----------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) {
    const on = s.id === id;
    if (on && s.hidden) {
      s.hidden = false;
      s.classList.remove('enter', 'leave');
      void s.offsetWidth;
      s.classList.add('enter');
    } else if (!on) {
      s.hidden = true;
      s.classList.remove('enter', 'leave');
    }
  }
  window.scrollTo(0, 0);
}

let openSheetEl = null;
function openSheet(id) {
  if (openSheetEl && openSheetEl.id !== id) closeSheet(true);
  const sh = $(id), scrim = $('scrim');
  scrim.hidden = false; sh.hidden = false;
  void sh.offsetWidth;
  scrim.classList.add('show'); sh.classList.add('open');
  sh.style.transform = '';
  openSheetEl = sh;
}
function closeSheet(instant) {
  const sh = openSheetEl;
  if (!sh) return;
  openSheetEl = null;
  sh.classList.remove('open', 'dragging');
  sh.style.transform = '';
  const scrim = $('scrim');
  scrim.classList.remove('show');
  const done = () => { if (openSheetEl !== sh) sh.hidden = true; if (!openSheetEl && !$('action-sheet').classList.contains('open')) scrim.hidden = true; };
  if (instant || REDUCED) done(); else setTimeout(done, 420);
  if (document.activeElement && sh.contains(document.activeElement)) document.activeElement.blur();
}
function wireSheetDrag(sh) {
  const head = sh.querySelector('.sheet-head'), grab = sh.querySelector('.sheet-grab');
  let y0 = null, dy = 0;
  const down = (e) => { if (e.target.closest('button')) return; y0 = e.clientY; dy = 0; sh.classList.add('dragging'); head.setPointerCapture(e.pointerId); };
  const move = (e) => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); sh.style.transform = `translateY(${dy}px)`; };
  const up = () => {
    if (y0 === null) return;
    y0 = null; sh.classList.remove('dragging');
    if (dy > 110) closeSheet(); else sh.style.transform = '';
  };
  for (const t of [head, grab]) {
    t.addEventListener('pointerdown', down);
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', up);
    t.addEventListener('pointercancel', up);
  }
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  $('toast-text').textContent = msg;
  t.hidden = true; void t.offsetWidth; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}
function setErr(id, msg) { $(id).textContent = msg || ''; }

let asResolve = null;
function actionSheet(title, actions) {
  const box = $('action-sheet'), scrim = $('scrim');
  if (asResolve) asResolve(null);
  $('as-title').textContent = title || '';
  $('as-title').hidden = !title;
  $('as-buttons').replaceChildren(...actions.map((a) => {
    const b = el('button', `as-btn${a.danger ? ' danger' : ''}`, a.label);
    b.type = 'button';
    b.addEventListener('click', () => finish(a.value));
    return b;
  }));
  scrim.hidden = false; scrim.classList.add('top'); box.hidden = false;
  void box.offsetWidth;
  scrim.classList.add('show'); box.classList.add('open');
  function finish(v) {
    box.classList.remove('open');
    scrim.classList.remove('top');
    if (!openSheetEl) scrim.classList.remove('show');
    setTimeout(() => { box.hidden = true; if (!openSheetEl) scrim.hidden = true; }, REDUCED ? 0 : 380);
    const r = asResolve; asResolve = null; if (r) r(v);
  }
  return new Promise((resolve) => { asResolve = resolve; box._finish = finish; });
}
const ask = (text, yesLabel = '是的') => actionSheet(text, [{ label: yesLabel, value: true, danger: true }]).then(Boolean);

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
  state.fails = 0; state.lastActive = Date.now(); state.filter = '全部';
  $('search').value = '';
  renderList(); show('s-list');
}

function lock() {
  state.key = null; state.kdf = null; state.entries = null; state.editingId = null;
  if (asResolve && $('action-sheet')._finish) $('action-sheet')._finish(null);
  closeSheet(true);
  for (const f of document.querySelectorAll('form')) f.reset();
  $('search').value = '';
  $('search-clear').hidden = true;
  $('list').replaceChildren();
  $('chips').replaceChildren();
  $('res-file-name').textContent = '在 Google Drive 或「文件」里找';
  for (const id of ['lock-err', 'edit-err', 'res-err', 'cp-err', 'setup-err']) setErr(id, '');
  for (const d of document.querySelectorAll('[data-dial]')) dial.reset(d);
  db.get('vault').then((env) => {
    state.env = env || null;
    show(env ? 's-lock' : 's-setup');
  }, () => show('s-lock'));
}

// ---------- list ----------
function highlight(text, q) {
  const frag = document.createDocumentFragment();
  if (!q) { frag.append(text); return frag; }
  const low = text.toLowerCase();
  let i = 0;
  for (;;) {
    const j = low.indexOf(q, i);
    if (j < 0) break;
    if (j > i) frag.append(text.slice(i, j));
    frag.append(el('mark', null, text.slice(j, j + q.length)));
    i = j + q.length;
  }
  frag.append(text.slice(i));
  return frag;
}

function renderChips(all) {
  const counts = Object.fromEntries(CATS.map((c) => [c.name, 0]));
  for (const e of all) counts[catOf(e.cat).name]++;
  const mk = (name, n, cat) => {
    const b = el('button', cat ? 'chip' : 'chip all');
    b.type = 'button'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(state.filter === name));
    if (cat) { const d = el('span', `dot ${cat.tone}`); d.append(icon(cat.icon)); b.append(d); }
    b.append(name, el('span', 'n', String(n)));
    b.addEventListener('click', () => { state.filter = name; renderList(); });
    return b;
  };
  const chips = [mk('全部', all.length)];
  for (const c of CATS) if (counts[c.name] || state.filter === c.name) chips.push(mk(c.name, counts[c.name], c));
  $('chips').replaceChildren(...chips);
  $('chips').hidden = all.length === 0;
}

let openRow = null;
function settleRow(cell) {
  cell.classList.add('snap');
  cell.style.transform = '';
  const li = cell.parentElement;
  setTimeout(() => { if (!cell.style.transform && li) li.classList.remove('swiping'); }, REDUCED ? 0 : 340);
}
function closeOpenRow() {
  if (openRow) { settleRow(openRow); openRow = null; }
}

function makeRow(e, q) {
  const cat = catOf(e.cat);
  const li = el('li');
  const acts = el('div', 'row-acts');
  const copyB = el('button', 'act copy'); copyB.type = 'button'; copyB.append(icon('copy'), '复制');
  const delB = el('button', 'act del'); delB.type = 'button'; delB.append(icon('trash'), '删除');
  acts.append(copyB, delB);
  const cell = el('button', 'cell'); cell.type = 'button';
  const text = el('span', 'cell-text');
  const t = el('span', 'cell-title'); t.append(highlight(e.title, q));
  const sub = el('span', 'cell-sub'); sub.append(highlight((e.body || '').split('\n')[0], q));
  text.append(t, sub);
  cell.append(tile(cat), text, icon('chev', 'chev'));
  li.append(acts, cell);

  copyB.addEventListener('click', () => { closeOpenRow(); copyText(e.body, `已复制「${e.title}」`); });
  delB.addEventListener('click', () => { closeOpenRow(); deleteEntry(e.id); });
  wireRowGestures(cell, e);
  return li;
}

const OPEN_X = -168;
function wireRowGestures(cell, e) {
  let x0 = 0, y0 = 0, base = 0, dx = 0, mode = null, pressTimer = 0, suppress = false;
  cell.addEventListener('pointerdown', (ev) => {
    if (openRow && openRow !== cell) closeOpenRow();
    x0 = ev.clientX; y0 = ev.clientY; dx = 0; mode = null; suppress = false;
    base = openRow === cell ? OPEN_X : 0;
    cell.classList.remove('snap');
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (mode) return;
      mode = 'press'; suppress = true;
      cell.classList.remove('held'); void cell.offsetWidth; cell.classList.add('held');
      entryMenu(e);
    }, 520);
  });
  cell.addEventListener('pointermove', (ev) => {
    const mx = ev.clientX - x0, my = ev.clientY - y0;
    if (!mode && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      clearTimeout(pressTimer);
      if (Math.abs(mx) > Math.abs(my)) { mode = 'swipe'; cell.parentElement.classList.add('swiping'); cell.setPointerCapture(ev.pointerId); }
      else mode = 'scroll';
    }
    if (mode === 'swipe') {
      dx = Math.min(0, Math.max(OPEN_X - 40, base + mx));
      cell.style.transform = `translateX(${dx}px)`;
    }
  });
  const end = () => {
    clearTimeout(pressTimer);
    if (mode === 'swipe') {
      suppress = true;
      cell.classList.add('snap');
      if (dx < OPEN_X / 2) { cell.style.transform = `translateX(${OPEN_X}px)`; openRow = cell; }
      else { settleRow(cell); if (openRow === cell) openRow = null; }
    }
    mode = mode === 'press' ? 'press' : null;
  };
  cell.addEventListener('pointerup', end);
  cell.addEventListener('pointercancel', () => { clearTimeout(pressTimer); if (mode === 'swipe') end(); mode = null; });
  cell.addEventListener('contextmenu', (ev) => ev.preventDefault());
  cell.addEventListener('click', () => {
    if (suppress) { suppress = false; return; }
    if (openRow === cell) { closeOpenRow(); return; }
    if (openRow) { closeOpenRow(); return; }
    openEdit(e.id);
  });
}

function renderList() {
  if (!state.entries) return;
  const raw = $('search').value.trim();
  const q = raw.toLowerCase();
  $('search-clear').hidden = !raw;
  const all = [...state.entries].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  renderChips(all);
  const inCat = state.filter === '全部' ? all : all.filter((e) => catOf(e.cat).name === state.filter);
  const hits = q ? inCat.filter((e) => `${e.title}\n${e.cat}\n${e.body}`.toLowerCase().includes(q)) : inCat;
  openRow = null;
  $('list').replaceChildren(...hits.map((e) => makeRow(e, q)));
  $('list-count').textContent = all.length ? `${all.length} 项资料` : '';
  $('list-empty').hidden = all.length !== 0;
  const none = all.length && !hits.length;
  $('list-none').hidden = !none;
  if (none) $('list-none').textContent = raw ? `找不到「${raw}」。试试别的字？` : '这个类别还没有资料。';
  $('list-hint').hidden = !(hits.length && hits.length <= 3 && !q);
  $('backup-nag').hidden = !(state.meta.changedSinceBackup && all.length);
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text || '');
    toast(okMsg || '已复制');
  } catch {
    toast('复制不到，请打开那一项，长按文字复制');
  }
}

async function entryMenu(e) {
  const v = await actionSheet(e.title, [
    { label: '复制内容', value: 'copy' },
    { label: '修改', value: 'edit' },
    { label: '删除', value: 'del', danger: true },
  ]);
  if (v === 'copy') copyText(e.body, `已复制「${e.title}」`);
  else if (v === 'edit') openEdit(e.id);
  else if (v === 'del') deleteEntry(e.id);
}

// ---------- edit ----------
function buildCatPicker() {
  $('edit-cats').replaceChildren(...CATS.map((c) => {
    const lab = el('label', 'cat');
    const r = el('input'); r.type = 'radio'; r.name = 'cat'; r.value = c.name;
    lab.append(r, tile(c), c.name);
    return lab;
  }));
}
function setCat(name) {
  for (const r of document.querySelectorAll('input[name=cat]')) r.checked = r.value === name;
}
function getCat() {
  const r = document.querySelector('input[name=cat]:checked');
  return r ? r.value : '其他';
}

function openEdit(id) {
  state.editingId = id || null;
  const e = id ? state.entries.find((x) => x.id === id) : null;
  $('edit-heading').textContent = e ? '修改' : '新增';
  setCat(e ? catOf(e.cat).name : (state.filter !== '全部' ? state.filter : '会员卡'));
  $('edit-title').value = e ? e.title : '';
  $('edit-body').value = e ? e.body : '';
  $('edit-extra').hidden = !e;
  setErr('edit-err', '');
  openSheet('sheet-edit');
}

async function onSaveEntry(ev) {
  ev.preventDefault();
  const title = $('edit-title').value.trim();
  if (!title) { setErr('edit-err', '请写名字。'); return; }
  const now = Date.now();
  const fields = { title, cat: getCat(), body: $('edit-body').value };
  const entries = state.editingId
    ? state.entries.map((e) => (e.id === state.editingId ? { ...e, ...fields, updated: now } : e))
    : [...state.entries, { id: newId(), ...fields, created: now, updated: now }];
  const btn = ev.submitter || $('f-edit').querySelector('button[type=submit]');
  try {
    await busy(btn, '正在保存…', () => saveEntries(entries));
    closeSheet();
    $('search').value = '';
    renderList();
    toast('保存好了');
  } catch (e) {
    setErr('edit-err', '保存不到！资料还没存。' + errText(e));
  }
}

async function deleteEntry(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  if (!(await ask(`删除「${e.title}」？删了就没有了。`, '删除'))) return;
  try {
    state.busy++;
    await saveEntries(state.entries.filter((x) => x.id !== e.id));
    if (openSheetEl && openSheetEl.id === 'sheet-edit') closeSheet();
    renderList();
    toast('已删除');
  } catch (err) {
    toast(errText(err));
  } finally {
    state.busy--;
  }
}

// ---------- setup / unlock ----------
async function onSetup(ev) {
  ev.preventDefault();
  const p1 = $('setup-pw1').value, p2 = $('setup-pw2').value;
  if (p1 !== p2) { setErr('setup-err', '两次输入的主密码不一样。'); return; }
  if (!$('setup-ok').checked) { setErr('setup-err', '请先打勾，确认你明白。'); return; }
  const host = $('setup-dial');
  try {
    vc.checkNewPassword(p1);
    const btn = $('f-setup').querySelector('button[type=submit]');
    setErr('setup-err', '');
    await busy(btn, '正在设定…', async () => {
      dial.start(host);
      const { key, kdf, envelope } = await vc.createVault(p1);
      const meta = { changedSinceBackup: false };
      await db.putMany({ vault: envelope, meta });
      await dial.open(host);
      $('f-setup').reset();
      enterVault({ key, kdf, data: { entries: [] }, env: envelope, meta });
    });
    toast('设定好了');
  } catch (e) {
    dial.fail(host);
    setErr('setup-err', errText(e));
  }
}

let waitTimer = 0;
async function onUnlock(ev) {
  ev.preventDefault();
  const pw = $('lock-pw').value;
  const host = $('lock-dial');
  setErr('lock-err', '');
  try {
    await busy($('lock-go'), '正在打开…', async () => {
      const env = await db.get('vault');
      if (!env) { show('s-setup'); return; }
      dial.start(host);
      const res = await vc.unlock(pw, env);
      const meta = (await db.get('meta')) || {};
      $('f-lock').reset();
      $('lock-pw').type = 'password'; $('lock-eye').setAttribute('aria-pressed', 'false');
      await dial.open(host);
      $('s-lock').classList.add('leave');
      await sleep(260);
      enterVault({ ...res, env: vc.checkEnvelope(env), meta });
    });
  } catch (e) {
    dial.fail(host);
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
    ? `上次：${fmtDate(state.meta.lastBackupAt)}${state.meta.changedSinceBackup ? '，之后有改过' : ''}`
    : '还没有做过备份';
  $('app-version').textContent = APP_VERSION;
}
function openSettings() { renderSettings(); openSheet('sheet-settings'); }

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
  renderList();
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
      () => markBackedUp().then(() => toast('备份做好了')),
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
  markBackedUp().then(() => toast('备份文件下载了'));
}

function openRestore() {
  $('f-restore').reset();
  $('res-file-name').textContent = '在 Google Drive 或「文件」里找';
  setErr('res-err', '');
  openSheet('sheet-restore');
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
          ? `手机里现在的 ${have} 项资料，会换成备份里的 ${n} 项。`
          : `手机里现在的资料，会换成备份里的 ${n} 项。`;
        if (!(await ask(msg, '换成备份的资料'))) return;
      }
      const meta = { lastBackupAt: Date.now(), changedSinceBackup: false };
      await db.putMany({ vault: env, meta });
      $('f-restore').reset();
      $('lock-restore').hidden = true;
      closeSheet(true);
      enterVault({ ...res, env, meta });
      toast(`恢复好了：${n} 项`);
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
    openSettings();
    renderList();
    toast('主密码换好了，请做新备份');
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
  for (const d of document.querySelectorAll('[data-dial]')) buildDial(d);
  buildCatPicker();
  for (const sh of document.querySelectorAll('.sheet')) {
    wireSheetDrag(sh);
    for (const b of sh.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeSheet());
  }
  $('scrim').addEventListener('click', () => {
    if ($('action-sheet').classList.contains('open')) $('action-sheet')._finish(null);
    else closeSheet();
  });
  $('as-cancel').addEventListener('click', () => $('action-sheet')._finish && $('action-sheet')._finish(null));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('action-sheet').classList.contains('open')) $('action-sheet')._finish(null);
    else closeSheet();
  });

  $('f-setup').addEventListener('submit', onSetup);
  $('setup-restore').addEventListener('click', openRestore);
  $('f-lock').addEventListener('submit', onUnlock);
  $('lock-eye').addEventListener('click', () => {
    const show = $('lock-pw').type === 'password';
    $('lock-pw').type = show ? 'text' : 'password';
    $('lock-eye').setAttribute('aria-pressed', String(show));
    $('lock-eye').setAttribute('aria-label', show ? '隐藏主密码' : '显示主密码');
  });
  $('lock-restore').addEventListener('click', openRestore);
  $('list-lock').addEventListener('click', lock);
  $('list-settings').addEventListener('click', openSettings);
  $('backup-nag').addEventListener('click', openSettings);
  $('list-add').addEventListener('click', () => openEdit(null));
  $('search').addEventListener('input', renderList);
  $('search-clear').addEventListener('click', () => { $('search').value = ''; renderList(); $('search').focus(); });
  document.addEventListener('scroll', closeOpenRow, { passive: true });
  $('f-edit').addEventListener('submit', onSaveEntry);
  $('edit-delete').addEventListener('click', () => deleteEntry(state.editingId));
  $('edit-copy').addEventListener('click', () => copyText($('edit-body').value, '已复制'));
  $('set-export').addEventListener('click', onExport);
  $('set-restore').addEventListener('click', openRestore);
  $('set-changepw').addEventListener('click', () => { $('f-changepw').reset(); setErr('cp-err', ''); openSheet('sheet-changepw'); });
  $('res-file').addEventListener('change', () => {
    const f = $('res-file').files[0];
    $('res-file-name').textContent = f ? f.name : '在 Google Drive 或「文件」里找';
  });
  $('f-restore').addEventListener('submit', onRestore);
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
