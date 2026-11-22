import { setButtonLoading, showToast } from '../components/modal.js';
import { OCR_FALLBACK_MIN_CHARS } from '../config.js';
import { apiPost } from '../services/api.js';

export async function extractTextFromPdfClientSide(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();

      const items = textContent.items
        .map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5]
        }))
        .filter((it) => it.str && it.str.trim() !== '');

      const lineTolerance = 4;
      const lines = [];
      items.forEach((it) => {
        let line = lines.find((l) => Math.abs(l.y - it.y) < lineTolerance);
        if (!line) {
          line = { y: it.y, items: [] };
          lines.push(line);
        }
        line.items.push(it);
      });

      lines.sort((a, b) => b.y - a.y);
      lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));

      const pageText = lines.map((l) => l.items.map((it) => it.str).join(' ')).join('\n');

      fullText += pageText + '\n\n';
    }
    return fullText.trim();
  } catch (err) {
    console.error('PDF.js Extraction Error:', err);
    return '';
  }
}

export async function requestOcrFallback(fileId) {
  try {
    const res = await apiPost({ action: 'ocr_pdf_drive', fileId });
    if (res.success && res.text) {
      return res.text;
    }
    console.warn('OCR fallback tidak menghasilkan teks:', res.message);
    return '';
  } catch (err) {
    console.error('OCR Fallback Error:', err);
    return '';
  }
}

export async function uploadPdfToDrive(targetModule = 'materi') {
  if (targetModule === 'lkpd') {
    // LKPD terstruktur: PDF hanya diimpor lewat editor, tidak diunggah ke Drive.
    showToast('warning', 'Gunakan tombol "Impor dari PDF" di form LKPD.');
    return;
  }
  const fileInput = document.getElementById('materi-form-file-pdf');
  const btn = document.getElementById('btn-upload-pdf');

  if (!fileInput.files || fileInput.files.length === 0) {
    showToast('warning', 'Pilih file PDF terlebih dahulu!');
    return;
  }

  const file = fileInput.files[0];
  setButtonLoading(btn, true, 'Membaca Teks PDF...', 'Unggah & Ekstrak Teks PDF');

  let extractedText = await extractTextFromPdfClientSide(file);
  let usedOcr = false;

  setButtonLoading(btn, true, 'Mengunggah ke Drive...', 'Unggah & Ekstrak Teks PDF');
  const reader = new FileReader();
  reader.onload = async function (e) {
    const res = await apiPost({
      action: 'upload_pdf',
      base64Data: e.target.result,
      fileName: file.name
    });

    if (res.success && (!extractedText || extractedText.length < OCR_FALLBACK_MIN_CHARS)) {
      setButtonLoading(btn, true, 'Teks Kosong, Menjalankan OCR...', 'Unggah & Ekstrak Teks PDF');
      const ocrText = await requestOcrFallback(res.fileId);
      if (ocrText && ocrText.length > extractedText.length) {
        extractedText = ocrText;
        usedOcr = true;
      }
    }

    setButtonLoading(btn, false, '', 'Unggah & Ekstrak Teks PDF');

    if (res.success) {
      const pdfUrlElem = document.getElementById('materi-form-pdf-url');
      const pdfIdElem = document.getElementById('materi-form-pdf-id');
      if (pdfUrlElem) pdfUrlElem.value = res.url;
      if (pdfIdElem) pdfIdElem.value = res.fileId;
      if (extractedText) {
        const teksElem = document.getElementById('materi-form-teks');
        if (teksElem) teksElem.value = extractedText;
      }
      showToast('success', usedOcr ? 'PDF Diunggah & Diproses via OCR!' : 'PDF Bahan Ajar Berhasil Diunggah!');
    } else {
      Swal.fire({ icon: 'error', title: 'Gagal Unggah PDF', text: res.message });
    }
  };
  reader.readAsDataURL(file);
}

window.uploadPdfToDrive = uploadPdfToDrive;
