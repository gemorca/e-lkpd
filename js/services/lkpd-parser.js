// Parser PDF LKPD -> draf isi_json (struktur terstruktur, versi 1), versi 2 sadar-posisi.
// PDF hanya dibaca di browser (pdf.js), TIDAK diunggah ke Drive.
// Hasil adalah DRAF: blok yang dibuat otomatis diberi penanda `_cek: true`
// (hanya hidup di editor, dibuang sebelum disimpan oleh editor).
//
// Beda dengan versi 1:
// - Posisi tiap teks, garis jawaban, dan gambar dibaca dari PDF (bukan hanya urutan teks).
// - Gambar vektor (Canva) dikenali sebagai wilayah gambar, lalu dipotong otomatis dari
//   halaman PDF oleh editor. Parser hanya mencatat letaknya di `_pdf` (hanya hidup di editor).
// - Gambar ditempatkan di tempatnya: sel tabel, gambar soal, atau blok gambar sesuai urutan baca.
// - Tabel dikenali dari kolom yang sejajar. Teks contoh di sel tabel ikut terbawa.
// - Baris teks yang terpotong (wrap) disatukan sebelum dinilai sebagai soal.
// - Teks bertanda tanya tanpa kotak jawaban di bawahnya BUKAN soal, hanya teks/petunjuk.
//
// Skema isi_json tidak berubah (backend Kode.gs tetap valid). Tambahan opsional:
//   tabel.barisIsian (tinggi kotak isian di sel), item/gambar/sel `_pdf` (hanya editor).

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

/* ---------- util ---------- */

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const klem = (v, a, b) => Math.min(b, Math.max(a, v));
const pusatX = (k) => (k.x0 + k.x1) / 2;
const pusatT = (k) => (k.t0 + k.t1) / 2;

function tinggiItem(it) {
  const t = it.transform || [];
  const dariMatriks = Math.hypot(t[2] || 0, t[3] || 0);
  return Math.abs(it.height || dariMatriks || Math.hypot(t[0] || 0, t[1] || 0) || 0);
}

// Konfigurasi heuristik (satuan: poin PDF, 1 pt = 1/72 inci)
const K = {
  garisMaxTebal: 3.5, // tinggi maksimal sebuah "garis jawaban"
  garisMinPanjang: 30,
  garisSusunMaks: 70, // jarak maksimal antar garis dalam satu kotak jawaban
  gambarCelahX: 10, // celah datar maksimal antar bentuk agar digabung jadi satu gambar
  gambarCelahT: 4, // celah tegak maksimal (lebih kecil: baris tabel tidak boleh menyatu)
  gambarMinSisi: 26,
  gambarMinLuas: 1000,
  panelMinLuas: 2000,
  panelTeksMinLuas: 3000,
  barisMin: 3,
  barisMaks: 12
};

/* ---------- item teks ---------- */

// Item pdf.js -> item sederhana {str,x,t,w,h}; t = garis dasar, dihitung dari atas halaman.
function normalisasiItem(raw, ke) {
  return (raw || [])
    .filter((it) => it && typeof it.str === 'string' && it.str.trim() !== '' && Array.isArray(it.transform))
    .map((it) => {
      const p = ke ? ke(it.transform[4], it.transform[5]) : [it.transform[4], -it.transform[5]];
      return { str: it.str, x: p[0], t: p[1], w: it.width || 0, h: tinggiItem(it) };
    });
}

// Kelompokkan item jadi baris (urut atas ke bawah), tiap baris dipecah jadi segmen.
export function kelompokkanBaris(items) {
  const urut = [...items].sort((a, b) => a.t - b.t || a.x - b.x);
  const baris = [];
  urut.forEach((it) => {
    const tol = Math.max(2, it.h * 0.45);
    const last = baris[baris.length - 1];
    if (last && Math.abs(last.t - it.t) <= tol) last.items.push(it);
    else baris.push({ t: it.t, items: [it] });
  });

  return baris
    .map((b) => {
      b.items.sort((p, q) => p.x - q.x);
      const ukuran = Math.max(...b.items.map((i) => i.h));
      const segmen = [];
      let cur = null;
      b.items.forEach((it) => {
        const akhirIt = it.x + (it.w || it.str.length * it.h * 0.5);
        if (cur) {
          const celah = it.x - cur.x1;
          if (celah > Math.max(ukuran * 2.5, 18)) {
            segmen.push(cur);
            cur = null;
          }
        }
        if (!cur) {
          cur = { teks: it.str, x0: it.x, x1: akhirIt };
        } else {
          const celah = it.x - cur.x1;
          const sambung = celah > it.h * 0.25 && !/\s$/.test(cur.teks) && !/^\s/.test(it.str) ? ' ' : '';
          cur.teks += sambung + it.str;
          cur.x1 = akhirIt;
        }
      });
      if (cur) segmen.push(cur);
      const seg = segmen
        .map((s) => ({ teks: s.teks.replace(/\s+/g, ' ').trim(), x0: s.x0, x1: s.x1 }))
        .filter((s) => s.teks);
      return {
        t: b.t,
        ukuran,
        segmen: seg,
        segTeks: seg.map((s) => s.teks),
        teks: seg.map((s) => s.teks).join(' ').trim(),
        x0: seg.length ? seg[0].x0 : 0,
        x1: seg.length ? seg[seg.length - 1].x1 : 0,
        jumlahKarakter: b.items.reduce((n, i) => n + i.str.length, 0)
      };
    })
    .filter((b) => b.teks !== '');
}

/* ---------- geometri halaman (garis, gambar, bentuk) ---------- */

function kali(a, b) {
  // a o b: terapkan b dulu, lalu a
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

function bboxPathLama(ops, koor, OPS) {
  // pdf.js 3.x: constructPath [ops[], koordinat[]]
  let i = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const titik = (x, y) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (let n = 0; n < ops.length; n++) {
    const op = ops[n];
    if (op === OPS.moveTo || op === OPS.lineTo) {
      titik(koor[i], koor[i + 1]);
      i += 2;
    } else if (op === OPS.curveTo) {
      titik(koor[i], koor[i + 1]);
      titik(koor[i + 2], koor[i + 3]);
      titik(koor[i + 4], koor[i + 5]);
      i += 6;
    } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
      titik(koor[i], koor[i + 1]);
      titik(koor[i + 2], koor[i + 3]);
      i += 4;
    } else if (op === OPS.rectangle) {
      titik(koor[i], koor[i + 1]);
      titik(koor[i] + koor[i + 2], koor[i + 1] + koor[i + 3]);
      i += 4;
    }
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

// Argumen operator warna pdf.js: "#rrggbb" (4.x ke atas) atau [r,g,b] (3.x).
function hexDariArg(a) {
  if (!a) return null;
  if (typeof a[0] === 'string') return a[0];
  if (a.length >= 3 && typeof a[0] === 'number') {
    return '#' + [a[0], a[1], a[2]].map((v) => klem(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function adalahHitam(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return true; // warna tak dikenal: anggap garis jawaban
  return [m[1], m[2], m[3]].every((c) => parseInt(c, 16) <= 48);
}

/**
 * Jalani daftar operator pdf.js, kumpulkan:
 *  - kotak:  bentuk vektor terisi/terbingkai {x0,t0,x1,t1}
 *  - gambar: gambar raster {x0,t0,x1,t1}
 *  - garis:  garis datar tipis {x0,x1,t}  (kandidat garis jawaban)
 * Koordinat sudah dalam sistem atas-ke-bawah (viewport skala 1).
 * Mendukung pdf.js 3.x (dipakai index.html) dan 4.x ke atas.
 */
export function jalaniOperator(ol, OPS, ke) {
  const kotak = [];
  const gambar = [];
  const garis = [];
  const tumpuk = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let warnaIsi = '#000000';
  let warnaGaris = '#000000';
  let tertunda = null; // pdf.js 3.x: path menunggu operator lukis

  const boxViewport = (b) => {
    const sudut = [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[0], b[3]],
      [b[2], b[3]]
    ].map(([x, y]) => {
      const px = ctm[0] * x + ctm[2] * y + ctm[4];
      const py = ctm[1] * x + ctm[3] * y + ctm[5];
      return ke(px, py);
    });
    const xs = sudut.map((p) => p[0]);
    const ts = sudut.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), t0: Math.min(...ts), t1: Math.max(...ts) };
  };

  const catat = (b, bingkai) => {
    if (!b) return;
    const v = boxViewport(b);
    const w = v.x1 - v.x0;
    const h = v.t1 - v.t0;
    if (!isFinite(w) || !isFinite(h)) return;
    const warna = bingkai ? warnaGaris : warnaIsi;
    // Garis jawaban selalu hitam. Garis tipis berwarna lain adalah bagian ilustrasi (kisi AC, dsb.).
    if (h <= K.garisMaxTebal && w >= K.garisMinPanjang) {
      if (adalahHitam(warna)) garis.push({ x0: v.x0, x1: v.x1, t: (v.t0 + v.t1) / 2, warna });
    } else if (w <= K.garisMaxTebal || h <= K.garisMaxTebal) return; // garis tegak / hiasan tipis
    else kotak.push({ ...v, warna });
  };

  const opLukis = new Set([
    OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
    OPS.stroke, OPS.closeStroke
  ].filter((x) => x !== undefined));
  const opBingkai = new Set([OPS.stroke, OPS.closeStroke].filter((x) => x !== undefined));
  const opWarnaIsi = new Set([OPS.setFillRGBColor, OPS.setFillGray, OPS.setFillCMYKColor].filter((x) => x !== undefined));
  const opWarnaGaris = new Set([OPS.setStrokeRGBColor, OPS.setStrokeGray, OPS.setStrokeCMYKColor].filter((x) => x !== undefined));
  const opGambar = new Set([
    OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintJpegXObject, OPS.paintImageMaskXObject
  ].filter((x) => x !== undefined));

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const a = ol.argsArray[i];

    if (fn === OPS.save) {
      tumpuk.push([ctm, warnaIsi, warnaGaris]);
    } else if (fn === OPS.restore) {
      if (tumpuk.length) [ctm, warnaIsi, warnaGaris] = tumpuk.pop();
    } else if (fn === OPS.transform) {
      if (a && a.length >= 6) ctm = kali(ctm, a);
    } else if (opWarnaIsi.has(fn)) {
      warnaIsi = hexDariArg(a) || warnaIsi;
    } else if (opWarnaGaris.has(fn)) {
      warnaGaris = hexDariArg(a) || warnaGaris;
    } else if (fn === OPS.paintFormXObjectBegin) {
      tumpuk.push([ctm, warnaIsi, warnaGaris]);
      if (a && a[0] && a[0].length >= 6) ctm = kali(ctm, a[0]);
    } else if (fn === OPS.paintFormXObjectEnd) {
      if (tumpuk.length) [ctm, warnaIsi, warnaGaris] = tumpuk.pop();
    } else if (opGambar.has(fn)) {
      gambar.push(boxViewport([0, 0, 1, 1]));
    } else if (fn === OPS.constructPath) {
      if (a && typeof a[0] === 'number') {
        // pdf.js 4.x+: [operatorLukis, data, minMax]
        const op = a[0];
        const mm = a[2];
        if (opLukis.has(op) && mm && mm.length >= 4) catat([mm[0], mm[1], mm[2], mm[3]], opBingkai.has(op));
      } else if (a && a[0] && a[1]) {
        // pdf.js 3.x: [ops[], koordinat[]], dilukis oleh operator berikutnya
        const b = bboxPathLama(a[0], a[1], OPS);
        if (b) {
          tertunda = tertunda
            ? [Math.min(tertunda[0], b[0]), Math.min(tertunda[1], b[1]), Math.max(tertunda[2], b[2]), Math.max(tertunda[3], b[3])]
            : b;
        }
      }
    } else if (opLukis.has(fn)) {
      if (tertunda) catat(tertunda, opBingkai.has(fn));
      tertunda = null;
    } else if (fn === OPS.endPath) {
      tertunda = null;
    }
  }
  return { kotak, gambar, garis };
}

/* ---------- wilayah gambar ---------- */

const dalam = (px, pt, k) => px >= k.x0 - 0.5 && px <= k.x1 + 0.5 && pt >= k.t0 - 0.5 && pt <= k.t1 + 0.5;

/**
 * Tentukan wilayah gambar di satu halaman.
 * Bentuk yang berisi teks atau garis jawaban dianggap PANEL TATA LETAK (sel tabel, kartu soal,
 * latar halaman) dan dibuang. Sisanya (ilustrasi, kartu berisi ilustrasi, gambar raster) digabung
 * bila saling bersentuhan, lalu menjadi satu wilayah gambar.
 */
export function cariWilayahGambar({ kotak, gambar, garis, items, lebar, tinggi }) {
  const luasHal = lebar * tinggi;
  const teksPanjang = items.filter((it) => it.str.trim().length >= 3).map((it) => ({ px: it.x + it.w / 2, pt: it.t - it.h * 0.3 }));
  const pusatGaris = garis.map((g) => ({ px: (g.x0 + g.x1) / 2, pt: g.t }));

  const kandidat = [];
  gambar.forEach((g) => kandidat.push({ ...g, raster: true }));
  kotak.forEach((k) => kandidat.push({ ...k, raster: false }));

  const simpan = kandidat.filter((k) => {
    const w = k.x1 - k.x0;
    const h = k.t1 - k.t0;
    const luas = w * h;
    if (luas > luasHal * 0.55 || w > lebar * 0.95) return false; // latar halaman
    if (k.raster) return true;
    if (luas >= K.panelMinLuas) {
      const adaGaris = pusatGaris.some((p) => dalam(p.px, p.pt, k));
      if (adaGaris) return false;
      const adaTeks = teksPanjang.some((p) => dalam(p.px, p.pt, k));
      if (adaTeks && luas >= K.panelTeksMinLuas) return false;
    }
    return true;
  });

  // gabung bentuk yang bersentuhan (union-find)
  const induk = simpan.map((_, i) => i);
  const cari = (i) => (induk[i] === i ? i : (induk[i] = cari(induk[i])));
  const cx = K.gambarCelahX;
  const ct = K.gambarCelahT;
  for (let i = 0; i < simpan.length; i++) {
    for (let j = i + 1; j < simpan.length; j++) {
      const p = simpan[i];
      const q = simpan[j];
      if (p.x0 - cx <= q.x1 && q.x0 - cx <= p.x1 && p.t0 - ct <= q.t1 && q.t0 - ct <= p.t1) {
        induk[cari(i)] = cari(j);
      }
    }
  }
  const gabung = new Map();
  simpan.forEach((k, i) => {
    const r = cari(i);
    const g = gabung.get(r);
    if (!g) gabung.set(r, { x0: k.x0, x1: k.x1, t0: k.t0, t1: k.t1, raster: k.raster });
    else {
      g.x0 = Math.min(g.x0, k.x0);
      g.x1 = Math.max(g.x1, k.x1);
      g.t0 = Math.min(g.t0, k.t0);
      g.t1 = Math.max(g.t1, k.t1);
      g.raster = g.raster || k.raster;
    }
  });

  return [...gabung.values()]
    .filter((g) => {
      const w = g.x1 - g.x0;
      const h = g.t1 - g.t0;
      if (w < K.gambarMinSisi || h < K.gambarMinSisi || w * h < K.gambarMinLuas) return false;
      if (w > lebar * 0.95 && h > tinggi * 0.5) return false;
      const teksDalam = items.filter((it) => it.str.trim().length >= 3 && dalam(it.x + it.w / 2, it.t - it.h * 0.3, g)).length;
      return teksDalam < 2;
    })
    .sort((a, b) => a.t0 - b.t0 || a.x0 - b.x0);
}

/* ---------- kotak jawaban (garis) ---------- */

export function kelompokGaris(garis) {
  const urut = [];
  [...garis]
    .sort((a, b) => a.t - b.t || a.x0 - b.x0)
    .forEach((g) => {
      // buang garis ganda (digambar dua kali)
      if (urut.some((u) => Math.abs(u.t - g.t) < 1.5 && Math.min(u.x1, g.x1) - Math.max(u.x0, g.x0) > 0.9 * Math.min(u.x1 - u.x0, g.x1 - g.x0))) return;
      urut.push(g);
    });
  const grup = [];
  urut.forEach((g) => {
    const cocok = grup.find((k) => {
      const irisan = Math.min(k.x1, g.x1) - Math.max(k.x0, g.x0);
      const lebarMin = Math.min(k.x1 - k.x0, g.x1 - g.x0);
      return irisan >= lebarMin * 0.6 && g.t >= k.tAkhir && g.t - k.tAkhir <= K.garisSusunMaks;
    });
    if (cocok) {
      cocok.x0 = Math.min(cocok.x0, g.x0);
      cocok.x1 = Math.max(cocok.x1, g.x1);
      cocok.tAkhir = g.t;
      cocok.n++;
    } else {
      grup.push({ x0: g.x0, x1: g.x1, t0: g.t, tAkhir: g.t, n: 1 });
    }
  });
  return grup.map((k) => ({ x0: k.x0, x1: k.x1, t0: k.t0, t1: k.tAkhir, n: k.n }));
}

/* ---------- penyusun bagian ---------- */

const RE_AKHIR_SOAL = /[:?!]\s*$/;
const RE_NOMOR = /\bnomor\b/i;
const adalahPenandaSoal = (teks) => RE_AKHIR_SOAL.test(teks) || RE_NOMOR.test(teks);

// Baris dengan >=2 segmen pendek => kandidat header tabel
function adalahHeaderTabel(b) {
  if (b.segmen.length < 2 || b.segmen.length > 6) return false;
  return b.segTeks.every((s) => s.length <= 40 && !/[.?!]\s*$/.test(s));
}

const barisDariGaris = (n) => klem(Math.max(K.barisMin, n), 1, K.barisMaks);

/**
 * Susun satu halaman menjadi satu bagian {judul, petunjuk, blok}.
 * data: { baris[], garis[], gambar[], hal, batasJudul, idSet }
 */
function susunBagian(data) {
  const { idSet, batasJudul } = data;
  const id = (p) => buatIdAcak(p, idSet);

  // 1) judul berurutan di awal digabung, sisanya jadi token teks
  const judulBuf = [];
  const teksBaris = [];
  data.baris.forEach((b) => {
    if (b.ukuran >= batasJudul && !teksBaris.length) judulBuf.push(b.teks);
    else if (b.ukuran >= batasJudul) teksBaris.push({ ...b, judulTengah: true });
    else teksBaris.push(b);
  });

  // 2) gabungkan baris yang terpotong (wrap) menjadi paragraf
  const gaGaris = kelompokGaris(data.garis);
  const wilayah = data.gambar;
  const token = [];
  gaGaris.forEach((g) => token.push({ jenis: 'G', g, atas: g.t0 - 6 }));
  wilayah.forEach((w) => token.push({ jenis: 'I', w, atas: w.t0 }));
  const tahan = token.map((t) => t.atas); // posisi atas token non-teks: mencegah penggabungan lintas-gambar

  let P = null;
  const lepaskan = () => {
    if (P) token.push(P);
    P = null;
  };
  teksBaris.forEach((b) => {
    if (adalahHeaderTabel(b)) {
      lepaskan();
      token.push({ jenis: 'T', baris: b, atas: b.t - b.ukuran });
      return;
    }
    if (b.judulTengah) {
      lepaskan();
      token.push({ jenis: 'P', baris: [b], teks: b.teks, x0: b.x0, x1: b.x1, atas: b.t - b.ukuran, bawah: b.t + b.ukuran * 0.3, ukuran: b.ukuran, judul: true });
      return;
    }
    if (P) {
      const jarak = b.t - P.terakhir.t;
      const samaUkuran = Math.abs(b.ukuran - P.ukuran) <= 1.5;
      const belumSelesai = !RE_AKHIR_SOAL.test(P.teks);
      const adaPenghalang = tahan.some((u) => u > P.terakhir.t - P.ukuran && u < b.t - b.ukuran);
      if (samaUkuran && belumSelesai && !adaPenghalang && jarak <= P.ukuran * 1.9) {
        P.baris.push(b);
        P.teks += ' ' + b.teks;
        P.terakhir = b;
        P.x0 = Math.min(P.x0, b.x0);
        P.x1 = Math.max(P.x1, b.x1);
        P.bawah = b.t + b.ukuran * 0.3;
        return;
      }
      lepaskan();
    }
    P = { jenis: 'P', baris: [b], teks: b.teks, x0: b.x0, x1: b.x1, atas: b.t - b.ukuran, bawah: b.t + b.ukuran * 0.3, ukuran: b.ukuran, terakhir: b };
  });
  lepaskan();

  token.sort((p, q) => p.atas - q.atas || (p.jenis === 'I' ? -1 : 1));

  const pakai = new Set();
  const berikut = (i) => {
    for (let j = i + 1; j < token.length; j++) if (!pakai.has(token[j])) return token[j];
    return null;
  };

  // 3) pasangkan gambar di sebelah kiri label soal (ikon per soal)
  token.forEach((t, i) => {
    if (t.jenis !== 'P' || t.judul) return;
    const n = berikut(i);
    t.g = n && n.jenis === 'G' && n.g.t0 - t.bawah <= 140 ? n : null;
  });
  const pasangan = new Map();
  token.forEach((t) => {
    if (t.jenis !== 'I') return;
    let terbaik = null;
    let skor = 0;
    token.forEach((p) => {
      if (p.jenis !== 'P' || !p.g || pasangan.has(p)) return;
      const bawahP = Math.max(p.bawah, p.g.g.t1);
      const tumpang = Math.min(t.w.t1, bawahP + 10) - Math.max(t.w.t0, p.atas - 10);
      if (t.w.x1 <= p.x0 + 6 && tumpang > 0 && tumpang > skor) {
        skor = tumpang;
        terbaik = p;
      }
    });
    if (terbaik) pasangan.set(terbaik, t);
  });
  const gambarTerpasang = new Set();
  pasangan.forEach((t) => gambarTerpasang.add(t));

  // 4) rakit blok
  const blok = [];
  const petunjuk = [];
  let adaBlok = false;
  let nomorJawab = 0;
  const jumlahTanpaLabel = token.filter((x) => x.jenis === 'G').length;
  const wilayahKePdf = (w) => ({ hal: data.hal, x0: w.x0, t0: w.t0, x1: w.x1, t1: w.t1 });
  const itemGambar = (w) => ({ url: '', caption: '', _pdf: wilayahKePdf(w) });

  const bangunSoal = (label, g, w) => {
    const grup = [g.g];
    pakai.add(g);
    // kotak jawaban sejajar (kiri-kanan) di bawah satu label digabung jadi satu soal
    token.forEach((x) => {
      if (x.jenis === 'G' && !pakai.has(x) && Math.abs(x.g.t0 - g.g.t0) <= 14 && (x.g.x0 >= g.g.x1 - 4 || x.g.x1 <= g.g.x0 + 4)) {
        grup.push(x.g);
        pakai.add(x);
      }
    });
    const jumlah = grup.reduce((s, q) => s + q.n, 0);
    return {
      id: id('b'),
      tipe: 'soal',
      label,
      gambar: w ? itemGambar(w) : null,
      baris: barisDariGaris(jumlah),
      _cek: true
    };
  };

  const tabelDariHeader = (idxHeader) => {
    const h = token[idxHeader].baris;
    const kolomX = h.segmen.map((s) => ({ x0: s.x0, x1: s.x1, c: (s.x0 + s.x1) / 2 }));
    const batas = [];
    for (let i = 0; i < kolomX.length - 1; i++) batas.push((kolomX[i].c + kolomX[i + 1].c) / 2);
    const kolomIdx = (px) => {
      let k = 0;
      while (k < batas.length && px > batas[k]) k++;
      return k;
    };
    const tx0 = Math.min(...kolomX.map((k) => k.x0)) - 40;
    const tx1 = Math.max(...kolomX.map((k) => k.x1)) + 40;
    const lebarTabel = tx1 - tx0;

    // token yang masih berada di wilayah tabel
    const isi = [];
    for (let j = idxHeader + 1; j < token.length; j++) {
      const t = token[j];
      if (pakai.has(t)) continue;
      if (t.jenis === 'P' || t.jenis === 'T') {
        const bs = t.jenis === 'T' ? [t.baris] : t.baris;
        const luar = bs.some((b) => b.ukuran >= batasJudul
          || b.segmen.some((s) => (s.x0 + s.x1) / 2 < tx0 || (s.x0 + s.x1) / 2 > tx1)
          || (b.segmen.length === 1 && b.x1 - b.x0 > lebarTabel * 0.8));
        if (luar) break;
        isi.push(t);
      } else if (t.jenis === 'G') {
        if (pusatX(t.g) < tx0 || pusatX(t.g) > tx1 || t.g.x1 - t.g.x0 > lebarTabel * 0.8) break;
        isi.push(t);
      } else if (t.jenis === 'I') {
        if (pusatX(t.w) < tx0 || pusatX(t.w) > tx1) break;
        if (gambarTerpasang.has(t)) break;
        isi.push(t);
      }
    }

    // posisi baris tabel: gambar dan garis jawaban lebih dipercaya daripada teks
    const barisPos = [];
    const tambahJangkar = (y) => {
      const dekat = barisPos.find((b) => Math.abs(b.y - y) < 45);
      if (dekat) {
        dekat.y = (dekat.y * dekat.n + y) / (dekat.n + 1);
        dekat.n++;
      } else barisPos.push({ y, n: 1 });
    };
    const kuat = [];
    isi.forEach((t) => {
      if (t.jenis === 'I') kuat.push(pusatT(t.w));
      else if (t.jenis === 'G') kuat.push(pusatT({ t0: t.g.t0, t1: t.g.t1 }));
    });
    kuat.sort((a, b) => a - b).forEach(tambahJangkar);

    const teksSeg = [];
    isi.forEach((t) => {
      const bs = t.jenis === 'T' ? [t.baris] : t.jenis === 'P' ? t.baris : [];
      bs.forEach((b) => b.segmen.forEach((s) => teksSeg.push({ y: b.t - b.ukuran * 0.3, x: (s.x0 + s.x1) / 2, teks: s.teks })));
    });
    teksSeg.sort((a, b) => a.y - b.y).forEach((s) => {
      const jarak = barisPos.length ? Math.min(...barisPos.map((b) => Math.abs(b.y - s.y))) : Infinity;
      if (jarak > 70) barisPos.push({ y: s.y, n: 1 });
    });
    barisPos.sort((a, b) => a.y - b.y);

    const barisTabel = barisPos.map(() => ({ sel: kolomX.map(() => ({ gambar: null, teks: [], garis: 0 })) }));
    const cariBaris = (y) => {
      let k = 0;
      let jarak = Infinity;
      barisPos.forEach((b, i) => {
        const d = Math.abs(b.y - y);
        if (d < jarak) {
          jarak = d;
          k = i;
        }
      });
      return k;
    };
    isi.forEach((t) => {
      if (t.jenis === 'I') barisTabel[cariBaris(pusatT(t.w))].sel[kolomIdx(pusatX(t.w))].gambar = t.w;
      else if (t.jenis === 'G') barisTabel[cariBaris(pusatT({ t0: t.g.t0, t1: t.g.t1 }))].sel[kolomIdx(pusatX(t.g))].garis += t.g.n;
    });
    teksSeg.forEach((s) => barisTabel[cariBaris(s.y)].sel[kolomIdx(s.x)].teks.push(s.teks));

    isi.forEach((t) => pakai.add(t));
    pakai.add(token[idxHeader]);

    if (!barisTabel.length) barisTabel.push({ sel: kolomX.map(() => ({ gambar: null, teks: [], garis: 3 })) });

    const kolom = h.segmen.map((s) => ({ id: id('k'), judul: s.teks }));
    let barisIsian = 2;
    const rows = barisTabel.map((r) => {
      const sel = {};
      r.sel.forEach((c, ci) => {
        const kid = kolom[ci].id;
        if (c.gambar) {
          sel[kid] = { jenis: 'gambar', nilai: '', _pdf: wilayahKePdf(c.gambar) };
        } else if (c.teks.length && !c.garis) {
          sel[kid] = { jenis: 'teks', nilai: c.teks.join(' ') };
        } else {
          sel[kid] = { jenis: 'isian', nilai: '' };
          if (c.garis > barisIsian) barisIsian = c.garis;
        }
      });
      return { id: id('r'), sel };
    });
    const tabel = { id: id('b'), tipe: 'tabel', kolom, baris: rows, _cek: true };
    if (barisIsian > 2) tabel.barisIsian = klem(barisIsian, 2, K.barisMaks);
    return tabel;
  };

  for (let i = 0; i < token.length; i++) {
    const t = token[i];
    if (pakai.has(t)) continue;

    if (t.jenis === 'T') {
      blok.push(tabelDariHeader(i));
      adaBlok = true;
      continue;
    }

    if (t.jenis === 'G') {
      nomorJawab++;
      blok.push(bangunSoal('Jawabanmu' + (jumlahTanpaLabel > 1 ? ' ' + nomorJawab : '') + ':', t, null));
      adaBlok = true;
      continue;
    }

    if (t.jenis === 'I') {
      if (gambarTerpasang.has(t)) continue;
      // gambar berurutan tanpa teks di antaranya jadi satu blok gambar
      const item = [itemGambar(t.w)];
      pakai.add(t);
      let j = i + 1;
      while (j < token.length && token[j].jenis === 'I' && !pakai.has(token[j]) && !gambarTerpasang.has(token[j])) {
        item.push(itemGambar(token[j].w));
        pakai.add(token[j]);
        j++;
      }
      blok.push({ id: id('b'), tipe: 'gambar', item: item.slice(0, 20), _cek: true });
      adaBlok = true;
      continue;
    }

    // paragraf
    pakai.add(t);
    if (t.judul) {
      blok.push({ id: id('b'), tipe: 'teks', isi: t.teks, _cek: true });
      adaBlok = true;
      continue;
    }

    // kandidat soal: teks + kotak jawaban tepat di bawahnya (bisa dengan gambar di antaranya)
    let g = t.g;
    let gambarSoal = pasangan.get(t) ? pasangan.get(t).w : null;
    if (!g) {
      const n1 = berikut(i);
      const n2 = n1 ? berikut(token.indexOf(n1)) : null;
      if (adaBlok && n1 && n1.jenis === 'I' && !gambarTerpasang.has(n1) && n2 && n2.jenis === 'G' && n2.g.t0 - n1.w.t1 <= 80) {
        g = n2;
        gambarSoal = n1.w;
        pakai.add(n1);
      }
    }
    // bagian awal tanpa blok = petunjuk, kecuali jelas-jelas label soal (bertanda ":" / "?" / "nomor")
    const jadiSoal = g && (adaBlok || adalahPenandaSoal(t.teks) || gambarSoal);
    if (jadiSoal) {
      blok.push(bangunSoal(t.teks, g, gambarSoal));
      adaBlok = true;
    } else if (!adaBlok) {
      petunjuk.push(t.teks);
    } else {
      blok.push({ id: id('b'), tipe: 'teks', isi: t.teks, _cek: true });
    }
  }

  return { judul: judulBuf.join(' '), petunjuk: petunjuk.join(' '), blok };
}

/**
 * Fungsi murni (mudah diuji): halaman terstruktur -> draf isi_json.
 * halaman: [{ items:[{str,x,t,w,h}], garis?, kotak?, gambarRaster?, lebar?, tinggi?, jumlahGambar? }]
 *   (items dinormalisasi oleh parsePdfKeDraf; koordinat t dihitung dari atas halaman)
 * opsi: { lewatiSampul: true }
 */
export function bangunDrafDariHalaman(halaman, opsi = {}) {
  const lewatiSampul = opsi.lewatiSampul !== false;
  const idSet = new Set();

  const dataHalaman = halaman.map((h) => {
    const items = h.items || [];
    const lebar = h.lebar || 595;
    const tinggi = h.tinggi || 842;
    const adaGeometri = Array.isArray(h.garis) || Array.isArray(h.kotak) || Array.isArray(h.gambarRaster);
    const wilayah = adaGeometri
      ? cariWilayahGambar({ kotak: h.kotak || [], gambar: h.gambarRaster || [], garis: h.garis || [], items, lebar, tinggi })
      : [];
    // teks yang berada di dalam gambar (angka penanda, label ilustrasi) ikut gambar
    const itemAlur = items.filter((it) => !wilayah.some((w) => dalam(it.x + it.w / 2, it.t - it.h * 0.3, w)));
    return {
      baris: kelompokkanBaris(itemAlur),
      garis: h.garis || [],
      gambar: wilayah,
      jumlahGambar: h.jumlahGambar || 0,
      adaGeometri
    };
  });

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
  let gambarTerdeteksi = 0;

  dataHalaman.forEach((h, idx) => {
    if (lewatiSampul && idx === 0 && dataHalaman.length > 1) {
      sampulDilewati = true;
      return;
    }
    if (!h.baris.length && !h.gambar.length && !h.jumlahGambar) return;

    const hasil = susunBagian({ baris: h.baris, garis: h.garis, gambar: h.gambar, hal: idx + 1, batasJudul, idSet });

    // cadangan: tanpa data geometri, jumlah gambar raster jadi blok gambar kosong di akhir
    if (!h.adaGeometri && h.jumlahGambar > 0) {
      const item = [];
      for (let g = 0; g < Math.min(h.jumlahGambar, 20); g++) item.push({ url: '', caption: '' });
      hasil.blok.push({ id: buatIdAcak('b', idSet), tipe: 'gambar', item, _cek: true });
    }

    gambarTerdeteksi += h.gambar.length;
    bagian.push({
      id: buatIdAcak('s', idSet),
      judul: hasil.judul || 'Halaman ' + (idx + 1),
      petunjuk: hasil.petunjuk,
      blok: hasil.blok
    });
  });

  return {
    isi: { versi: 1, bagian: bagian.slice(0, 50) },
    info: { halaman: halaman.length, sampulDilewati, medianFont: med, gambarTerdeteksi }
  };
}

/**
 * Baca file PDF (File/ArrayBuffer) di browser -> draf isi_json.
 * opsi.pdfjs: pustaka pdf.js alternatif (untuk pengujian di Node).
 */
export async function parsePdfKeDraf(fileOrBuffer, opsi = {}) {
  const lib = opsi.pdfjs || (typeof pdfjsLib !== 'undefined' ? pdfjsLib : null);
  if (!lib) throw new Error('pdf.js belum dimuat. Periksa koneksi internet lalu muat ulang.');
  const buffer = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const pdf = await lib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
  const halaman = [];
  const OPS = lib.OPS || {};

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const ke = (x, y) => {
      const q = vp.convertToViewportPoint(x, y);
      return [q[0], q[1]];
    };
    const tc = await page.getTextContent();
    const items = normalisasiItem(tc.items, ke);
    let geo = { kotak: [], gambar: [], garis: [] };
    let geometriOk = true;
    try {
      const ol = await page.getOperatorList();
      geo = jalaniOperator(ol, OPS, ke);
    } catch (e) {
      geometriOk = false;
    }
    halaman.push({
      items,
      lebar: vp.width,
      tinggi: vp.height,
      kotak: geometriOk ? geo.kotak : undefined,
      gambarRaster: geometriOk ? geo.gambar : undefined,
      garis: geometriOk ? geo.garis : undefined,
      jumlahGambar: geo.gambar.length
    });
  }
  const hasil = bangunDrafDariHalaman(halaman, opsi);
  if (pdf.destroy) {
    try { await pdf.destroy(); } catch (e) { /* abaikan */ }
  }
  return hasil;
}
