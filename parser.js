// Lectura de texto de facturas y pantallazos (salida del OCR) -> campos del gasto.
// Funciona en el navegador y en node (para pruebas).

export function toNumber(str) {
  const m = String(str).replace(/[^\d.,]/g, '').match(/^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?$/);
  if (!m) return NaN;
  return parseInt(m[1].replace(/[.,]/g, ''), 10);
}

const TOTAL_RE = /total|a pagar|valor pagado|valor a pagar|neto|monto|pagado|valor/i;
const SKIP_RE = /cambio|recibido|iva|propina|descuento|base|nit|tel|cel|nro|n[uú]mero|factura|resoluci[oó]n|referencia|ref\b|cuenta|aprobaci[oó]n|autoriz/i;

export function parseAmount(text) {
  const lines = text.split('\n');
  const found = [];
  for (const line of lines) {
    const tokens = line.match(/\d[\d.,]*\d|\d/g) || [];
    for (const t of tokens) {
      const n = toNumber(t);
      if (!Number.isNaN(n) && n >= 500 && n <= 50000000) {
        found.push({ n, total: TOTAL_RE.test(line) && !/subtotal/i.test(line), skip: SKIP_RE.test(line) && !TOTAL_RE.test(line) });
      }
    }
  }
  const totals = found.filter(f => f.total);
  if (totals.length) return Math.max(...totals.map(f => f.n));
  const rest = found.filter(f => !f.skip);
  if (rest.length) return Math.max(...rest.map(f => f.n));
  return found.length ? Math.max(...found.map(f => f.n)) : null;
}

export function todayStr(d = new Date()) {
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12 };

export function parseDate(text, now = new Date()) {
  const cands = [];
  let m;
  const r1 = /(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/g;
  while ((m = r1.exec(text))) cands.push([+m[1], +m[2], +m[3]]);
  const r2 = /(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/g;
  while ((m = r2.exec(text))) cands.push([m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]]);
  const r3 = /(\d{1,2})\s*(?:de\s+)?(ene|feb|mar|abr|may|jun|jul|ago|sept|sep|oct|nov|dic)[a-z]*\.?,?\s*(?:de\s+)?(\d{4})/gi;
  while ((m = r3.exec(text))) cands.push([+m[3], MESES[m[2].toLowerCase()], +m[1]]);
  const lo = new Date(now); lo.setFullYear(lo.getFullYear() - 2);
  const hi = new Date(now); hi.setDate(hi.getDate() + 1);
  for (const [y, mo, d] of cands) {
    const dt = new Date(y, mo - 1, d);
    if (dt.getMonth() === mo - 1 && dt.getDate() === d && dt >= lo && dt <= hi) return todayStr(dt);
  }
  return null;
}

export function parseSupplier(text) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  // Pantallazos de transferencia: "Para" + nombre
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:para|destino|beneficiario|enviaste a)\s*[:\-]?\s*(.*)$/i);
    if (m) {
      const val = (m[1] || lines[i + 1] || '').replace(/[^\p{L}\p{N}\s.&'-]/gu, '').trim();
      if (val.length >= 3) return val.slice(0, 60);
    }
  }
  for (const l of lines.slice(0, 8)) {
    const letters = (l.match(/\p{L}/gu) || []).length;
    if (letters >= 4 && letters / l.length > 0.6 && !/factura|nit|recibo|ticket|comprobante|fecha|tel|www|\.com|venta/i.test(l)) {
      return l.replace(/[^\p{L}\p{N}\s.&'-]/gu, '').trim().slice(0, 60);
    }
  }
  return '';
}

const GUESS = [
  [/castiza|barril|cerveza|bavaria|bbc|cervecer|malta|lupulo|l[uú]pulo/i, 'Barriles y cerveza'],
  [/arriendo|alquiler|canon/i, 'Arriendo'],
  [/energ[ií]a|cedenar|acueducto|agua|internet|claro|movistar|tigo|etb|gas\b|servicios/i, 'Servicios públicos'],
  [/n[oó]mina|salario|sueldo|pago empleado|turno/i, 'Nómina'],
  [/[eé]xito|\bd1\b|\bara\b|olimpica|justo|fruta|jugo|toronja|naranja|vaso|servilleta|hielo|aseo|papeler|insumo|supermercado|tienda/i, 'Insumos'],
  [/reparaci|mantenimiento|ferreter|plomer|el[eé]ctric|manguera|regulador|co2|v[aá]lvula|nevera|keezer/i, 'Mantenimiento y equipos'],
  [/publicidad|impres|dise[nñ]o|canva|instagram|meta ads|volante|pendon|pend[oó]n/i, 'Marketing'],
];

export function guessCategory(text) {
  for (const [re, cat] of GUESS) if (re.test(text)) return cat;
  return '';
}

export function parseReceipt(text, now = new Date()) {
  return {
    monto: parseAmount(text),
    fecha: parseDate(text, now),
    proveedor: parseSupplier(text),
    categoria: guessCategory(text),
  };
}
