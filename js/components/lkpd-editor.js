// Editor isi LKPD terstruktur (modal layar penuh) untuk guru.
// Kontrak data: lihat Point.md (isi_json versi 1).
// Pratinjau memakai renderer siswa (js/components/lkpd-render.js), mode 'pratinjau'.

import { apiPost } from '../services/api.js';
import { escapeHtml, jsArg, safeUrl } from '../services/html.js';
import { showToast, showConfirm } from './modal.js';
import { buatIdAcak } from '../services/lkpd-parser.js';
import { renderIsiLkpd } from './lkpd-render.js';
import { adaSumberPdf, bukaPotongPdf, potongBanyakDariPdf, tutupPotongPdf } from './pdf-crop.js';

const MAKS_JSON = 45000;
const MAKS = { bagian: 50, blok: 100, kolom: 10, baris: 50, isian: 500, gambar: 20 };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODAL_ID = 'lkpd-editor-modal';

let ed = null; // state editor aktif

/* ---------- util ---------- */

function semuaId(isi) {
  const s = new Set();
  (isi.bagian || []).forEach((b) => {
    s.add(b.id);
    (b.blok || []).forEach((k) => {
      s.add(k.id);
      if (k.tipe === 'tabel') {
        (k.kolom || []).forEach((c) => s.add(c.id));
        (k.baris || []).forEach((r) => s.add(r.id));
      }
    });
  });
  return s;
}

const idBaru = (prefix) => buatIdAcak(prefix, ed.idSet);

function kunciDraf(idLkpd) {
  return 'lkpd_editor_draf_' + (idLkpd || 'baru');
}

function bacaDraf(idLkpd) {
  try { return JSON.parse(localStorage.getItem(kunciDraf(idLkpd)) || 'null'); } catch (e) { return null; }
}
function simpanDraf() {
  if (!ed) return;
  try { localStorage.setItem(kunciDraf(ed.idLkpd), JSON.stringify({ isi: ed.isi, cek: [...ed.cek], waktu: Date.now() })); } catch (e) { /* abaikan */ }
}
function hapusDraf(idLkpd) {
  try { localStorage.removeItem(kunciDraf(idLkpd)); } catch (e) { /* abaikan */ }
}

// buang penanda editor (_cek) sebelum disimpan
function bersihkan(isi) {
  return JSON.parse(JSON.stringify(isi, (k, v) => (k === '_cek' || k === '_pdf' ? undefined : v)));
}

export function isiKosong() {
  return { versi: 1, bagian: [] };
}

export function hitungIsian(isi) {
  let n = 0;
  (isi.bagian || []).forEach((b) => (b.blok || []).forEach((k) => {
    if (k.tipe === 'soal') n++;
    if (k.tipe === 'tabel') (k.baris || []).forEach((r) => Object.values(r.sel || {}).forEach((s) => { if (s && s.jenis === 'isian') n++; }));
  }));
  return n;
}

const urlHttps = (u) => /^https:\/\/[^\s"'<>]+$/i.test(String(u || ''));

/** Validasi sebelum simpan. Kembalikan daftar pesan (kosong = lolos). */
export function validasiEditor(isi) {
  const err = [];
  const bag = isi.bagian || [];
  if (!bag.length) err.push('Minimal satu bagian.');
  if (bag.length > MAKS.bagian) err.push('Maksimal ' + MAKS.bagian + ' bagian.');
  const pakai = new Set();
  const cekId = (id, ctx) => {
    if (!ID_RE.test(String(id || ''))) err.push(ctx + ': ID tidak valid.');
    else if (pakai.has(id)) err.push(ctx + ': ID ganda.');
    pakai.add(id);
  };
  bag.forEach((b, i) => {
    const cb = 'Bagian ' + (i + 1);
    cekId(b.id, cb);
    if (!String(b.judul || '').trim()) err.push(cb + ': judul kosong.');
    if ((b.blok || []).length > MAKS.blok) err.push(cb + ': maksimal ' + MAKS.blok + ' blok.');
    (b.blok || []).forEach((k, j) => {
      const ck = cb + ' blok ' + (j + 1);
      cekId(k.id, ck);
      if (k.tipe === 'teks') {
        if (!String(k.isi || '').trim()) err.push(ck + ' (teks): isi kosong.');
      } else if (k.tipe === 'soal') {
        if (!String(k.label || '').trim()) err.push(ck + ' (soal): label kosong.');
        if (k.gambar && !urlHttps(k.gambar.url)) err.push(ck + ' (soal): gambar belum punya URL https.');
      } else if (k.tipe === 'gambar') {
        if (!k.item || !k.item.length) err.push(ck + ' (gambar): minimal 1 gambar.');
        (k.item || []).forEach((g, n) => {
          if (!urlHttps(g.url)) err.push(ck + ' (gambar) item ' + (n + 1) + ': belum diunggah / URL bukan https.');
        });
      } else if (k.tipe === 'tabel') {
        if (!k.kolom.length || k.kolom.length > MAKS.kolom) err.push(ck + ' (tabel): kolom 1–' + MAKS.kolom + '.');
        if (!k.baris.length || k.baris.length > MAKS.baris) err.push(ck + ' (tabel): baris 1–' + MAKS.baris + '.');
        k.kolom.forEach((c, n) => {
          cekId(c.id, ck + ' kolom ' + (n + 1));
          if (!String(c.judul || '').trim()) err.push(ck + ' (tabel): judul kolom ' + (n + 1) + ' kosong.');
        });
        k.baris.forEach((r, n) => {
          cekId(r.id, ck + ' baris ' + (n + 1));
          Object.keys(r.sel || {}).forEach((kid) => {
            const s = r.sel[kid];
            if (s.jenis === 'gambar' && !urlHttps(s.nilai)) err.push(ck + ' (tabel) baris ' + (n + 1) + ': gambar sel belum punya URL https.');
          });
        });
        let isian = 0;
        k.baris.forEach((r) => Object.values(r.sel || {}).forEach((s) => { if (s.jenis === 'isian') isian++; }));
        if (isian < 1) err.push(ck + ' (tabel): harus ada minimal 1 sel isian.');
      } else {
        err.push(ck + ': tipe tidak dikenal.');
      }
    });
  });
  if (hitungIsian(isi) > MAKS.isian) err.push('Maksimal ' + MAKS.isian + ' isian siswa.');
  const ukuran = JSON.stringify(bersihkan(isi)).length;
  if (ukuran > MAKS_JSON) err.push('Isi terlalu besar (' + ukuran + ' dari ' + MAKS_JSON + ' karakter). Pecah jadi dua LKPD.');
  return err;
}

/* ---------- unggah gambar ---------- */

function kompresGambar(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const maks = 1280;
      const skala = Math.min(1, maks / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * skala));
      c.height = Math.max(1, Math.round(img.height * skala));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('File bukan gambar yang valid.')); };
    img.src = url;
  });
}

function pilihFile() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp';
    inp.onchange = () => resolve(inp.files && inp.files[0] ? inp.files[0] : null);
    inp.click();
  });
}

async function unggahGambar() {
  const file = await pilihFile();
  if (!file) return null;
  try {
    ed.sibuk = true;
    showToast('info', 'Mengunggah gambar...');
    const dataUrl = await kompresGambar(file);
    const res = await apiPost({ action: 'upload_image', base64Data: dataUrl });
    if (!res || !res.success) {
      showToast('error', (res && res.message) || 'Gagal mengunggah gambar');
      return null;
    }
    showToast('success', 'Gambar terunggah');
    return res.url;
  } catch (e) {
    showToast('error', e.message || 'Gagal mengunggah gambar');
    return null;
  } finally {
    ed.sibuk = false;
  }
}

/* ---------- pencarian objek ---------- */

function cariBagian(id) { return ed.isi.bagian.find((b) => b.id === id); }
function cariBlok(id) {
  for (const b of ed.isi.bagian) {
    const i = b.blok.findIndex((k) => k.id === id);
    if (i !== -1) return { bagian: b, blok: b.blok[i], idx: i };
  }
  return null;
}

function geser(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

/* ---------- pabrik blok ---------- */

function blokBaru(tipe) {
  const id = idBaru('b');
  if (tipe === 'teks') return { id, tipe, isi: '' };
  if (tipe === 'soal') return { id, tipe, label: '', gambar: null, baris: 3 };
  if (tipe === 'gambar') return { id, tipe, item: [{ url: '', caption: '' }] };
  const k1 = { id: idBaru('k'), judul: 'Kolom 1' };
  const k2 = { id: idBaru('k'), judul: 'Kolom 2' };
  const mk = () => ({ id: idBaru('r'), sel: { [k1.id]: { jenis: 'teks', nilai: '' }, [k2.id]: { jenis: 'isian', nilai: '' } } });
  return { id, tipe: 'tabel', kolom: [k1, k2], baris: [mk(), mk()] };
}

function ubahJenis(blok, tipeBaru) {
  if (blok.tipe === tipeBaru) return blok;
  const baru = blokBaru(tipeBaru);
  baru.id = blok.id;
  if (blok.tipe === 'teks' && tipeBaru === 'soal') baru.label = blok.isi;
  if (blok.tipe === 'soal' && tipeBaru === 'teks') baru.isi = blok.label;
  if (blok._cek) baru._cek = true;
  return baru;
}

/* ---------- render ---------- */

const cls = {
  inp: 'w-full p-2 rounded-lg border border-slate-300 text-xs',
  btn: 'px-2 py-1 rounded-lg font-bold text-[11px] border bg-white hover:bg-slate-50',
  btnDanger: 'px-2 py-1 rounded-lg font-bold text-[11px] bg-red-100 text-red-700 hover:bg-red-200'
};

const JENIS_BLOK = { teks: '📝 Teks', gambar: '🖼️ Gambar', soal: '❓ Soal (isian)', tabel: '📊 Tabel' };

function optJenis(sel) {
  return Object.keys(JENIS_BLOK).map((t) => `<option value="${t}" ${t === sel ? 'selected' : ''}>${JENIS_BLOK[t]}</option>`).join('');
}

function renderGambarField(label, g, aksiPrefix, boleh = true) {
  // g: {url, caption}; aksiPrefix: string inline untuk pemanggilan (diakhiri argumen)
  const u = safeUrl(g.url);
  return `
    <div class="flex gap-2 items-start">
      ${u ? `<img src="${escapeHtml(u)}" alt="" class="w-20 h-20 object-cover rounded-lg border" loading="lazy">` : `<div class="w-20 h-20 rounded-lg border border-dashed grid place-items-center text-slate-400 text-[10px] text-center">belum ada gambar</div>`}
      <div class="flex-1 space-y-1">
        <div class="flex gap-1">
          <button type="button" class="${cls.btn}" onclick="lkpdEd.${aksiPrefix.up}">⬆ Unggah</button>
          ${aksiPrefix.pot ? `<button type="button" class="${cls.btn}" onclick="lkpdEd.${aksiPrefix.pot}">✂ Potong dari PDF</button>` : ''}
        </div>
        <input class="${cls.inp}" placeholder="URL https (otomatis terisi setelah unggah)" value="${escapeHtml(g.url || '')}" oninput="lkpdEd.${aksiPrefix.url}">
        <input class="${cls.inp}" placeholder="${escapeHtml(label)}" value="${escapeHtml(g.caption || '')}" oninput="lkpdEd.${aksiPrefix.cap}">
      </div>
    </div>`;
}

function renderBlok(b, k, i, n) {
  const idA = jsArg(k.id);
  const flag = k._cek ? `<span class="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold">perlu dicek</span>` : '';
  let isi = '';
  if (k.tipe === 'teks') {
    isi = `<textarea rows="3" class="${cls.inp}" placeholder="Teks bacaan / penjelasan" oninput="lkpdEd.set(${idA},'isi',this.value)">${escapeHtml(k.isi || '')}</textarea>`;
  } else if (k.tipe === 'soal') {
    isi = `
      <textarea rows="2" class="${cls.inp}" placeholder="Pertanyaan / label isian" oninput="lkpdEd.set(${idA},'label',this.value)">${escapeHtml(k.label || '')}</textarea>
      <div class="flex items-center gap-2">
        <label class="font-bold text-slate-600">Tinggi kotak jawaban (baris)</label>
        <input type="number" min="1" max="20" value="${Number(k.baris) || 3}" class="w-16 p-1.5 rounded-lg border text-xs" oninput="lkpdEd.set(${idA},'baris',Math.max(1,Math.min(20,Number(this.value)||3)))">
      </div>
      ${k.gambar
        ? `<div class="p-2 bg-slate-50 rounded-xl border space-y-1">
            ${renderGambarField('Keterangan gambar soal', k.gambar, {
              up: `soalGambarUp(${idA})`, pot: `potong(${jsArg('soal|' + k.id)})`, url: `soalGambar(${idA},'url',this.value)`, cap: `soalGambar(${idA},'caption',this.value)`
            })}
            <button type="button" class="${cls.btnDanger}" onclick="lkpdEd.soalGambarHapus(${idA})">Hapus gambar soal</button>
          </div>`
        : `<button type="button" class="${cls.btn}" onclick="lkpdEd.soalGambarTambah(${idA})">+ Tambah gambar pada soal</button>`}`;
  } else if (k.tipe === 'gambar') {
    isi = k.item.map((g, n2) => `
      <div class="p-2 bg-slate-50 rounded-xl border space-y-1">
        ${renderGambarField('Caption (opsional)', g, {
          up: `itemUp(${idA},${n2})`, pot: `potong(${jsArg('item|' + k.id + '|' + n2)})`, url: `itemSet(${idA},${n2},'url',this.value)`, cap: `itemSet(${idA},${n2},'caption',this.value)`
        })}
        <div class="flex gap-1">
          <button type="button" class="${cls.btn}" onclick="lkpdEd.itemGeser(${idA},${n2},-1)">↑</button>
          <button type="button" class="${cls.btn}" onclick="lkpdEd.itemGeser(${idA},${n2},1)">↓</button>
          <button type="button" class="${cls.btnDanger}" onclick="lkpdEd.itemHapus(${idA},${n2})">Hapus</button>
        </div>
      </div>`).join('') +
      (k.item.length < MAKS.gambar ? `<button type="button" class="${cls.btn}" onclick="lkpdEd.itemTambah(${idA})">+ Tambah gambar</button>` : '');
  } else if (k.tipe === 'tabel') {
    isi = renderTabel(k);
  }

  return `
    <div class="p-3 rounded-2xl border ${k._cek ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200 bg-white'} space-y-2" id="blok-${escapeHtml(k.id)}">
      <div class="flex items-center gap-1.5 flex-wrap">
        <select class="p-1.5 rounded-lg border text-[11px] font-bold" onchange="lkpdEd.jenis(${idA},this.value)">${optJenis(k.tipe)}</select>
        ${flag}
        <span class="flex-1"></span>
        ${k._cek ? `<button type="button" class="${cls.btn}" onclick="lkpdEd.tandaiAman(${idA})">✓ Sudah dicek</button>` : ''}
        <button type="button" class="${cls.btn}" onclick="lkpdEd.blokGeser(${idA},-1)" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="${cls.btn}" onclick="lkpdEd.blokGeser(${idA},1)" ${i === n - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="${cls.btnDanger}" onclick="lkpdEd.blokHapus(${idA})">Hapus</button>
      </div>
      ${isi}
    </div>`;
}

function renderSelInput(k, r, c) {
  const s = r.sel[c.id] || { jenis: 'teks', nilai: '' };
  const a = `${jsArg(k.id)},${jsArg(r.id)},${jsArg(c.id)}`;
  let nilai = '';
  if (s.jenis === 'teks') nilai = `<textarea rows="2" class="${cls.inp}" oninput="lkpdEd.selSet(${a},this.value)">${escapeHtml(s.nilai || '')}</textarea>`;
  else if (s.jenis === 'gambar') {
    const u = safeUrl(s.nilai);
    nilai = `${u ? `<img src="${escapeHtml(u)}" alt="" class="w-16 h-16 object-cover rounded border">` : ''}
      <button type="button" class="${cls.btn}" onclick="lkpdEd.selUp(${a})">⬆ Unggah</button>
      <button type="button" class="${cls.btn}" onclick="lkpdEd.potong(${jsArg('sel|' + k.id + '|' + r.id + '|' + c.id)})">✂ Potong</button>
      <input class="${cls.inp}" placeholder="URL https" value="${escapeHtml(s.nilai || '')}" oninput="lkpdEd.selSet(${a},this.value)">`;
  } else nilai = `<div class="text-[10px] text-slate-500 italic">siswa mengisi di sini</div>`;
  return `
    <td class="p-1.5 align-top border min-w-[130px] space-y-1">
      <select class="w-full p-1 rounded border text-[10px] font-bold" onchange="lkpdEd.selJenis(${a},this.value)">
        <option value="teks" ${s.jenis === 'teks' ? 'selected' : ''}>Teks</option>
        <option value="gambar" ${s.jenis === 'gambar' ? 'selected' : ''}>Gambar</option>
        <option value="isian" ${s.jenis === 'isian' ? 'selected' : ''}>Isian siswa</option>
      </select>
      ${nilai}
    </td>`;
}

function renderTabel(k) {
  const idA = jsArg(k.id);
  return `
    <div class="overflow-x-auto">
      <table class="text-[11px] border-collapse">
        <thead>
          <tr>
            <th class="border p-1 bg-slate-100 w-12">#</th>
            ${k.kolom.map((c, ci) => `
              <th class="border p-1.5 bg-slate-100 min-w-[130px] space-y-1">
                <input class="${cls.inp}" value="${escapeHtml(c.judul || '')}" placeholder="Judul kolom" oninput="lkpdEd.kolomSet(${idA},${jsArg(c.id)},this.value)">
                <div class="flex gap-1 justify-center flex-wrap">
                  <button type="button" class="${cls.btn}" onclick="lkpdEd.kolomGeser(${idA},${ci},-1)">←</button>
                  <button type="button" class="${cls.btn}" onclick="lkpdEd.kolomGeser(${idA},${ci},1)">→</button>
                  <button type="button" class="${cls.btnDanger}" onclick="lkpdEd.kolomHapus(${idA},${jsArg(c.id)})">✕</button>
                </div>
                <button type="button" class="${cls.btn} w-full" onclick="lkpdEd.kolomIsian(${idA},${jsArg(c.id)})">Jadikan kolom ini isian</button>
              </th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${k.baris.map((r, ri) => `
            <tr>
              <td class="border p-1 text-center align-top space-y-1">
                <div class="font-bold">${ri + 1}</div>
                <button type="button" class="${cls.btn}" onclick="lkpdEd.barisGeser(${idA},${ri},-1)">↑</button>
                <button type="button" class="${cls.btn}" onclick="lkpdEd.barisGeser(${idA},${ri},1)">↓</button>
                <button type="button" class="${cls.btnDanger}" onclick="lkpdEd.barisHapus(${idA},${jsArg(r.id)})">✕</button>
              </td>
              ${k.kolom.map((c) => renderSelInput(k, r, c)).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="flex gap-2 flex-wrap">
      ${k.kolom.length < MAKS.kolom ? `<button type="button" class="${cls.btn}" onclick="lkpdEd.kolomTambah(${idA})">+ Kolom</button>` : ''}
      ${k.baris.length < MAKS.baris ? `<button type="button" class="${cls.btn}" onclick="lkpdEd.barisTambah(${idA})">+ Baris</button>` : ''}
    </div>`;
}

function renderBagian(b, i, n) {
  const idA = jsArg(b.id);
  return `
    <section class="bg-white rounded-3xl border shadow-xs p-4 space-y-3">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="px-2 py-0.5 rounded-full bg-brand-blue text-white font-bold text-[10px]">Bagian ${i + 1}</span>
        <span class="flex-1"></span>
        <button type="button" class="${cls.btn}" onclick="lkpdEd.bagianGeser(${idA},-1)" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="${cls.btn}" onclick="lkpdEd.bagianGeser(${idA},1)" ${i === n - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="${cls.btnDanger}" onclick="lkpdEd.bagianHapus(${idA})">Hapus bagian</button>
      </div>
      <input class="${cls.inp} font-black text-sm" placeholder="Judul bagian (mis. Kegiatan 1)" value="${escapeHtml(b.judul || '')}" oninput="lkpdEd.bagianSet(${idA},'judul',this.value)">
      <textarea rows="2" class="${cls.inp}" placeholder="Petunjuk bagian ini (opsional)" oninput="lkpdEd.bagianSet(${idA},'petunjuk',this.value)">${escapeHtml(b.petunjuk || '')}</textarea>
      <div class="space-y-2">
        ${b.blok.map((k, j) => renderBlok(b, k, j, b.blok.length)).join('') || '<p class="text-slate-400 italic">Belum ada blok.</p>'}
      </div>
      <div class="flex items-center gap-2 flex-wrap pt-1">
        <span class="font-bold text-slate-600">Tambah blok:</span>
        ${Object.keys(JENIS_BLOK).map((t) => `<button type="button" class="${cls.btn}" onclick="lkpdEd.blokTambah(${idA},'${t}')">${JENIS_BLOK[t]}</button>`).join('')}
      </div>
    </section>`;
}

/* pratinjau: renderer siswa, kotak jawaban kosong */
function renderPratinjau(isi) {
  return renderIsiLkpd(isi, { mode: 'pratinjau' });
}

function render() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal || !ed) return;
  const jumlahTertunda = gambarTertunda().length;
  const jumlahCek = ed.isi.bagian.reduce((n, b) => n + b.blok.filter((k) => k._cek).length, 0);
  const body = ed.pratinjau
    ? renderPratinjau(ed.isi)
    : ed.isi.bagian.map((b, i) => renderBagian(b, i, ed.isi.bagian.length)).join('') +
      (ed.isi.bagian.length < MAKS.bagian ? `<button type="button" class="${cls.btn} w-full py-3" onclick="lkpdEd.bagianTambah()">+ Tambah bagian</button>` : '');
  const scroll = modal.querySelector('#lkpd-ed-body');
  const sy = scroll ? scroll.scrollTop : 0;

  modal.innerHTML = `
    <div class="bg-slate-100 w-full h-full flex flex-col text-xs">
      <div class="lkpd-ed-head flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 bg-white border-b flex-wrap">
        <h2 class="font-black text-brand-navy text-sm flex-1 min-w-[140px] truncate">Editor Isi LKPD — ${escapeHtml(ed.judul || 'Tanpa judul')}</h2>
        ${jumlahCek ? `<span class="px-2 py-1 rounded-full bg-amber-100 text-amber-800 font-bold">${jumlahCek} blok perlu dicek</span>` : ''}
        <span class="text-slate-500">${hitungIsian(ed.isi)} isian · ${JSON.stringify(bersihkan(ed.isi)).length}/${MAKS_JSON} karakter</span>
        ${jumlahTertunda ? `<button type="button" class="${cls.btn} bg-amber-50 border-amber-300 text-amber-800" onclick="lkpdEd.potongOtomatis()">🪄 Potong ${jumlahTertunda} gambar otomatis</button>` : ''}
        <button type="button" class="${cls.btn}" onclick="lkpdEd.potong('')">✂ Potong dari PDF</button>
        <button type="button" class="${cls.btn}" onclick="lkpdEd.togglePratinjau()">${ed.pratinjau ? '✏️ Kembali edit' : '👁️ Pratinjau'}</button>
        <button type="button" class="${cls.btn}" onclick="lkpdEd.tutup()">Tutup</button>
        <button type="button" id="lkpd-ed-simpan" class="px-4 py-1.5 rounded-lg bg-brand-blue text-white font-black" onclick="lkpdEd.simpan()">💾 Simpan</button>
      </div>
      <div id="lkpd-ed-body" class="flex-1 overflow-y-auto p-2.5 sm:p-4 pb-20 space-y-3 max-w-3xl w-full mx-auto">${body}</div>
    </div>`;
  const nb = modal.querySelector('#lkpd-ed-body');
  if (nb) nb.scrollTop = sy;
}

/* ---------- aksi (dipanggil dari HTML inline lewat window.lkpdEd) ---------- */

function ubah(fn, { render: r = true } = {}) {
  fn();
  simpanDraf();
  if (r) render();
}

/* ---------- tempat gambar untuk alat Potong dari PDF ---------- */
// Kunci tujuan: soal|idBlok, item|idBlok|n, sel|idBlok|idBaris|idKolom (ID tanpa karakter "|").

function daftarSlotGambar() {
  const hasil = [];
  ed.isi.bagian.forEach((b, bi) => {
    const nb = b.judul || 'Bagian ' + (bi + 1);
    b.blok.forEach((k, ki) => {
      if (k.tipe === 'soal') {
        hasil.push({ kunci: 'soal|' + k.id, label: nb + ' › Soal: ' + (k.label || '(tanpa label)').slice(0, 50), terisi: Boolean(k.gambar && k.gambar.url) });
      } else if (k.tipe === 'gambar') {
        k.item.forEach((g, n) => {
          hasil.push({ kunci: 'item|' + k.id + '|' + n, label: nb + ' › Blok ' + (ki + 1) + ', gambar ' + (n + 1), terisi: Boolean(g.url) });
        });
      } else if (k.tipe === 'tabel') {
        k.baris.forEach((r, ri) => k.kolom.forEach((c) => {
          const s = r.sel[c.id];
          if (s && s.jenis === 'gambar') {
            hasil.push({ kunci: 'sel|' + k.id + '|' + r.id + '|' + c.id, label: nb + ' › Tabel baris ' + (ri + 1) + ', kolom ' + (c.judul || '?'), terisi: Boolean(s.nilai) });
          }
        }));
      }
    });
  });
  return hasil;
}

function isiSlotGambar(kunci, url) {
  if (!ed) return false;
  const [tipe, idBlok, a, b] = String(kunci).split('|');
  const x = cariBlok(idBlok);
  if (!x) return false;
  if (tipe === 'soal' && x.blok.tipe === 'soal') {
    ubah(() => { x.blok.gambar = { url, caption: (x.blok.gambar && x.blok.gambar.caption) || '' }; });
    return true;
  }
  if (tipe === 'item' && x.blok.tipe === 'gambar' && x.blok.item[Number(a)]) {
    ubah(() => { x.blok.item[Number(a)].url = url; });
    return true;
  }
  if (tipe === 'sel' && x.blok.tipe === 'tabel') {
    const r = x.blok.baris.find((q) => q.id === a);
    if (r && r.sel[b] && r.sel[b].jenis === 'gambar') {
      ubah(() => { r.sel[b].nilai = url; });
      return true;
    }
  }
  return false;
}

/* ---------- potong gambar otomatis dari PDF hasil impor ---------- */
// Parser mencatat letak tiap gambar di `_pdf` ({hal,x0,t0,x1,t1}). Di sini wilayah itu
// dipotong dari PDF sumber, diunggah, lalu URL-nya dipasang di tempat gambar.

function gambarTertunda() {
  const hasil = [];
  const catat = (kunci, obj, url) => {
    if (obj && obj._pdf && !url) hasil.push({ kunci, ...obj._pdf });
  };
  ed.isi.bagian.forEach((b) => b.blok.forEach((k) => {
    if (k.tipe === 'soal' && k.gambar) catat('soal|' + k.id, k.gambar, k.gambar.url);
    else if (k.tipe === 'gambar') k.item.forEach((g, n) => catat('item|' + k.id + '|' + n, g, g.url));
    else if (k.tipe === 'tabel') {
      k.baris.forEach((r) => k.kolom.forEach((c) => {
        const sl = r.sel[c.id];
        if (sl && sl.jenis === 'gambar') catat('sel|' + k.id + '|' + r.id + '|' + c.id, sl, sl.nilai);
      }));
    }
  }));
  return hasil;
}

function pasangUrl(kunci, url) {
  const [tipe, idBlok, a, b] = String(kunci).split('|');
  const x = cariBlok(idBlok);
  if (!x) return;
  if (tipe === 'soal' && x.blok.gambar) x.blok.gambar.url = url;
  else if (tipe === 'item' && x.blok.item[Number(a)]) x.blok.item[Number(a)].url = url;
  else if (tipe === 'sel') {
    const r = x.blok.baris.find((q) => q.id === a);
    if (r && r.sel[b]) r.sel[b].nilai = url;
  }
}

async function jalankanPotongOtomatis() {
  const daftar = gambarTertunda();
  if (!daftar.length) return { ok: true, sisa: 0 };
  if (!adaSumberPdf()) return { ok: false, sisa: daftar.length, alasan: 'sumber' };
  ed.sibuk = true;
  try {
    showToast('info', 'Memotong ' + daftar.length + ' gambar dari PDF...');
    const potongan = await potongBanyakDariPdf(daftar);
    if (!potongan) return { ok: false, sisa: daftar.length, alasan: 'sumber' };

    let selesai = 0;
    let gagal = 0;
    const antre = [...potongan];
    const pekerja = async () => {
      while (antre.length) {
        const p = antre.shift();
        try {
          const res = await apiPost({ action: 'upload_image', base64Data: p.dataUrl, fileName: 'potongan.jpg' });
          if (res && res.success && res.url) {
            pasangUrl(p.kunci, res.url);
            selesai++;
          } else gagal++;
        } catch (err) {
          gagal++;
        }
      }
    };
    await Promise.all([pekerja(), pekerja(), pekerja()]);
    gagal += daftar.length - potongan.length;
    simpanDraf();
    render();
    showToast(gagal ? 'warning' : 'success', gagal
      ? selesai + ' gambar terpasang, ' + gagal + ' gagal. Tekan "Potong gambar otomatis" lagi untuk mengulang.'
      : selesai + ' gambar terpasang otomatis');
    return { ok: gagal === 0, sisa: gagal };
  } finally {
    ed.sibuk = false;
  }
}

const api = {
  async potongOtomatis() {
    if (!ed || ed.sibuk) return;
    const r = await jalankanPotongOtomatis();
    if (!r.ok && r.alasan === 'sumber') {
      showToast('error', 'PDF sumber belum dipilih. Buka "Potong dari PDF" dan pilih file PDF, lalu coba lagi.');
    }
  },
  set(id, f, v) { const x = cariBlok(id); if (x) { x.blok[f] = v; simpanDraf(); } },
  bagianSet(id, f, v) { const b = cariBagian(id); if (b) { b[f] = v; simpanDraf(); } },
  bagianTambah() {
    ubah(() => ed.isi.bagian.push({ id: idBaru('s'), judul: '', petunjuk: '', blok: [] }));
  },
  bagianGeser(id, d) { ubah(() => geser(ed.isi.bagian, ed.isi.bagian.findIndex((b) => b.id === id), d)); },
  bagianHapus(id) {
    showConfirm('Hapus bagian?', 'Semua blok di bagian ini ikut terhapus.', () => ubah(() => {
      ed.isi.bagian = ed.isi.bagian.filter((b) => b.id !== id);
    }), 'Ya, hapus');
  },
  blokTambah(idBagian, tipe) {
    const b = cariBagian(idBagian);
    if (!b) return;
    if (b.blok.length >= MAKS.blok) { showToast('error', 'Maksimal ' + MAKS.blok + ' blok per bagian'); return; }
    ubah(() => b.blok.push(blokBaru(tipe)));
  },
  blokGeser(id, d) { const x = cariBlok(id); if (x) ubah(() => geser(x.bagian.blok, x.idx, d)); },
  blokHapus(id) { const x = cariBlok(id); if (x) ubah(() => x.bagian.blok.splice(x.idx, 1)); },
  jenis(id, tipe) {
    const x = cariBlok(id);
    if (!x || x.blok.tipe === tipe) return;
    const adaIsi = JSON.stringify(x.blok).length > 120;
    const lakukan = () => ubah(() => { x.bagian.blok[x.idx] = ubahJenis(x.blok, tipe); });
    if (adaIsi && (['gambar', 'tabel'].includes(tipe) || ['gambar', 'tabel'].includes(x.blok.tipe))) {
      showConfirm('Ubah jenis blok?', 'Isi blok lama yang tidak cocok akan hilang.', lakukan, 'Ya, ubah');
      render();
    } else lakukan();
  },
  tandaiAman(id) { const x = cariBlok(id); if (x) ubah(() => { delete x.blok._cek; ed.cek.delete(id); }); },

  soalGambarTambah(id) { const x = cariBlok(id); if (x) ubah(() => { x.blok.gambar = { url: '', caption: '' }; }); },
  soalGambarHapus(id) { const x = cariBlok(id); if (x) ubah(() => { x.blok.gambar = null; }); },
  soalGambar(id, f, v) { const x = cariBlok(id); if (x && x.blok.gambar) { x.blok.gambar[f] = v; simpanDraf(); } },
  async soalGambarUp(id) {
    const url = await unggahGambar();
    const x = cariBlok(id);
    if (url && x && x.blok.gambar) ubah(() => { x.blok.gambar.url = url; });
  },

  itemSet(id, n, f, v) { const x = cariBlok(id); if (x && x.blok.item[n]) { x.blok.item[n][f] = v; simpanDraf(); } },
  async itemUp(id, n) {
    const url = await unggahGambar();
    const x = cariBlok(id);
    if (url && x && x.blok.item[n]) ubah(() => { x.blok.item[n].url = url; });
  },
  itemTambah(id) { const x = cariBlok(id); if (x && x.blok.item.length < MAKS.gambar) ubah(() => x.blok.item.push({ url: '', caption: '' })); },
  itemHapus(id, n) {
    const x = cariBlok(id);
    if (!x) return;
    if (x.blok.item.length <= 1) { showToast('error', 'Minimal 1 gambar. Hapus blok bila tidak dipakai.'); return; }
    ubah(() => x.blok.item.splice(n, 1));
  },
  itemGeser(id, n, d) { const x = cariBlok(id); if (x) ubah(() => geser(x.blok.item, n, d)); },

  kolomSet(id, kid, v) { const x = cariBlok(id); const c = x && x.blok.kolom.find((q) => q.id === kid); if (c) { c.judul = v; simpanDraf(); } },
  kolomTambah(id) {
    const x = cariBlok(id);
    if (!x || x.blok.kolom.length >= MAKS.kolom) return;
    ubah(() => {
      const c = { id: idBaru('k'), judul: 'Kolom ' + (x.blok.kolom.length + 1) };
      x.blok.kolom.push(c);
      x.blok.baris.forEach((r) => { r.sel[c.id] = { jenis: 'teks', nilai: '' }; });
    });
  },
  kolomGeser(id, i, d) { const x = cariBlok(id); if (x) ubah(() => geser(x.blok.kolom, i, d)); },
  kolomHapus(id, kid) {
    const x = cariBlok(id);
    if (!x) return;
    if (x.blok.kolom.length <= 1) { showToast('error', 'Minimal 1 kolom'); return; }
    ubah(() => {
      x.blok.kolom = x.blok.kolom.filter((c) => c.id !== kid);
      x.blok.baris.forEach((r) => { delete r.sel[kid]; });
    });
  },
  kolomIsian(id, kid) { const x = cariBlok(id); if (x) ubah(() => x.blok.baris.forEach((r) => { r.sel[kid] = { jenis: 'isian', nilai: '' }; })); },
  barisTambah(id) {
    const x = cariBlok(id);
    if (!x || x.blok.baris.length >= MAKS.baris) return;
    ubah(() => {
      const sel = {};
      x.blok.kolom.forEach((c) => { sel[c.id] = { jenis: 'isian', nilai: '' }; });
      x.blok.baris.push({ id: idBaru('r'), sel });
    });
  },
  barisGeser(id, i, d) { const x = cariBlok(id); if (x) ubah(() => geser(x.blok.baris, i, d)); },
  barisHapus(id, rid) {
    const x = cariBlok(id);
    if (!x) return;
    if (x.blok.baris.length <= 1) { showToast('error', 'Minimal 1 baris'); return; }
    ubah(() => { x.blok.baris = x.blok.baris.filter((r) => r.id !== rid); });
  },
  selSet(id, rid, kid, v) {
    const x = cariBlok(id);
    const r = x && x.blok.baris.find((q) => q.id === rid);
    if (r && r.sel[kid]) { r.sel[kid].nilai = v; simpanDraf(); }
  },
  selJenis(id, rid, kid, jenis) {
    const x = cariBlok(id);
    const r = x && x.blok.baris.find((q) => q.id === rid);
    if (r) ubah(() => { r.sel[kid] = { jenis, nilai: '' }; });
  },
  async selUp(id, rid, kid) {
    const url = await unggahGambar();
    const x = cariBlok(id);
    const r = x && x.blok.baris.find((q) => q.id === rid);
    if (url && r && r.sel[kid]) ubah(() => { r.sel[kid].nilai = url; });
  },

  togglePratinjau() { ed.pratinjau = !ed.pratinjau; render(); },

  potong(kunci) {
    if (!ed) return;
    bukaPotongPdf({ ambilTujuan: daftarSlotGambar, terapkan: isiSlotGambar, tujuanAwal: kunci || '' });
  },

  tutup() {
    if (ed && ed.sibuk) { showToast('info', 'Tunggu unggahan selesai'); return; }
    if (!tutupPotongPdf()) return;
    const modal = document.getElementById(MODAL_ID);
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); modal.innerHTML = ''; }
    document.body.classList.remove('overflow-hidden');
    ed = null;
  },

  async simpan() {
    if (!ed || ed.sibuk) return;
    if (gambarTertunda().length && adaSumberPdf()) await jalankanPotongOtomatis();
    if (!ed) return;
    const galat = validasiEditor(ed.isi);
    if (galat.length) {
      const html = '<ul style="text-align:left;font-size:12px;max-height:50vh;overflow:auto;padding-left:18px;list-style:disc">' +
        galat.slice(0, 30).map((g) => `<li>${escapeHtml(g)}</li>`).join('') + (galat.length > 30 ? `<li>…dan ${galat.length - 30} lagi</li>` : '') + '</ul>';
      Swal.fire({ icon: 'warning', title: 'Perbaiki dulu sebelum simpan', html });
      return;
    }
    const btn = document.getElementById('lkpd-ed-simpan');
    if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }
    const bersih = bersihkan(ed.isi);
    try {
      const ok = await ed.onSimpan(bersih);
      if (ok === false) return;
      hapusDraf(ed.idLkpd);
      api.tutup();
    } finally {
      const b2 = document.getElementById('lkpd-ed-simpan');
      if (b2) { b2.disabled = false; b2.textContent = '💾 Simpan'; }
    }
  }
};

/**
 * Buka editor.
 * opsi: { idLkpd, judul, isi (objek|string|null), onSimpan: async (isiBersih)=>boolean, tandaiSemuaCek:boolean }
 */
export function bukaEditorLkpd(opsi) {
  let isi = opsi.isi;
  if (typeof isi === 'string') {
    try { isi = JSON.parse(isi); } catch (e) { isi = null; }
  }
  if (!isi || typeof isi !== 'object' || !Array.isArray(isi.bagian)) isi = isiKosong();
  isi = JSON.parse(JSON.stringify(isi));

  ed = {
    idLkpd: opsi.idLkpd || '',
    judul: opsi.judul || '',
    isi,
    onSimpan: opsi.onSimpan,
    pratinjau: false,
    sibuk: false,
    idSet: new Set(),
    cek: new Set()
  };
  ed.idSet = semuaId(ed.isi);

  // tawarkan pulihkan draf lokal (hanya bila bukan impor baru)
  const draf = opsi.abaikanDraf ? null : bacaDraf(ed.idLkpd);

  let modal = document.getElementById(MODAL_ID);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.className = 'fixed inset-0 z-[60] hidden';
    document.body.appendChild(modal);
  }
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.body.classList.add('overflow-hidden');
  render();

  if (opsi.potongOtomatis) setTimeout(() => { if (ed) api.potongOtomatis(); }, 300);

  if (draf && draf.isi && Array.isArray(draf.isi.bagian) && JSON.stringify(draf.isi) !== JSON.stringify(ed.isi)) {
    Swal.fire({
      icon: 'question',
      title: 'Ada draf yang belum disimpan',
      text: 'Draf tersimpan di perangkat ini dari penyuntingan sebelumnya. Pulihkan?',
      showCancelButton: true,
      confirmButtonText: 'Pulihkan draf',
      cancelButtonText: 'Pakai versi tersimpan'
    }).then((r) => {
      if (!ed) return;
      if (r.isConfirmed) {
        ed.isi = draf.isi;
        ed.idSet = semuaId(ed.isi);
      } else {
        hapusDraf(ed.idLkpd);
      }
      render();
    });
  }
}

window.lkpdEd = api;
