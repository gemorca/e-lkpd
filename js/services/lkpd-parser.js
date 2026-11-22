// Parser PDF LKPD -> draf isi_json (struktur terstruktur, versi 1).
// PDF hanya dibaca di browser (pdf.js), TIDAK diunggah ke Drive.
// Hasil adalah DRAF: blok yang dibuat otomatis diberi penanda `_cek: true`
// (hanya hidup di editor, dibuang sebelum disimpan oleh editor).
//
// Batasan yang disengaja: garis/kotak vektor dan gambar vektor (Canva) tidak
// terbaca. Jumlah gambar raster dihitung hanya sebagai bonus (blok gambar kosong
// yang harus diunggah guru). Kotak jawaban default baris = 3.

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function buatIdAcak(prefix = 'x', dipakai = null) {
  for (let n = 0; n < 50; n++) {
    let s = '';
    for (let i = 0; i < 8; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    const id = prefix + s;
    if (!dipakai || !dipakai.has(id)) {
      if (dipakai) dipakai.add(id);
      return id;
    }
  }
  throw new Error('Gagal membuat ID unik');
}

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function tinggiItem(it) {
  const t = it.transform || [];
  const dariMatriks = Math.hypot(t[2] || 0, t[3] || 0);
  return Math.abs(it.height || dariMatriks || Math.hypot(t[0] || 0, t[1] || 0) || 0);
}

// Item pdf.js -> item sederhana {str,x,y,h,font}
function normalisasiItem(raw) {
  return (raw || [])
    .filter((it) => it && typeof it.str === 'string' && it.str.trim() !== '' && Array.isArray(it.transform))
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      h: tinggiItem(it),
      font: it.fontName || ''
    }));
}

// Kelompokkan item jadi baris (urut atas ke bawah), tiap baris dipecah jadi segmen.
export function kelompokkanBaris(items) {
  const urut = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const baris = [];
  urut.forEach((it) => {
    const tol = Math.max(2, it.h * 0.45);
    const last = baris[baris.length - 1];
    if (last && Math.abs(last.y - it.y) <= tol) {
      last.items.push(it);
    } else {
      baris.push({ y: it.y, items: [it] });
    }
  });

  return baris.map((b) => {
    b.items.sort((p, q) => p.x - q.x);
    const ukuran = Math.max(...b.items.map((i) => i.h));
    // pecah jadi segmen bila ada celah horizontal besar
    const segmen = [];
    let cur = null;
    b.items.forEach((it) => {
      if (cur) {
        const akhir = cur.xAkhir;
        const celah = it.x - akhir;
        if (celah > Math.max(ukuran * 2.5, 18)) {
          segmen.push(cur);
          cur = null;
        }
      }
      if (!cur) {
        cur = { teks: it.str, x: it.x, xAkhir: it.x + (it.w || it.str.length * it.h * 0.5) };
      } else {
        const celah = it.x - cur.xAkhir;
        const sambung = celah > it.h * 0.25 && !/\s$/.test(cur.teks) && !/^\s/.test(it.str) ? ' ' : '';
        cur.teks += sambung + it.str;
        cur.xAkhir = it.x + (it.w || it.str.length * it.h * 0.5);
      }
    });
    if (cur) segmen.push(cur);
    const segTeks = segmen.map((s) => s.teks.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return {
      y: b.y,
      ukuran,
      segmen: segTeks,
      teks: segTeks.join(' ').trim(),
      jumlahKarakter: b.items.reduce((n, i) => n + i.str.length, 0)
    };
  }).filter((b) => b.teks !== '');
}

const RE_AKHIR_SOAL = /[:?!]\s*$/;
const RE_NOMOR = /\bnomor\b/i;

function adalahSoal(teks) {
  return RE_AKHIR_SOAL.test(teks) || RE_NOMOR.test(teks);
}

// Baris dengan >=2 segmen pendek => kandidat header tabel
function adalahHeaderTabel(b) {
  if (b.segmen.length < 2 || b.segmen.length > 6) return false;
  return b.segmen.every((s) => s.length <= 40 && !/[.?!]\s*$/.test(s));
}

function bangunTabel(headers, idSet) {
  const kolom = headers.map((j) => ({ id: buatIdAcak('k', idSet), judul: j }));
  const baris = [];
  for (let r = 0; r < 3; r++) {
    const sel = {};
    kolom.forEach((k) => { sel[k.id] = { jenis: 'isian', nilai: '' }; });
    baris.push({ id: buatIdAcak('r', idSet), sel });
  }
  return { id: buatIdAcak('b', idSet), tipe: 'tabel', kolom, baris, _cek: true };
}

/**
 * Fungsi murni (mudah diuji): halaman terstruktur -> draf isi_json.
 * halaman: [{ items:[{str,transform,height,fontName,width}], jumlahGambar?:number }]
 * opsi: { lewatiSampul: true }
 */
export function bangunDrafDariHalaman(halaman, opsi = {}) {
  const lewatiSampul = opsi.lewatiSampul !== false;
  const idSet = new Set();

  const dataHalaman = halaman.map((h) => ({
    baris: kelompokkanBaris(normalisasiItem(h.items)),
    jumlahGambar: h.jumlahGambar || 0
  }));

  // font median per dokumen, berbobot jumlah karakter
  const ukuranKarakter = [];
  dataHalaman.forEach((h) => h.baris.forEach((b) => {
    const n = Math.min(b.jumlahKarakter, 200);
    for (let i = 0; i < n; i += 10) ukuranKarakter.push(Math.round(b.ukuran * 10) / 10);
  }));
  const med = median(ukuranKarakter) || 12;
  const batasJudul = med * 1.4;

  const bagian = [];
  let sampulDilewati = false;

  dataHalaman.forEach((h, idx) => {
    if (lewatiSampul && idx === 0 && dataHalaman.length > 1) {
      sampulDilewati = true;
      return;
    }
    if (!h.baris.length && !h.jumlahGambar) return;

    // 1) judul berurutan digabung
    const bagianBaris = [];
    let judulBuf = [];
    const flushJudul = () => {
      if (judulBuf.length) {
        bagianBaris.push({ jenis: 'judul', teks: judulBuf.join(' ') });
        judulBuf = [];
      }
    };
    h.baris.forEach((b) => {
      if (b.ukuran >= batasJudul) judulBuf.push(b.teks);
      else {
        flushJudul();
        bagianBaris.push({ jenis: 'biasa', baris: b });
      }
    });
    flushJudul();

    let judul = '';
    let mulai = 0;
    if (bagianBaris.length && bagianBaris[0].jenis === 'judul') {
      judul = bagianBaris[0].teks;
      mulai = 1;
    }
    if (!judul) judul = 'Halaman ' + (idx + 1);

    const blok = [];
    let petunjuk = '';
    let paragraf = [];
    const flushParagraf = () => {
      if (paragraf.length) {
        blok.push({ id: buatIdAcak('b', idSet), tipe: 'teks', isi: paragraf.join(' '), _cek: true });
        paragraf = [];
      }
    };

    let sudahBlokSelain = false;
    let petunjukBuf = [];
    for (let i = mulai; i < bagianBaris.length; i++) {
      const e = bagianBaris[i];
      if (e.jenis === 'judul') {
        flushParagraf();
        blok.push({ id: buatIdAcak('b', idSet), tipe: 'teks', isi: e.teks, _cek: true });
        sudahBlokSelain = true;
        continue;
      }
      const b = e.baris;
      if (adalahHeaderTabel(b)) {
        flushParagraf();
        blok.push(bangunTabel(b.segmen, idSet));
        sudahBlokSelain = true;
        continue;
      }
      if (adalahSoal(b.teks)) {
        flushParagraf();
        blok.push({
          id: buatIdAcak('b', idSet),
          tipe: 'soal',
          label: b.teks,
          gambar: null,
          baris: 3,
          _cek: true
        });
        sudahBlokSelain = true;
        continue;
      }
      if (!sudahBlokSelain) {
        petunjukBuf.push(b.teks);
      } else {
        paragraf.push(b.teks);
      }
    }
    petunjuk = petunjukBuf.join(' ');
    flushParagraf();

    if (h.jumlahGambar > 0) {
      const item = [];
      for (let g = 0; g < Math.min(h.jumlahGambar, 20); g++) item.push({ url: '', caption: '' });
      blok.push({ id: buatIdAcak('b', idSet), tipe: 'gambar', item, _cek: true });
    }

    bagian.push({
      id: buatIdAcak('s', idSet),
      judul,
      petunjuk,
      blok
    });
  });

  return {
    isi: { versi: 1, bagian: bagian.slice(0, 50) },
    info: { halaman: halaman.length, sampulDilewati, medianFont: med }
  };
}

/**
 * Baca file PDF (File/ArrayBuffer) di browser -> draf isi_json.
 */
export async function parsePdfKeDraf(fileOrBuffer, opsi = {}) {
  if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js belum dimuat. Periksa koneksi internet lalu muat ulang.');
  const buffer = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const halaman = [];
  const OPS = pdfjsLib.OPS || {};
  const opGambar = new Set([OPS.paintImageXObject, OPS.paintJpegXObject, OPS.paintInlineImageXObject].filter((x) => x !== undefined));

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    let jumlahGambar = 0;
    try {
      const ol = await page.getOperatorList();
      jumlahGambar = ol.fnArray.filter((f) => opGambar.has(f)).length;
    } catch (e) {
      jumlahGambar = 0;
    }
    halaman.push({ items: tc.items, jumlahGambar });
  }
  return bangunDrafDariHalaman(halaman, opsi);
}
