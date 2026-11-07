import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  loadPtbxlBinary,
  validateBinaryChunk,
  computeCrc32,
  getCaseWaveforms,
  getCaseById,
  TelewardBinaryError,
  EXPECTED_BINARY_BYTES,
} from '../src/data/ptbxlLoader.ts';
import { RHYTHM_CLASSES, LEAD_NAMES } from '../src/types/teleward.ts';

const WORKSPACE_ROOT = resolve(process.cwd());
const DATA_DIR = resolve(WORKSPACE_ROOT, 'public/data');
const BIN_PATH = resolve(DATA_DIR, 'ptbxl_120.bin');
const INDEX_PATH = resolve(DATA_DIR, 'ptbxl_index.json');
const COMPILER_SCRIPT = resolve(WORKSPACE_ROOT, 'compiler/compile_ptbxl.py');

describe('US-01: PhysioNet PTB-XL 120-Record Python + DuckDB Binary Compiler & Loader', () => {
  beforeAll(() => {
    execFileSync('python', [COMPILER_SCRIPT, '--out-dir', 'public/data', '--seed', '42'], {
      cwd: WORKSPACE_ROOT,
      stdio: 'pipe',
    });
  });

  it('US-01.1: compiles 120 curated records (10 per 12 classes) with TWEC header, CRC32, < 50ms parse time, and Einthoven law |II - (I + III)| < 1e-4 mV', () => {
    expect(existsSync(BIN_PATH)).toBe(true);
    expect(existsSync(INDEX_PATH)).toBe(true);

    const binBuf = readFileSync(BIN_PATH);
    const indexJson = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));

    // Exact byte length: 32-byte header + 120 * 12 * 1250 * 4 = 7,200,032 bytes (<= 7.5 MB ADR invariant)
    expect(binBuf.byteLength).toBe(7200032);
    expect(binBuf.byteLength).toBe(EXPECTED_BINARY_BYTES);
    expect(binBuf.byteLength).toBeLessThanOrEqual(7500000);

    const t0 = performance.now();
    const dataset = loadPtbxlBinary(binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength), indexJson);
    const parseMs = performance.now() - t0;
    expect(parseMs).toBeLessThan(50);

    expect(dataset.records.length).toBe(120);

    // Verify 12 classes x 10 records = 120
    for (const rClass of RHYTHM_CLASSES) {
      const matching = dataset.records.filter((r) => r.rhythmClass === rClass);
      expect(matching.length).toBe(10);
    }

    // Verify 24 starter free cases (2 per rhythm class)
    const freeCount = dataset.records.filter((r) => r.freeStarter).length;
    expect(freeCount).toBe(24);

    // Verify fiducial sample alignment, NSR PR bounds (140..190 ms), and Lead II J-point stMv across all 120 records
    for (const rec of dataset.records) {
      const f = rec.fiducials;
      if (rec.rhythmClass === 'NSR') {
        expect(f.prMs).toBeGreaterThanOrEqual(140);
        expect(f.prMs).toBeLessThanOrEqual(190);
      }
      expect(f.qrsOnSample - f.pOnSample).toBe(Math.round(f.prMs * 0.5));
      expect(f.qrsOffSample - f.qrsOnSample).toBe(Math.round(f.qrsMs * 0.5));
      expect(f.tOffSample - f.qrsOnSample).toBe(Math.round(f.qtMs * 0.5));

      const w = getCaseWaveforms(dataset, rec.caseId, 1250);
      if (f.qrsMs > 0 && f.rPeakSamples.length > 0) {
        const qrsPre = f.rPeakSamples[0]! - f.qrsOnSample;
        const qrsSamples = f.qrsOffSample - f.qrsOnSample;
        for (const rp of f.rPeakSamples) {
          const beatOn = (rp - qrsPre + 1250) % 1250;
          const beatOff = (beatOn + qrsSamples) % 1250;
          const stRel = w.II[beatOff]! - w.II[beatOn]!;
          expect(Math.abs(stRel - f.stMv)).toBeLessThanOrEqual(0.025);
        }
      }
    }

    // Verify Einthoven's identity II = I + III and Goldberger identities across records
    for (let idx = 0; idx < 120; idx += 11) {
      const rec = dataset.records[idx]!;
      const waveforms = getCaseWaveforms(dataset, rec.caseId, 1250);
      for (let s = 0; s < 1250; s += 25) {
        const leadI = waveforms.I[s]!;
        const leadII = waveforms.II[s]!;
        const leadIII = waveforms.III[s]!;
        const aVR = waveforms.aVR[s]!;
        const aVL = waveforms.aVL[s]!;
        const aVF = waveforms.aVF[s]!;
        expect(Math.abs(leadII - (leadI + leadIII))).toBeLessThan(1e-4);
        expect(Math.abs(aVR + aVL + aVF)).toBeLessThan(1e-4);
      }
    }
  });

  it('US-01.2: validates boundary records (0 and 119), sample boundaries (0, 1249, and 5000-sample 10s expansion) within [-5.0, +5.0] mV', () => {
    const binBuf = readFileSync(BIN_PATH);
    const indexJson = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
    const dataset = loadPtbxlBinary(binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength), indexJson);

    for (const caseId of ['ptbxl-001', 'ptbxl-120']) {
      const strip10s = getCaseWaveforms(dataset, caseId, 5000);
      for (const lead of LEAD_NAMES) {
        const arr = strip10s[lead];
        expect(arr.length).toBe(5000);
        expect(Number.isFinite(arr[0]!)).toBe(true);
        expect(Number.isFinite(arr[1249]!)).toBe(true);
        expect(Number.isFinite(arr[1250]!)).toBe(true);
        expect(Number.isFinite(arr[4999]!)).toBe(true);

        for (let i = 0; i < arr.length; i++) {
          const val = arr[i]!;
          expect(Number.isFinite(val)).toBe(true);
          expect(val).toBeGreaterThanOrEqual(-5.0);
          expect(val).toBeLessThanOrEqual(5.0);
        }
        // Check seam continuity between sample 1249 and 1250
        expect(Math.abs(arr[1250]! - arr[0]!)).toBeLessThan(1e-5);
      }
    }
  });

  it('US-01.3: rejects corrupted binary headers, wrong byte lengths, mutated CRC32, NaN floats, and unknown/path-traversal case IDs with TelewardBinaryError', () => {
    const binBuf = readFileSync(BIN_PATH);
    const indexJson = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
    const validAb = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);

    // 1. Corrupted magic header
    const badMagic = validAb.slice(0);
    new Uint8Array(badMagic)[0] = 0x00;
    expect(() => validateBinaryChunk(badMagic)).toThrowError(TelewardBinaryError);

    // 2. Truncated buffer
    const truncated = validAb.slice(0, 1024);
    expect(() => validateBinaryChunk(truncated)).toThrowError(TelewardBinaryError);

    // 3. Mutated sample bytes (triggers CRC32 mismatch)
    const badCrc = validAb.slice(0);
    const floatView = new DataView(badCrc);
    floatView.setFloat32(64, 1.2345, true);
    expect(() => validateBinaryChunk(badCrc)).toThrowError(TelewardBinaryError);

    // 4. Non-multiple-of-64 float corruption (index 17) with recomputed CRC32
    const badFloat17 = validAb.slice(0);
    const dv17 = new DataView(badFloat17);
    dv17.setFloat32(32 + 17 * 4, 9.25, true);
    dv17.setUint32(24, computeCrc32(new Uint8Array(badFloat17, 32)), true);
    expect(() => validateBinaryChunk(badFloat17)).toThrowError(TelewardBinaryError);

    // 5. Manifest crc32Hex or recordIndex tampering
    const badCrcManifest = { ...indexJson, crc32Hex: 'deadbeef' };
    expect(() => loadPtbxlBinary(validAb, badCrcManifest)).toThrowError(TelewardBinaryError);

    const badIdxRecords = indexJson.records.map((r: { recordIndex: number }, i: number) =>
      i === 5 ? { ...r, recordIndex: 99 } : r
    );
    expect(() =>
      loadPtbxlBinary(validAb, { ...indexJson, records: badIdxRecords })
    ).toThrowError(TelewardBinaryError);

    // 6. Unknown or traversal caseId
    const dataset = loadPtbxlBinary(validAb, indexJson);
    expect(() => getCaseById(dataset, 'ptbxl-999')).toThrowError(TelewardBinaryError);
    expect(() => getCaseById(dataset, '../etc/passwd')).toThrowError(TelewardBinaryError);
  });

  it('US-01.4: produces bit-identical SHA-256 and CRC32 across repeated seeded compiler invocations', () => {
    const shaBefore = createHash('sha256').update(readFileSync(BIN_PATH)).digest('hex');
    execFileSync('python', [COMPILER_SCRIPT, '--out-dir', 'public/data', '--seed', '42'], {
      cwd: WORKSPACE_ROOT,
      stdio: 'pipe',
    });
    const shaAfter = createHash('sha256').update(readFileSync(BIN_PATH)).digest('hex');
    expect(shaAfter).toBe(shaBefore);
  });

  it('US-01.5: cleans up stale .tmp files and succeeds offline when raw WFDB archives are absent', () => {
    const staleTmp = resolve(DATA_DIR, 'ptbxl_120.bin.tmp.99999');
    writeFileSync(staleTmp, 'partial-corrupt-bytes', 'utf-8');
    expect(existsSync(staleTmp)).toBe(true);

    execFileSync(
      'python',
      [COMPILER_SCRIPT, '--out-dir', 'public/data', '--ptbxl-dir', 'public/data/nonexistent_wfdb', '--seed', '42'],
      { cwd: WORKSPACE_ROOT, stdio: 'pipe' }
    );

    const remainingTmp = readdirSync(DATA_DIR).filter((name) => name.includes('.tmp'));
    expect(remainingTmp.length).toBe(0);
    expect(readFileSync(BIN_PATH).byteLength).toBe(7200032);
  });

  it('US-01.6: rejects path-traversal --out-dir outside the workspace with exit code 2 and ERR_PATH_TRAVERSAL', () => {
    let exitStatus = 0;
    let stderrOut = '';
    try {
      execFileSync('python', [COMPILER_SCRIPT, '--out-dir', '../../outside_teleward_escape'], {
        cwd: WORKSPACE_ROOT,
        stdio: 'pipe',
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer };
      exitStatus = e.status ?? 1;
      stderrOut = (e.stderr?.toString('utf-8') ?? '') + (e.stdout?.toString('utf-8') ?? '');
    }
    expect(exitStatus).toBe(2);
    expect(stderrOut).toContain('ERR_PATH_TRAVERSAL');
  });
});
