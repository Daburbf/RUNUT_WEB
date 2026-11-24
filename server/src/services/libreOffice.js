// Centralized, safe LibreOffice discovery and headless process execution.
// Supports native Windows (preferring soffice.com over soffice.exe), Linux, macOS,
// explicit LIBREOFFICE_PATH, PATH discovery, and optional Docker deployments.
// Never uses shell execution (shell: false) to prevent command injection.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WINDOWS_LIBREOFFICE_PATHS = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.com',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
];

export const LINUX_LIBREOFFICE_PATHS = [
  '/usr/bin/soffice',
  '/usr/bin/libreoffice',
  '/usr/local/bin/soffice',
  '/usr/local/bin/libreoffice',
  '/snap/bin/libreoffice',
];

export const MACOS_LIBREOFFICE_PATHS = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
];

const MAX_CAPTURE_BYTES = 256 * 1024;

export function isAbsoluteBinaryPath(bin) {
  const s = String(bin || '');
  return path.isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s);
}

export function isRunningInDocker() {
  if (process.env.RUNNING_IN_DOCKER === 'true') return true;
  try {
    return existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

export function getCandidateLibreOfficePaths(env = process.env, { platform = process.platform } = {}) {
  const configured = String(env.LIBREOFFICE_PATH || env.LIBREOFFICE_BIN || '').trim();
  const list = [];

  if (configured) {
    list.push(configured);
    // If on Windows and user configured soffice.exe, also consider sibling soffice.com as fallback
    if (platform === 'win32' && /soffice\.exe$/i.test(configured)) {
      list.push(configured.replace(/soffice\.exe$/i, 'soffice.com'));
    }
  }

  if (platform === 'win32') {
    list.push(...WINDOWS_LIBREOFFICE_PATHS);
    list.push('soffice.com', 'soffice.exe', 'soffice', 'libreoffice');
  } else if (platform === 'darwin') {
    list.push(...MACOS_LIBREOFFICE_PATHS, 'soffice', 'libreoffice', ...WINDOWS_LIBREOFFICE_PATHS);
  } else {
    list.push(...LINUX_LIBREOFFICE_PATHS, 'soffice', 'libreoffice', ...WINDOWS_LIBREOFFICE_PATHS);
  }

  return Array.from(new Set(list.filter(Boolean)));
}

export function getLibreOfficeInstallInstructions(platform = process.platform) {
  if (platform === 'win32') {
    return {
      platform: 'win32',
      docker_required: false,
      summary: 'LibreOffice belum terpasang di Windows. Docker tidak wajib untuk pengembangan lokal.',
      install_steps: [
        'Pasang LibreOffice langsung di Windows melalui Winget: winget install --id TheDocumentFoundation.LibreOffice -e',
        'Atau unduh installer resmi Windows (.msi) dari https://www.libreoffice.org/download/download-libreoffice/',
        'Setelah terpasang, RUNUT akan mendeteksi otomatis C:\\Program Files\\LibreOffice\\program\\soffice.com (atau atur LIBREOFFICE_PATH di server/.env).',
      ],
      recommended_env: 'LIBREOFFICE_PATH=C:\\Program Files\\LibreOffice\\program\\soffice.com',
    };
  }
  if (platform === 'darwin') {
    return {
      platform: 'darwin',
      docker_required: false,
      summary: 'LibreOffice belum terpasang di macOS.',
      install_steps: [
        'Pasang LibreOffice melalui Homebrew: brew install --cask libreoffice',
        'Atau atur LIBREOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice di server/.env.',
      ],
      recommended_env: 'LIBREOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice',
    };
  }
  return {
    platform,
    docker_required: false,
    summary: 'LibreOffice belum terpasang di sistem Linux.',
    install_steps: [
      'Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y libreoffice-writer libreoffice-core fonts-dejavu fonts-noto-core',
      'Alpine/Docker: apk add --no-cache libreoffice font-noto ttf-dejavu',
      'Atau atur LIBREOFFICE_PATH=/usr/bin/soffice di server/.env.',
    ],
    recommended_env: 'LIBREOFFICE_PATH=/usr/bin/soffice',
  };
}

function terminateProcessTree(child, platform = process.platform) {
  if (!child || !child.pid) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  if (platform === 'win32') {
    try {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        timeout: 5000,
      }, () => {});
    } catch {
      // ignore
    }
  } else {
    setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 500).unref?.();
  }
}

// Safe process spawner with shell: false, bounded stdout/stderr capture,
// execution timeout, and proper process tree termination.
export function spawnSafe(binary, args = [], {
  timeoutMs = 120000,
  cwd = undefined,
  env = process.env,
  platform = process.platform,
} = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(binary, args, {
        shell: false,
        windowsHide: true,
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child, platform);
        }, timeoutMs)
      : null;

    const appendBounded = (current, chunk) => {
      if (current.length >= MAX_CAPTURE_BYTES) return current;
      const text = chunk.toString('utf8');
      return (current + text).slice(0, MAX_CAPTURE_BYTES);
    };

    child.stdout?.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timedOut) {
        const err = new Error(`LibreOffice process timed out after ${timeoutMs} ms`);
        err.code = 'ETIMEDOUT';
        err.killed = true;
        err.exitCode = code;
        err.signal = signal;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      if (code !== 0) {
        const err = new Error(`LibreOffice exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
        err.code = 'LIBREOFFICE_EXIT_NONZERO';
        err.exitCode = code;
        err.signal = signal;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ exitCode: code, signal, stdout, stderr });
    });
  });
}

// Adapter compatible with both default spawnSafe and injected execRunner(bin, args, opts)
async function invokeRunner(binary, args, { timeoutMs, execRunner, platform }) {
  if (typeof execRunner === 'function') {
    const res = await execRunner(binary, args, { timeout: timeoutMs, shell: false, windowsHide: true });
    return {
      exitCode: 0,
      stdout: String(res?.stdout || ''),
      stderr: String(res?.stderr || ''),
    };
  }
  return spawnSafe(binary, args, { timeoutMs, platform });
}

export async function detectLibreOffice({
  env = process.env,
  execRunner = null,
  fileExists = existsSync,
  platform = process.platform,
  probeTimeoutMs = 5000,
} = {}) {
  const candidates = getCandidateLibreOfficePaths(env, { platform });
  const checked = [];

  for (const bin of candidates) {
    checked.push(bin);
    if (isAbsoluteBinaryPath(bin) && !fileExists(bin)) continue;
    try {
      const { stdout, stderr } = await invokeRunner(bin, ['--version'], {
        timeoutMs: probeTimeoutMs,
        execRunner,
        platform,
      });
      const rawOut = String(stdout || stderr || '').trim();
      const version = rawOut.split(/\r?\n/)[0] || 'LibreOffice';
      const isWindowsConsole = /soffice\.com$/i.test(bin);
      return {
        available: true,
        binary: bin,
        version,
        platform,
        in_docker: isRunningInDocker(),
        prefers_console_binary: isWindowsConsole,
        checked_paths: checked,
      };
    } catch {
      // Binary missing or failed to execute — try next candidate
    }
  }

  return {
    available: false,
    binary: null,
    version: null,
    platform,
    in_docker: isRunningInDocker(),
    prefers_console_binary: false,
    checked_paths: candidates,
    install_guidance: getLibreOfficeInstallInstructions(platform),
  };
}

export function cleanupTempDir(dirPath) {
  if (!dirPath) return true;
  try {
    rmSync(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return !existsSync(dirPath);
  } catch {
    return !existsSync(dirPath);
  }
}

export async function runLibreOfficeConversion({
  inputBuffer,
  inputFilename,
  expectedOutputFilename,
  convertTo,
  inFilter = null,
  env = process.env,
  execRunner = null,
  fileExists = existsSync,
  timeoutMs = Number(env.DOCX_PDF_TIMEOUT_MS || 120000),
  platform = process.platform,
  tempPrefix = 'runut-lo-',
} = {}) {
  const detected = await detectLibreOffice({ env, execRunner, fileExists, platform });
  if (!detected.available) {
    return {
      ok: false,
      code: 'CONVERTER_UNAVAILABLE',
      detected,
      install_guidance: detected.install_guidance || getLibreOfficeInstallInstructions(platform),
      stdout: '',
      stderr: '',
    };
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), tempPrefix));
  const profileDir = path.join(tmpDir, 'lo-profile');
  try {
    const inFile = path.join(tmpDir, inputFilename);
    const outFile = path.join(tmpDir, expectedOutputFilename);
    writeFileSync(inFile, inputBuffer);

    const profileUrl = pathToFileURL(profileDir).href;
    const args = [
      `-env:UserInstallation=${profileUrl}`,
      '--headless',
      '--norestore',
      '--nodefault',
      '--nofirststartwizard',
      ...(inFilter ? [`--infilter=${inFilter}`] : []),
      '--convert-to',
      convertTo,
      '--outdir',
      tmpDir,
      inFile,
    ];

    const runResult = await invokeRunner(detected.binary, args, {
      timeoutMs,
      execRunner,
      platform,
    });

    if (!existsSync(outFile)) {
      return {
        ok: false,
        code: 'OUTPUT_FILE_MISSING',
        detected,
        stdout: runResult.stdout || '',
        stderr: runResult.stderr || '',
        temp_dir: tmpDir,
      };
    }

    const outputBuffer = readFileSync(outFile);
    if (!outputBuffer || outputBuffer.length === 0) {
      return {
        ok: false,
        code: 'EMPTY_OUTPUT_FILE',
        detected,
        stdout: runResult.stdout || '',
        stderr: runResult.stderr || '',
        temp_dir: tmpDir,
      };
    }

    return {
      ok: true,
      buffer: outputBuffer,
      detected,
      binary: detected.binary,
      version: detected.version,
      stdout: runResult.stdout || '',
      stderr: runResult.stderr || '',
      temp_dir: tmpDir,
    };
  } catch (err) {
    const isTimeout = err?.code === 'ETIMEDOUT' || Boolean(err?.killed);
    return {
      ok: false,
      code: isTimeout ? 'CONVERSION_TIMEOUT' : 'CONVERSION_FAILED',
      detected,
      error: err?.message || 'LibreOffice execution failed',
      stdout: String(err?.stdout || ''),
      stderr: String(err?.stderr || ''),
      temp_dir: tmpDir,
    };
  } finally {
    cleanupTempDir(tmpDir);
  }
}
