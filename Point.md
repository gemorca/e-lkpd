# Point.md: serah terima proyek E-LKPD (ubah LKPD PDF overlay menjadi form teks terstruktur)

Dokumen ini untuk melanjutkan pekerjaan di chat atau akun lain. Baca seluruhnya sebelum menulis kode.

## 0. Cara memulai di chat baru

1. Unggah ke chat baru: `repomix-output.xml` (kode frontend), `Kode.gs` versi TERBARU (dari zip tahap terakhir), contoh PDF LKPD, dan berkas ini.
2. Minta Claude: "Baca Point.md, lalu lanjutkan dari Tahap yang statusnya BELUM."
3. Pengguna menyukai gaya jawaban ringkas (mode `/caveman`) dan bahasa Indonesia. Kode, komentar, dan dokumen tetap ditulis normal.
4. Aturan kerja yang disepakati: logika dulu, tampilan paling akhir (Tahap 6). Setiap tahap diserahkan sebagai patch .zip beserta Point.md terbaru. Jangan lanjut ke tahap berikutnya sebelum pengguna konfirmasi.

## 1. Proyek

- Aplikasi: E-LKPD Interaktif IPA STEAM. PWA, JavaScript ES Module tanpa build, Tailwind via CDN, backend Google Apps Script (`Kode.gs`), data di Google Sheets, gambar dan PDF di Drive.
- Peran: tamu, siswa, guru, admin. Auth memakai token HMAC buatan sendiri (`issueToken_`, `authenticate_`).
- Struktur frontend: lihat README di `repomix-output.xml`. File penting untuk pekerjaan ini: `js/views/lkpd.js`, `js/views/guru.js`, `js/services/ocr.js`, `js/services/api.js`, `js/services/idb.js`, `js/components/modal.js`, `index.html`, `sw.js`, `js/main.js`, `js/components/drawer.js`.
- `Kode.gs` ada di `.gitignore`, jadi tidak ikut repo. Gunakan versi dari zip terakhir.

## 2. Masalah dan tujuan

Klien (penelitian) melaporkan siswa kesulitan mengisi LKPD langsung di atas PDF (canvas, zoom, kolom kecil). Klien meminta:
- LKPD tidak lagi ditampilkan sebagai PDF yang diisi langsung.
- PDF yang diunggah guru dikonversi menjadi teks terstruktur yang menyesuaikan isinya (bagian, petunjuk, soal, tabel).
- Gambar tidak ikut terkonversi. Soal bergambar menampilkan tombol unggah gambar untuk GURU, supaya siswa bisa melihat gambarnya.

## 3. Keputusan terkunci

- Guru yang mengunggah PDF dan gambar. Siswa hanya mengisi dan melihat.
- PDF LKPD hanya diparse di browser, tidak disimpan di Drive.
- LKPD lama (overlay) dibuang total: tanpa mode cadangan, tanpa migrasi. Jawaban lama berformat `lkpd_isian` tetap terbaca guru secara sederhana (pasangan kunci dan nilai).
- Jenis isi: `teks`, `gambar`, `soal`, `tabel`. Tidak ada pilihan ganda atau centang (semua LKPD klien isian teks).
- Tidak ada fitur kelompok (satu perangkat, satu akun).
- Maksimal 1.000 karakter per kolom jawaban. Maksimal 45.000 karakter untuk `isi_json` dan `jawaban_json` (batas sel Sheets 50.000).
- Kirim hanya sekali, dipaksa di backend.
- Salah kirim ditangani tombol "Buka Kembali" (pilihan B): jawaban tidak dihapus, status menjadi `Dibuka Kembali`, siswa melihat form dengan jawaban lama terisi, mengedit, lalu kirim ulang. Kirim ulang menimpa baris yang sama dan mengosongkan nilai dan catatan lama.
- Alat "Potong dari PDF" (guru memotong gambar dari halaman PDF) disetujui sebagai tambahan setelah inti selesai.

## 4. Kontrak data (jangan diubah tanpa menyesuaikan backend)

Kolom baru `isi_json` di sheet `lkpd` (dibuat otomatis oleh `handleSaveLkpd`):

    { "versi": 1,
      "bagian": [
        { "id": "b1", "judul": "Perubahan Energi di Sekitar Kita", "petunjuk": "...",
          "blok": [ ...blok... ] } ] }

Jenis blok (`tipe`):

| tipe | bentuk |
|---|---|
| `teks` | `{id, tipe:"teks", isi:"..."}` |
| `gambar` | `{id, tipe:"gambar", item:[{url, caption}]}` (1 sampai 20 item) |
| `soal` | `{id, tipe:"soal", label:"...", gambar:{url,caption}|null, baris:3}` (menghasilkan satu textarea) |
| `tabel` | `{id, tipe:"tabel", kolom:[{id,judul}], baris:[{id, sel:{<idKolom>:{jenis, nilai}}}]}` |

- Jenis sel tabel (`jenis`): `teks` (nilai teks tetap), `gambar` (nilai berisi URL https), `isian` (diisi siswa, nilai boleh kosong).
- Aturan ID: regex `^[A-Za-z0-9_-]{1,64}$` (tanpa titik dua). ID bagian dan blok unik secara global. ID kolom dan baris unik di dalam tabelnya.
- URL gambar wajib `https://`. Gambar hasil unggah berbentuk `https://lh3.googleusercontent.com/d/<fileId>`.
- Batas: 50 bagian, 100 blok per bagian, 20 gambar per blok gambar, 10 kolom dan 50 baris per tabel, 500 kolom isian total.

Kunci jawaban siswa (`jawaban_json` berbentuk objek datar):
- Soal: `<idBlok>` -> teks.
- Sel tabel jenis `isian`: `<idTabel>:<idBaris>:<idKolom>` -> teks.
- Backend membuang kunci yang tidak ada di `isi_json` (respons memuat `dibuang: n`) dan memotong nilai hingga 1.000 karakter.

Baris submissions untuk LKPD: `tipe_sub='lkpd'`, `id_game = id_lkpd`, `id_pertemuan` diambil dari LKPD di server. Nilai `status`: `Belum Dinilai`, `Selesai Dinilai`, `Dibuka Kembali`.

## 5. API backend (hasil Tahap 1)

| Aksi | Peran | Payload | Respons |
|---|---|---|---|
| `save_lkpd` | guru, admin | field LKPD lama + `isi_json` (objek atau string JSON) | `{success, id_lkpd}`. Jika `isi_json` tidak dikirim, nilai yang tersimpan dipertahankan. Jika dikirim, divalidasi (`validasiIsiLkpd_`). `tipe_lkpd` otomatis `terstruktur`. |
| `upload_image` | guru, admin | `{base64Data: "data:image/...;base64,...", fileName?}` | `{success, fileId, url}`. Hanya PNG, JPEG, WebP (dicek lewat magic bytes), maks 3 MB. Disimpan di folder Drive "LKPD_Gambar" (ID folder di Script Properties `FOLDER_GAMBAR_ID`). |
| `delete_image` | guru, admin | `{fileId}` | Hanya file di folder LKPD_Gambar dan hanya jika tidak dipakai `isi_json` mana pun yang tersimpan. File dipindah ke tempat sampah (bisa dipulihkan). |
| `submit_lkpd` | siswa (grace token 7 hari) | `{id_lkpd, jawaban_json:{...}, queue_id}` | Pertama: `{success:true}`. Sudah pernah kirim: `{success:true, duplicate:true}` (sengaja `success:true` supaya antrean offline `sw.js` tuntas). Setelah Buka Kembali: `{success:true, ulang:true}`. Guru dan admin ditolak. Divalidasi: LKPD ada, Publish, kelas cocok, pertemuan Publish. |
| `buka_kembali_submisi` | guru, admin | `{id_sub}` | Hanya `tipe_sub='lkpd'`. Status menjadi `Dibuka Kembali`. |

Catatan implementasi:
- `submit_lkpd` dikunci dengan `LockService` lewat `handleQueuedAction` (jika ada `queue_id`) atau `denganKunci_` (jika tidak).
- LKPD tanpa `isi_json`: `submit_lkpd` kini gagal dengan pesan "LKPD belum disiapkan oleh guru." (`handleSubmitLkpdLama_` dihapus di Tahap 5).
- `handlePdfUpload` tidak lagi menjalankan OCR otomatis (dulu OCR bisa jalan dua kali). OCR kini hanya lewat aksi `ocr_pdf_drive`. `extractTextFromPdfBlob` dihapus. Respons `extractedText` tetap ada tetapi selalu kosong.

## 6. Status tahap

| Tahap | Isi | Status |
|---|---|---|
| 1 | Backend `Kode.gs` | SELESAI (zip `tahap-1-backend`). Lulus 32 + 10 uji logika. BELUM diuji di Apps Script sungguhan: pengguna perlu deploy dan menjalankan uji manual di `CARA-PASANG.md`. |
| 2 | Parser PDF dan editor guru | SELESAI (zip `tahap-2-parser-editor`). Lulus uji logika parser (data tiruan) dan uji editor di Chromium (tambah/ubah/hapus blok, tabel, validasi, simpan, draf). BELUM diuji dengan PDF contoh Canva asli dan Apps Script sungguhan. |
| 3 | Sisi siswa, koreksi guru, Buka Kembali | SELESAI (zip `tahap-3-sisi-siswa`). Lulus uji di Chromium (data tiruan): form siswa, draf, kirim, mode baca, Buka Kembali, kirim ulang, koreksi guru, mode guru dan tamu. BELUM diuji dengan Apps Script sungguhan dan HP asli. `Kode.gs` TIDAK berubah. |
| 4 | Alat Potong dari PDF | SELESAI (zip `tahap-4-potong-pdf`). Lulus uji di Chromium (pdf.js 6.2 lokal, PDF tiruan 2 halaman, mouse): potong, unggah, pasang ke soal/item/sel tabel, pindah halaman, zoom. BELUM diuji dengan PDF Canva asli, sentuhan di HP asli, dan Apps Script sungguhan. `Kode.gs` TIDAK berubah. |
| 5 | Pembersihan kode lama | SELESAI (zip `tahap-5-pembersihan`). Lihat "Hasil Tahap 5". Menunggu konfirmasi pengguna sebelum Tahap 6. |
| 6 | Tampilan (CSS, HP) | SELESAI (zip `tahap-6-tampilan`). Lihat "Hasil Tahap 6". Semua tahap rencana selesai. |

Penyimpangan dari rencana awal (disengaja): aksi lama `save_field_map_lkpd`, `submit_lkpd_isian`, `get_jawaban_lkpd_isian`, serta `QUEUED_ACTIONS.submit_lkpd_isian` tidak dihapus di Tahap 1 supaya aplikasi lama tetap jalan. Sudah dihapus di Tahap 5 (kecuali stub `submit_lkpd_isian`, lihat Hasil Tahap 5).

## 7. Rencana tahap berikutnya

### Tahap 2. Parser PDF dan editor guru
Berkas: `js/services/lkpd-parser.js` (baru), `js/components/lkpd-editor.js` (baru), ubah `js/views/guru.js`, `index.html`, `js/services/ocr.js`.
- Parser berjalan di browser dengan pdf.js (`getTextContent` memberi `transform` dan `height`/ukuran font, `fontName`). Hitung ukuran font median per dokumen. Baris dengan ukuran kira-kira 1,4 kali median atau lebih besar adalah judul, dan baris judul berurutan digabung. Satu halaman menjadi satu bagian. Halaman sampul dilewati (opsi di editor). Teks di bawah judul menjadi petunjuk. Baris berakhiran `:` `?` `!` atau memuat "nomor" menjadi `soal`. Teks pendek sejajar menjadi draf header `tabel`. Blok hasil otomatis diberi tanda "perlu dicek" (hanya di editor, tidak disimpan).
- Garis jawaban (vektor) dan gambar vektor Canva TIDAK terbaca. Jumlah garis lewat `operatorList` hanya bonus. Bawaan `baris=3`.
- Editor (modal layar penuh): naik, turun, hapus, ubah jenis blok (tanpa drag and drop supaya jalan di HP); tambah blok; blok gambar dengan tombol Unggah (kompres di browser, lebar maks 1280 px, JPEG kualitas 0,8, kirim lewat `upload_image`), caption, banyak item; editor tabel (atur baris dan kolom, jenis tiap sel, "jadikan kolom ini isian"); pratinjau memakai renderer siswa mode baca; draf editor disimpan di localStorage; validasi sebelum simpan (label soal tidak kosong, gambar punya URL, tabel punya minimal satu sel isian, ukuran di bawah 45.000).
- Modal LKPD disederhanakan: pertemuan, judul, instruksi, video, status, tombol "Impor dari PDF", tombol "Buka Editor". Daftar LKPD: hapus "Petakan Isian", tambah "Edit Isi".
- Jangan memanggil `upload_pdf` untuk LKPD. Jangan memakai OCR untuk LKPD.
- Uji: impor PDF contoh, hasil 5 bagian (hal. 2 sampai 6; hal. 1 sampul dilewati), guru bisa menyusun LKPD setara aslinya.

### Hasil Tahap 2 (SELESAI)
Berkas baru: `js/services/lkpd-parser.js`, `js/components/lkpd-editor.js`. Berkas diubah: `js/views/guru.js`, `index.html` (modal `#lkpd-modal`), `js/services/ocr.js`, `js/services/labels.js` (label "Terstruktur"), `sw.js` (`CACHE_VERSION` v23, dua berkas baru masuk `SHELL_ASSETS`). `Kode.gs` TIDAK berubah.
- Parser: `parsePdfKeDraf(file, {lewatiSampul})` (pdf.js, hanya di browser, PDF tidak dikirim ke mana pun) dan fungsi murni `bangunDrafDariHalaman(halaman, opsi)` untuk uji. Mengembalikan `{isi, info}`. Blok otomatis bertanda `_cek: true`; ID acak (`s…` bagian, `b…` blok, `k…` kolom, `r…` baris). Halaman bergambar raster menambah blok gambar kosong (URL harus diunggah guru). Tabel draf: 3 baris, semua sel isian. Soal: `baris=3`.
- Editor: `bukaEditorLkpd({idLkpd, judul, isi, abaikanDraf, onSimpan})`; `onSimpan(isiBersih)` harus mengembalikan `true` jika sukses. Modal dibuat dinamis (`#lkpd-editor-modal`, z-60), handler lewat `window.lkpdEd`. Penanda `_cek` dibuang sebelum simpan. Validasi: `validasiEditor(isi)`. Draf localStorage kunci `lkpd_editor_draf_<idLkpd|baru>`, dihapus setelah simpan berhasil.
- Pratinjau di editor semula memakai render bawaan editor. SUDAH diganti ke renderer siswa (`lkpd-render.js`, mode `pratinjau`) di Tahap 3.
- `guru.js`: alur `simpanLkpdKeServer(isiObj|null)` dipakai tombol Simpan modal (isi tidak diubah, `isi_json` tidak dikirim sehingga nilai lama dipertahankan) dan tombol Simpan editor (kirim `isi_json`). Field lama (`file_pdf_url`, `peta_field_json`, `isi_teks`, `soal_json`, dst.) dikirim ulang dari data tersimpan agar tidak terhapus. Daftar LKPD: "Petakan Field" diganti "Edit Isi". Impor PDF menanyakan konfirmasi bila LKPD sudah punya isi; isi lama baru terganti saat Simpan di editor.
- `ocr.js`: `uploadPdfToDrive('lkpd')` kini hanya menampilkan peringatan (cabang lama dihapus penuh di Tahap 5). `field-map-editor.js`/`pdf-overlay.js` masih ada tetapi tidak dipanggil dari daftar LKPD.
- Catatan: kolom `baris` pada blok `soal` adalah angka (tinggi kotak), pada `tabel` adalah daftar. Kode yang menelusuri ID harus memeriksa `tipe` dulu.
- Belum diuji: impor PDF contoh Canva asli (pdf.js butuh CDN), unggah gambar sungguhan ke Drive, dan tampilan di HP. Uji manual: impor PDF contoh, harapkan 5 bagian (hal. 1 dilewati), lengkapi gambar lewat Unggah, Simpan, cek `isi_json` di Sheet.

### Tahap 3. Sisi siswa, koreksi, Buka Kembali
Berkas: `js/views/lkpd.js` (tulis ulang), `js/views/guru.js`, `js/services/api.js` bila perlu.
- Render dari `isi_json`. Tanpa `isi_json`: "LKPD belum disiapkan". Kartu identitas otomatis dari akun (nama, kelas, read-only). Textarea `maxlength=1000`, draf otomatis debounce 400 ms (kunci per LKPD dan pengguna), penghitung "terisi X dari Y". Gambar bisa diketuk untuk diperbesar, hanya URL https, semua teks di-escape.
- Kirim: konfirmasi ("hanya bisa dikirim sekali, N kolom belum diisi"), panggil `submit_lkpd` dengan objek jawaban. Tangani `res.duplicate` (tampilkan info, anggap sudah terkirim). Jika masuk antrean offline (`res.queued`), simpan penanda lokal "sudah dikirim" agar tidak bisa kirim dua kali. Setelah kirim: mode baca dengan jawaban dan tanggal.
- Cari submisi siswa dari `state.cachedData.submissions` (backend sudah memfilter per siswa): `tipe_sub==='lkpd'` dan `id_game===id_lkpd`. Jika `status==='Dibuka Kembali'`: tampilkan form dengan jawaban lama terisi dan banner "Guru membuka kembali LKPD ini...". Refresh data setelah kirim (`fetchAllInitialData(true)`).
- Guru: tombol "Buka Kembali" di kartu jawaban LKPD (di samping Hapus) dengan konfirmasi yang menjelaskan bahwa jawaban tidak dihapus dan nilai lama dikosongkan saat siswa kirim ulang. Panggil `buka_kembali_submisi`. Tampilkan label status "Dibuka Kembali".
- Koreksi: label dari `isi_json` (judul bagian, label soal, "Baris n, kolom X" untuk tabel), urut sesuai dokumen, dengan gambar pendukung. Blok yang sudah dihapus: "(blok dihapus)". Jawaban lama `lkpd_isian` tampil sebagai pasangan kunci dan nilai, tanpa kode overlay.
- Uji: alur penuh; kirim ganda online dan offline; salah kirim lalu Buka Kembali lalu kirim ulang; siswa kelas lain tidak melihat; mode tamu.

### Hasil Tahap 3 (SELESAI)
Berkas baru: `js/components/lkpd-render.js` (renderer bersama). Berkas diubah: `js/views/lkpd.js` (tulis ulang), `js/views/guru.js`, `js/components/drawer.js`, `js/components/lkpd-editor.js` (pratinjau), `js/services/progress.js`, `js/services/nilai.js`, `sw.js` (`CACHE_VERSION` v24, `lkpd-render.js` masuk `SHELL_ASSETS`). `Kode.gs` dan `api.js` TIDAK berubah.

- `lkpd-render.js`: `parseIsiLkpd(raw)`, `daftarIsian(isi)` (semua kolom isian urut dokumen: `{kunci, idBagian, bagian, label, gambar}`; label tabel "Baris n, kolom X"), `kunciSel`, `renderIsiLkpd(isi, {mode, jawaban})` dengan mode `isi` (textarea `maxlength=1000`, atribut `data-lkpd-kunci`), `baca` (jawaban teks), `pratinjau` (kotak kosong), `perbesarGambar` (juga `window.lkpdPerbesar`, hanya URL https, Esc atau ketuk untuk tutup). Semua teks di-escape. Tabel masih `overflow-x-auto` (jadi kartu di HP = Tahap 6).
- `lkpd.js`: `renderLkpdView(ptmId)` membungkus isi dalam `#lkpd-root`; `inisiasiLkpd(ptmId)` dipanggil `drawer.js` setelah HTML dipasang (pasang listener, penghitung "terisi X dari Y", pulihkan draf, rapikan penanda). Kartu identitas dari akun. Tanpa `isi_json`: "LKPD belum disiapkan oleh guru." Guru/admin melihat pratinjau tanpa tombol kirim. Tamu bisa mengisi, kirim meminta login.
- Draf: kunci `<CACHE_KEY>_DRAFT_LKPD_<idLkpd>_<username>` (cocok dengan `migrateGuestDrafts`), objek datar `{kunci: teks}`, debounce 400 ms, simpan langsung saat `change`. Dihapus saat kirim berhasil. Draf lama berkunci `_DRAFT_<ptmId>_` tidak dipakai lagi.
- Kirim: hanya kolom terisi yang dikirim (`jawaban_json` objek datar). Konfirmasi menyebut jumlah kolom kosong. Minimal satu kolom terisi. Batas 45.000 karakter dicek di klien.
- `progress.js` (sumber kebenaran status LKPD siswa): `keadaanLkpd(idLkpd)` mengembalikan `{keadaan:'kosong'|'dibuka'|'terkirim', sub, marker}`; `submisiLkpdSaya`, `bacaKirimLkpd`, `simpanKirimLkpd`, `hapusKirimLkpd`. Centang LKPD di tab pertemuan kini memakai `keadaanLkpd`, jadi status `Dibuka Kembali` tidak lagi dihitung selesai.
- PENTING: `apiPost` SELALU mengantrekan `submit_lkpd` ke outbox, jadi klien selalu menerima `{queued:true}` dan tidak pernah melihat `duplicate`/`ulang` dari server (cabang `res.duplicate` tetap ada untuk jaga-jaga). Karena server terlambat tahu, klien menyimpan penanda lokal `<CACHE_KEY>_LKPD_KIRIM_<idLkpd>_<username>` = `{jawaban, waktu, dasarTs}`. Selama penanda ada dan server belum punya submisi, tampil mode baca "menunggu terkirim".
- Buka Kembali di sisi siswa: submisi server berstatus `Dibuka Kembali` -> form dengan jawaban lama (draf lokal didahulukan bila ada) + banner kuning. Saat kirim ulang, penanda menyimpan `dasarTs` = timestamp submisi di server saat itu. Selama server masih menampilkan timestamp yang sama dan status `Dibuka Kembali`, tampil mode baca (kirim ulang belum diproses). Setelah server memproses (status `Belum Dinilai`, timestamp baru), penanda dibuang otomatis (`rapikanPenanda`).
- Penanda basi: tanpa submisi di server, lebih tua dari 10 menit, dan outbox kosong -> dibuang (misalnya guru menghapus submisi). Siswa lalu bisa mengisi lagi.
- Mode baca menampilkan tanggal kirim, nilai dan catatan guru bila sudah dinilai, dan bagian "Jawaban lain" untuk kunci yang tidak ada di `isi_json` (format lama).
- `guru.js`: tombol "Buka Kembali" (amber) di samping Hapus pada kartu submisi bila `tipe_sub==='lkpd'` dan status belum `Dibuka Kembali`; konfirmasi menjelaskan jawaban tidak dihapus dan nilai lama dikosongkan saat siswa kirim ulang; panggil `buka_kembali_submisi`; label status "Dibuka Kembali" berlencana amber. Koreksi LKPD (`htmlJawabanLkpd`): dikelompokkan per bagian, label dari `isi_json`, gambar pendukung bisa diperbesar, kunci yatim berlabel "(blok dihapus)", jawaban `lkpd_isian` lama atau LKPD tanpa `isi_json` tampil sebagai pasangan kunci dan nilai. Kotak daftar jawaban di modal koreksi dilebarkan ke `max-h-[55vh]`.
- `nilai.js`: `getNilaiSubmisi` mengembalikan `null` untuk status `Dibuka Kembali` (sebelumnya skor otomatis 0 terhitung sebagai nilai 0). Nilai guru yang sudah ada (`nilai_esai`) tetap terbaca sampai siswa kirim ulang.
- `drawer.js`: cabang `lkpd-ptm` kini hanya memanggil `inisiasiLkpd`; impor `renderLkpdUntukSiswa` dari `pdf-overlay.js` dihapus (file `pdf-overlay.js` sendiri dihapus di Tahap 5).
- Uji Chromium (data tiruan, jaringan diblokir): 4 kolom isian terbentuk (soal + 2 sel tabel + soal bagian 2), progres 0 -> 2 dari 4, draf pulih, zoom gambar buka/tutup, kirim -> mode baca + penanda + draf terhapus + outbox 1, server memberi submisi -> penanda dibuang, `Dibuka Kembali` -> form terisi + centang tab belum selesai, kirim ulang -> mode baca, server memproses -> penanda dibuang, guru melihat pratinjau, tamu melihat form. Koreksi guru: label, escape HTML, kunci yatim, format lama, tombol Buka Kembali muncul tepat pada submisi LKPD yang belum dibuka.
- Belum diuji: Apps Script sungguhan, outbox `sw.js` yang benar-benar terkirim, gambar Drive di HP, kelas lain dan siswa lain (filter ada di backend). Uji manual di bagian 11.

### Tahap 4. Potong dari PDF
Berkas: `js/components/pdf-crop.js` (baru), disambungkan ke editor.
- Render halaman PDF di canvas (navigasi, zoom), kotak seleksi dengan pointer events (mouse dan sentuh), pratinjau, konfirmasi. Hasil JPEG kualitas 0,85, latar putih, lebar maks 1.000 px, kirim lewat `upload_image`, URL masuk ke blok atau item gambar aktif. Alat tetap terbuka untuk potongan berikutnya.
- PDF tidak disimpan di Drive, jadi saat editor dibuka lagi guru memilih ulang file PDF untuk memotong.

### Hasil Tahap 4 (SELESAI)
Berkas baru: `js/components/pdf-crop.js`. Berkas diubah: `js/components/lkpd-editor.js`, `js/views/guru.js`, `sw.js` (`CACHE_VERSION` v25, `pdf-crop.js` masuk `SHELL_ASSETS`). `Kode.gs`, `api.js`, `index.html` TIDAK berubah (pdf.js 3.11.174 sudah dimuat dari CDN di `index.html`).

- `pdf-crop.js` ekspor: `bukaPotongPdf({ambilTujuan, terapkan, tujuanAwal})`, `tutupPotongPdf(force)`, `setSumberPdf(fileOrBuffer)`. Modal layar penuh dinamis `#pdf-crop-modal` (z-65, di atas editor z-60), semua handler lewat `addEventListener` (tanpa binding `window`).
- PDF hanya di memori halaman (`sumber`), tidak dikirim ke server. `guru.js` memanggil `setSumberPdf(file)` setelah impor PDF berhasil, jadi alat langsung terbuka dengan PDF yang sama. Dari "Edit Isi" biasa guru memilih file PDF sekali; setelah itu PDF dipakai ulang sampai halaman dimuat ulang. Tombol "Ganti PDF" tersedia.
- Tampilan: navigasi halaman, zoom 100/150/200/300/400 persen (100 persen = pas lebar), kanvas dirender dengan dpr maks 2. Tombol mode "Pilih area" / "Geser halaman": di mode pilih, overlay memakai `touch-action:none` supaya jari menggambar kotak; di mode geser overlay `pointer-events:none` supaya area bisa di-scroll. Seleksi memakai pointer events (mouse dan sentuh), disimpan dalam satuan PDF sehingga tetap benar saat zoom. Seleksi di bawah 20 px diabaikan. Ganti halaman menghapus seleksi.
- Potongan: area terpilih dirender ulang langsung ke kanvas kecil (opsi `transform` pdf.js) dengan skala `min(4, 1000/lebarPDF)`, jadi lebar hasil maksimal 1.000 px dan tajam. Latar putih, JPEG kualitas 0,85. Pratinjau = berkas yang akan diunggah. Batas 3 MB dicek di klien. Unggah lewat `upload_image` (`fileName: potongan.jpg`).
- Tujuan: dropdown "Pasang ke gambar" berisi semua tempat gambar di editor (`daftarSlotGambar` di `lkpd-editor.js`): gambar soal (soal tanpa gambar ikut terdaftar dan objek gambarnya dibuat saat dipakai), tiap item blok gambar, tiap sel tabel berjenis gambar. Penanda ✓ terisi, ○ kosong. Kunci tujuan: `soal|idBlok`, `item|idBlok|n`, `sel|idBlok|idBaris|idKolom`. Setelah satu potongan dipakai, alat TETAP terbuka dan tujuan pindah ke tempat kosong berikutnya.
- Editor: tombol "✂ Potong dari PDF" di bilah atas (tujuan otomatis tempat kosong pertama), serta tombol per tempat gambar (gambar soal, item gambar, sel tabel "✂ Potong"). `isiSlotGambar` memakai `ubah()` sehingga draf localStorage ikut tersimpan. `tutup()` editor ikut menutup alat.
- Uji Chromium: potong kotak merah halaman 1 (800x400 px, piksel tengah merah) ke item gambar 2, tujuan pindah otomatis, halaman 2 + zoom 150 persen, potong kotak hijau ke soal, klik seleksi kecil diabaikan, mode geser, tutup alat (editor tetap terbuka dan terkunci scroll), URL tampil di input dan pratinjau editor, PDF dipakai ulang saat dibuka lagi.
- Belum diuji: PDF Canva asli (vektor besar), seret dengan jari di HP, PDF sangat besar (memori HP), unggah sungguhan ke Drive.
- Catatan: pada uji, Tailwind CDN tidak ada (jaringan diblokir), jadi tata letak diuji dengan CSS minimal. Cek tampilan sungguhan di Tahap 6.

### Tahap 5. Pembersihan (SELESAI, ringkasan di Hasil Tahap 5)
- Cek impor (grep) sebelum menghapus: `js/components/pdf-overlay.js`, `js/components/field-map-editor.js`, `js/services/auto-detect.js`, `js/services/detectors/*`, `js/services/ocr-labels.js`. Pastikan materi dan game (misalnya hotspot) tidak memakainya.
- Bersihkan modal fullscreen LKPD dan peta isian di `index.html`, binding `window.*` di `main.js` dan `drawer.js`, aturan CSS overlay, `parseQuestionsFromText` dan cabang `isLkpd` di `ocr.js`.
- `lkpd.js` tidak lagi mengimpor `pdf-overlay.js`; `drawer.js` juga tidak (dibersihkan di Tahap 3). Tetap cek impor lain sebelum menghapus.
- WAJIB: perbarui daftar pra-cache di `sw.js` (file yang dihapus harus keluar dari daftar, kalau tidak instalasi service worker gagal). Naikkan `CACHE_VERSION`. Perbarui README.
- Backend: hapus `save_field_map_lkpd`, `submit_lkpd_isian`, `get_jawaban_lkpd_isian`, `handleSubmitLkpdLama_`, dan entri terkait di `ACTION_RULES`, `ACTION_SHEETS`, `QUEUED_ACTIONS`, `routePost_`, `handleQueuedAction`. Sebelum itu pastikan frontend tidak lagi memanggilnya.

### Hasil Tahap 5 (SELESAI)
Frontend dihapus: `js/components/pdf-overlay.js`, `js/components/field-map-editor.js`, `js/services/auto-detect.js`, `js/services/detectors/*`, `js/services/ocr-labels.js`. Grep sebelum hapus: hanya `main.js` yang mengimpor `pdf-overlay.js`; hotspot, materi, game tidak memakai file yang dihapus.
- `main.js`: impor `pdf-overlay.js` dibuang. `index.html`: modal `#lkpd-fullscreen-modal` dibuang.
- `css/style.css`: semua aturan overlay dibuang (`.lkpd-fill-input*`, `.lkpd-sheet*`, `#lkpd-fullscreen-*`, `.lkpd-fullscreen-page-wrap`, kanvas `#siswa-lkpd-pages` dan `#desktop-lkpd-pages`, serta rujukan di media query).
- `ocr.js`: `isValidPdfBuffer`, `base64ToArrayBuffer`, `fetchPdfArrayBuffer`, `parseQuestionsFromText` dan cabang `isLkpd` dibuang. Jalur materi, `extractTextFromPdfClientSide`, `requestOcrFallback` tetap.
- `api.js`: reset modal peta field di `handleAuthExpired` dibuang; `submit_lkpd_isian` keluar dari daftar antrean. `pull-refresh.js`: pemeriksaan modal peta field dibuang. `state.js`: field `uiState` khusus guru/overlay dibuang (field kanvas STEAM tetap).
- `sw.js`: file terhapus keluar dari SHELL_ASSETS, `CACHE_VERSION` = `v26`.
- Backend `Kode.gs`: dihapus `save_field_map_lkpd`, `get_jawaban_lkpd_isian`, `handleSubmitLkpdLama_`, `handleSaveFieldMapLkpd`, `handleSubmitLkpdIsian`, `handleGetJawabanLkpdIsian` beserta entri `ACTION_RULES`, `ACTION_SHEETS`, `QUEUED_ACTIONS`, `routePost_`, `handleQueuedAction`. `handleSubmitLkpd` tanpa `isi_json` kini menolak.
- STUB sengaja: `submit_lkpd_isian` masih ada di `ACTION_RULES` (grace) dan `routePost_`, hanya mengembalikan `{success:true, deprecated:true}` supaya kiriman lama di outbox HP siswa tuntas dan tidak macet. Boleh dihapus kelak bila yakin tidak ada antrean lama.
- Dibiarkan: `get_pdf_base64` di backend (kini tidak dipakai frontend, aman dihapus belakangan). Penanganan `lkpd_isian` di `nilai.js`, `progress.js`, `guru.js` dipertahankan untuk membaca jawaban lama. Kolom `peta_field_json` di sheet lkpd tidak disentuh.
- Uji: semua `.js` lolos `node --check`, `Kode.gs` lolos parse, semua impor relatif terselesaikan, semua berkas SHELL_ASSETS ada (ikon biner tidak ada di repomix), grep tidak menemukan rujukan tersisa. BELUM diuji di browser/Apps Script sungguhan: pengguna perlu deploy ulang Kode.gs (versi baru) dan cek form siswa, editor guru, dan impor PDF masih jalan.

### Tahap 6. Tampilan
Form LKPD nyaman di HP (tabel menjadi kartu di layar kecil: gambar di atas, isian di bawah), progress bar, tombol kirim melayang, banner Buka Kembali, polesan editor guru dan alat potong. Uji dari 360 px sampai desktop.

### Hasil Tahap 6 (SELESAI)
Berkas diubah: `css/style.css`, `js/components/lkpd-render.js`, `js/views/lkpd.js`, `js/components/lkpd-editor.js`, `js/components/pdf-crop.js`, `sw.js` (`CACHE_VERSION` = `v27`), `Point.md`. Tidak ada perubahan backend.
- Tabel jadi kartu di layar < 640 px: sel diberi `data-jenis` dan `data-label` (judul kolom). Di HP kepala tabel disembunyikan, tiap baris menjadi kartu, sel gambar tampil paling atas (`order:-1`), isian di bawah dengan label kolom di atas kotaknya, sel kosong disembunyikan. Di >= 640 px tabel tetap seperti semula.
- Progress bar `.lkpd-progres-sticky` menempel di bawah header (`--lkpd-top` diukur dari tinggi `<header>` di `inisiasiLkpd`). Tombol kirim dibungkus `.lkpd-kirim-wrap` (sticky bawah, jarak 0,75 rem) sehingga selalu terlihat.
- Banner Buka Kembali: garis kiri tebal amber dan `role="status"`.
- Editor guru: header menempel di atas, judul dipotong (`truncate`), padding lebih kecil di HP, ruang bawah 5 rem. Alat Potong: judul dipotong, header lebih ringkas (susunan lain sudah responsif dari Tahap 4).
- Uji Chromium (halaman tiruan, CSS aplikasi dipakai, Tailwind CDN TIDAK ada): pada 360, 768, 1280 px tidak ada geser horizontal. Pada 360 px baris tabel menjadi kolom tunggal (gambar atas, isian bawah, label kolom tampil, baris teks tetap terbaca); pada 768 dan 1280 px tetap tabel. Progress dan tombol kirim menempel saat digulir.
- BELUM diuji: tampilan dengan Tailwind sungguhan di HP asli, kotak isian dengan keyboard layar terbuka (tombol kirim melayang bisa menutupi kolom terbawah saat keyboard muncul), editor dan alat Potong di HP asli. Uji manual di HP 360 px: isi form, gulir, kirim.

## 8. Temuan tentang kode yang ada

- `apiPost` mengantrekan `submit_lkpd`, `submit_game`, `submit_lkpd_isian`, `save_review`, `submit_evaluasi` ke outbox IndexedDB. `sw.js` menganggap kiriman tuntas jika respons JSON `success:true`. Karena itu respons duplikat harus `success:true`.
- `handleQueuedAction` sudah memakai `LockService` dan pengecekan `queue_id` ganda.
- Backend memfilter data: siswa hanya menerima `submissions` miliknya dan hanya LKPD Publish sesuai kelasnya. Guru dan admin menerima semua.
- `fetchPdfArrayBuffer` di `ocr.js` bisa mengambil PDF lewat `get_pdf_base64` (hanya file yang terdaftar di materi atau LKPD untuk non-staf). Tidak dipakai untuk LKPD baru.
- `extractTextFromPdfClientSide` di `ocr.js` mengelompokkan teks per baris (toleransi y = 4) tetapi membuang ukuran font. Parser baru perlu menyimpannya.

## 9. Temuan dari PDF contoh (Canva)

PDF contoh: 6 halaman. Hal. 1 sampul (judul, Nama, Kelas). Hal. 2 sampai 6 masing-masing satu kegiatan.
- Teks PDF terbaca langsung (bukan hasil flatten), jadi OCR tidak perlu.
- Judul bagian bukan "A." atau "1.", melainkan teks berukuran terbesar di tiap halaman. Parser harus berbasis ukuran font dan halaman.
- Kotak jawaban adalah garis vektor, tidak ada di teks. Jumlah baris dan kolom jawaban tidak terbaca otomatis.
- Gambar adalah vektor Canva (bukan gambar raster), jadi deteksi gambar pdf.js tidak menemukannya. Karena itu ada alat Potong dari PDF.
- Urutan teks hasil ekstraksi bisa acak (hal. 4: "Penjelasan nomor 2, 5, 3"). Label yang sama berulang (hal. 5: "Nama benda dan peran:" empat kali), jadi ID harus acak, bukan dari teks.
- Hal. 2 adalah tabel 3 kolom: Nama Benda (gambar), Perubahan Energi, Pemanfaatan. Satu baris contoh sudah terisi (teks tetap), empat baris kosong (isian).
- Hal. 3: dua rangkaian tiga gambar (energi, alat, hasil) dengan dua garis jawaban masing-masing. Hal. 4: gambar fotosintesis bernomor 1 sampai 5, siswa menjelaskan nomor 2, 5, 3. Hal. 5: empat gambar, tiap gambar satu isian "Nama benda dan peran". Hal. 6: satu gambar pembangkit listrik dan dua kotak jawaban.

## 10. Risiko dan batasan yang diketahui

- Parser hanya menghasilkan kerangka. Editor guru dan alat potong menutup kekurangannya.
- Rumus sains dari PDF bisa rusak menjadi teks acak (MathJax sudah ada di aplikasi bila perlu).
- Hasil potongan membawa latar pastel Canva.
- Gambar Drive bergantung pada akses "siapa saja dengan link". Jika kebijakan akun Google sekolah membatasinya, gambar tidak tampil. Uji saat Tahap 1 dideploy.
- Kasus tepi: jika kiriman antrean offline yang sama diputar ulang SETELAH guru membuka kembali jawaban, kiriman lama bisa menimpa. Sangat jarang, belum ditangani.
- Penanda kirim lokal siswa dibuang dengan tebakan waktu (10 menit + outbox kosong). Jika outbox sudah kosong tetapi data submisi di cache klien belum disegarkan, siswa bisa sebentar melihat form lagi. Bila ia kirim lagi, server menjawab `duplicate` dan tidak menimpa. Segarkan halaman untuk memperbaiki tampilan.
- Backend hanya menerima URL gambar berawalan `https://`. Belum dibatasi ke domain tertentu.
- Parser heuristik: baris berakhiran `:` `?` `!` atau memuat "nomor" dianggap soal, dua+ segmen pendek sejajar dianggap header tabel. Hasil bisa meleset (mis. judul terbaca soal), sebab itu semua blok otomatis bertanda "perlu dicek". Urutan teks PDF acak (seperti hal. 4 contoh) harus dirapikan guru.
- Editor tidak memakai drag-and-drop; blok digeser dengan tombol naik/turun.

## 11. Uji yang belum dijalankan di lingkungan nyata

Seluruh uji Tahap 1 memakai simulasi Apps Script di Node.js (`uji/`). Pengguna harus menjalankan uji manual (`CARA-PASANG.md`) setelah deploy: simpan LKPD, unggah gambar (cek folder "LKPD_Gambar" terbentuk dan URL gambar terbuka di browser tanpa login), kirim dua kali, buka kembali, kirim ulang.

Tambahan uji manual Tahap 3 (setelah deploy, dengan LKPD berisi soal dan tabel):
1. Login siswa, buka LKPD: identitas tampil, isi dua kolom, muat ulang halaman, draf pulih.
2. Kirim: konfirmasi menyebut kolom kosong, setelah kirim tampil mode baca. Cek baris di sheet `submissions` (`tipe_sub=lkpd`, `jawaban_json` memuat kunci id soal dan `tabel:baris:kolom`).
3. Matikan jaringan, kirim, cek lencana "menunggu kirim", nyalakan jaringan, pastikan hanya satu baris tercipta.
4. Login guru, Koreksi, Detail siswa: label sesuai dokumen, klik Buka Kembali, status berlencana amber.
5. Login siswa lagi: form terisi jawaban lama + banner kuning, ubah, kirim ulang, baris yang sama tertimpa dan nilai/catatan kosong.
6. Siswa kelas lain tidak melihat LKPD ini. Mode tamu: form tampil, kirim meminta login.

Tambahan uji manual Tahap 4:
1. Guru, Edit Isi, klik "✂ Potong dari PDF", pilih PDF contoh Canva. Halaman tampil pas lebar.
2. Seret kotak di sekitar satu gambar. Pratinjau muncul (lebar maks 1.000 px). Pilih tujuan, klik "Pakai potongan". Cek gambar masuk ke blok dan URL `https://lh3.googleusercontent.com/d/...` terisi.
3. Potong gambar kedua: tujuan pindah ke tempat kosong berikutnya. Alat tidak menutup sendiri.
4. Di HP: pakai mode "Geser halaman" untuk menggulir saat zoom, kembali ke "Pilih area" untuk menyeret kotak dengan jari.
5. Simpan LKPD, buka sebagai siswa, gambar tampil dan bisa diperbesar.
6. Muat ulang halaman, buka editor lagi: alat meminta memilih PDF lagi (PDF tidak disimpan).

