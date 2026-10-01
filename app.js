import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getDatabase, ref, onValue, push, set, remove, get } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';
import { parseReceipt, toNumber, todayStr } from './parser.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDil0xY3SGibP3-x8-nD3Kg1zEl08obnXg',
  authDomain: 'dcbeer-gastos.firebaseapp.com',
  databaseURL: 'https://dcbeer-gastos-default-rtdb.firebaseio.com',
  projectId: 'dcbeer-gastos',
  storageBucket: 'dcbeer-gastos.firebasestorage.app',
  messagingSenderId: '321858031815',
  appId: '1:321858031815:web:21796e7c5e2195ada82ee2',
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

/* ---------- constantes ---------- */
const DEFAULT_CATS = ['Barriles y cerveza', 'Insumos', 'Nómina', 'Arriendo', 'Servicios públicos', 'Mantenimiento y equipos', 'Marketing', 'Otros'];
// Fijo = se paga igual venda o no venda. Variable = sube o baja con la operación. Editable desde el Resumen.
const DEFAULT_TIPOS = { 'Arriendo': 'fijo', 'Nómina': 'fijo', 'Servicios públicos': 'fijo' };
const METODOS = ['Efectivo', 'Transferencia', 'Tarjeta', 'Nequi / Daviplata', 'Otro'];
// Paleta categórica validada sobre la superficie de las tarjetas (orden fijo). "Otros" va en gris.
const PALETTE = ['#BE7A1E', '#4A8FC4', '#CC5A52', '#2FA395', '#9B74CC', '#7BA14A', '#C9709F'];
const GRAY = '#8E7F78';
const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const $ = id => document.getElementById(id);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- estado ---------- */
let gastos = {};
let cats = [...DEFAULT_CATS];
let tipos = { ...DEFAULT_TIPOS };
let month = todayStr().slice(0, 7);
let unsubs = [];
let editId = null;
let photo = null;          // dataURL comprimida a guardar
let photoChanged = false;
let ocrRun = 0;
const charts = {};

/* ---------- utilidades ---------- */
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
const monthOf = f => (f || '').slice(0, 7);
function shiftMonth(m, d) { const [y, mo] = m.split('-').map(Number); const dt = new Date(y, mo - 1 + d, 1); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; }
function monthName(m, long = true) { const [y, mo] = m.split('-').map(Number); return cap(new Date(y, mo - 1, 1).toLocaleDateString('es-CO', { month: long ? 'long' : 'short', year: long ? 'numeric' : undefined }).replace(' de ', ' ')); }
function dayLabel(f) { const [y, m, d] = f.split('-').map(Number); return cap(new Date(y, m - 1, d).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'short' }).replace(',', '')); }
function colorFor(cat) {
  if (cat === 'Otros') return GRAY;
  const i = cats.filter(c => c !== 'Otros').indexOf(cat);
  return i >= 0 && i < PALETTE.length ? PALETTE[i] : GRAY;
}
const tipoOf = c => (tipos[c] === 'fijo' ? 'fijo' : 'variable');
const list = () => Object.entries(gastos).map(([id, g]) => ({ id, ...g }));
const inMonth = m => list().filter(g => monthOf(g.fecha) === m);
const sum = a => a.reduce((s, g) => s + (+g.monto || 0), 0);

/* ---------- autenticación ---------- */
const ERR = {
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/wrong-password': 'Correo o contraseña incorrectos.',
  'auth/user-not-found': 'Correo o contraseña incorrectos.',
  'auth/invalid-email': 'Escribe un correo válido.',
  'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
  'auth/network-request-failed': 'Sin conexión. Revisa tu internet.',
};
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginErr').textContent = ''; $('loginBtn').disabled = true;
  try { await signInWithEmailAndPassword(auth, $('loginEmail').value.trim(), $('loginPass').value); }
  catch (err) { $('loginErr').textContent = ERR[err.code] || 'No se pudo entrar. Intenta de nuevo.'; }
  $('loginBtn').disabled = false;
});
$('logout').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, user => {
  unsubs.forEach(u => u()); unsubs = [];
  if (!user) { gastos = {}; $('app').hidden = true; $('login').hidden = false; return; }
  $('login').hidden = true; $('app').hidden = false;
  let seeded = false;
  unsubs.push(onValue(ref(db, 'config/categorias'), s => {
    const v = s.val();
    if (Array.isArray(v) && v.length) cats = v;
    else if (!seeded) { seeded = true; set(ref(db, 'config/categorias'), DEFAULT_CATS).catch(() => {}); }
    renderAll();
  }, permissionError));
  unsubs.push(onValue(ref(db, 'config/tipos'), s => {
    const v = s.val();
    tipos = { ...DEFAULT_TIPOS, ...(v && typeof v === 'object' ? v : {}) };
    renderAll();
  }, permissionError));
  unsubs.push(onValue(ref(db, 'gastos'), s => { gastos = s.val() || {}; renderAll(); }, permissionError));
});
function permissionError(err) {
  console.error(err);
  toast('No tengo permiso para leer los datos. Revisa las reglas de Firebase.', 6000);
}

/* ---------- pintar ---------- */
function renderAll() { renderHeader(); renderKpis(); renderList(); renderSummary(); }

function renderHeader() { $('monthLabel').textContent = monthName(month); $('nextM').disabled = month >= todayStr().slice(0, 7); }

function renderKpis() {
  const cur = inMonth(month), prev = inMonth(shiftMonth(month, -1));
  const total = sum(cur), totalPrev = sum(prev);
  const now = todayStr(), isCur = month === now.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const days = isCur ? +now.slice(8) : new Date(y, m, 0).getDate();
  let delta = '';
  if (totalPrev > 0) {
    const p = Math.round((total - totalPrev) / totalPrev * 100);
    const cls = p > 0 ? 'up' : p < 0 ? 'down' : '';
    delta = `<span class="delta ${cls}">${p > 0 ? '▲' : p < 0 ? '▼' : '='} ${Math.abs(p)}% vs ${monthName(shiftMonth(month, -1), false)}</span>`;
  } else delta = '<span class="delta">Sin mes anterior para comparar</span>';
  const top = Object.entries(cur.reduce((o, g) => (o[g.categoria] = (o[g.categoria] || 0) + (+g.monto || 0), o), {})).sort((a, b) => b[1] - a[1])[0];
  $('kpis').innerHTML = `
    <div class="kpi hero"><small>Total del mes</small><b>${COP.format(total)}</b>${delta}</div>
    <div class="kpi"><small>Gastos</small><b>${cur.length}</b></div>
    <div class="kpi"><small>Promedio por día</small><b>${COP.format(days ? total / days : 0)}</b></div>
    <div class="kpi"><small>Mayor categoría</small><b style="font-size:22px">${top ? esc(top[0]) : '—'}</b></div>`;
}

function renderList() {
  const cur = inMonth(month).sort((a, b) => (b.fecha.localeCompare(a.fecha)) || ((b.creado || 0) - (a.creado || 0)));
  if (!cur.length) {
    $('lista').innerHTML = `<div class="empty"><b>Sin gastos en ${esc(monthName(month))}</b>Toma una foto de una factura o toca “Manual” para registrar el primero.</div>`;
    return;
  }
  const byDay = {};
  cur.forEach(g => (byDay[g.fecha] ||= []).push(g));
  $('lista').innerHTML = Object.keys(byDay).sort().reverse().map(f => `
    <div class="day">
      <div class="day-head"><span>${esc(dayLabel(f))}</span><b>${COP.format(sum(byDay[f]))}</b></div>
      ${byDay[f].map(g => `
        <button class="item" data-id="${g.id}">
          <span class="chip" style="background:${colorFor(g.categoria)}"></span>
          <span class="main">
            <span class="t" style="display:block">${esc(g.proveedor || g.concepto || 'Sin nombre')}</span>
            <span class="s" style="display:block">${esc(g.categoria)}${g.concepto && g.proveedor ? ' · ' + esc(g.concepto) : ''} · ${esc(g.metodo || '')}</span>
          </span>
          ${g.tieneFoto ? '<span class="cam-i" title="Con soporte">📷</span>' : ''}
          <span class="amt">${COP.format(g.monto)}</span>
        </button>`).join('')}
    </div>`).join('');
}

/* ---------- resumen y gráficas ---------- */
function chartDefaults() {
  if (!window.Chart) return false;
  Chart.defaults.color = '#BFA48F';
  Chart.defaults.font.family = 'Lato, system-ui, sans-serif';
  Chart.defaults.borderColor = 'rgba(245,205,163,.10)';
  return true;
}
function upsertChart(key, canvasId, cfg) {
  if (charts[key]) { charts[key].destroy(); }
  charts[key] = new Chart($(canvasId), cfg);
}
const tip = { backgroundColor: '#1A0A05', titleColor: '#F5CDA3', bodyColor: '#F2E4A8', borderColor: 'rgba(245,205,163,.25)', borderWidth: 1, padding: 10, displayColors: true };

function renderSummary() {
  const cur = inMonth(month), total = sum(cur);
  // por categoría
  const byCat = {};
  cur.forEach(g => byCat[g.categoria] = (byCat[g.categoria] || 0) + (+g.monto || 0));
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  $('catList').innerHTML = rows.length ? rows.map(([c, v]) =>
    `<li><i style="background:${colorFor(c)}"></i><span class="n">${esc(c)}<small>${Math.round(v / total * 100)}%</small></span><span class="v">${COP.format(v)}</span></li>`).join('')
    : '<li class="muted">Sin datos este mes.</li>';
  // top proveedores
  const byProv = {};
  cur.forEach(g => { const k = (g.proveedor || g.concepto || 'Sin nombre').trim(); byProv[k] = (byProv[k] || 0) + (+g.monto || 0); });
  $('topProv').innerHTML = Object.entries(byProv).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `<li><span>${esc(k)}</span><b>${COP.format(v)}</b></li>`).join('') || '<li class="muted">Sin datos este mes.</li>';

  renderFV(cur, byCat);
  if (!chartDefaults()) return;
  const surface = '#3D1A0E';
  upsertChart('cat', 'chCat', {
    type: 'doughnut',
    data: { labels: rows.map(r => r[0]), datasets: [{ data: rows.map(r => r[1]), backgroundColor: rows.map(r => colorFor(r[0])), borderColor: surface, borderWidth: 2 }] },
    options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { display: false }, tooltip: { ...tip, callbacks: { label: c => ` ${c.label}: ${COP.format(c.parsed)}` } } } },
  });
  // por día
  const [y, m] = month.split('-').map(Number), nd = new Date(y, m, 0).getDate();
  const perDay = Array(nd).fill(0);
  cur.forEach(g => perDay[+g.fecha.slice(8) - 1] += (+g.monto || 0));
  upsertChart('dia', 'chDia', {
    type: 'bar',
    data: { labels: perDay.map((_, i) => i + 1), datasets: [{ data: perDay, backgroundColor: '#C4893A', borderRadius: { topLeft: 4, topRight: 4 }, maxBarThickness: 18 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...tip, displayColors: false, callbacks: { title: i => `Día ${i[0].label}`, label: c => COP.format(c.parsed.y) } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { beginAtZero: true, ticks: { callback: v => v >= 1e6 ? (v / 1e6) + ' M' : v >= 1e3 ? (v / 1e3) + ' mil' : v }, border: { display: false } } } },
  });
  // últimos 6 meses
  const ms = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
  upsertChart('mes', 'chMes', {
    type: 'bar',
    data: { labels: ms.map(x => monthName(x, false)), datasets: [{ data: ms.map(x => sum(inMonth(x))), backgroundColor: ms.map(x => x === month ? '#C4893A' : '#7a5230'), borderRadius: { topLeft: 4, topRight: 4 }, maxBarThickness: 44 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { ...tip, displayColors: false, callbacks: { label: c => COP.format(c.parsed.y) } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: v => v >= 1e6 ? (v / 1e6) + ' M' : v >= 1e3 ? (v / 1e3) + ' mil' : v }, border: { display: false } } } },
  });
}
const FV_COLOR = { fijo: '#4A8FC4', variable: '#BE7A1E' };
function renderFV(cur, byCat) {
  const total = sum(cur);
  const fijo = cur.filter(g => tipoOf(g.categoria) === 'fijo').reduce((s, g) => s + (+g.monto || 0), 0);
  const vari = total - fijo;
  const pct = v => (total ? Math.round(v / total * 100) : 0);
  $('fvKpis').innerHTML = ['fijo', 'variable'].map(t => {
    const v = t === 'fijo' ? fijo : vari;
    return `<div class="fv-k"><span class="sw" style="background:${FV_COLOR[t]}"></span><small>${t === 'fijo' ? 'Costos fijos' : 'Costos variables'}</small><b>${COP.format(v)}</b><em>${pct(v)}% del gasto</em></div>`;
  }).join('');
  $('fvBar').innerHTML = total
    ? `<i style="flex:${fijo || 0.0001};background:${FV_COLOR.fijo}"></i><i style="flex:${vari || 0.0001};background:${FV_COLOR.variable}"></i>` : '';
  // categorías (incluye las que no tienen gasto este mes para poder reasignarlas)
  const all = cats.map(c => ({ c, v: byCat[c] || 0, t: tipoOf(c) }));
  const col = t => all.filter(x => x.t === t).sort((a, b) => b.v - a.v)
    .map(x => `<button class="fv-cat" data-cat="${esc(x.c)}" title="Pasar a ${t === 'fijo' ? 'variable' : 'fijo'}"><span>${esc(x.c)}</span><b>${COP.format(x.v)}</b></button>`).join('') || '<p class="muted">Ninguna</p>';
  $('fvCats').innerHTML = `<div><h4 style="color:${FV_COLOR.fijo}">Fijos</h4>${col('fijo')}</div><div><h4 style="color:${FV_COLOR.variable}">Variables</h4>${col('variable')}</div>`;
  if (!chartDefaults()) return;
  const ms = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
  const part = (m, t) => inMonth(m).filter(g => tipoOf(g.categoria) === t).reduce((s, g) => s + (+g.monto || 0), 0);
  const ds = t => ({ label: t === 'fijo' ? 'Fijos' : 'Variables', data: ms.map(m => part(m, t)), backgroundColor: FV_COLOR[t], borderColor: '#3D1A0E', borderWidth: 2, maxBarThickness: 44 });
  upsertChart('fv', 'chFV', {
    type: 'bar', data: { labels: ms.map(x => monthName(x, false)), datasets: [ds('fijo'), ds('variable')] },
    options: { maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, color: '#F2E4A8' } }, tooltip: { ...tip, callbacks: { label: c => ` ${c.dataset.label}: ${COP.format(c.parsed.y)}` } } },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { callback: v => v >= 1e6 ? (v / 1e6) + ' M' : v >= 1e3 ? (v / 1e3) + ' mil' : v }, border: { display: false } } } },
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('.fv-cat'); if (!b) return;
  const c = b.dataset.cat, next = tipoOf(c) === 'fijo' ? 'variable' : 'fijo';
  tipos = { ...tipos, [c]: next }; renderAll();
  set(ref(db, 'config/tipos'), tipos).catch(() => toast('No se pudo guardar el cambio'));
  toast(`${c}: ahora es costo ${next}`);
});
window.addEventListener('load', () => { if (!$('app').hidden) renderSummary(); });

/* ---------- navegación ---------- */
$('prevM').onclick = () => { month = shiftMonth(month, -1); renderAll(); };
$('nextM').onclick = () => { if (month < todayStr().slice(0, 7)) { month = shiftMonth(month, 1); renderAll(); } };
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'resumen') setTimeout(renderSummary, 30);
});
$('lista').addEventListener('click', e => { const it = e.target.closest('.item'); if (it) openForm(it.dataset.id); });

/* ---------- exportar ---------- */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('expCsv').onclick = () => {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = inMonth(month).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const csv = ['Fecha;Proveedor;Concepto;Categoría;Tipo;Pagado con;Monto;Nota']
    .concat(rows.map(g => [g.fecha, g.proveedor, g.concepto, g.categoria, tipoOf(g.categoria) === 'fijo' ? 'Fijo' : 'Variable', g.metodo, g.monto, g.nota].map(cell).join(';'))).join('\r\n');
  download(`gastos-dcbeer-${month}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
};
$('expJson').onclick = () => download(`respaldo-gastos-dcbeer-${todayStr()}.json`, JSON.stringify({ categorias: cats, tipos, gastos }, null, 2), 'application/json');

/* ---------- formulario ---------- */
function fillSelects() {
  $('fCat').innerHTML = cats.map(c => `<option>${esc(c)}</option>`).join('') + '<option value="__new">➕ Nueva categoría…</option>';
  $('fMetodo').innerHTML = METODOS.map(c => `<option>${esc(c)}</option>`).join('');
}
$('fCat').addEventListener('change', async () => {
  if ($('fCat').value !== '__new') return;
  const name = (prompt('Nombre de la nueva categoría:') || '').trim().slice(0, 40);
  if (name && !cats.includes(name)) {
    const next = [...cats.filter(c => c !== 'Otros'), name, ...(cats.includes('Otros') ? ['Otros'] : [])];
    cats = next; set(ref(db, 'config/categorias'), next).catch(() => toast('No se pudo guardar la categoría'));
    tipos = { ...tipos, [name]: confirm(`¿"${name}" es un costo FIJO (se paga igual todos los meses)?\n\nAceptar = Fijo · Cancelar = Variable`) ? 'fijo' : 'variable' };
    set(ref(db, 'config/tipos'), tipos).catch(() => {});
  }
  fillSelects(); $('fCat').value = name && cats.includes(name) ? name : cats[0];
});
$('fMonto').addEventListener('input', () => { const n = toNumber($('fMonto').value.replace(/\D/g, '')); $('fMonto').value = Number.isNaN(n) ? '' : NUM.format(n); });

function setPhoto(dataUrl) {
  photo = dataUrl;
  $('photoRow').hidden = !dataUrl; $('noPhotoRow').hidden = !!dataUrl;
  if (dataUrl) $('photoImg').src = dataUrl;
}
function banner(html, kind = '') { const b = $('ocrBanner'); b.hidden = !html; b.className = 'banner ' + kind; b.innerHTML = html || ''; }

async function openForm(id = null, pre = null) {
  editId = id; photoChanged = false; fillSelects(); banner('');
  const g = id ? gastos[id] : null;
  $('sheetTitle').textContent = id ? 'Editar gasto' : 'Nuevo gasto';
  $('gDelete').hidden = !id;
  $('fFecha').value = g?.fecha || pre?.fecha || todayStr();
  $('fMonto').value = g ? NUM.format(g.monto) : pre?.monto ? NUM.format(pre.monto) : '';
  $('fProv').value = g?.proveedor || pre?.proveedor || '';
  $('fConcepto').value = g?.concepto || '';
  $('fCat').value = g?.categoria && cats.includes(g.categoria) ? g.categoria : pre?.categoria && cats.includes(pre.categoria) ? pre.categoria : cats[0];
  $('fMetodo').value = g?.metodo || 'Efectivo';
  $('fNota').value = g?.nota || '';
  setPhoto(null);
  $('sheet').hidden = false; document.body.style.overflow = 'hidden';
  if (id && g?.tieneFoto) {
    try { const s = await get(ref(db, 'fotos/' + id)); if (editId === id && !photoChanged) setPhoto(s.val()); } catch { /* sin foto */ }
  }
}
function closeForm() { ocrRun++; $('sheet').hidden = true; document.body.style.overflow = ''; editId = null; }
$('gClose').onclick = $('gCancel').onclick = closeForm;
$('sheet').addEventListener('click', e => { if (e.target === $('sheet') && confirm('¿Cerrar sin guardar?')) closeForm(); });

$('gForm').addEventListener('submit', e => {
  e.preventDefault();
  const monto = toNumber($('fMonto').value.replace(/\D/g, ''));
  if (Number.isNaN(monto) || monto <= 0) { toast('Escribe el monto'); $('fMonto').focus(); return; }
  if ($('fCat').value === '__new') { toast('Elige una categoría'); return; }
  const old = editId ? gastos[editId] : null;
  const id = editId || push(ref(db, 'gastos')).key;
  const hasPhoto = photoChanged ? !!photo : !!old?.tieneFoto;
  const data = {
    fecha: $('fFecha').value, monto, proveedor: $('fProv').value.trim(), concepto: $('fConcepto').value.trim(),
    categoria: $('fCat').value, metodo: $('fMetodo').value, nota: $('fNota').value.trim(),
    tieneFoto: hasPhoto, creado: old?.creado || Date.now(), actualizado: Date.now(),
  };
  const fail = () => toast('No se pudo guardar. Revisa tu conexión.', 5000);
  set(ref(db, 'gastos/' + id), data).catch(fail);
  if (photoChanged) (photo ? set(ref(db, 'fotos/' + id), photo) : remove(ref(db, 'fotos/' + id))).catch(fail);
  const m = monthOf(data.fecha); if (m !== month) month = m;
  closeForm(); renderAll(); toast(old ? 'Gasto actualizado ✓' : 'Gasto guardado ✓');
});
$('gDelete').onclick = () => {
  if (!editId || !confirm('¿Eliminar este gasto?')) return;
  const id = editId;
  remove(ref(db, 'gastos/' + id)).catch(() => toast('No se pudo eliminar'));
  remove(ref(db, 'fotos/' + id)).catch(() => {});
  closeForm(); toast('Gasto eliminado');
};

/* ---------- fotos + lectura (OCR en el navegador, gratis) ---------- */
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('imagen')); };
    img.src = url;
  });
}
function scaled(img, max) {
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c;
}
let tessPromise = null;
function loadTesseract() {
  return tessPromise ||= new Promise((res, rej) => {
    if (window.Tesseract) return res(window.Tesseract);
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => res(window.Tesseract); s.onerror = () => { tessPromise = null; rej(new Error('ocr')); };
    document.head.appendChild(s);
  });
}
async function handleFile(file) {
  if (!file) return;
  const run = ++ocrRun;
  let img;
  try { img = await loadImage(file); } catch { toast('No pude abrir esa imagen'); return; }
  const store = scaled(img, 1000).toDataURL('image/jpeg', 0.62);
  const forOcr = scaled(img, 1800);
  if ($('sheet').hidden) await openForm(null);
  photoChanged = true; setPhoto(store);
  banner('Leyendo la factura… <div class="bar"><i id="ocrBar"></i></div>');
  try {
    const T = await loadTesseract();
    const worker = await T.createWorker('spa', 1, { logger: m => { if (m.status === 'recognizing text' && $('ocrBar')) $('ocrBar').style.width = Math.round(m.progress * 100) + '%'; } });
    const { data } = await worker.recognize(forOcr);
    await worker.terminate();
    if (run !== ocrRun || $('sheet').hidden) return;
    const r = parseReceipt(data.text || '');
    let found = 0;
    const mark = (id, ok) => { $(id).closest('label').classList.toggle('flag', !!ok); };
    if (r.monto) { $('fMonto').value = NUM.format(r.monto); found++; }
    if (r.fecha) { $('fFecha').value = r.fecha; found++; }
    if (r.proveedor && !$('fProv').value) { $('fProv').value = r.proveedor; found++; }
    if (r.categoria && cats.includes(r.categoria)) { $('fCat').value = r.categoria; }
    ['fMonto', 'fFecha', 'fProv', 'fCat'].forEach(id => mark(id, id === 'fMonto' ? r.monto : id === 'fFecha' ? r.fecha : id === 'fProv' ? r.proveedor : r.categoria));
    banner(found ? 'Leí la factura. <b>Revisa los campos resaltados</b> antes de guardar.' : 'No pude leer datos claros. Llénalos a mano; la foto queda como soporte.', found ? 'ok' : 'warn');
  } catch {
    if (run === ocrRun) banner('No se pudo leer la foto (¿sin internet?). Llena los datos a mano; la foto queda como soporte.', 'warn');
  }
}
const pick = id => { const el = $(id); el.value = ''; el.click(); };
$('btnCam').onclick = () => pick('fileCam');
$('btnGal').onclick = () => pick('fileGal');
$('btnMan').onclick = () => openForm(null);
$('addCam').onclick = $('photoRetake').onclick = () => pick('fileCam');
$('addGal').onclick = () => pick('fileGal');
$('photoDrop').onclick = () => { photoChanged = true; setPhoto(null); banner(''); };
$('fileCam').onchange = e => handleFile(e.target.files[0]);
$('fileGal').onchange = e => handleFile(e.target.files[0]);
document.addEventListener('input', e => e.target.closest?.('label')?.classList.remove('flag'));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) closeForm(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
