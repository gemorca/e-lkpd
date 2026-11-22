import { setButtonLoading, showConfirm, showToast, toastSubmitResult } from '../components/modal.js';
import { MAKS_JAWABAN, MAKS_JSON, daftarIsian, parseIsiLkpd, renderIsiLkpd } from '../components/lkpd-render.js';
import { CACHE_KEY } from '../config.js';
import { apiPost, fetchAllInitialData } from '../services/api.js';
import { escapeHtml as e, jsArg } from '../services/html.js';
import { countOutbox } from '../services/idb.js';
import { isPublish, sama } from '../services/match.js';
import { hapusKirimLkpd, keadaanLkpd, markSelesai, simpanKirimLkpd } from '../services/progress.js';
import { state } from '../state.js';

// Penanda kirim yang tidak punya submisi di server dianggap basi setelah waktu ini
// (dan antrean kirim kosong), misalnya karena guru menghapus submisinya.
const UMUR_PENANDA_BASI_MS = 10 * 60 * 1000;

let timerDraft = null;

export function getYoutubeEmbedUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/
  ];
  for (const re of patterns) {
    const match = trimmed.match(re);
    if (match && match[1]) return `https://www.youtube.com/embed/${match[1]}`;
  }
  return '';
}

/* ---------- draf lokal ---------- */

const namaPengguna = () => (state.currentUser ? state.currentUser.username : 'guest');
const kunciDraft = (idLkpd) => `${CACHE_KEY}_DRAFT_LKPD_${idLkpd}_${namaPengguna()}`;

function bacaDraft(idLkpd) {
  try {
    const d = JSON.parse(localStorage.getItem(kunciDraft(idLkpd)) || 'null');
    return d && d.jawaban && typeof d.jawaban === 'object' && !Array.isArray(d.jawaban) ? d.jawaban : null;
  } catch (err) {
    return null;
  }
}

function tulisDraft(idLkpd, jawaban) {
  try {
    if (Object.keys(jawaban).length === 0) {
      localStorage.removeItem(kunciDraft(idLkpd));
    } else {
      localStorage.setItem(kunciDraft(idLkpd), JSON.stringify({ jawaban, timestamp: new Date().toISOString() }));
    }
  } catch (err) {
    console.warn('Gagal menyimpan draf LKPD:', err);
  }
}

function hapusDraft(idLkpd) {
  try {
    localStorage.removeItem(kunciDraft(idLkpd));
  } catch (err) {}
}

/* ---------- data ---------- */

function ambilLkpd(ptmId) {
  return (state.cachedData.lkpd || []).find((l) => sama(l.id_pertemuan, ptmId) && isPublish(l.status));
}

// Jawaban dari server berbentuk objek datar. Format lama (larik) diubah menjadi pasangan.
function parseJawaban(raw) {
  let v = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch (err) {
      return raw.trim() ? { 'Jawaban': raw } : {};
    }
  }
  if (Array.isArray(v)) {
    const out = {};
    v.forEach((x, i) => {
      out[`Pertanyaan ${i + 1}`] = x;
    });
    return out;
  }
  return v && typeof v === 'object' ? v : {};
}

function kumpulJawaban(root) {
  const out = {};
  root.querySelectorAll('textarea[data-lkpd-kunci]').forEach((t) => {
    if (t.value.trim() !== '') out[t.dataset.lkpdKunci] = t.value.slice(0, MAKS_JAWABAN);
  });
  return out;
}

function formatWaktu(ts) {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('id-ID');
}

/* ---------- tampilan ---------- */

function kartuJudul(lkpdObj) {
  const videoEmbedUrl = getYoutubeEmbedUrl(lkpdObj.video_url || '');
  return `
    <div class="bg-white p-5 rounded-3xl border shadow-sm space-y-3">
      <div class="flex items-center justify-between gap-2 border-b pb-2">
        <h3 class="font-black text-brand-navy text-sm font-heading">${e(lkpdObj.judul_lkpd)}</h3>
        <span class="text-[10px] bg-purple-50 text-purple-700 border border-purple-200 px-2.5 py-0.5 rounded-full font-bold shrink-0">Lembar Kerja</span>
      </div>
      ${lkpdObj.instruksi ? `<p class="text-slate-600 font-medium leading-relaxed whitespace-pre-line">${e(lkpdObj.instruksi)}</p>` : ''}
    </div>
    ${videoEmbedUrl
      ? `
    <div class="bg-white p-5 rounded-3xl border shadow-sm space-y-2">
      <h4 class="font-black text-brand-navy border-b pb-2">🎬 Video Bahan Ajar</h4>
      <div class="rounded-2xl overflow-hidden border bg-black aspect-video">
        <iframe src="${videoEmbedUrl}" class="w-full h-full border-0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
      </div>
    </div>`
      : ''}`;
}

function kartuIdentitas() {
  const u = state.currentUser;
  if (!u) {
    return `
    <div class="bg-amber-50 border border-amber-200 p-4 rounded-3xl text-amber-800 font-medium">
      Kamu sedang dalam Mode Tamu. Kamu bisa membaca dan mengisi, tetapi harus login sebagai siswa untuk mengirim jawaban.
    </div>`;
  }
  return `
    <div class="bg-white p-4 rounded-3xl border shadow-sm grid grid-cols-2 gap-3">
      <div><span class="block text-[10px] font-bold text-slate-400 uppercase">Nama</span><span class="font-bold text-slate-800 break-words">${e(u.name || u.username)}</span></div>
      <div><span class="block text-[10px] font-bold text-slate-400 uppercase">Kelas</span><span class="font-bold text-slate-800">${e(u.kelas || '-')}</span></div>
    </div>`;
}

// Jawaban yang kuncinya tidak ada di isi LKPD (format lama atau blok yang sudah dihapus guru).
function jawabanLain(isi, jawaban) {
  const dikenal = new Set(daftarIsian(isi).map((d) => d.kunci));
  const sisa = Object.keys(jawaban).filter((k) => !dikenal.has(k) && String(jawaban[k] ?? '').trim() !== '');
  if (!sisa.length) return '';
  return `
    <section class="bg-white rounded-3xl border shadow-sm p-4 space-y-2">
      <h3 class="font-black text-brand-navy text-sm font-heading">Jawaban lain</h3>
      ${sisa.map((k) => `
        <div class="p-3 rounded-xl bg-slate-50 border space-y-1">
          <span class="block text-[10px] font-bold text-slate-500 break-all">${e(k)}</span>
          <span class="block whitespace-pre-wrap break-words">${e(String(jawaban[k]))}</span>
        </div>`).join('')}
    </section>`;
}

function bannerStatus(ctx) {
  if (ctx.staf) {
    return `<div class="bg-slate-100 border p-4 rounded-3xl text-slate-600 font-medium">Pratinjau tampilan siswa. Guru dan admin tidak bisa mengirim jawaban.</div>`;
  }
  if (ctx.mode === 'baca') {
    const waktu = formatWaktu(ctx.waktu);
    const menunggu = !ctx.sub;
    const nilai = ctx.sub && ctx.sub.nilai_esai !== '' && ctx.sub.nilai_esai !== null && ctx.sub.nilai_esai !== undefined ? ctx.sub.nilai_esai : null;
    return `
    <div class="bg-emerald-50 border border-emerald-200 p-4 rounded-3xl space-y-1">
      <div class="font-black text-emerald-800">✅ Jawaban sudah terkirim${waktu ? ` pada ${e(waktu)}` : ''}</div>
      <p class="text-emerald-700 font-medium">${menunggu ? 'Jawaban tersimpan di perangkat dan sedang menunggu terkirim ke server. Jawaban tidak bisa diubah.' : 'Jawaban tidak bisa diubah. Jika ada yang salah, minta guru membuka kembali LKPD ini.'}</p>
      ${nilai !== null ? `<p class="font-bold text-emerald-900">Nilai dari guru: ${e(nilai)}${ctx.sub.catatan_guru ? ` · ${e(ctx.sub.catatan_guru)}` : ''}</p>` : ''}
    </div>`;
  }
  if (ctx.dibuka) {
    return `
    <div role="status" class="bg-amber-50 border border-amber-300 border-l-8 border-l-amber-500 p-4 rounded-3xl space-y-1">
      <div class="font-black text-amber-800">🔓 Guru membuka kembali LKPD ini</div>
      <p class="text-amber-700 font-medium">Jawaban lamamu sudah terisi. Perbaiki seperlunya, lalu kirim ulang. Nilai dan catatan lama dikosongkan saat kamu mengirim ulang.</p>
    </div>`;
  }
  return '';
}

function kartuProgres(total) {
  return `
    <div class="lkpd-progres-sticky bg-white p-3 sm:p-4 rounded-3xl border shadow-sm space-y-2">
      <div class="flex items-center justify-between font-bold text-slate-700">
        <span>Kolom terisi</span>
        <span id="lkpd-progres-teks">0 dari ${total}</span>
      </div>
      <div class="h-2 rounded-full bg-slate-100 overflow-hidden"><div id="lkpd-progres-bar" class="h-full bg-brand-emerald transition-all" style="width:0%"></div></div>
    </div>`;
}

function bangunIsi(lkpdObj, ptmId) {
  const kepala = kartuJudul(lkpdObj);
  const isi = parseIsiLkpd(lkpdObj.isi_json);
  if (!isi) {
    return `${kepala}
    <div class="bg-white p-8 rounded-3xl border shadow-sm text-center text-slate-400 font-bold">LKPD belum disiapkan oleh guru.</div>`;
  }

  const u = state.currentUser;
  const staf = Boolean(u && (u.role === 'guru' || u.role === 'admin'));
  const idLkpd = lkpdObj.id_lkpd;
  const k = staf ? { keadaan: 'kosong', sub: null, marker: null } : keadaanLkpd(idLkpd);

  let mode = 'isi';
  let jawaban = {};
  let waktu = '';
  let pakaiDraft = false;

  if (staf) {
    mode = 'pratinjau';
  } else if (k.keadaan === 'terkirim') {
    mode = 'baca';
    jawaban = k.sub ? parseJawaban(k.sub.jawaban_json) : k.marker.jawaban;
    waktu = k.sub ? k.sub.timestamp : k.marker.waktu;
  } else {
    const draft = bacaDraft(idLkpd);
    if (draft) {
      jawaban = draft;
      pakaiDraft = true;
    } else if (k.keadaan === 'dibuka') {
      jawaban = parseJawaban(k.sub.jawaban_json);
    }
  }

  const ctx = { staf, mode, dibuka: k.keadaan === 'dibuka', sub: k.sub, waktu };
  const total = daftarIsian(isi).length;
  const labelKirim = ctx.dibuka ? 'Kirim Ulang Jawaban' : 'Kirim Jawaban';

  return `
    ${kepala}
    ${kartuIdentitas()}
    ${bannerStatus(ctx)}
    ${mode === 'isi' ? kartuProgres(total) : ''}
    <div id="lkpd-isi" data-draft="${pakaiDraft ? '1' : '0'}" class="space-y-4">
      ${renderIsiLkpd(isi, { mode, jawaban })}
      ${mode === 'baca' ? jawabanLain(isi, jawaban) : ''}
    </div>
    ${mode === 'isi'
      ? `<div class="lkpd-kirim-wrap"><button id="btn-kirim-lkpd" onclick="requireStudentAuth(() => kirimLkpdSiswa(${jsArg(idLkpd)}))" class="w-full py-3.5 bg-brand-emerald text-white font-black rounded-2xl shadow-xl hover:bg-emerald-600 transition">${labelKirim}</button></div>`
      : ''}`;
}

export function renderLkpdView(ptmId) {
  const lkpdObj = ambilLkpd(ptmId);
  if (!lkpdObj) return `<div class="p-8 text-center text-slate-400">LKPD belum tersedia pada pertemuan ini.</div>`;
  return `<div id="lkpd-root" data-ptm="${e(ptmId)}" data-lkpd="${e(lkpdObj.id_lkpd)}" class="max-w-4xl mx-auto space-y-4 text-xs">${bangunIsi(lkpdObj, ptmId)}</div>`;
}

function perbaruiProgres(root) {
  const kolom = root.querySelectorAll('textarea[data-lkpd-kunci]');
  const teks = root.querySelector('#lkpd-progres-teks');
  const bar = root.querySelector('#lkpd-progres-bar');
  if (!teks || !bar) return;
  let terisi = 0;
  kolom.forEach((t) => {
    if (t.value.trim() !== '') terisi++;
  });
  teks.textContent = `${terisi} dari ${kolom.length}`;
  bar.style.width = kolom.length ? `${Math.round((terisi / kolom.length) * 100)}%` : '0%';
}

function segarkan(ptmId) {
  const root = document.getElementById('lkpd-root');
  const lkpdObj = ambilLkpd(ptmId);
  if (!root || !lkpdObj) return;
  root.innerHTML = bangunIsi(lkpdObj, ptmId);
  perbaruiProgres(root);
}

// Dipanggil drawer.js setelah HTML dari renderLkpdView dipasang ke halaman.
export function inisiasiLkpd(ptmId) {
  const root = document.getElementById('lkpd-root');
  if (!root) return;

  if (!root.dataset.terpasang) {
    root.dataset.terpasang = '1';
    const idLkpd = root.dataset.lkpd;
    root.addEventListener('input', (ev) => {
      if (!ev.target.matches || !ev.target.matches('textarea[data-lkpd-kunci]')) return;
      perbaruiProgres(root);
      clearTimeout(timerDraft);
      timerDraft = setTimeout(() => tulisDraft(idLkpd, kumpulJawaban(root)), 400);
    });
    root.addEventListener('change', (ev) => {
      if (!ev.target.matches || !ev.target.matches('textarea[data-lkpd-kunci]')) return;
      clearTimeout(timerDraft);
      tulisDraft(idLkpd, kumpulJawaban(root));
    });
  }

  const header = document.querySelector('header');
  if (header) root.style.setProperty('--lkpd-top', `${header.offsetHeight + 4}px`);
  perbaruiProgres(root);
  const isiElem = root.querySelector('#lkpd-isi');
  if (isiElem && isiElem.dataset.draft === '1') showToast('info', 'Draf pengerjaan dipulihkan!');

  rapikanPenanda(ptmId);
}

// Buang penanda kirim lokal yang sudah digantikan data server atau sudah basi.
async function rapikanPenanda(ptmId) {
  try {
    const lkpdObj = ambilLkpd(ptmId);
    if (!lkpdObj || !state.currentUser) return;
    const idLkpd = lkpdObj.id_lkpd;
    const raw = localStorage.getItem(`${CACHE_KEY}_LKPD_KIRIM_${idLkpd}_${state.currentUser.username}`);
    if (!raw) return;

    const k = keadaanLkpd(idLkpd);
    let hapus = false;

    if (k.sub && !k.marker) {
      hapus = true; // server sudah memegang datanya
    } else if (!k.sub && k.marker) {
      const umur = Date.now() - (Date.parse(k.marker.waktu) || 0);
      if (umur > UMUR_PENANDA_BASI_MS && (await countOutbox()) === 0) hapus = true;
    }

    if (hapus) {
      hapusKirimLkpd(idLkpd);
      segarkan(ptmId);
    }
  } catch (err) {
    console.warn('Gagal merapikan penanda LKPD:', err);
  }
}

/* ---------- kirim ---------- */

export function kirimLkpdSiswa(idLkpd) {
  const root = document.getElementById('lkpd-root');
  if (!root) return;
  const lkpdObj = (state.cachedData.lkpd || []).find((l) => sama(l.id_lkpd, idLkpd));
  const isi = lkpdObj ? parseIsiLkpd(lkpdObj.isi_json) : null;
  if (!isi) return;

  const jawaban = kumpulJawaban(root);
  const terisi = Object.keys(jawaban).length;
  const total = daftarIsian(isi).length;
  const kosong = Math.max(0, total - terisi);

  if (terisi === 0) {
    Swal.fire({ icon: 'info', title: 'Belum Ada Jawaban', text: 'Isi minimal satu kolom sebelum mengirim.' });
    return;
  }
  if (JSON.stringify(jawaban).length > MAKS_JSON) {
    Swal.fire({ icon: 'error', title: 'Jawaban Terlalu Panjang', text: 'Persingkat beberapa jawaban lalu coba kirim lagi.' });
    return;
  }

  const k = keadaanLkpd(idLkpd);
  const ulang = k.keadaan === 'dibuka';
  const teks = [
    ulang ? 'Jawaban lamamu akan diganti dengan jawaban ini.' : 'Jawaban hanya bisa dikirim sekali.',
    kosong > 0 ? `${kosong} kolom belum diisi.` : 'Semua kolom sudah diisi.'
  ].join(' ');

  showConfirm(ulang ? 'Kirim Ulang Jawaban?' : 'Kirim Jawaban?', teks, () => prosesKirim(idLkpd, jawaban, k, ulang), 'Ya, Kirim');
}

async function prosesKirim(idLkpd, jawaban, k, ulang) {
  const ptmId = document.getElementById('lkpd-root')?.dataset.ptm;
  const btn = document.getElementById('btn-kirim-lkpd');
  const label = ulang ? 'Kirim Ulang Jawaban' : 'Kirim Jawaban';
  setButtonLoading(btn, true, 'Mengirim LKPD...', label);

  const res = await apiPost({ action: 'submit_lkpd', id_lkpd: idLkpd, jawaban_json: jawaban });

  setButtonLoading(btn, false, '', label);
  if (!res || !res.success) {
    Swal.fire({ icon: 'error', title: 'Gagal Mengirim', text: (res && res.message) || 'Terjadi kesalahan.' });
    return;
  }

  simpanKirimLkpd(idLkpd, {
    jawaban,
    waktu: new Date().toISOString(),
    dasarTs: ulang && k.sub ? String(k.sub.timestamp) : null
  });
  hapusDraft(idLkpd);
  markSelesai('lkpd', idLkpd);

  if (res.duplicate) {
    showToast('info', res.message || 'LKPD ini sudah pernah kamu kirim.');
  } else {
    if (!res.queued) await fetchAllInitialData(true);
    toastSubmitResult(res, 'Jawaban LKPD Berhasil Terkirim!');
  }

  if (ptmId) segarkan(ptmId);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.kirimLkpdSiswa = kirimLkpdSiswa;
