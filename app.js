'use strict';
/* PDF Toolkit — everything runs locally in the browser. */
const { PDFDocument, degrees } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB';
const baseName = n => n.replace(/\.[^.]+$/, '');
const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImg = f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const arrMove = (a, from, to) => { const [x] = a.splice(from, 1); a.splice(to, 0, x); };
let uid = 1;

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = '', err ? 5000 : 2800);
}
function busy(msg) { $('#busy-msg').textContent = msg; $('#busy-bar').style.width = '0'; $('#busy').hidden = false; }
function progress(frac, msg) { $('#busy-bar').style.width = Math.round(frac * 100) + '%'; if (msg) $('#busy-msg').textContent = msg; }
function idle() { $('#busy').hidden = true; }
async function run(label, fn) {
  busy(label);
  try { return await fn(); }
  catch (e) { console.error(e); toast(friendly(e), true); }
  finally { idle(); }
}
function friendly(e) {
  const m = (e && e.message) || String(e);
  if (/encrypt/i.test(m)) return 'This PDF is password-protected and can’t be processed.';
  if (/PasswordException|password/i.test(m)) return 'This PDF is password-protected and can’t be opened.';
  return m;
}
function download(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const readBuf = f => f.arrayBuffer();
const openPdfJs = buf => pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false }).promise;
const loadLib = buf => PDFDocument.load(buf, { ignoreEncryption: false, updateMetadata: false });

function bindDrop(dropEl, { multiple, test, onFiles, msg }) {
  const input = $('input', dropEl);
  const handle = files => {
    files = [...files];
    const ok = files.filter(test);
    if (files.length && ok.length < files.length) toast(msg || 'Some files were skipped (wrong type).', true);
    if (ok.length) onFiles(multiple ? ok : ok.slice(0, 1));
  };
  input.addEventListener('change', () => { handle(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.remove('over'); }));
  dropEl.addEventListener('drop', e => handle(e.dataTransfer.files));
  return () => input.click();
}

/* Drag-to-reorder for children carrying data-i. axis: 'x' for grids, 'y' for lists */
function enableReorder(container, onMove, axis = 'x') {
  let from = null;
  const clear = () => $$('.dragging,.over-before,.over-after', container).forEach(e => e.classList.remove('dragging', 'over-before', 'over-after'));
  const itemOf = e => { const it = e.target.closest && e.target.closest('[data-i]'); return it && it.parentNode === container ? it : null; };
  const after = (e, it) => { const r = it.getBoundingClientRect(); return axis === 'x' ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2; };
  container.addEventListener('dragstart', e => {
    const it = itemOf(e); if (!it) return;
    from = +it.dataset.i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'x'); it.classList.add('dragging');
  });
  container.addEventListener('dragend', () => { from = null; clear(); });
  container.addEventListener('dragover', e => {
    if (from === null) return; const it = itemOf(e); if (!it) return;
    e.preventDefault(); $$('.over-before,.over-after', container).forEach(x => x.classList.remove('over-before', 'over-after'));
    it.classList.add(after(e, it) ? 'over-after' : 'over-before');
  });
  container.addEventListener('drop', e => {
    if (from === null) return; const it = itemOf(e); if (!it) return;
    e.preventDefault(); let idx = +it.dataset.i + (after(e, it) ? 1 : 0); if (from < idx) idx--;
    const f = from; from = null; clear(); if (idx !== f) onMove(f, idx);
  });
}

/* "1-3, 5, 7-" -> [[0,1,2],[4],[6..n-1]] */
function parseRanges(str, n) {
  const out = [];
  for (const part of str.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/) || part.match(/^(\d+)$/);
    if (!m) throw new Error(`Invalid range “${part}”.`);
    let a, b;
    if (m.length === 2) a = b = +m[1];
    else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
    if (a < 1 || b > n || a > b) throw new Error(`Range “${part}” is outside 1–${n}.`);
    const r = []; for (let i = a; i <= b; i++) r.push(i - 1); out.push(r);
  }
  if (!out.length) throw new Error('Enter at least one page range.');
  return out;
}
async function renderCanvas(pdf, num, { scale, width }) {
  const page = await pdf.getPage(num);
  const v1 = page.getViewport({ scale: 1 });
  const s = width ? width / v1.width : scale;
  const vp = page.getViewport({ scale: s });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return { canvas: c, w: v1.width, h: v1.height };
}
const canvasBlob = (c, type = 'image/jpeg', q = .85) => new Promise(r => c.toBlob(r, type, q));

/* ---------- navigation ---------- */
function showTool(name) {
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
  $$('.tool').forEach(s => s.classList.toggle('active', s.id === 'tool-' + name));
  history.replaceState(null, '', '#' + name);
  if (name === 'flipbook') fb.layout();
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTool(b.dataset.tool); });
// Stop the browser from navigating away when a file is dropped outside a drop zone
['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => { if (!e.target.closest('.drop')) e.preventDefault(); }));

/* =====================================================================
   ORGANIZER
   ===================================================================== */
const org = { src: new Map(), items: [], undo: [], sid: 1 };
const ORG_BOX = 140;

const orgOpen = bindDrop($('#org-drop'), { multiple: true, test: isPdf, msg: 'Only PDF files are supported here.', onFiles: files => orgAdd(files) });
$('#org-add').onclick = orgOpen;

async function orgAdd(files) {
  await run('Reading PDFs…', async () => {
    const added = [];
    for (const f of files) {
      const buf = await readBuf(f);
      let pdf;
      try { pdf = await openPdfJs(buf); } catch (e) { toast(`${f.name}: ${friendly(e)}`, true); continue; }
      const id = org.sid++;
      org.src.set(id, { id, name: f.name, buf, pdf, lib: null });
      for (let p = 1; p <= pdf.numPages; p++) added.push({ uid: uid++, src: id, page: p, rot: 0, thumb: null, aspect: 0.77 });
    }
    if (!added.length) return;
    orgSnapshot(); org.items.push(...added); orgRender();
    $('#org-drop').classList.add('compact');
  });
  orgThumbs();
}
async function orgThumbs() {
  for (const it of org.items) {
    if (it.thumb) continue;
    const s = org.src.get(it.src); if (!s) continue;
    try {
      const { canvas } = await renderCanvas(s.pdf, it.page, { width: 220 });
      it.aspect = canvas.width / canvas.height; it.thumb = canvas.toDataURL('image/jpeg', .7);
    } catch { it.thumb = ''; }
    const card = $(`#org-grid [data-uid="${it.uid}"]`);
    if (card) orgPaintThumb(card, it);
  }
}
function orgPaintThumb(card, it) {
  const box = $('.thumb', card), img = $('img', box);
  if (!it.thumb) { box.classList.add('ph'); img.style.display = 'none'; return; }
  box.classList.remove('ph'); img.style.display = '';
  const rotated = it.rot % 180 !== 0, a = rotated ? 1 / it.aspect : it.aspect;
  const [bw, bh] = a >= 1 ? [ORG_BOX, ORG_BOX / a] : [ORG_BOX * a, ORG_BOX];
  const [w, h] = rotated ? [bh, bw] : [bw, bh];
  img.src = it.thumb; img.style.width = w + 'px'; img.style.height = h + 'px';
  img.style.transform = `translate(-50%,-50%) rotate(${it.rot}deg)`;
}
function orgRender() {
  const grid = $('#org-grid');
  $('#org-ui').hidden = !org.items.length;
  grid.innerHTML = org.items.map((it, i) => `
    <div class="card" draggable="true" data-i="${i}" data-uid="${it.uid}">
      <div class="thumb ph"><img alt="Page ${i + 1}" draggable="false"></div>
      <div class="cardbar"><span class="n" title="${esc(org.src.get(it.src).name)} · p.${it.page}"><b>${i + 1}</b> · ${esc(org.src.get(it.src).name)} p${it.page}</span>
        <button class="ib" data-a="left" title="Move left" ${i === 0 ? 'disabled' : ''}>◀</button>
        <button class="ib" data-a="right" title="Move right" ${i === org.items.length - 1 ? 'disabled' : ''}>▶</button>
        <button class="ib" data-a="rot" title="Rotate 90°">⟳</button>
        <button class="ib del" data-a="del" title="Delete page">✕</button></div>
    </div>`).join('');
  $$('.card', grid).forEach((c, i) => orgPaintThumb(c, org.items[i]));
  const n = org.items.length, files = new Set(org.items.map(i => i.src)).size;
  $('#org-count').textContent = `${n} page${n === 1 ? '' : 's'} from ${files} file${files === 1 ? '' : 's'}`;
  $('#org-undo').disabled = !org.undo.length;
}
function orgSnapshot() { org.undo.push(org.items.map(i => ({ ...i }))); if (org.undo.length > 50) org.undo.shift(); }
function orgMutate(fn) { orgSnapshot(); fn(); orgRender(); }
$('#org-grid').addEventListener('click', e => {
  const b = e.target.closest('.ib'); if (!b) return;
  const i = +b.closest('.card').dataset.i, a = b.dataset.a;
  if (a === 'del') orgMutate(() => org.items.splice(i, 1));
  else if (a === 'rot') orgMutate(() => org.items[i].rot = (org.items[i].rot + 90) % 360);
  else if (a === 'left') orgMutate(() => arrMove(org.items, i, i - 1));
  else if (a === 'right') orgMutate(() => arrMove(org.items, i, i + 1));
});
enableReorder($('#org-grid'), (f, t) => orgMutate(() => arrMove(org.items, f, t)), 'x');
$('#org-undo').onclick = () => { const s = org.undo.pop(); if (s) { org.items = s; orgRender(); } };
$('#org-reverse').onclick = () => orgMutate(() => org.items.reverse());
$('#org-clear').onclick = () => { org.items = []; org.src.clear(); org.undo = []; orgRender(); $('#org-drop').classList.remove('compact'); };
$('#org-export').onclick = () => {
  if (!org.items.length) return toast('No pages to export.', true);
  run('Building PDF…', async () => {
    const out = await PDFDocument.create();
    for (let k = 0; k < org.items.length; k++) {
      const it = org.items[k], s = org.src.get(it.src);
      s.lib ||= await loadLib(s.buf);
      const [p] = await out.copyPages(s.lib, [it.page - 1]);
      if (it.rot) p.setRotation(degrees((p.getRotation().angle + it.rot) % 360));
      out.addPage(p);
      if (k % 10 === 0) progress(k / org.items.length);
    }
    const bytes = await out.save();
    download(bytes, 'organized.pdf', 'application/pdf');
    toast(`Exported ${org.items.length} pages (${fmtBytes(bytes.length)})`);
  });
};

/* =====================================================================
   MERGE
   ===================================================================== */
const mg = { files: [] };
bindDrop($('#merge-drop'), { multiple: true, test: isPdf, msg: 'Only PDF files can be merged.', onFiles: async files => {
  await run('Reading PDFs…', async () => {
    for (const f of files) {
      try {
        const buf = await readBuf(f), lib = await loadLib(buf);
        mg.files.push({ id: uid++, name: f.name, buf, pages: lib.getPageCount(), size: f.size });
      } catch (e) { toast(`${f.name}: ${friendly(e)}`, true); }
    }
  });
  mgRender();
} });
function mgRender() {
  $('#merge-ui').hidden = !mg.files.length;
  $('#merge-list').innerHTML = mg.files.map((f, i) => `
    <div class="item" draggable="true" data-i="${i}"><span class="idx">${i + 1}</span><span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="meta">${f.pages} p · ${fmtBytes(f.size)}</span>
      <button class="ib" data-a="up" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
      <button class="ib" data-a="down" ${i === mg.files.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
      <button class="ib del" data-a="del" title="Remove">✕</button></div>`).join('');
  const pages = mg.files.reduce((s, f) => s + f.pages, 0);
  $('#merge-info').textContent = `${mg.files.length} files · ${pages} pages total`;
}
$('#merge-list').addEventListener('click', e => {
  const b = e.target.closest('.ib'); if (!b) return;
  const i = +b.closest('.item').dataset.i;
  if (b.dataset.a === 'del') mg.files.splice(i, 1); else arrMove(mg.files, i, b.dataset.a === 'up' ? i - 1 : i + 1);
  mgRender();
});
enableReorder($('#merge-list'), (f, t) => { arrMove(mg.files, f, t); mgRender(); }, 'y');
$('#merge-clear').onclick = () => { mg.files = []; mgRender(); };
$('#merge-go').onclick = () => {
  if (mg.files.length < 2) return toast('Add at least two PDFs to merge.', true);
  run('Merging…', async () => {
    const out = await PDFDocument.create();
    for (let k = 0; k < mg.files.length; k++) {
      const lib = await loadLib(mg.files[k].buf);
      const pages = await out.copyPages(lib, lib.getPageIndices());
      pages.forEach(p => out.addPage(p));
      progress((k + 1) / mg.files.length);
    }
    const bytes = await out.save();
    download(bytes, 'merged.pdf', 'application/pdf');
    toast(`Merged ${mg.files.length} files → ${fmtBytes(bytes.length)}`);
  });
};

/* =====================================================================
   SPLIT
   ===================================================================== */
const sp = { file: null, buf: null, pages: 0 };
bindDrop($('#split-drop'), { multiple: false, test: isPdf, msg: 'Please choose a PDF.', onFiles: ([f]) => run('Reading PDF…', async () => {
  const buf = await readBuf(f), lib = await loadLib(buf);
  Object.assign(sp, { file: f, buf, pages: lib.getPageCount() });
  $('#split-info').innerHTML = `📄 <b>${esc(f.name)}</b> <span class="muted">${sp.pages} pages · ${fmtBytes(f.size)}</span>`;
  $('#split-ui').hidden = false; $('#split-drop').hidden = true;
  $('#split-n').max = sp.pages; $('#split-ranges').placeholder = `1-${Math.ceil(sp.pages / 2)}, ${Math.ceil(sp.pages / 2) + 1}-${sp.pages}`;
}) });
const splitMode = () => $('input[name=split-mode]:checked').value;
$$('input[name=split-mode]').forEach(r => r.onchange = () => {
  $('#split-ranges-wrap').hidden = !['ranges', 'extract'].includes(splitMode());
  $('#split-n-wrap').hidden = splitMode() !== 'every';
});
$('#split-clear').onclick = () => { sp.file = sp.buf = null; $('#split-ui').hidden = true; $('#split-drop').hidden = false; };
$('#split-go').onclick = () => run('Splitting…', async () => {
  const lib = await loadLib(sp.buf), n = sp.pages, mode = splitMode(), name = baseName(sp.file.name);
  let groups;
  if (mode === 'ranges') groups = parseRanges($('#split-ranges').value, n);
  else if (mode === 'extract') groups = [parseRanges($('#split-ranges').value, n).flat()];
  else {
    const size = mode === 'single' ? 1 : Math.max(1, +$('#split-n').value || 1);
    groups = []; for (let i = 0; i < n; i += size) groups.push(Array.from({ length: Math.min(size, n - i) }, (_, k) => i + k));
  }
  const files = [];
  for (let g = 0; g < groups.length; g++) {
    const out = await PDFDocument.create();
    (await out.copyPages(lib, groups[g])).forEach(p => out.addPage(p));
    const idx = groups[g], label = mode === 'extract' ? 'extract' : idx.length === 1 ? `page${idx[0] + 1}` : `pages${idx[0] + 1}-${idx[idx.length - 1] + 1}`;
    files.push({ name: `${name}_${label}.pdf`, bytes: await out.save() });
    progress((g + 1) / groups.length);
  }
  if (files.length === 1) { download(files[0].bytes, files[0].name, 'application/pdf'); toast('Done — 1 file saved'); return; }
  const zip = new JSZip(), seen = new Set();
  files.forEach((f, i) => { let nm = f.name; if (seen.has(nm)) nm = nm.replace(/\.pdf$/, `_${i + 1}.pdf`); seen.add(nm); zip.file(nm, f.bytes); });
  download(await zip.generateAsync({ type: 'blob' }), `${name}_split.zip`);
  toast(`Done — ${files.length} PDFs in a ZIP`);
});

/* =====================================================================
   COMPRESS
   ===================================================================== */
const cp = { file: null, buf: null, out: null };
const COMP = { light: { dpi: 150, q: .75 }, medium: { dpi: 110, q: .6 }, extreme: { dpi: 72, q: .45 } };
bindDrop($('#comp-drop'), { multiple: false, test: isPdf, msg: 'Please choose a PDF.', onFiles: ([f]) => run('Reading PDF…', async () => {
  const buf = await readBuf(f), lib = await loadLib(buf);
  Object.assign(cp, { file: f, buf });
  $('#comp-info').innerHTML = `📄 <b>${esc(f.name)}</b> <span class="muted">${lib.getPageCount()} pages · ${fmtBytes(f.size)}</span>`;
  $('#comp-ui').hidden = false; $('#comp-drop').hidden = true; $('#comp-result').hidden = true;
}) });
$('#comp-clear').onclick = () => { cp.file = cp.buf = null; $('#comp-ui').hidden = true; $('#comp-drop').hidden = false; };
$('#comp-go').onclick = () => run('Compressing…', async () => {
  const mode = $('input[name=comp-mode]:checked').value, orig = cp.file.size;
  let bytes;
  if (mode === 'lossless') {
    const lib = await loadLib(cp.buf);
    lib.setProducer('PDF Toolkit'); lib.setCreator('PDF Toolkit');
    bytes = await lib.save({ useObjectStreams: true });
  } else {
    const { dpi, q } = COMP[mode], pdf = await openPdfJs(cp.buf), out = await PDFDocument.create();
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), v = page.getViewport({ scale: 1 });
      let scale = dpi / 72; scale = Math.min(scale, 4000 / Math.max(v.width, v.height));
      const { canvas } = await renderCanvas(pdf, i, { scale });
      const jpg = await out.embedJpg(await (await canvasBlob(canvas, 'image/jpeg', q)).arrayBuffer());
      const p = out.addPage([v.width, v.height]); p.drawImage(jpg, { x: 0, y: 0, width: v.width, height: v.height });
      canvas.width = canvas.height = 0;
      progress(i / pdf.numPages, `Compressing page ${i} of ${pdf.numPages}…`);
    }
    bytes = await out.save({ useObjectStreams: true });
  }
  cp.out = bytes;
  const box = $('#comp-result'), saved = 1 - bytes.length / orig, better = bytes.length < orig;
  box.className = 'result' + (better ? '' : ' warn'); box.hidden = false;
  box.innerHTML = `<div><b>${fmtBytes(orig)} → ${fmtBytes(bytes.length)}</b><br><span class="muted">${better ? `Saved ${(saved * 100).toFixed(0)}%` : 'No size reduction — this file is already well optimized. Try a stronger mode.'}</span></div><span class="spacer"></span><button class="btn primary" id="comp-dl">Download${better ? '' : ' anyway'}</button>`;
  $('#comp-dl').onclick = () => download(cp.out, baseName(cp.file.name) + '_compressed.pdf', 'application/pdf');
});

/* =====================================================================
   FLIPBOOK
   ===================================================================== */
const fb = (() => {
  const S = { pdf: null, n: 0, ar: 0.707, spread: 0, zoom: 1, flipping: false, imgs: new Map(), gen: 0 };
  const stage = $('#fb-stage'), book = $('#fb-book'), L = $('#fb-L'), R = $('#fb-R');
  const spreads = () => Math.floor(S.n / 2) + 1;
  const pagesOf = s => ({ l: s === 0 ? null : 2 * s, r: 2 * s + 1 <= S.n ? 2 * s + 1 : null });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  bindDrop($('#fb-drop'), { multiple: false, test: isPdf, msg: 'Please choose a PDF.', onFiles: ([f]) => run('Opening PDF…', async () => {
    const buf = await readBuf(f), pdf = await openPdfJs(buf), p1 = await pdf.getPage(1), v = p1.getViewport({ scale: 1 });
    S.imgs.forEach(p => p.then(u => URL.revokeObjectURL(u)).catch(() => {})); S.imgs.clear(); S.gen++;
    Object.assign(S, { pdf, n: pdf.numPages, ar: v.width / v.height, spread: 0, zoom: 1 });
    $('#fb-drop').hidden = true; $('#fb-ui').hidden = false; $('#fb-total').textContent = S.n; $('#fb-page').max = S.n;
    setZoom(1, false); layout(); show(0);
  }) });

  function getImg(n) {
    if (!S.imgs.has(n)) {
      const gen = S.gen;
      S.imgs.set(n, renderCanvas(S.pdf, n, { width: Math.min(1600, Math.max(900, Math.round(innerWidth * .6))) })
        .then(async ({ canvas }) => { const u = URL.createObjectURL(await canvasBlob(canvas, 'image/jpeg', .9)); canvas.width = 0; return u; })
        .catch(e => { if (gen === S.gen) S.imgs.delete(n); throw e; }));
    }
    return S.imgs.get(n);
  }
  function setPage(el, n) {
    el.innerHTML = ''; el.dataset.n = n || ''; el.classList.toggle('empty', !n);
    if (!n) { el.classList.remove('loading'); return; }
    el.classList.add('loading');
    getImg(n).then(u => {
      if (el.dataset.n != n) return;
      const img = new Image(); img.src = u; img.draggable = false; img.alt = 'Page ' + n; el.append(img); el.classList.remove('loading');
    }).catch(() => el.classList.remove('loading'));
  }
  function show(s) {
    S.spread = s; const p = pagesOf(s); setPage(L, p.l); setPage(R, p.r); ui();
    // prefetch neighbours
    [p.r + 1, p.r + 2, p.r + 3, p.l - 1, p.l - 2].forEach(n => { if (n >= 1 && n <= S.n) getImg(n).catch(() => {}); });
  }
  function ui() {
    const p = pagesOf(S.spread);
    $('#fb-page').value = p.r || p.l;
    $('#fb-first').disabled = $('#fb-prev').disabled = S.spread === 0;
    $('#fb-last').disabled = $('#fb-next').disabled = S.spread === spreads() - 1;
    // centre a lone cover / back page when not zoomed
    const shift = S.zoom <= 1.01 ? (p.l === null ? -.25 : p.r === null ? .25 : 0) : 0;
    book.style.transform = shift ? `translateX(${shift * 100}%)` : '';
  }
  function layout() {
    if (!S.pdf) return;
    const ch = stage.clientHeight, cw = stage.clientWidth;
    let ph = Math.max(200, ch - 40), pw = ph * S.ar;
    if (pw * 2 > cw - 24) { pw = Math.max(120, (cw - 24) / 2); ph = pw / S.ar; }
    book.style.setProperty('--pw', pw * S.zoom + 'px'); book.style.setProperty('--ph', ph * S.zoom + 'px');
  }
  async function goTo(target) {
    target = clamp(target, 0, spreads() - 1);
    if (S.flipping || target === S.spread) return;
    const dir = target > S.spread ? 1 : -1, old = pagesOf(S.spread), nw = pagesOf(target);
    S.flipping = true;
    try {
      const urls = await Promise.all([old.l, old.r, nw.l, nw.r].map(n => n ? getImg(n) : null));
      const [ul, ur, nl, nr] = urls;
      const leaf = document.createElement('div'); leaf.className = 'leaf ' + (dir > 0 ? 'right' : 'left');
      const face = (cls, u) => `<div class="face ${cls}">${u ? `<img src="${u}" draggable="false">` : ''}</div>`;
      if (dir > 0) { setPage(R, nw.r); leaf.innerHTML = face('front', ur) + face('back', nl); }
      else { setPage(L, nw.l); leaf.innerHTML = face('front', ul) + face('back', nr); }
      book.append(leaf); void leaf.offsetWidth;
      ui(); S.spread = target; ui();
      leaf.style.transform = dir > 0 ? 'rotateY(-180deg)' : 'rotateY(180deg)';
      await Promise.race([new Promise(r => leaf.addEventListener('transitionend', r, { once: true })), sleep(1000)]);
      leaf.remove(); show(target);
    } catch (e) { console.error(e); toast('Could not render that page.', true); show(target); }
    S.flipping = false;
    // a queued jump (e.g. from the page box) is not needed; keep it simple
  }
  const pageToSpread = p => Math.floor(p / 2);
  function setZoom(z, keepCenter = true) {
    const oldZ = S.zoom; z = clamp(Math.round(z * 100) / 100, .5, 4); S.zoom = z;
    $('#fb-zoom').value = z * 100; $('#fb-zlabel').textContent = Math.round(z * 100) + '%';
    let fx = .5, fy = .5;
    if (keepCenter && stage.scrollWidth > stage.clientWidth) fx = (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth;
    if (keepCenter && stage.scrollHeight > stage.clientHeight) fy = (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight;
    layout(); ui();
    if (keepCenter && oldZ !== z) { stage.scrollLeft = fx * stage.scrollWidth - stage.clientWidth / 2; stage.scrollTop = fy * stage.scrollHeight - stage.clientHeight / 2; }
  }
  // controls
  $('#fb-next').onclick = () => goTo(S.spread + 1);
  $('#fb-prev').onclick = () => goTo(S.spread - 1);
  $('#fb-first').onclick = () => goTo(0);
  $('#fb-last').onclick = () => goTo(spreads() - 1);
  $('#fb-page').addEventListener('change', e => { const v = clamp(+e.target.value || 1, 1, S.n); goTo(pageToSpread(v)); });
  $('#fb-zoom').addEventListener('input', e => setZoom(e.target.value / 100));
  $('#fb-zin').onclick = () => setZoom(S.zoom + .25);
  $('#fb-zout').onclick = () => setZoom(S.zoom - .25);
  $('#fb-fit').onclick = () => { setZoom(1, false); stage.scrollTo(0, 0); };
  $('#fb-full').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('#fb-viewer').requestFullscreen().catch(() => toast('Fullscreen not available.', true));
  $('#fb-close').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); S.pdf = null; S.gen++; S.imgs.forEach(p => p.then(u => URL.revokeObjectURL(u)).catch(() => {})); S.imgs.clear(); L.innerHTML = R.innerHTML = ''; $('#fb-ui').hidden = true; $('#fb-drop').hidden = false; };
  stage.addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false });
  stage.addEventListener('dblclick', () => setZoom(S.zoom > 1.2 ? 1 : 2.5));
  // drag to pan, click to turn
  let drag = null;
  stage.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop, moved: false }; });
  window.addEventListener('pointermove', e => {
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 5) { drag.moved = true; stage.classList.add('panning'); }
    if (drag.moved) { stage.scrollLeft = drag.sl - dx; stage.scrollTop = drag.st - dy; }
  });
  window.addEventListener('pointerup', e => {
    if (!drag) return; const d = drag; drag = null; stage.classList.remove('panning');
    if (d.moved || !stage.contains(e.target)) return;
    const r = book.getBoundingClientRect(); if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) return;
    goTo(S.spread + (e.clientX < r.left + r.width / 2 ? -1 : 1));
  });
  // keyboard
  document.addEventListener('keydown', e => {
    if (!S.pdf || !$('#tool-flipbook').classList.contains('active') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== 'range') return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); goTo(S.spread + 1); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); goTo(S.spread - 1); }
    else if (k === 'Home') goTo(0); else if (k === 'End') goTo(spreads() - 1);
    else if (k === '+' || k === '=') setZoom(S.zoom + .25); else if (k === '-') setZoom(S.zoom - .25);
    else if (k === '0') { setZoom(1, false); }
    else if (k === 'f' || k === 'F') $('#fb-full').click();
  });
  new ResizeObserver(() => requestAnimationFrame(layout)).observe(stage);
  return { layout };
})();

/* =====================================================================
   IMAGE → PDF
   ===================================================================== */
const im = { items: [] };
const imgOpen = bindDrop($('#img-drop'), { multiple: true, test: isImg, msg: 'Some files were skipped — only images are supported.', onFiles: files => {
  files.forEach(f => im.items.push({ id: uid++, file: f, url: URL.createObjectURL(f) }));
  imRender();
} });
$('#img-add').onclick = imgOpen;
function imRender() {
  $('#img-ui').hidden = !im.items.length;
  $('#img-grid').innerHTML = im.items.map((it, i) => `
    <div class="card" draggable="true" data-i="${i}"><div class="thumb"><img src="${it.url}" draggable="false" style="max-width:100%;max-height:100%;position:static;transform:none"></div>
      <div class="cardbar"><span class="n" title="${esc(it.file.name)}"><b>${i + 1}</b> · ${esc(it.file.name)}</span>
      <button class="ib" data-a="left" ${i === 0 ? 'disabled' : ''}>◀</button><button class="ib" data-a="right" ${i === im.items.length - 1 ? 'disabled' : ''}>▶</button>
      <button class="ib del" data-a="del">✕</button></div></div>`).join('');
  $$('#img-grid .thumb').forEach(t => t.style.height = '110px');
  $('#img-info').textContent = `${im.items.length} image${im.items.length === 1 ? '' : 's'}`;
}
$('#img-grid').addEventListener('click', e => {
  const b = e.target.closest('.ib'); if (!b) return; const i = +b.closest('.card').dataset.i;
  if (b.dataset.a === 'del') { URL.revokeObjectURL(im.items[i].url); im.items.splice(i, 1); }
  else arrMove(im.items, i, b.dataset.a === 'left' ? i - 1 : i + 1);
  imRender();
});
enableReorder($('#img-grid'), (f, t) => { arrMove(im.items, f, t); imRender(); }, 'x');
$('#img-clear').onclick = () => { im.items.forEach(i => URL.revokeObjectURL(i.url)); im.items = []; imRender(); };
const PAGE = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008] };
async function imageForPdf(out, file) {
  const buf = await readBuf(file);
  if (file.type === 'image/png') { try { return await out.embedPng(buf); } catch { /* fall through to canvas */ } }
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file));
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0);
  const img = await out.embedJpg(await (await canvasBlob(c, 'image/jpeg', .92)).arrayBuffer());
  bmp.close && bmp.close(); return img;
}
$('#img-go').onclick = () => run('Creating PDF…', async () => {
  const out = await PDFDocument.create(), size = $('#img-size').value, orient = $('#img-orient').value, m = +$('#img-margin').value;
  for (let i = 0; i < im.items.length; i++) {
    const img = await imageForPdf(out, im.items[i].file), iw = img.width, ih = img.height;
    let pw, ph;
    if (size === 'fit') { pw = iw + 2 * m; ph = ih + 2 * m; }
    else {
      [pw, ph] = PAGE[size];
      const land = orient === 'auto' ? iw > ih : orient === 'l';
      if (land !== pw > ph) [pw, ph] = [ph, pw];
    }
    const k = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih, size === 'fit' ? 1 : Infinity), w = iw * k, h = ih * k;
    out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    progress((i + 1) / im.items.length);
  }
  const bytes = await out.save();
  download(bytes, 'images.pdf', 'application/pdf'); toast(`Created PDF with ${im.items.length} pages (${fmtBytes(bytes.length)})`);
});

/* =====================================================================
   HTML → PDF
   ===================================================================== */
const frame = $('#html-frame'), htmlSrc = $('#html-src');
htmlSrc.value = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body{font-family:Georgia,serif;color:#222;line-height:1.6}
  h1{color:#4f46e5;border-bottom:2px solid #4f46e5;padding-bottom:6px}
  table{border-collapse:collapse;width:100%} td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}
</style></head><body>
  <h1>Hello, PDF!</h1>
  <p>Edit this HTML or open a file. Everything is rendered <b>locally</b> in your browser.</p>
  <table><tr><th>Item</th><th>Qty</th></tr><tr><td>Widgets</td><td>4</td></tr><tr><td>Gadgets</td><td>7</td></tr></table>
</body></html>`;
const htmlDims = () => {
  let [pw, ph] = PAGE[$('#html-size').value]; if ($('#html-orient').value === 'l') [pw, ph] = [ph, pw];
  return { pw, ph, m: +$('#html-margin').value };
};
let previewTimer;
function updatePreview() {
  const { pw, m } = htmlDims(), cw = Math.round((pw - 2 * m) * 96 / 72);
  frame.style.width = cw + 'px';
  frame.srcdoc = htmlSrc.value;
}
frame.addEventListener('load', () => {
  const d = frame.contentDocument; if (!d) return;
  frame.style.height = Math.max(300, d.documentElement.scrollHeight) + 'px';
});
htmlSrc.addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 350); });
['#html-size', '#html-orient', '#html-margin'].forEach(s => $(s).addEventListener('change', updatePreview));
$('#html-file').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { htmlSrc.value = await f.text(); updatePreview(); } e.target.value = ''; });
updatePreview();
/* html2canvas can't parse modern CSS colours (oklch, color-mix, color(), lab…). Convert them to rgba via a canvas. */
const MODERN_START = /\b(color-mix|oklch|oklab|lab|lch|hwb|color)\(/g, MODERN_TEST = /\b(color-mix|oklch|oklab|lab|lch|hwb|color)\(/;
const colorCtx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
function colorToRgba(v) {
  colorCtx.clearRect(0, 0, 1, 1); colorCtx.fillStyle = '#000'; colorCtx.fillStyle = v; colorCtx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r},${g},${b},${+(a / 255).toFixed(3)})`;
}
function replaceModernColors(str) {
  let out = '', i = 0, m;
  MODERN_START.lastIndex = 0;
  while ((m = MODERN_START.exec(str))) {
    let depth = 1, j = m.index + m[0].length;
    while (j < str.length && depth) { if (str[j] === '(') depth++; else if (str[j] === ')') depth--; j++; }
    const piece = str.slice(m.index, j);
    out += str.slice(i, m.index) + (/var\(/.test(piece) ? piece : colorToRgba(piece));
    i = j; MODERN_START.lastIndex = j;
  }
  return out + str.slice(i);
}
const COLOR_PROPS = ['color', 'background-color', 'background-image', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'outline-color', 'text-decoration-color', 'box-shadow', 'text-shadow', 'caret-color', 'fill', 'stroke'];
function fixModernColors(clonedDoc) {
  const win = clonedDoc.defaultView;
  clonedDoc.querySelectorAll('style').forEach(s => { if (MODERN_TEST.test(s.textContent)) s.textContent = replaceModernColors(s.textContent); });
  clonedDoc.querySelectorAll('*').forEach(el => {
    const cs = win.getComputedStyle(el);
    for (const p of COLOR_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && MODERN_TEST.test(v)) el.style.setProperty(p, replaceModernColors(v), 'important');
    }
  });
}
$('#html-go').onclick = () => run('Rendering HTML…', async () => {
  updatePreview(); await new Promise(r => frame.addEventListener('load', r, { once: true })); await sleep(250);
  const doc = frame.contentDocument, { pw, ph, m } = htmlDims(), scale = +$('#html-scale').value;
  const cw = Math.round((pw - 2 * m) * 96 / 72);
  frame.style.height = Math.max(300, doc.documentElement.scrollHeight) + 'px';
  const canvas = await html2canvas(doc.documentElement, { scale, backgroundColor: '#ffffff', width: cw, windowWidth: cw, logging: false, useCORS: false, allowTaint: false, onclone: fixModernColors });
  const pdf = new jspdf.jsPDF({ unit: 'pt', format: [pw, ph], compress: true, orientation: pw > ph ? 'l' : 'p' });
  const cwPt = pw - 2 * m, chPt = ph - 2 * m, slicePx = Math.floor(canvas.width * chPt / cwPt);
  const pages = Math.max(1, Math.ceil(canvas.height / slicePx));
  for (let i = 0; i < pages; i++) {
    const hPx = Math.min(slicePx, canvas.height - i * slicePx), s = document.createElement('canvas');
    s.width = canvas.width; s.height = hPx;
    const ctx = s.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, s.width, s.height);
    ctx.drawImage(canvas, 0, i * slicePx, canvas.width, hPx, 0, 0, canvas.width, hPx);
    if (i) pdf.addPage([pw, ph], pw > ph ? 'l' : 'p');
    pdf.addImage(s.toDataURL('image/jpeg', .92), 'JPEG', m, m, cwPt, hPx * cwPt / canvas.width, undefined, 'FAST');
    progress((i + 1) / pages);
  }
  download(pdf.output('blob'), 'document.pdf');
  toast(`Created ${pages}-page PDF`);
});

/* =====================================================================
   PDF → TEXT
   ===================================================================== */
const tx = { name: '', text: '', pages: [] };
bindDrop($('#txt-drop'), { multiple: false, test: isPdf, msg: 'Please choose a PDF.', onFiles: ([f]) => run('Extracting text…', async () => {
  const pdf = await openPdfJs(await readBuf(f)); tx.name = baseName(f.name); tx.pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    tx.pages.push(pageToText(await (await pdf.getPage(i)).getTextContent()));
    progress(i / pdf.numPages, `Reading page ${i} of ${pdf.numPages}…`);
  }
  $('#txt-info').innerHTML = `📄 <b>${esc(f.name)}</b> <span class="muted">${pdf.numPages} pages · ${fmtBytes(f.size)}</span>`;
  $('#txt-ui').hidden = false; $('#txt-drop').hidden = true; txRender();
  if (!tx.pages.some(t => t.trim())) toast('No text found — this PDF may be scanned images (OCR is not included).', true);
}) });
function pageToText(tc) {
  let out = '', lastY = null, endX = 0, lastH = 0;
  for (const it of tc.items) {
    if (!it.str && !it.hasEOL) continue;
    const t = it.transform, x = t[4], y = t[5], h = Math.hypot(t[2], t[3]) || lastH || 10;
    if (lastY !== null && it.str) {
      const dy = Math.abs(y - lastY), ref = Math.max(h, lastH);
      if (dy > ref * .6) { out = out.replace(/[ \t]+$/, '') + (dy > ref * 2 ? '\n\n' : '\n'); }
      else if (x - endX > h * .15 && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
    }
    out += it.str;
    if (it.str) { lastY = y; endX = x + it.width; lastH = h; }
  }
  return out.trim();
}
function txRender() {
  const sep = $('#txt-sep').checked;
  tx.text = tx.pages.map((t, i) => (sep ? `--- Page ${i + 1} ---\n\n` : '') + t).join(sep ? '\n\n' : '\n\n');
  $('#txt-out').value = tx.text;
  const words = (tx.text.match(/\S+/g) || []).length;
  $('#txt-stats').textContent = `${tx.pages.length} pages · ${words.toLocaleString()} words · ${tx.text.length.toLocaleString()} characters`;
  $('#txt-copy').disabled = $('#txt-save').disabled = !tx.text.trim();
}
$('#txt-sep').onchange = txRender;
$('#txt-clear').onclick = () => { tx.pages = []; $('#txt-ui').hidden = true; $('#txt-drop').hidden = false; };
$('#txt-save').onclick = () => download(new Blob(['﻿' + tx.text], { type: 'text/plain;charset=utf-8' }), tx.name + '.txt');
$('#txt-copy').onclick = async () => { try { await navigator.clipboard.writeText(tx.text); toast('Copied to clipboard'); } catch { $('#txt-out').select(); document.execCommand('copy'); toast('Copied'); } };

/* ---------- init ---------- */
(function init() {
  const h = location.hash.slice(1);
  if (h && $('#tool-' + h)) showTool(h);
})();
