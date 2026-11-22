// Renderer isi LKPD terstruktur (isi_json versi 1).
// Dipakai tiga tempat: form siswa (js/views/lkpd.js), koreksi guru (js/views/guru.js),
// dan pratinjau editor (js/components/lkpd-editor.js).
// Kontrak data: lihat Point.md bagian 4.
//
// Mode render:
//   'isi'       siswa mengetik jawaban (textarea, maxlength 1000)
//   'baca'      menampilkan jawaban yang sudah ada (teks biasa)
//   'pratinjau' kotak jawaban kosong (editor guru, mode tamu non-siswa)

import { escapeHtml as e, safeUrl } from '../services/html.js';

export const MAKS_JAWABAN = 1000;
export const MAKS_JSON = 45000;

export function parseIsiLkpd(raw) {
  let isi = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try {
      isi = JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }
  if (!isi || typeof isi !== 'object' || !Array.isArray(isi.bagian)) return null;
  return isi;
}

export const kunciSel = (idTabel, idBaris, idKolom) => `${idTabel}:${idBaris}:${idKolom}`;

function urlGambarBaris(baris) {
  const sel = (baris && baris.sel) || {};
  const id = Object.keys(sel).find((k) => sel[k] && sel[k].jenis === 'gambar' && safeUrl(sel[k].nilai));
  return id ? sel[id].nilai : '';
}

// Daftar semua kolom isian sesuai urutan dokumen.
// Tiap entri: { kunci, idBagian, bagian, label, gambar }
export function daftarIsian(isi) {
  const hasil = [];
  ((isi && isi.bagian) || []).forEach((b, bi) => {
    const namaBagian = b.judul || `Bagian ${bi + 1}`;
    (b.blok || []).forEach((k) => {
      if (k.tipe === 'soal') {
        hasil.push({
          kunci: String(k.id),
          idBagian: b.id,
          bagian: namaBagian,
          label: k.label || '(tanpa label)',
          gambar: k.gambar && safeUrl(k.gambar.url) ? k.gambar.url : ''
        });
      } else if (k.tipe === 'tabel') {
        const kolom = Array.isArray(k.kolom) ? k.kolom : [];
        (Array.isArray(k.baris) ? k.baris : []).forEach((r, ri) => {
          kolom.forEach((c) => {
            const s = (r.sel || {})[c.id];
            if (s && s.jenis === 'isian') {
              hasil.push({
                kunci: kunciSel(k.id, r.id, c.id),
                idBagian: b.id,
                bagian: namaBagian,
                label: `Baris ${ri + 1}, kolom ${c.judul || '?'}`,
                gambar: urlGambarBaris(r)
              });
            }
          });
        });
      }
    });
  });
  return hasil;
}

/* ---------- potongan HTML ---------- */

function gambarHtml(url, kelas, alt = '') {
  const u = safeUrl(url);
  if (!u) return '';
  return `<img src="${e(u)}" alt="${e(alt)}" loading="lazy" onclick="lkpdPerbesar(this.src)" onerror="this.onerror=null;this.alt='Gambar tidak dapat dimuat'" class="${kelas} cursor-zoom-in bg-white">`;
}

function kotakGambarKosong(kelas = 'h-24') {
  return `<div class="${kelas} border border-dashed rounded-lg grid place-items-center text-slate-400 text-[10px]">gambar</div>`;
}

function kotakIsian(mode, kunci, label, jawaban, baris) {
  const nilai = jawaban && jawaban[kunci] !== undefined && jawaban[kunci] !== null ? String(jawaban[kunci]) : '';
  if (mode === 'isi') {
    return `<textarea data-lkpd-kunci="${e(kunci)}" aria-label="${e(label)}" maxlength="${MAKS_JAWABAN}" rows="${baris}" placeholder="Tuliskan jawabanmu..." class="w-full p-3 rounded-xl border bg-white text-xs leading-relaxed">${e(nilai)}</textarea>`;
  }
  if (mode === 'baca') {
    return `<div class="w-full p-3 rounded-xl border bg-slate-50 text-xs leading-relaxed whitespace-pre-wrap break-words min-h-[2.5rem]">${nilai.trim() ? e(nilai) : '<i class="text-slate-400">(Tidak diisi)</i>'}</div>`;
  }
  return `<div class="border rounded-lg bg-slate-50" style="min-height:${baris * 1.6}rem"></div>`;
}

function blokSoal(k, mode, jawaban) {
  const baris = Math.min(12, Math.max(1, Number(k.baris) || 3));
  const gambar = k.gambar && safeUrl(k.gambar.url)
    ? `<figure class="space-y-1">${gambarHtml(k.gambar.url, 'max-w-full sm:max-w-xs rounded-xl border', k.gambar.caption || '')}${k.gambar.caption ? `<figcaption class="text-[10px] text-slate-500">${e(k.gambar.caption)}</figcaption>` : ''}</figure>`
    : '';
  return `
    <div class="space-y-2 p-3 rounded-2xl bg-slate-50 border">
      <p class="font-bold text-slate-800 whitespace-pre-line">${e(k.label)}</p>
      ${gambar}
      ${kotakIsian(mode, String(k.id), k.label, jawaban, baris)}
    </div>`;
}

function blokGambar(k) {
  const item = Array.isArray(k.item) ? k.item : [];
  return `<div class="flex flex-wrap gap-3">${item
    .map((g) => `
      <figure class="w-40 space-y-1">
        ${safeUrl(g.url) ? gambarHtml(g.url, 'w-full rounded-xl border', g.caption || '') : kotakGambarKosong()}
        ${g.caption ? `<figcaption class="text-[10px] text-slate-500">${e(g.caption)}</figcaption>` : ''}
      </figure>`)
    .join('')}</div>`;
}

function selTabel(k, r, c, ri, mode, jawaban) {
  const s = (r.sel || {})[c.id] || {};
  if (s.jenis === 'gambar') {
    return `<td data-jenis="gambar" data-label="${e(c.judul || '')}" class="border p-1.5 align-top">${safeUrl(s.nilai) ? gambarHtml(s.nilai, 'w-20 h-20 sm:w-20 sm:h-20 object-cover rounded-lg border') : ''}</td>`;
  }
  if (s.jenis === 'isian') {
    const label = `Baris ${ri + 1}, kolom ${c.judul || '?'}`;
    return `<td data-jenis="isian" data-label="${e(c.judul || '')}" class="border p-1.5 align-top min-w-[9rem]">${kotakIsian(mode, kunciSel(k.id, r.id, c.id), label, jawaban, 2)}</td>`;
  }
  return `<td data-jenis="teks" data-label="${e(c.judul || '')}" class="border p-1.5 align-top whitespace-pre-line">${e(s.nilai || '')}</td>`;
}

function blokTabel(k, mode, jawaban) {
  const kolom = Array.isArray(k.kolom) ? k.kolom : [];
  const baris = Array.isArray(k.baris) ? k.baris : [];
  return `
    <div class="lkpd-tabel-wrap overflow-x-auto rounded-xl border">
      <table class="lkpd-tabel w-full border-collapse text-[11px]">
        <thead><tr>${kolom.map((c) => `<th class="border p-1.5 bg-slate-100 text-left">${e(c.judul)}</th>`).join('')}</tr></thead>
        <tbody>${baris.map((r, ri) => `<tr>${kolom.map((c) => selTabel(k, r, c, ri, mode, jawaban)).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function blokHtml(k, mode, jawaban) {
  if (k.tipe === 'teks') return `<p class="whitespace-pre-line leading-relaxed text-slate-700">${e(k.isi)}</p>`;
  if (k.tipe === 'gambar') return blokGambar(k);
  if (k.tipe === 'soal') return blokSoal(k, mode, jawaban);
  if (k.tipe === 'tabel') return blokTabel(k, mode, jawaban);
  return '';
}

export function renderIsiLkpd(isi, { mode = 'pratinjau', jawaban = {} } = {}) {
  return ((isi && isi.bagian) || [])
    .map((b, bi) => `
      <section class="bg-white rounded-3xl border shadow-sm p-4 space-y-3">
        <h3 class="font-black text-brand-navy text-sm font-heading">${e(b.judul || `Bagian ${bi + 1}`)}</h3>
        ${b.petunjuk ? `<p class="text-slate-600 italic leading-relaxed whitespace-pre-line">${e(b.petunjuk)}</p>` : ''}
        ${(b.blok || []).map((k) => blokHtml(k, mode, jawaban)).join('')}
      </section>`)
    .join('');
}

/* ---------- perbesar gambar ---------- */

export function perbesarGambar(src) {
  const u = safeUrl(src);
  if (!u) return;
  const lama = document.getElementById('lkpd-zoom');
  if (lama) lama.remove();

  const ov = document.createElement('div');
  ov.id = 'lkpd-zoom';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-label', 'Gambar diperbesar');
  ov.className = 'fixed inset-0 z-[70] bg-slate-950/90 flex items-center justify-center p-3 cursor-zoom-out';

  const img = document.createElement('img');
  img.src = u;
  img.alt = '';
  img.className = 'max-w-full max-h-full object-contain rounded-lg bg-white';
  ov.appendChild(img);

  const onKey = (ev) => {
    if (ev.key === 'Escape') tutup();
  };
  function tutup() {
    ov.remove();
    document.removeEventListener('keydown', onKey);
  }
  ov.addEventListener('click', tutup);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
}

window.lkpdPerbesar = perbesarGambar;
