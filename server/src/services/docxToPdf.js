// Template-preserving DOC-to-DOCX and DOCX-to-PDF conversion using centralized LibreOffice headless runner.
// Supports native Windows (soffice.com preferred, soffice.exe fallback), Linux, macOS, and optional Docker.
// Never returns success merely because LibreOffice exits with code 0; always validates output structure.
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import {
  WINDOWS_LIBREOFFICE_PATHS,
  LINUX_LIBREOFFICE_PATHS,
  getCandidateLibreOfficePaths,
  detectLibreOffice,
  getLibreOfficeInstallInstructions,
  runLibreOfficeConversion,
} from './libreOffice.js';

export {
  WINDOWS_LIBREOFFICE_PATHS,
  LINUX_LIBREOFFICE_PATHS,
  getCandidateLibreOfficePaths,
  detectLibreOffice,
  getLibreOfficeInstallInstructions,
};

export async function validateDocxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return false;
  // ZIP magic bytes PK\x03\x04
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4B || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    return false;
  }
  try {
    const zip = await JSZip.loadAsync(buffer);
    return Boolean(zip.file('word/document.xml'));
  } catch {
    return false;
  }
}

export async function validateGeneratedPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    return { valid: false, page_count: 0, page_dimensions: [] };
  }
  try {
    const doc = await PDFDocument.load(new Uint8Array(buffer), { ignoreEncryption: true });
    const pageCount = doc.getPageCount();
    const dims = doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return { width: Math.round(width * 10) / 10, height: Math.round(height * 10) / 10 };
    });
    const validDims = dims.length > 0 && dims.every((d) => d.width > 0 && d.height > 0);
    return { valid: pageCount > 0 && validDims, page_count: pageCount, page_dimensions: dims };
  } catch {
    return { valid: false, page_count: 0, page_dimensions: [] };
  }
}

export function hasOleDocMagic(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 8
    && buffer[0] === 0xd0
    && buffer[1] === 0xcf
    && buffer[2] === 0x11
    && buffer[3] === 0xe0;
}

// Konversi berkas Microsoft Word legacy (.doc / OLE2) ke .docx perantara menggunakan LibreOffice headless.
// Berkas .doc asli tetap disimpan terpisah secara immutable.
export async function convertDocBufferToDocx(docBuffer, {
  env = process.env,
  converter = null,
  execRunner = null,
  fileExists = existsSync,
  timeoutMs = Number(env.DOCX_PDF_TIMEOUT_MS || 120000),
  platform = process.platform,
} = {}) {
  if (!hasOleDocMagic(docBuffer)) {
    return {
      ok: false,
      code: 'INVALID_DOC_SIGNATURE',
      reason: 'Berkas bukan dokumen Microsoft Word .DOC yang valid (tanda tangan OLE2 tidak cocok).',
    };
  }

  if (typeof converter === 'function') {
    try {
      const out = await converter(Buffer.from(docBuffer));
      const valid = await validateDocxBuffer(out);
      if (!valid) {
        return { ok: false, code: 'INVALID_DOCX_OUTPUT', reason: 'Hasil konversi .DOC ke .DOCX tidak valid.' };
      }
      return {
        ok: true,
        buffer: out,
        engine: 'custom',
        conversion_note: 'Dokumen .DOC dikonversi ke .DOCX perantara; periksa tata letak hasil unduhan.',
      };
    } catch (err) {
      return {
        ok: false,
        code: 'DOC_CONVERSION_FAILED',
        reason: 'Konversi .DOC ke .DOCX gagal dijalankan.',
        stderr: String(err?.message || ''),
      };
    }
  }

  const run = await runLibreOfficeConversion({
    inputBuffer: docBuffer,
    inputFilename: 'legacy.doc',
    expectedOutputFilename: 'legacy.docx',
    convertTo: 'docx',
    env,
    execRunner,
    fileExists,
    timeoutMs,
    platform,
    tempPrefix: 'runut-doc2docx-',
  });

  if (!run.ok) {
    if (run.code === 'CONVERTER_UNAVAILABLE') {
      const guidance = run.install_guidance || getLibreOfficeInstallInstructions(platform);
      return {
        ok: false,
        code: 'DOC_CONVERTER_UNAVAILABLE',
        reason: `Konversi format Word lama (.doc) memerlukan LibreOffice. ${guidance.summary} Atur ${guidance.recommended_env} atau simpan berkas sebagai .docx lalu unggah kembali.`,
        install_guidance: guidance,
      };
    }
    if (run.code === 'CONVERSION_TIMEOUT') {
      return {
        ok: false,
        code: 'CONVERSION_TIMEOUT',
        reason: `Konversi .DOC ke .DOCX melewati batas waktu ${timeoutMs} ms.`,
        stderr: run.stderr || '',
      };
    }
    if (run.code === 'OUTPUT_FILE_MISSING' || run.code === 'EMPTY_OUTPUT_FILE') {
      return {
        ok: false,
        code: 'DOC_CONVERSION_FAILED',
        reason: 'LibreOffice selesai tanpa menghasilkan berkas .DOCX keluaran yang valid.',
        stderr: run.stderr || '',
      };
    }
    return {
      ok: false,
      code: 'DOC_CONVERSION_FAILED',
      reason: 'Konversi .DOC ke .DOCX gagal dijalankan oleh LibreOffice.',
      stderr: run.stderr || run.error || '',
    };
  }

  const valid = await validateDocxBuffer(run.buffer);
  if (!valid) {
    return {
      ok: false,
      code: 'INVALID_DOCX_OUTPUT',
      reason: 'Hasil konversi .DOC ke .DOCX gagal validasi struktur OOXML (word/document.xml tidak valid).',
      stderr: run.stderr || '',
    };
  }

  return {
    ok: true,
    buffer: run.buffer,
    engine: 'libreoffice',
    binary: run.binary,
    version: run.version,
    conversion_note: 'Dokumen Word lama (.doc) dikonversi ke .docx perantara. Sebagian tata letak kompleks dapat sedikit berubah; untuk preservasi 100% disarankan mengunggah format .docx asli.',
  };
}

export async function convertDocxBufferToPdf(docxBuffer, {
  env = process.env,
  converter = null,
  execRunner = null,
  fileExists = existsSync,
  timeoutMs = Number(env.DOCX_PDF_TIMEOUT_MS || 120000),
  platform = process.platform,
} = {}) {
  const enabled = String(env.DOCX_PDF_CONVERSION_ENABLED || 'true') !== 'false';
  if (!enabled) {
    return {
      ok: false,
      status: 'docx_pdf_converter_unavailable',
      code: 'CONVERSION_DISABLED',
      reason: 'Konversi DOCX-ke-PDF dinonaktifkan melalui DOCX_PDF_CONVERSION_ENABLED=false.',
    };
  }

  const validDocx = await validateDocxBuffer(docxBuffer);
  if (!validDocx) {
    return {
      ok: false,
      status: 'pdf_validation_failed',
      code: 'CORRUPTED_DOCX',
      reason: 'Berkas DOCX rusak atau tidak valid (word/document.xml tidak ditemukan).',
    };
  }

  // Optional custom converter hook for automated tests
  if (typeof converter === 'function') {
    let timer;
    try {
      const out = await Promise.race([
        converter(Buffer.from(docxBuffer)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error('Conversion timed out');
            err.code = 'ETIMEDOUT';
            reject(err);
          }, timeoutMs);
        }),
      ]);
      const check = await validateGeneratedPdf(out);
      if (check.valid) {
        return {
          ok: true,
          status: 'docx_pdf_conversion_success',
          buffer: out,
          page_count: check.page_count,
          page_dimensions: check.page_dimensions,
          engine: 'custom',
        };
      }
      return {
        ok: false,
        status: 'pdf_validation_failed',
        code: 'INVALID_PDF_OUTPUT',
        reason: 'Hasil konversi DOCX-ke-PDF bukan berkas PDF yang valid.',
      };
    } catch (err) {
      const isTimeout = err?.code === 'ETIMEDOUT' || err?.killed;
      return {
        ok: false,
        status: 'docx_pdf_converter_unavailable',
        code: isTimeout ? 'CONVERSION_TIMEOUT' : 'CONVERSION_FAILED',
        reason: isTimeout
          ? `Konversi DOCX-ke-PDF melewati batas waktu ${timeoutMs} ms.`
          : 'Konversi DOCX-ke-PDF gagal dijalankan.',
        stderr: String(err?.message || ''),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const run = await runLibreOfficeConversion({
    inputBuffer: docxBuffer,
    inputFilename: 'document.docx',
    expectedOutputFilename: 'document.pdf',
    convertTo: 'pdf',
    env,
    execRunner,
    fileExists,
    timeoutMs,
    platform,
    tempPrefix: 'runut-docx2pdf-',
  });

  if (!run.ok) {
    if (run.code === 'CONVERTER_UNAVAILABLE') {
      const guidance = run.install_guidance || getLibreOfficeInstallInstructions(platform);
      return {
        ok: false,
        status: 'docx_pdf_converter_unavailable',
        code: 'CONVERTER_UNAVAILABLE',
        reason: `LibreOffice (soffice) tidak ditemukan di sistem. ${guidance.summary} Atur ${guidance.recommended_env} di server/.env, atau unduh format .DOCX untuk preservasi template 100%.`,
        install_guidance: guidance,
      };
    }
    if (run.code === 'CONVERSION_TIMEOUT') {
      return {
        ok: false,
        status: 'docx_pdf_converter_unavailable',
        code: 'CONVERSION_TIMEOUT',
        reason: `Konversi DOCX-ke-PDF melewati batas waktu ${timeoutMs} ms.`,
        stderr: run.stderr || '',
      };
    }
    if (run.code === 'OUTPUT_FILE_MISSING' || run.code === 'EMPTY_OUTPUT_FILE') {
      return {
        ok: false,
        status: 'pdf_validation_failed',
        code: 'CONVERSION_FAILED',
        reason: 'LibreOffice selesai tanpa menghasilkan berkas PDF keluaran.',
        stderr: run.stderr || '',
      };
    }
    return {
      ok: false,
      status: 'docx_pdf_converter_unavailable',
      code: 'CONVERSION_FAILED',
      reason: 'Konversi DOCX-ke-PDF gagal dijalankan oleh LibreOffice.',
      stderr: run.stderr || run.error || '',
    };
  }

  const check = await validateGeneratedPdf(run.buffer);
  if (!check.valid) {
    return {
      ok: false,
      status: 'pdf_validation_failed',
      code: 'INVALID_PDF_OUTPUT',
      reason: 'PDF hasil konversi gagal validasi struktur.',
      stderr: run.stderr || '',
    };
  }

  return {
    ok: true,
    status: 'docx_pdf_conversion_success',
    buffer: run.buffer,
    page_count: check.page_count,
    page_dimensions: check.page_dimensions,
    engine: 'libreoffice',
    binary: run.binary,
    version: run.version,
  };
}
