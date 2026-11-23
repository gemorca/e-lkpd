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
        items: b.items,
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

function adalahPutih(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  return Boolean(m) && [m[1], m[2], m[3]].every((c) => parseInt(c, 16) >= 245);
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
  const tegak = [];
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
    } else if (w <= K.garisMaxTebal && h >= 12) {
      tegak.push({ x: (v.x0 + v.x1) / 2, t0: v.t0, t1: v.t1 }); // garis tegak: tanda kisi tabel / bingkai
    } else if (w <= K.garisMaxTebal || h <= K.garisMaxTebal) return; // hiasan tipis
    else kotak.push({ ...v, warna, bingkai: Boolean(bingkai) });
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
  return { kotak, gambar, garis, tegak };
}

/**
 * Buang garis datar yang sebenarnya bagian kisi tabel atau bingkai: ujungnya menyentuh garis tegak.
 * Garis jawaban asli berujung bebas.
 */
export function saringGarisKisi(garis, tegak) {
  if (!tegak || !tegak.length) return garis;
  return garis.filter((g) => !tegak.some((v) => (Math.abs(v.x - g.x0) <= 3 || Math.abs(v.x - g.x1) <= 3) && v.t0 <= g.t + 3 && v.t1 >= g.t - 3));
}

/**
 * Buang garis yang berada tepat di atas teks dan membentang selebar teks itu
 * (garis batas paragraf / coretan dari Word), bukan kotak jawaban.
 */
export function buangGarisPalsu(garis, baris) {
  return garis.filter((g) => !baris.some((b) => {
    const atas = b.t - b.ukuran - 16;
    if (g.t < atas || g.t > b.t + 1) return false;
    const irisan = Math.min(g.x1, b.x1) - Math.max(g.x0, b.x0);
    return irisan >= 0.7 * (g.x1 - g.x0) && g.t < b.t - b.ukuran * 0.3;
  }));
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
  const teksSemua = items.map((it) => ({ px: it.x + it.w / 2, pt: it.t - it.h * 0.3 }));
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
    if (k.bingkai && luas >= K.panelMinLuas) return false; // bingkai tanpa isi: garis kotak/tabel, bukan gambar
    if (luas >= K.panelMinLuas && adalahPutih(k.warna) && teksSemua.some((p) => dalam(p.px, p.pt, k))) return false; // sel tabel putih berisi teks
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

export function kelompokGaris(garis, teksBaris = []) {
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
      // garis pertama menerima jarak hingga 46 pt; berikutnya mengikuti jarak antar-garis sebelumnya
      const batasJarak = k.n === 1 ? 46 : Math.min(K.garisSusunMaks, k.jarak * 1.5 + 6);
      // teks yang berada di antara dua garis memisahkan keduanya (label soal berikutnya)
      const adaTeks = teksBaris.some((b) => b.t > k.tAkhir + 2 && b.t < g.t - 2
        && Math.min(g.x1, b.x1) - Math.max(g.x0, b.x0) >= 0.3 * Math.min(g.x1 - g.x0, b.x1 - b.x0));
      return !adaTeks && irisan >= lebarMin * 0.6 && g.t >= k.tAkhir && g.t - k.tAkhir <= batasJarak;
    });
    if (cocok) {
      cocok.x0 = Math.min(cocok.x0, g.x0);
      cocok.x1 = Math.max(cocok.x1, g.x1);
      cocok.jarak = g.t - cocok.tAkhir;
      cocok.tAkhir = g.t;
      cocok.n++;
    } else {
      grup.push({ x0: g.x0, x1: g.x1, t0: g.t, tAkhir: g.t, n: 1, jarak: 0 });
    }
  });
  return grup.map((k) => ({ x0: k.x0, x1: k.x1, t0: k.t0, t1: k.tAkhir, n: k.n }));
}

/* ---------- halaman berupa gambar (scan): OCR dan garis dari piksel ---------- */

/**
 * Baris hasil OCR [{ words:[{text,x0,y0,x1,y1}] }] (piksel) -> item teks (poin PDF).
 * Garis dasar tiap baris dihitung dari median bawah kata, agar kata berekor (g, y, p)
 * tetap sebaris.
 */
export function itemDariOcr(barisOcr, skala) {
  const out = [];
  (barisOcr || []).forEach((ln) => {
    const ws = (ln.words || [])
      .map((w) => (w && w.text !== undefined ? { ...w, text: String(w.text).replace(/^[|¦]+|[|¦]+$/g, '').trim() } : w))
      .filter((w) => w && w.text && !/^[|¦_\-—–=~]+$/.test(w.text));
    if (!ws.length) return;
    const dasar = median(ws.map((w) => w.y1));
    const tinggi = median(ws.map((w) => w.y1 - w.y0)) * 1.15;
    ws.forEach((w) => out.push({
      str: String(w.text).trim(),
      x: w.x0 / skala,
      t: dasar / skala,
      w: (w.x1 - w.x0) / skala,
      h: (tinggi * 0.85) / skala
    }));
  });
  return out;
}

/**
 * Cari garis jawaban pada gambar halaman (skala abu-abu 0..255, 1 piksel = 1/skala poin).
 * Garis jawaban: garis datar tipis, kedua sisinya putih, ujungnya bebas.
 * Bingkai panel dan kisi tabel dibuang (sisinya berwarna / ujungnya bertemu garis tegak).
 */
export function garisDariPiksel(abu, lebarPx, tinggiPx, skala) {
  const GELAP = 215;
  const PUTIH = 242;
  const minLari = Math.round(K.garisMinPanjang * skala);
  const maxTebal = Math.max(3, Math.round(K.garisMaxTebal * skala));

  const lari = [];
  for (let y = 0; y < tinggiPx; y++) {
    const baris = y * lebarPx;
    let x = 0;
    while (x < lebarPx) {
      if (abu[baris + x] < GELAP) {
        const x0 = x;
        while (x < lebarPx && abu[baris + x] < GELAP) x++;
        if (x - x0 >= minLari) lari.push({ y, x0, x1: x });
      } else x++;
    }
  }
  // gabung lari pada baris piksel yang berurutan
  const kumpul = [];
  lari.forEach((r) => {
    const k = kumpul.find((q) => q.y1 === r.y - 1 || q.y1 === r.y);
    const cocok = kumpul.find((q) => r.y - q.y1 <= 1 && Math.min(q.x1, r.x1) - Math.max(q.x0, r.x0) >= 0.8 * Math.min(q.x1 - q.x0, r.x1 - r.x0));
    if (cocok) {
      cocok.y1 = r.y;
      cocok.x0 = Math.min(cocok.x0, r.x0);
      cocok.x1 = Math.max(cocok.x1, r.x1);
    } else if (!k || true) kumpul.push({ y0: r.y, y1: r.y, x0: r.x0, x1: r.x1 });
  });

  const putihDi = (y, x0, x1) => {
    if (y < 0 || y >= tinggiPx) return true;
    let putih = 0;
    let n = 0;
    for (let x = x0 + 2; x < x1 - 2; x += 2) {
      n++;
      if (abu[y * lebarPx + x] >= PUTIH) putih++;
    }
    return n === 0 || putih / n >= 0.85;
  };

  const tipis = kumpul.filter((g) => g.y1 - g.y0 + 1 <= maxTebal);
  const datar = tipis.map((g) => ({ x0: g.x0 / skala, x1: g.x1 / skala, t: (g.y0 + g.y1) / 2 / skala }));
  const garis = tipis
    .filter((g) => putihDi(g.y0 - 5, g.x0, g.x1) && putihDi(g.y1 + 5, g.x0, g.x1))
    .filter((g) => g.y0 / skala > 40 && g.y1 / skala < tinggiPx / skala - 40) // bingkai halaman
    .map((g) => ({ x0: g.x0 / skala, x1: g.x1 / skala, t: (g.y0 + g.y1) / 2 / skala, warna: '#000000' }));

  // garis tegak (untuk mengenali kisi tabel)
  const minTegak = Math.round(12 * skala);
  const tegak = [];
  for (let x = 0; x < lebarPx; x++) {
    let y = 0;
    while (y < tinggiPx) {
      if (abu[y * lebarPx + x] < GELAP) {
        const y0 = y;
        while (y < tinggiPx && abu[y * lebarPx + x] < GELAP) y++;
        if (y - y0 >= minTegak) tegak.push({ x: x / skala, t0: y0 / skala, t1: y / skala });
      } else y++;
    }
  }
  return { garis: saringGarisKisi(garis, tegak), datar, tegak };
}

/**
 * Kenali tabel berkisi (garis datar + tegak) dari hasil garisDariPiksel.
 * Hasil: [{ x:[batas kolom], t:[batas baris], x0,x1,t0,t1 }]. Garis bingkai halaman (sangat panjang) diabaikan.
 */
export function cariKisiTabel(datar, tegak, tinggiHal) {
  // gabung garis tegak sejajar menjadi garis kolom; hanya yang panjang total >= 60 pt
  const kol = [];
  [...tegak].sort((a, b) => a.x - b.x).forEach((v) => {
    if (v.t1 - v.t0 > tinggiHal * 0.55) return; // bingkai halaman
    const sama = kol.find((q) => Math.abs(q.x - v.x) <= 4);
    if (sama) sama.seg.push([v.t0, v.t1]);
    else kol.push({ x: v.x, seg: [[v.t0, v.t1]] });
  });
  const seg = [];
  kol.forEach((k) => {
    const urut = k.seg.sort((a, b) => a[0] - b[0]);
    const gab = [];
    urut.forEach((r) => {
      const last = gab[gab.length - 1];
      if (last && r[0] <= last[1] + 3) last[1] = Math.max(last[1], r[1]);
      else gab.push([r[0], r[1]]);
    });
    const terpanjang = Math.max(...gab.map((r) => r[1] - r[0]));
    if (terpanjang < 45) return; // bukan garis kolom (hiasan pojok, huruf, dsb.)
    gab.forEach((r) => seg.push({ x: k.x, t0: r[0], t1: r[1] }));
  });
  seg.sort((a, b) => a.t0 - b.t0);

  const grup = [];
  seg.forEach((v) => {
    const g = grup.find((q) => v.t0 <= q.t1 + 40 && v.t1 >= q.t0 - 40);
    if (g) {
      g.v.push(v);
      g.t0 = Math.min(g.t0, v.t0);
      g.t1 = Math.max(g.t1, v.t1);
    } else grup.push({ v: [v], t0: v.t0, t1: v.t1 });
  });

  const hasil = [];
  grup.forEach((g) => {
    const xs = [];
    g.v.forEach((v) => {
      if (!xs.some((x) => Math.abs(x - v.x) <= 4)) xs.push(v.x);
    });
    xs.sort((a, b) => a - b);
    if (xs.length < 3) return;
    const x0 = xs[0];
    const x1 = xs[xs.length - 1];
    const lebar = x1 - x0;
    const garisBaris = [];
    datar
      .filter((h) => h.t >= g.t0 - 4 && h.t <= g.t1 + 4 && Math.min(h.x1, x1 + 6) - Math.max(h.x0, x0 - 6) >= lebar * 0.6)
      .sort((a, b) => a.t - b.t)
      .forEach((h) => {
        if (!garisBaris.some((t) => Math.abs(t - h.t) <= 3)) garisBaris.push(h.t);
      });
    if (!garisBaris.length || garisBaris[0] > g.t0 + 3) garisBaris.unshift(g.t0);
    if (garisBaris[garisBaris.length - 1] < g.t1 - 3) garisBaris.push(g.t1);
    // interval baris sah bila dilintasi garis tegak (celah kosong antara header dan isi dibuang)
    const t = [];
    for (let i = 0; i < garisBaris.length - 1; i++) {
      const a = garisBaris[i];
      const b = garisBaris[i + 1];
      if (b - a < 8) continue;
      const lintas = g.v.filter((v) => v.t0 <= a + 3 && v.t1 >= b - 3).length;
      if (lintas >= Math.max(2, Math.floor(xs.length / 2))) t.push([a, b]);
    }
    if (t.length) hasil.push({ x: xs, t, x0, x1, t0: t[0][0], t1: t[t.length - 1][1] });
  });
  return hasil;
}

// Tabel berkisi (halaman OCR): kata diletakkan ke sel menurut posisinya.
function bangunTabelKisi(k, items, idSet) {
  const id = (p) => buatIdAcak(p, idSet);
  const sel = (a, b, c, d) => {
    const kata = items
      .filter((it) => {
        const cx = it.x + it.w / 2;
        const cy = it.t - it.h * 0.3;
        return cx >= a && cx <= c && cy >= b && cy <= d;
      })
      .sort((p, q) => p.t - q.t || p.x - q.x);
    // kelompokkan per baris teks di dalam sel
    const baris = [];
    kata.forEach((w) => {
      const last = baris[baris.length - 1];
      if (last && Math.abs(last.t - w.t) <= Math.max(3, w.h * 0.6)) last.w.push(w);
      else baris.push({ t: w.t, w: [w] });
    });
    return baris.map((r) => r.w.sort((p, q) => p.x - q.x).map((w) => w.str.trim()).join(' ')).join(' ').replace(/\s+/g, ' ').trim();
  };
  let grid = k.t.map(([a, b]) => k.x.slice(0, -1).map((x, ci) => sel(x, a, k.x[ci + 1], b)));
  // kolom yang kosong seluruhnya (garis tegak nyasar) dibuang
  const pakaiKolom = grid[0].map((_, ci) => grid.some((r) => r[ci]));
  if (pakaiKolom.some(Boolean)) grid = grid.map((r) => r.filter((_, ci) => pakaiKolom[ci]));
  // baris pertama = header bila semua selnya berisi
  const adaHeader = grid.length > 1 && grid[0].every((c) => c);
  const kolom = (adaHeader ? grid[0] : grid[0].map((_, i) => 'Kolom ' + (i + 1))).map((judul) => ({ id: id('k'), judul }));
  const isiBaris = (adaHeader ? grid.slice(1) : grid).slice(0, 60);
  let barisBlok = isiBaris.map((r) => {
    const sl = {};
    r.forEach((c, ci) => {
      sl[kolom[ci].id] = c && !RE_ISI_KOSONG.test(c) ? { jenis: 'teks', nilai: c } : { jenis: 'isian', nilai: '' };
    });
    return { id: id('r'), sel: sl };
  });
  if (!barisBlok.length) barisBlok = [{ id: id('r'), sel: Object.fromEntries(kolom.map((c) => [c.id, { jenis: 'isian', nilai: '' }])) }];
  return { x0: k.x0, x1: k.x1, t0: k.t0, t1: k.t1, blok: { id: id('b'), tipe: 'tabel', kolom, baris: barisBlok, _cek: true } };
}

/* ---------- penyusun bagian ---------- */

const RE_AKHIR_SOAL = /[:?!]\s*$/;
const RE_LIST = /^(\d{1,2}[.)]|[•●▪◦·]|[-–])\s*\S/;
const RE_NOMOR_SAJA = /^(\d{1,2}[.)]|[•●▪◦·])$/;
const RE_TITIK = /[.…_]{5,}/;
const RE_PLACEHOLDER = /^\(.*(di sini|\.\.\.|…).*\)$/i;
const RE_HURUF_JUDUL = /^[A-Z]\.\s+\S/;
const RE_JUDUL_KATA = /^(PERTEMUAN|KEGIATAN|BAB|LEMBAR KERJA)\b/i;
const RE_MODE_SOAL = /pertanyaan|latihan|soal|analisis|diskusi|refleksi|kesimpulan|evaluasi|tantangan|tugas|uji kompetensi/i;
const RE_KATA_TANYA = /^(hitunglah|jelaskan|tuliskan|tentukan|analisislah|sebutkan|buatlah|mengapa|bagaimana|apa\b|apakah|berapa|ceritakan|rancanglah|simpulkan|diskusikan)/i;
const RE_ISI_KOSONG = /^[.…_\-\s]{3,}$/;

const adalahPenandaSoal = (teks) => RE_AKHIR_SOAL.test(teks) || /\bnomor\b/i.test(teks);

// Baris dengan >=2 segmen pendek => kandidat header tabel
function adalahHeaderTabel(b) {
  if (b.segmen.length < 2 || b.segmen.length > 6) return false;
  if (RE_TITIK.test(b.teks)) return false;
  if (RE_NOMOR_SAJA.test(b.segmen[0].teks)) return false;
  return b.segTeks.every((s) => s.length <= 40 && !/[.?!]\s*$/.test(s));
}

const barisDariGaris = (n) => klem(Math.max(K.barisMin, n), 1, K.barisMaks);

function segarkanBaris(b) {
  b.segTeks = b.segmen.map((s) => s.teks);
  b.teks = b.segTeks.join(' ').trim();
  b.x0 = b.segmen[0].x0;
  b.x1 = b.segmen[b.segmen.length - 1].x1;
  return b;
}

// Penanda daftar ("1." atau "•") yang terpisah dari teksnya digabung kembali.
function rapikanBaris(ls) {
  const out = [];
  for (let i = 0; i < ls.length; i++) {
    let b = ls[i];
    if (b.segmen.length === 2 && RE_NOMOR_SAJA.test(b.segmen[0].teks) && b.segmen[1].teks.length > 15) {
      b = segarkanBaris({ ...b, segmen: [{ teks: b.segmen[0].teks + ' ' + b.segmen[1].teks, x0: b.segmen[0].x0, x1: b.segmen[1].x1 }] });
    }
    if (b.segmen.length === 1 && RE_NOMOR_SAJA.test(b.teks) && ls[i + 1]) {
      const n = ls[i + 1];
      if (n.t - b.t <= Math.max(b.ukuran, n.ukuran) * 2.4 && n.x0 > b.x0) {
        out.push(segarkanBaris({
          ...n,
          segmen: [{ teks: b.teks + ' ' + n.segmen[0].teks, x0: b.x0, x1: n.segmen[0].x1 }, ...n.segmen.slice(1)]
        }));
        i++;
        continue;
      }
    }
    out.push(b);
  }
  return out;
}

function kolomHeaderCocok(kolom, s) {
  let terbaik = -1;
  let jarak = Infinity;
  kolom.forEach((k, i) => {
    // teks header bisa rata tengah atau rata kiri: ambil jarak pusat atau jarak tepi kiri yang terkecil
    const d = Math.min(Math.abs((k.x0 + k.x1) / 2 - (s.x0 + s.x1) / 2), Math.abs(k.x0 - s.x0));
    if (d < jarak) {
      jarak = d;
      terbaik = i;
    }
  });
  return jarak <= 60 ? terbaik : -1;
}

function adalahJudul(b, batasJudul, med) {
  if (b.ukuran >= batasJudul) return true;
  if (b.segmen.length !== 1 || b.teks.length > 80) return false;
  // baris huruf kapital seluruhnya ("PETUNJUK PENGGUNAAN LKPD") = judul
  const huruf = b.teks.replace(/[^A-Za-z]/g, '');
  if (huruf.length >= 6 && b.teks === b.teks.toUpperCase() && !/[.?!:]\s*$/.test(b.teks) && !/\d\s*[=+×x]/.test(b.teks)) return true;
  if (RE_JUDUL_KATA.test(b.teks) && b.teks.length <= 60) return true;
  if (RE_HURUF_JUDUL.test(b.teks) && !/[.!?]\s*$/.test(b.teks)) {
    const hurufBesar = b.teks === b.teks.toUpperCase();
    return hurufBesar || b.ukuran >= med * 1.15;
  }
  return false;
}

const sudahTeks = (blok) => blok.length && blok[blok.length - 1].tipe === 'teks';

/**
 * Susun satu halaman menjadi daftar bagian [{judul, petunjuk, blok}].
 * Bagian pertama boleh berjudul '' (lanjutan bagian dari halaman sebelumnya).
 * data: { baris[], garis[], gambar[], hal, batasJudul, med, tanpaGaris, idSet }
 */
function susunHalaman(data) {
  const { idSet, batasJudul, med } = data;
  const id = (p) => buatIdAcak(p, idSet);

  const gaGaris = kelompokGaris(data.garis, data.baris);
  const token = [];
  (data.tabelKisi || []).forEach((tb) => token.push({ jenis: 'K', blok: tb.blok, atas: tb.t0 }));
  gaGaris.forEach((g) => token.push({ jenis: 'G', g, atas: g.t0 - 6 }));
  data.gambar.forEach((w) => token.push({ jenis: 'I', w, atas: w.t0 }));
  const tahan = token.map((t) => t.atas); // penghalang penggabungan baris lintas-gambar/garis

  // 1) baris -> token (judul, header tabel, isian bertitik-titik, paragraf)
  let P = null;
  let hdr = null;
  let D = null;
  let tabelAktif = null;
  const lepaskan = () => {
    if (P) token.push(P);
    P = null;
  };
  const lepaskanD = () => {
    if (D) token.push(D);
    D = null;
  };
  rapikanBaris(data.baris).forEach((b) => {
    if (adalahJudul(b, batasJudul, med)) {
      lepaskan();
      lepaskanD();
      hdr = null;
      tabelAktif = null;
      token.push({ jenis: 'H', teks: b.teks, atas: b.t - b.ukuran, t: b.t, ukuran: b.ukuran });
      return;
    }
    const lanjutHeader = Boolean(hdr && b.t - hdr.tAkhir <= Math.max(b.ukuran, hdr.ukuran) * 1.9 && b.items && b.items.length
      && !/^\d+$/.test(b.items[0].str.trim()) && !RE_TITIK.test(b.teks));
    if (tabelAktif && (b.t - tabelAktif.tAkhir > 80 || (b.segmen.length === 1 && b.x1 - b.x0 > (tabelAktif.x1 - tabelAktif.x0) * 0.8))) tabelAktif = null;
    if (tabelAktif && !lanjutHeader && b.segmen.length >= 2 && b.segmen.every((s) => (s.x0 + s.x1) / 2 >= tabelAktif.x0 - 40 && (s.x0 + s.x1) / 2 <= tabelAktif.x1 + 40)) {
      // baris isi tabel (mis. "1 | 20 cm | ..... | ....."): jangan dianggap isian bertitik-titik
      lepaskan();
      lepaskanD();
      hdr = null;
      tabelAktif.tAkhir = b.t;
      token.push({ jenis: 'P', item: [b.teks], daftar: false, baris: [b], x0: b.x0, x1: b.x1, atas: b.t - b.ukuran, bawah: b.t + b.ukuran * 0.3, ukuran: b.ukuran, terakhir: b });
      return;
    }
    if (RE_TITIK.test(b.teks)) {
      lepaskan();
      hdr = null;
      const label = b.teks.replace(/[.…_]{5,}/g, '').replace(/\s*\/\s*$/, '').replace(/\s{2,}/g, ' ').trim();
      if (D && b.t - D.t <= b.ukuran * 2.4) {
        D.label.push(label);
        D.t = b.t;
        D.bawah = b.t;
      } else {
        lepaskanD();
        D = { jenis: 'D', label: [label], atas: b.t - b.ukuran, t: b.t, bawah: b.t, ukuran: b.ukuran };
      }
      return;
    }
    lepaskanD();
    if (hdr && b.t - hdr.tAkhir <= Math.max(b.ukuran, hdr.ukuran) * 1.9 && b.items && b.items.length
      && !/^\d+$/.test(b.items[0].str.trim()) && !RE_TITIK.test(b.teks)) {
      // lanjutan header tabel yang terbagi beberapa baris: tiap kata masuk kolom terdekat
      const kol = hdr.baris.segmen;
      const pusat = kol.map((k) => (k.x0 + k.x1) / 2);
      const lebarAwal = Math.min(...kol.map((k) => k.x0)) - 60;
      const lebarAkhir = Math.max(...kol.map((k) => k.x1)) + 60;
      const dalamRentang = b.items.every((it) => it.x >= lebarAwal && it.x + it.w <= lebarAkhir);
      if (dalamRentang) {
        const kolomDi = (px) => {
          let k = 0;
          for (let i = 0; i < pusat.length - 1; i++) if (px > (pusat[i] + pusat[i + 1]) / 2) k = i + 1;
          return k;
        };
        b.items.forEach((it) => {
          const k = kol[kolomDi(it.x + it.w / 2)];
          k.teks += ' ' + it.str.trim();
          k.x0 = Math.min(k.x0, it.x);
          k.x1 = Math.max(k.x1, it.x + it.w);
        });
        hdr.tAkhir = b.t;
        if (tabelAktif) {
          tabelAktif.x0 = Math.min(tabelAktif.x0, ...kol.map((x) => x.x0));
          tabelAktif.x1 = Math.max(tabelAktif.x1, ...kol.map((x) => x.x1));
          tabelAktif.tAkhir = b.t;
        }
        return;
      }
    }
    hdr = null;
    if (adalahHeaderTabel(b)) {
      lepaskan();
      const baris = { segmen: b.segmen.map((s) => ({ ...s })), ukuran: b.ukuran, t: b.t };
      hdr = { jenis: 'T', baris, atas: b.t - b.ukuran, tAkhir: b.t, ukuran: b.ukuran };
      token.push(hdr);
      tabelAktif = { x0: Math.min(...baris.segmen.map((x) => x.x0)), x1: Math.max(...baris.segmen.map((x) => x.x1)), tAkhir: b.t };
      return;
    }
    const mulaiDaftar = RE_LIST.test(b.teks);
    if (P) {
      const jarak = b.t - P.terakhir.t;
      const samaUkuran = Math.abs(b.ukuran - P.ukuran) <= Math.max(1.5, P.ukuran * 0.3);
      const adaPenghalang = tahan.some((u) => u > P.terakhir.t - P.ukuran && u < b.t - b.ukuran);
      if (samaUkuran && !adaPenghalang) {
        if (mulaiDaftar && P.daftar && jarak <= P.ukuran * 2.6) {
          P.item.push(b.teks);
          P.baris.push(b);
          P.terakhir = b;
          P.x1 = Math.max(P.x1, b.x1);
          P.bawah = b.t + b.ukuran * 0.3;
          return;
        }
        const belumSelesai = P.daftar ? true : !RE_AKHIR_SOAL.test(P.item[P.item.length - 1]);
        if (!mulaiDaftar && belumSelesai && jarak <= P.ukuran * 1.9) {
          P.item[P.item.length - 1] += ' ' + b.teks;
          P.baris.push(b);
          P.terakhir = b;
          P.x0 = Math.min(P.x0, b.x0);
          P.x1 = Math.max(P.x1, b.x1);
          P.bawah = b.t + b.ukuran * 0.3;
          return;
        }
      }
      lepaskan();
    }
    P = {
      jenis: 'P', item: [b.teks], daftar: mulaiDaftar, baris: [b], x0: b.x0, x1: b.x1,
      atas: b.t - b.ukuran, bawah: b.t + b.ukuran * 0.3, ukuran: b.ukuran, terakhir: b
    };
  });
  lepaskan();
  lepaskanD();
  token.forEach((t) => {
    if (t.jenis === 'P') t.teks = t.item.join('\n');
  });
  token.sort((p, q) => p.atas - q.atas || (p.jenis === 'I' ? -1 : 1));

  const pakai = new Set();
  const berikut = (i) => {
    for (let j = i + 1; j < token.length; j++) if (!pakai.has(token[j])) return token[j];
    return null;
  };

  // 2) pasangkan gambar di sebelah kiri label soal (ikon per soal)
  token.forEach((t, i) => {
    if (t.jenis !== 'P') return;
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

  // 3) rakit bagian
  const hasil = [];
  let cur = { judul: '', petunjuk: [], blok: [], adaBlok: false, modeSoal: false };
  const kosong = () => !cur.blok.length && !cur.petunjuk.length;
  const tutupBagian = () => {
    if (cur.judul || cur.blok.length || cur.petunjuk.length) hasil.push(cur);
  };
  const wilayahKePdf = (w) => ({ hal: data.hal, x0: w.x0, t0: w.t0, x1: w.x1, t1: w.t1 });
  const itemGambar = (w) => ({ url: '', caption: '', _pdf: wilayahKePdf(w) });
  const tambah = (b) => {
    cur.blok.push(b);
    cur.adaBlok = true;
  };
  const tambahTeks = (teks) => {
    if (sudahTeks(cur.blok)) cur.blok[cur.blok.length - 1].isi += '\n' + teks;
    else tambah({ id: id('b'), tipe: 'teks', isi: teks, _cek: true });
  };
  const soalTeks = (label, baris) => ({ id: id('b'), tipe: 'soal', label, gambar: null, baris, _cek: true });

  const bangunSoal = (label, g, w) => {
    const grup = [g.g];
    pakai.add(g);
    token.forEach((x) => {
      if (x.jenis === 'G' && !pakai.has(x) && Math.abs(x.g.t0 - g.g.t0) <= 14 && (x.g.x0 >= g.g.x1 - 4 || x.g.x1 <= g.g.x0 + 4)) {
        grup.push(x.g);
        pakai.add(x);
      }
    });
    return {
      id: id('b'),
      tipe: 'soal',
      label,
      gambar: w ? itemGambar(w) : null,
      baris: barisDariGaris(grup.reduce((s, q) => s + q.n, 0)),
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

    const isi = [];
    for (let j = idxHeader + 1; j < token.length; j++) {
      const t = token[j];
      if (pakai.has(t)) continue;
      if (t.jenis === 'H' || t.jenis === 'D') break;
      if (t.jenis === 'P' || t.jenis === 'T') {
        const bs = t.jenis === 'T' ? [t.baris] : t.baris;
        const luar = bs.some((b) => (b.ukuran || 0) >= batasJudul
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

    const teksSeg = [];
    isi.forEach((t) => {
      const bs = t.jenis === 'T' ? [t.baris] : t.jenis === 'P' ? t.baris : [];
      bs.forEach((b) => {
        const y = b.t - (b.ukuran || 10) * 0.3;
        if (b.items && b.items.length) b.items.forEach((it) => teksSeg.push({ y, x: it.x + it.w / 2, teks: it.str.trim() }));
        else b.segmen.forEach((sg) => teksSeg.push({ y, x: (sg.x0 + sg.x1) / 2, teks: sg.teks }));
      });
    });
    teksSeg.sort((a, b) => a.y - b.y || a.x - b.x);
    // baris tabel teks: kata sebaris dalam toleransi yang sama dianggap satu baris
    teksSeg.forEach((s) => {
      s.y = Math.round(s.y * 2) / 2;
    });

    // posisi baris tabel: gambar dan garis jawaban lebih dipercaya; tanpa keduanya, tiap baris teks
    const barisPos = [];
    const kuat = [];
    isi.forEach((t) => {
      if (t.jenis === 'I') kuat.push(pusatT(t.w));
      else if (t.jenis === 'G') kuat.push(pusatT({ t0: t.g.t0, t1: t.g.t1 }));
    });
    kuat.sort((a, b) => a - b).forEach((y) => {
      const dekat = barisPos.find((b) => Math.abs(b.y - y) < 45);
      if (dekat) {
        dekat.y = (dekat.y * dekat.n + y) / (dekat.n + 1);
        dekat.n++;
      } else barisPos.push({ y, yAkhir: y, n: 1 });
    });
    if (!kuat.length) {
      teksSeg.forEach((s) => {
        const last = barisPos[barisPos.length - 1];
        if (last && s.y - last.yAkhir < h.ukuran * 1.6) last.yAkhir = s.y;
        else barisPos.push({ y: s.y, yAkhir: s.y, n: 1 });
      });
    } else {
      teksSeg.forEach((s) => {
        const jarak = Math.min(...barisPos.map((b) => Math.abs(b.y - s.y)));
        if (jarak > 70) barisPos.push({ y: s.y, yAkhir: s.y, n: 1 });
      });
    }
    barisPos.sort((a, b) => a.y - b.y);

    const cariBaris = (y) => {
      let k = -1;
      barisPos.forEach((b, i) => {
        if (y >= b.y - h.ukuran * 0.8 && y <= b.yAkhir + h.ukuran * 0.8 && k === -1) k = i;
      });
      if (k !== -1) return k;
      let jarak = Infinity;
      barisPos.forEach((b, i) => {
        const d = Math.abs(b.y - y);
        if (d < jarak) {
          jarak = d;
          k = i;
        }
      });
      return Math.max(0, k);
    };

    const barisTabel = barisPos.map(() => ({ sel: kolomX.map(() => ({ gambar: null, teks: [], garis: 0 })) }));
    isi.forEach((t) => {
      if (t.jenis === 'I') barisTabel[cariBaris(pusatT(t.w))].sel[kolomIdx(pusatX(t.w))].gambar = t.w;
      else if (t.jenis === 'G') barisTabel[cariBaris(pusatT({ t0: t.g.t0, t1: t.g.t1 }))].sel[kolomIdx(pusatX(t.g))].garis += t.g.n;
    });
    teksSeg.forEach((s) => {
      if (!RE_ISI_KOSONG.test(s.teks)) barisTabel[cariBaris(s.y)].sel[kolomIdx(s.x)].teks.push(s.teks);
    });

    if (!isi.length) return null;
    isi.forEach((t) => pakai.add(t));
    pakai.add(token[idxHeader]);
    if (!barisTabel.length) barisTabel.push({ sel: kolomX.map(() => ({ gambar: null, teks: [], garis: 3 })) });

    const kolom = h.segmen.map((s) => ({ id: id('k'), judul: s.teks }));
    let barisIsian = 2;
    const rows = barisTabel.map((r) => {
      const sel = {};
      r.sel.forEach((c, ci) => {
        const kid = kolom[ci].id;
        if (c.gambar) sel[kid] = { jenis: 'gambar', nilai: '', _pdf: wilayahKePdf(c.gambar) };
        else if (c.teks.length && !c.garis) sel[kid] = { jenis: 'teks', nilai: c.teks.join(' ') };
        else {
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

  let nomorJawab = 0;
  const jumlahG = token.filter((x) => x.jenis === 'G').length;

  for (let i = 0; i < token.length; i++) {
    const t = token[i];
    if (pakai.has(t)) continue;

    if (t.jenis === 'H') {
      pakai.add(t);
      if (kosong() && cur.judul) {
        // judul yang terpotong baris (ukuran sama, rapat) disambung spasi; judul lain dipisah " — "
        const sambung = cur.hUk && Math.abs(cur.hUk - t.ukuran) <= 1.5 && t.t - cur.hT <= t.ukuran * 1.7;
        cur.judul += (sambung ? ' ' : ' — ') + t.teks;
      } else if (kosong()) cur.judul = t.teks;
      else {
        tutupBagian();
        cur = { judul: t.teks, petunjuk: [], blok: [], adaBlok: false, modeSoal: false };
      }
      cur.hUk = t.ukuran;
      cur.hT = t.t;
      cur.modeSoal = data.tanpaGaris && RE_MODE_SOAL.test(cur.judul);
      continue;
    }

    if (t.jenis === 'K') {
      pakai.add(t);
      tambah(t.blok);
      continue;
    }

    if (t.jenis === 'T') {
      const tb = tabelDariHeader(i);
      if (tb) {
        tambah(tb);
        continue;
      }
      // dua segmen sebaris tanpa isi di bawahnya (mis. "Alokasi Waktu : 2 x 45 Menit"): teks biasa
      const teksT = t.baris.segmen.map((x) => x.teks).join(' ');
      if (!cur.adaBlok && !cur.petunjuk.length) cur.petunjuk.push(teksT);
      else tambahTeks(teksT);
      continue;
    }

    if (t.jenis === 'G') {
      pakai.add(t);
      nomorJawab++;
      tambah(bangunSoal('Jawabanmu' + (jumlahG > 1 ? ' ' + nomorJawab : '') + ':', t, null));
      continue;
    }

    if (t.jenis === 'I') {
      if (gambarTerpasang.has(t)) continue;
      const item = [itemGambar(t.w)];
      pakai.add(t);
      let j = i + 1;
      while (j < token.length && token[j].jenis === 'I' && !pakai.has(token[j]) && !gambarTerpasang.has(token[j])) {
        item.push(itemGambar(token[j].w));
        pakai.add(token[j]);
        j++;
      }
      tambah({ id: id('b'), tipe: 'gambar', item: item.slice(0, 20), _cek: true });
      continue;
    }

    if (t.jenis === 'D') {
      // isian bertitik-titik ("Nama : ........") -> soal singkat
      pakai.add(t);
      tambah(soalTeks(t.label.filter(Boolean).join('\n') || 'Isian:', t.label.length > 1 ? Math.min(t.label.length + 1, K.barisMaks) : 1));
      continue;
    }

    // paragraf
    pakai.add(t);

    // petunjuk pengisian ("(Tuliskan kesimpulan di sini...)") bukan konten
    if (!t.daftar && RE_PLACEHOLDER.test(t.teks)) {
      const last = cur.blok[cur.blok.length - 1];
      if (last && last.tipe === 'soal') last.baris = Math.max(last.baris, 6);
      continue;
    }

    // kandidat soal: teks + kotak jawaban tepat di bawahnya (bisa dengan gambar di antaranya)
    let g = t.g;
    let gambarSoal = pasangan.get(t) ? pasangan.get(t).w : null;
    if (!g) {
      const n1 = berikut(i);
      const n2 = n1 ? berikut(token.indexOf(n1)) : null;
      if (cur.adaBlok && n1 && n1.jenis === 'I' && !gambarTerpasang.has(n1) && n2 && n2.jenis === 'G' && n2.g.t0 - n1.w.t1 <= 80) {
        g = n2;
        gambarSoal = n1.w;
        pakai.add(n1);
      }
    }
    const jadiSoalGaris = Boolean(g);
    if (jadiSoalGaris) {
      const teksLabel = t.daftar && t.item.length > 1 ? t.item.join('\n') : t.teks;
      tambah(bangunSoal(teksLabel, g, gambarSoal));
      continue;
    }

    // soal tanpa kotak jawaban (dokumen teks biasa): butir bernomor / pertanyaan di bagian latihan
    const kata = (x) => RE_KATA_TANYA.test(x.replace(/^(\d{1,2}[.)]|[•●▪◦·])\s*/, ''));
    const butirSoal = (x) => /[?!]\s*$/.test(x) || kata(x) || (cur.modeSoal && (RE_LIST.test(x) || /:\s*$/.test(x)));
    if (cur.modeSoal || (data.tanpaGaris && t.item.some(butirSoal))) {
      const butir = t.item.filter((x) => x.trim());
      if (cur.modeSoal || butir.every(butirSoal)) {
        butir.forEach((x) => tambah(soalTeks(x, 4)));
        continue;
      }
    }

    if (!t.daftar && /^[^.?!]{3,40}:\s*$/.test(t.teks) && cur.adaBlok) {
      tambah(soalTeks(t.teks, 4));
      continue;
    }
    if (!cur.adaBlok && !cur.petunjuk.length && t.teks.length <= 300 && !t.daftar) cur.petunjuk.push(t.teks);
    else tambahTeks(t.teks);
  }
  tutupBagian();
  return hasil.map((b) => ({ judul: b.judul, petunjuk: b.petunjuk.join('\n'), blok: b.blok }));
}

/**
 * Fungsi murni (mudah diuji): halaman terstruktur -> draf isi_json.
 * halaman: [{ items:[{str,x,t,w,h}], garis?, tegak?, kotak?, gambarRaster?, lebar?, tinggi?, jumlahGambar? }]
 *   (items dinormalisasi oleh parsePdfKeDraf; koordinat t dihitung dari atas halaman)
 * opsi: { lewatiSampul: true }
 */
export function bangunDrafDariHalaman(halaman, opsi = {}) {
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
    const tabelKisi = (h.kisi || []).map((k) => bangunTabelKisi(k, items, idSet));
    const diKisi = (it) => tabelKisi.some((k) => dalam(it.x + it.w / 2, it.t - it.h * 0.3, { x0: k.x0 - 2, x1: k.x1 + 2, t0: k.t0 - 2, t1: k.t1 + 2 }));
    const itemAlur = items.filter((it) => !wilayah.some((w) => dalam(it.x + it.w / 2, it.t - it.h * 0.3, w)) && !diKisi(it));
    const baris = rapikanBaris(kelompokkanBaris(itemAlur));
    const garisSaring = buangGarisPalsu(saringGarisKisi(h.garis || [], h.tegak), baris);
    const garis = garisSaring.filter((g) => !tabelKisi.some((k) => g.t >= k.t0 - 2 && g.t <= k.t1 + 2 && g.x0 >= k.x0 - 6 && g.x1 <= k.x1 + 6));
    return { baris, garis, gambar: wilayah, tabelKisi, jumlahGambar: h.jumlahGambar || 0, adaGeometri, ocr: Boolean(h.ocr) };
  });

  // font median per dokumen, berbobot jumlah karakter
  const ukuranKarakter = [];
  dataHalaman.forEach((h) => h.baris.forEach((b) => {
    const n = Math.min(b.jumlahKarakter, 200);
    for (let i = 0; i < n; i += 10) ukuranKarakter.push(Math.round(b.ukuran * 10) / 10);
  }));
  const med = median(ukuranKarakter) || 12;
  // ukuran huruf hasil OCR tidak andal: pada dokumen scan, judul hanya dikenali dari pola teksnya
  const halamanOcr = dataHalaman.filter((h) => h.ocr).length;
  const batasJudul = halamanOcr > dataHalaman.length / 2 ? Infinity : med * 1.4;
  const tanpaGaris = dataHalaman.every((h) => !h.garis.length);

  // sampul: halaman pertama tanpa judul berhuruf ("A. ...") dilewati
  const adaJudulHuruf = (h) => h.baris.some((b) => b.segmen.length === 1 && RE_HURUF_JUDUL.test(b.teks) && b.teks.length <= 80);
  const lewatiSampul = opsi.lewatiSampul !== false && dataHalaman.length > 1 && !adaJudulHuruf(dataHalaman[0]);

  const bagian = [];
  let gambarTerdeteksi = 0;

  dataHalaman.forEach((h, idx) => {
    if (lewatiSampul && idx === 0) return;
    if (!h.baris.length && !h.gambar.length && !h.jumlahGambar) return;

    const daftar = susunHalaman({ baris: h.baris, garis: h.garis, gambar: h.gambar, tabelKisi: h.tabelKisi, hal: idx + 1, batasJudul, med, tanpaGaris, idSet });

    // cadangan: tanpa data geometri, jumlah gambar raster jadi blok gambar kosong di akhir
    if (!h.adaGeometri && h.jumlahGambar > 0) {
      const item = [];
      for (let g = 0; g < Math.min(h.jumlahGambar, 20); g++) item.push({ url: '', caption: '' });
      if (!daftar.length) daftar.push({ judul: '', petunjuk: '', blok: [] });
      daftar[daftar.length - 1].blok.push({ id: buatIdAcak('b', idSet), tipe: 'gambar', item, _cek: true });
    }
    gambarTerdeteksi += h.gambar.length;

    daftar.forEach((b, n) => {
      if (n === 0 && !b.judul && bagian.length) {
        // lanjutan bagian dari halaman sebelumnya
        const last = bagian[bagian.length - 1];
        const susulan = [];
        if (b.petunjuk) susulan.push({ id: buatIdAcak('b', idSet), tipe: 'teks', isi: b.petunjuk, _cek: true });
        susulan.push(...b.blok);
        susulan.forEach((x) => {
          const akhir = last.blok[last.blok.length - 1];
          if (x.tipe === 'teks' && akhir && akhir.tipe === 'teks') akhir.isi += '\n' + x.isi;
          else last.blok.push(x);
        });
        return;
      }
      bagian.push({ id: buatIdAcak('s', idSet), judul: b.judul || 'Halaman ' + (idx + 1), petunjuk: b.petunjuk, blok: b.blok });
    });
  });

  return {
    isi: { versi: 1, bagian: bagian.slice(0, 50) },
    info: {
      halaman: dataHalaman.length,
      sampulDilewati: lewatiSampul,
      medianFont: med,
      gambarTerdeteksi,
      halamanOcr: dataHalaman.filter((h) => h.ocr).length
    }
  };
}

/* ---------- baca PDF di browser ---------- */

const SKALA_OCR = 2.2;

async function bacaHalamanOcr(page, vp, pekerja, lib) {
  const skala = SKALA_OCR;
  const kanvas = document.createElement('canvas');
  const v = page.getViewport({ scale: skala });
  kanvas.width = Math.round(v.width);
  kanvas.height = Math.round(v.height);
  const ctx = kanvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, kanvas.width, kanvas.height);
  await page.render({ canvasContext: ctx, viewport: v }).promise;

  const baris = await pekerja.kenaliBaris(kanvas);
  const items = itemDariOcr(baris, skala);

  const px = ctx.getImageData(0, 0, kanvas.width, kanvas.height).data;
  const abu = new Uint8Array(kanvas.width * kanvas.height);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) abu[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
  const gp = garisDariPiksel(abu, kanvas.width, kanvas.height, skala);
  return { items, garis: gp.garis, tegak: gp.tegak, kisi: cariKisiTabel(gp.datar, gp.tegak, vp.height) };
}

/**
 * Baca file PDF (File/ArrayBuffer) di browser -> draf isi_json.
 * Halaman yang hanya berisi gambar (hasil scan / tangkapan layar) dibaca dengan OCR.
 * opsi.pdfjs: pustaka pdf.js alternatif (untuk pengujian di Node).
 * opsi.pekerjaOcr: { kenaliBaris(canvas), akhiri() } (untuk pengujian).
 * opsi.onProgres(teks): kabar kemajuan untuk UI.
 */
export async function parsePdfKeDraf(fileOrBuffer, opsi = {}) {
  const lib = opsi.pdfjs || (typeof pdfjsLib !== 'undefined' ? pdfjsLib : null);
  if (!lib) throw new Error('pdf.js belum dimuat. Periksa koneksi internet lalu muat ulang.');
  const buffer = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
  const pdf = await lib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise;
  const halaman = [];
  const OPS = lib.OPS || {};
  let pekerja = opsi.pekerjaOcr || null;
  let gagalOcr = false;

  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      if (opsi.onProgres) opsi.onProgres(`Membaca halaman ${p} dari ${pdf.numPages}...`);
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const ke = (x, y) => {
        const q = vp.convertToViewportPoint(x, y);
        return [q[0], q[1]];
      };
      const tc = await page.getTextContent();
      let items = normalisasiItem(tc.items, ke);
      let geo = { kotak: [], gambar: [], garis: [], tegak: [] };
      let geometriOk = true;
      try {
        const ol = await page.getOperatorList();
        geo = jalaniOperator(ol, OPS, ke);
      } catch (e) {
        geometriOk = false;
      }

      // halaman gambar: hampir tidak ada teks, satu gambar raster menutupi halaman
      const luasHal = vp.width * vp.height;
      const penuh = geo.gambar.some((g) => (g.x1 - g.x0) * (g.t1 - g.t0) > luasHal * 0.6);
      let ocr = false;
      let kisi = [];
      if (items.length < 5 && penuh && !gagalOcr) {
        try {
          if (!pekerja) {
            if (opsi.onProgres) opsi.onProgres('Menyiapkan OCR (pertama kali agak lama)...');
            const mod = await import('./ocr-labels.js');
            pekerja = await mod.buatPekerjaDokumen('ind');
          }
          if (opsi.onProgres) opsi.onProgres(`Halaman ${p} berupa gambar, membaca dengan OCR...`);
          const o = await bacaHalamanOcr(page, vp, pekerja, lib);
          items = o.items;
          geo = { kotak: [], gambar: [], garis: o.garis, tegak: o.tegak };
          kisi = o.kisi;
          ocr = true;
        } catch (err) {
          console.warn('OCR gagal:', err);
          gagalOcr = true;
        }
      }

      halaman.push({
        items,
        lebar: vp.width,
        tinggi: vp.height,
        kotak: geometriOk ? geo.kotak : undefined,
        gambarRaster: geometriOk ? (ocr ? [] : geo.gambar) : undefined,
        garis: geometriOk ? geo.garis : undefined,
        tegak: geo.tegak,
        kisi,
        jumlahGambar: ocr ? 0 : geo.gambar.length,
        ocr
      });
    }
  } finally {
    if (pekerja && pekerja.akhiri && !opsi.pekerjaOcr) {
      try { await pekerja.akhiri(); } catch (e) { /* abaikan */ }
    }
    if (pdf.destroy) {
      try { await pdf.destroy(); } catch (e) { /* abaikan */ }
    }
  }
  const hasil = bangunDrafDariHalaman(halaman, opsi);
  hasil.info.ocrGagal = gagalOcr;
  return hasil;
}
