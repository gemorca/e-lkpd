// Alat "Potong dari PDF": guru memotong gambar dari halaman PDF lalu mengunggahnya
// sebagai gambar LKPD. Dipakai dari js/components/lkpd-editor.js.
//
// - PDF hanya dibaca di browser (pdf.js), tidak dikirim ke server dan tidak disimpan di Drive.
//   Berkas PDF terakhir disimpan di memori halaman supaya tidak perlu dipilih ulang
//   selama halaman tidak dimuat ulang.
// - Hasil potongan: JPEG kualitas 0,85, latar putih, lebar maksimal 1.000 px,
//   dikirim lewat aksi `upload_image`.
// - Alat tetap terbuka setelah satu potongan dipakai, tujuan berpindah ke tempat gambar
//   kosong berikutnya.

import { apiPost } from '../services/api.js';
import { escapeHtml as e } from '../services/html.js';
import { showToast } from './modal.js';

const MODAL_ID = 'pdf-crop-modal';
const LEBAR_MAKS = 1000;
const KUALITAS = 0.85;
const SKALA_MAKS = 4;
const MIN_PX = 20;
const ZOOM = [1, 1.5, 2, 3, 4];
const MAKS_DATAURL = Math.round(3 * 1024 * 1024 * 1.37);

const btn = 'px-2.5 py-1.5 rounded-lg font-bold text-[11px] border bg-white hover:bg-slate-50 disabled:opacity-40';

let sumber = null; // { buffer: ArrayBuffer, nama: string }
let st = null; // state alat yang sedang terbuka

const $ = (id) => document.getElementById(id);
const klem = (v, a, b) => Math.min(b, Math.max(a, v));

export async function setSumberPdf(fileOrBuffer) {
  try {
    if (fileOrBuffer instanceof ArrayBuffer) {
      sumber = { buffer: fileOrBuffer, nama: 'PDF' };
    } else if (fileOrBuffer && typeof fileOrBuffer.arrayBuffer === 'function') {
      sumber = { buffer: await fileOrBuffer.arrayBuffer(), nama: fileOrBuffer.name || 'PDF' };
    }
  } catch (err) {
    sumber = null;
  }
}

function pilihPdf() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/pdf';
    inp.onchange = () => resolve(inp.files && inp.files[0] ? inp.files[0] : null);
    inp.click();
  });
}

/* ---------- kerangka ---------- */

function bangunModal() {
  let modal = $(MODAL_ID);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.className = 'fixed inset-0 z-[65] hidden';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="bg-slate-100 w-full h-full flex flex-col text-xs">
      <div class="flex items-center gap-2 px-3 py-2.5 bg-white border-b flex-wrap">
        <h2 class="font-black text-brand-navy text-sm flex-1 min-w-[140px]">✂ Potong Gambar dari PDF</h2>
        <span id="pc-nama" class="text-slate-500 truncate max-w-[40%]"></span>
        <button type="button" id="pc-ganti" class="${btn}">Pilih PDF</button>
        <button type="button" id="pc-tutup" class="${btn}">Tutup</button>
      </div>
      <div class="flex items-center gap-1.5 px-3 py-2 bg-white border-b flex-wrap">
        <button type="button" id="pc-prev" class="${btn}" aria-label="Halaman sebelumnya">◀</button>
        <span id="pc-hal" class="font-bold text-slate-600 min-w-[70px] text-center">- / -</span>
        <button type="button" id="pc-next" class="${btn}" aria-label="Halaman berikutnya">▶</button>
        <span class="w-2"></span>
        <button type="button" id="pc-zkecil" class="${btn}" aria-label="Perkecil">−</button>
        <span id="pc-zlabel" class="font-bold text-slate-600 min-w-[40px] text-center">100%</span>
        <button type="button" id="pc-zbesar" class="${btn}" aria-label="Perbesar">+</button>
        <span class="flex-1"></span>
        <button type="button" id="pc-mode" class="${btn}" title="Ganti antara memilih area dan menggeser halaman">✂ Pilih area</button>
      </div>
      <div id="pc-area" class="flex-1 overflow-auto bg-slate-300 p-2 relative">
        <div id="pc-kosong" class="absolute inset-0 grid place-items-center text-center p-6 text-slate-600 font-medium">
          <div class="space-y-3"><p>PDF LKPD tidak disimpan di server. Pilih file PDF untuk mulai memotong gambar.</p><button type="button" id="pc-pilih2" class="px-4 py-2 rounded-xl bg-brand-blue text-white font-black">Pilih file PDF</button></div>
        </div>
        <div id="pc-wrap" class="relative mx-auto bg-white shadow hidden">
          <canvas id="pc-canvas" class="block"></canvas>
          <div id="pc-ov" class="absolute inset-0" style="touch-action:none;cursor:crosshair">
            <div id="pc-box" class="absolute border-2 border-brand-blue bg-blue-500/20 hidden pointer-events-none"></div>
          </div>
        </div>
      </div>
      <div class="px-3 py-2.5 bg-white border-t flex gap-3 items-center flex-wrap">
        <div class="w-20 h-20 rounded-lg border bg-slate-50 grid place-items-center overflow-hidden shrink-0"><img id="pc-hasil" alt="Pratinjau potongan" class="max-w-full max-h-full hidden"><span id="pc-hasil-kosong" class="text-[10px] text-slate-400 text-center px-1">pratinjau</span></div>
        <div class="flex-1 min-w-[180px] space-y-1">
          <label for="pc-tujuan" class="block font-bold text-slate-600">Pasang ke gambar</label>
          <select id="pc-tujuan" class="w-full p-1.5 rounded-lg border text-xs"></select>
          <p id="pc-info" class="text-[10px] text-slate-500">Seret pada halaman untuk memilih area gambar.</p>
        </div>
        <button type="button" id="pc-pakai" class="px-4 py-2 rounded-xl bg-brand-emerald text-white font-black disabled:opacity-40" disabled>Pakai potongan</button>
      </div>
    </div>`;
  return modal;
}

/* ---------- PDF ---------- */

async function muatPdf(buffer, nama) {
  if (typeof pdfjsLib === 'undefined') {
    showToast('error', 'pdf.js belum dimuat. Periksa koneksi internet lalu muat ulang.');
    return;
  }
  try {
    const dok = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
    if (st.pdf) {
      try { st.pdf.destroy(); } catch (err) {}
    }
    st.pdf = dok;
    st.total = dok.numPages;
    st.hal = 1;
    st.zoom = 0;
    st.sel = null;
    st.hasil = null;
    $('pc-nama').textContent = nama;
    $('pc-ganti').textContent = 'Ganti PDF';
    $('pc-kosong').classList.add('hidden');
    $('pc-wrap').classList.remove('hidden');
    await tampil();
    perbaruiPratinjau();
  } catch (err) {
    showToast('error', 'PDF tidak bisa dibuka: ' + ((err && err.message) || err));
  }
}

async function tampil() {
  if (!st || !st.pdf) return;
  const saya = ++st.token;
  if (st.tugas) {
    try { st.tugas.cancel(); } catch (err) {}
  }
  const page = await st.pdf.getPage(st.hal);
  if (!st || saya !== st.token) return;

  st.page = page;
  const v1 = page.getViewport({ scale: 1 });
  st.w1 = v1.width;
  st.h1 = v1.height;

  const area = $('pc-area');
  const pas = Math.max(0.1, (area.clientWidth - 16) / v1.width);
  st.skala = pas * ZOOM[st.zoom];

  const vp = page.getViewport({ scale: st.skala });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = $('pc-canvas');
  c.width = Math.max(1, Math.round(vp.width * dpr));
  c.height = Math.max(1, Math.round(vp.height * dpr));
  c.style.width = vp.width + 'px';
  c.style.height = vp.height + 'px';
  const wrap = $('pc-wrap');
  wrap.style.width = vp.width + 'px';
  wrap.style.height = vp.height + 'px';

  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);

  const tugas = page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: st.skala * dpr }) });
  st.tugas = tugas;
  try {
    await tugas.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    showToast('error', 'Halaman gagal ditampilkan.');
    return;
  }

  $('pc-hal').textContent = `${st.hal} / ${st.total}`;
  $('pc-zlabel').textContent = Math.round(ZOOM[st.zoom] * 100) + '%';
  $('pc-prev').disabled = st.hal <= 1;
  $('pc-next').disabled = st.hal >= st.total;
  $('pc-zkecil').disabled = st.zoom <= 0;
  $('pc-zbesar').disabled = st.zoom >= ZOOM.length - 1;
  gambarKotak();
}

function gambarKotak() {
  const box = $('pc-box');
  if (!box || !st) return;
  let r = null;
  if (st.dragPx) r = st.dragPx;
  else if (st.sel) r = { x: st.sel.x * st.skala, y: st.sel.y * st.skala, w: st.sel.w * st.skala, h: st.sel.h * st.skala };
  if (!r || r.w < 1 || r.h < 1) {
    box.classList.add('hidden');
    return;
  }
  box.style.left = r.x + 'px';
  box.style.top = r.y + 'px';
  box.style.width = r.w + 'px';
  box.style.height = r.h + 'px';
  box.classList.remove('hidden');
}

/* ---------- seleksi (pointer events: mouse dan sentuh) ---------- */

function pasangSeleksi() {
  const ov = $('pc-ov');

  const titik = (ev) => {
    const r = ov.getBoundingClientRect();
    return { x: klem(ev.clientX - r.left, 0, r.width), y: klem(ev.clientY - r.top, 0, r.height) };
  };

  ov.addEventListener('pointerdown', (ev) => {
    if (!st || !st.pdf || st.mode !== 'pilih' || st.sibuk) return;
    ev.preventDefault();
    try { ov.setPointerCapture(ev.pointerId); } catch (err) {}
    st.awal = titik(ev);
    st.dragPx = { x: st.awal.x, y: st.awal.y, w: 0, h: 0 };
    gambarKotak();
  });

  ov.addEventListener('pointermove', (ev) => {
    if (!st || !st.awal) return;
    const p = titik(ev);
    st.dragPx = {
      x: Math.min(st.awal.x, p.x),
      y: Math.min(st.awal.y, p.y),
      w: Math.abs(p.x - st.awal.x),
      h: Math.abs(p.y - st.awal.y)
    };
    gambarKotak();
  });

  const selesai = () => {
    if (!st || !st.awal) return;
    const r = st.dragPx;
    st.awal = null;
    st.dragPx = null;
    if (!r || r.w < MIN_PX || r.h < MIN_PX) {
      st.sel = null;
      st.hasil = null;
    } else {
      st.sel = { x: r.x / st.skala, y: r.y / st.skala, w: r.w / st.skala, h: r.h / st.skala };
    }
    gambarKotak();
    buatPotongan();
  };
  ov.addEventListener('pointerup', selesai);
  ov.addEventListener('pointercancel', selesai);
}

/* ---------- potongan ---------- */

// Render hanya area terpilih pada resolusi akhir. Hasilnya langsung menjadi berkas unggahan.
async function buatPotongan() {
  if (!st) return;
  const saya = ++st.tokenPotong;
  if (!st.sel || !st.page) {
    st.hasil = null;
    perbaruiPratinjau();
    return;
  }
  const s = st.sel;
  const page = st.page;
  const skala = Math.min(SKALA_MAKS, LEBAR_MAKS / s.w);
  const lebar = Math.max(1, Math.round(s.w * skala));
  const tinggi = Math.max(1, Math.round(s.h * skala));

  const c = document.createElement('canvas');
  c.width = lebar;
  c.height = tinggi;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, lebar, tinggi);

  try {
    await page.render({
      canvasContext: ctx,
      viewport: page.getViewport({ scale: skala }),
      transform: [1, 0, 0, 1, -s.x * skala, -s.y * skala]
    }).promise;
  } catch (err) {
    if (st && saya === st.tokenPotong) showToast('error', 'Potongan gagal dibuat.');
    return;
  }
  if (!st || saya !== st.tokenPotong) return;

  st.hasil = c.toDataURL('image/jpeg', KUALITAS);
  st.ukuran = { lebar, tinggi };
  perbaruiPratinjau();
}

function perbaruiPratinjau() {
  if (!st) return;
  const img = $('pc-hasil');
  const kosong = $('pc-hasil-kosong');
  const info = $('pc-info');
  const pakai = $('pc-pakai');
  if (st.hasil) {
    img.src = st.hasil;
    img.classList.remove('hidden');
    kosong.classList.add('hidden');
    const kb = Math.round((st.hasil.length * 0.75) / 1024);
    info.textContent = `Potongan ${st.ukuran.lebar}×${st.ukuran.tinggi} px, sekitar ${kb} KB. Seret lagi untuk mengganti area.`;
  } else {
    img.removeAttribute('src');
    img.classList.add('hidden');
    kosong.classList.remove('hidden');
    info.textContent = st.pdf ? 'Seret pada halaman untuk memilih area gambar.' : 'Pilih file PDF dulu.';
  }
  pakai.disabled = !(st.hasil && st.tujuan) || st.sibuk;
}

/* ---------- tujuan ---------- */

function isiTujuan(pilih) {
  const daftar = st.ambilTujuan() || [];
  const sel = $('pc-tujuan');
  if (!daftar.length) {
    sel.innerHTML = '<option value="">(belum ada tempat gambar, tambah blok gambar dulu)</option>';
    st.tujuan = '';
    return;
  }
  let dipilih = daftar.find((d) => d.kunci === pilih) ? pilih : '';
  if (!dipilih) {
    const kosong = daftar.find((d) => !d.terisi);
    dipilih = (kosong || daftar[0]).kunci;
  }
  st.tujuan = dipilih;
  sel.innerHTML = daftar
    .map((d) => `<option value="${e(d.kunci)}" ${d.kunci === dipilih ? 'selected' : ''}>${d.terisi ? '✓' : '○'} ${e(d.label)}</option>`)
    .join('');
}

function tujuanBerikutnya(kunciSekarang) {
  const daftar = st.ambilTujuan() || [];
  const i = daftar.findIndex((d) => d.kunci === kunciSekarang);
  for (let n = 1; n <= daftar.length; n++) {
    const d = daftar[(i + n) % daftar.length];
    if (!d.terisi) return d.kunci;
  }
  return kunciSekarang;
}

async function pakai() {
  if (!st || st.sibuk || !st.hasil) return;
  if (!st.tujuan) {
    showToast('error', 'Pilih tempat gambar dulu.');
    return;
  }
  if (st.hasil.length > MAKS_DATAURL) {
    showToast('error', 'Potongan terlalu besar. Pilih area yang lebih kecil.');
    return;
  }

  const tujuan = st.tujuan;
  st.sibuk = true;
  const tombol = $('pc-pakai');
  tombol.disabled = true;
  tombol.textContent = 'Mengunggah...';
  try {
    const res = await apiPost({ action: 'upload_image', base64Data: st.hasil, fileName: 'potongan.jpg' });
    if (!res || !res.success) {
      showToast('error', (res && res.message) || 'Gagal mengunggah gambar');
      return;
    }
    const ok = await st.terapkan(tujuan, res.url);
    if (ok === false) {
      showToast('error', 'Tempat gambar tidak ditemukan lagi. Pilih tujuan lain.');
      isiTujuan('');
      return;
    }
    showToast('success', 'Potongan terpasang');
    st.sel = null;
    st.hasil = null;
    st.tokenPotong++;
    gambarKotak();
    isiTujuan(tujuanBerikutnya(tujuan));
  } catch (err) {
    showToast('error', (err && err.message) || 'Gagal mengunggah gambar');
  } finally {
    if (st) {
      st.sibuk = false;
      const t2 = $('pc-pakai');
      if (t2) t2.textContent = 'Pakai potongan';
      perbaruiPratinjau();
    }
  }
}

/* ---------- buka / tutup ---------- */

function onKey(ev) {
  if (ev.key === 'Escape') tutupPotongPdf();
}

let timerUkuran = null;
function onUkuran() {
  clearTimeout(timerUkuran);
  timerUkuran = setTimeout(() => {
    if (st && st.pdf) tampil();
  }, 200);
}

/**
 * opsi: {
 *   ambilTujuan: () => [{kunci, label, terisi}],
 *   terapkan: async (kunci, url) => boolean,
 *   tujuanAwal: string
 * }
 */
export async function bukaPotongPdf(opsi) {
  if (st) tutupPotongPdf(true);
  st = {
    ambilTujuan: opsi.ambilTujuan,
    terapkan: opsi.terapkan,
    tujuan: '',
    pdf: null,
    page: null,
    total: 0,
    hal: 1,
    zoom: 0,
    skala: 1,
    w1: 0,
    h1: 0,
    sel: null,
    dragPx: null,
    awal: null,
    hasil: null,
    ukuran: null,
    mode: 'pilih',
    sibuk: false,
    token: 0,
    tokenPotong: 0,
    tugas: null
  };

  const modal = bangunModal();
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  $('pc-tutup').addEventListener('click', () => tutupPotongPdf());
  const ganti = async () => {
    const f = await pilihPdf();
    if (!f) return;
    await setSumberPdf(f);
    if (sumber && st) await muatPdf(sumber.buffer, sumber.nama);
  };
  $('pc-ganti').addEventListener('click', ganti);
  $('pc-pilih2').addEventListener('click', ganti);
  $('pc-prev').addEventListener('click', () => { if (st.hal > 1) { st.hal--; st.sel = null; st.hasil = null; tampil(); perbaruiPratinjau(); } });
  $('pc-next').addEventListener('click', () => { if (st.hal < st.total) { st.hal++; st.sel = null; st.hasil = null; tampil(); perbaruiPratinjau(); } });
  $('pc-zkecil').addEventListener('click', () => { if (st.zoom > 0) { st.zoom--; tampil(); } });
  $('pc-zbesar').addEventListener('click', () => { if (st.zoom < ZOOM.length - 1) { st.zoom++; tampil(); } });
  $('pc-mode').addEventListener('click', () => {
    st.mode = st.mode === 'pilih' ? 'geser' : 'pilih';
    $('pc-mode').textContent = st.mode === 'pilih' ? '✂ Pilih area' : '✋ Geser halaman';
    const ov = $('pc-ov');
    ov.style.pointerEvents = st.mode === 'pilih' ? 'auto' : 'none';
    ov.style.cursor = st.mode === 'pilih' ? 'crosshair' : 'default';
  });
  $('pc-tujuan').addEventListener('change', (ev) => { st.tujuan = ev.target.value; perbaruiPratinjau(); });
  $('pc-pakai').addEventListener('click', pakai);
  pasangSeleksi();

  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onUkuran);
  document.body.classList.add('overflow-hidden');

  isiTujuan(opsi.tujuanAwal || '');
  perbaruiPratinjau();

  if (sumber) await muatPdf(sumber.buffer, sumber.nama);
}

// force=true dipakai editor saat ia sendiri ditutup.
export function tutupPotongPdf(force = false) {
  if (!st) return true;
  if (st.sibuk && !force) {
    showToast('info', 'Tunggu unggahan selesai');
    return false;
  }
  if (st.tugas) {
    try { st.tugas.cancel(); } catch (err) {}
  }
  if (st.pdf) {
    try { st.pdf.destroy(); } catch (err) {}
  }
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onUkuran);
  const modal = $(MODAL_ID);
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.innerHTML = '';
  }
  st = null;
  // Editor di belakangnya tetap terbuka dan tetap mengunci scroll halaman.
  if (!$('lkpd-editor-modal') || $('lkpd-editor-modal').classList.contains('hidden')) {
    document.body.classList.remove('overflow-hidden');
  }
  return true;
}
