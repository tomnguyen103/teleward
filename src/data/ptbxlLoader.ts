import {
  LEAD_NAMES,
  RHYTHM_CLASSES,
  type LeadName,
  type PtbxlCaseRecord,
  type PtbxlIndexManifest,
  type Rfc7807Error,
} from '../types/teleward.ts';

// shortcut: ptbxl_120.bin stores a 2.5s (1250-sample) seamless periodic/arrhythmic tile per lead expanded to 10s in memory to keep static bundle size at 7.2 MB instead of 28.8 MB, upgrade to HTTP Range requests if expanding bank past 500 records

export const HEADER_BYTE_LENGTH = 32;
export const EXPECTED_RECORD_COUNT = 120;
export const EXPECTED_LEAD_COUNT = 12;
export const EXPECTED_SAMPLE_RATE_HZ = 500;
export const EXPECTED_SAMPLES_PER_TILE = 1250;
export const EXPECTED_PAYLOAD_FLOATS =
  EXPECTED_RECORD_COUNT * EXPECTED_LEAD_COUNT * EXPECTED_SAMPLES_PER_TILE;
export const EXPECTED_BINARY_BYTES = HEADER_BYTE_LENGTH + EXPECTED_PAYLOAD_FLOATS * 4; // 7,200,032 bytes

const CASE_ID_REGEX = /^ptbxl-(\d{3})$/;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i]!;
    const lookupIdx = (crc ^ byte) & 0xff;
    crc = (crc >>> 8) ^ CRC32_TABLE[lookupIdx]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type TelewardBinaryErrorCode = 'BINARY_CORRUPT' | 'CASE_NOT_FOUND' | 'MANIFEST_MISMATCH';

export class TelewardBinaryError extends Error {
  public readonly code: TelewardBinaryErrorCode;
  public readonly problem: Rfc7807Error;

  constructor(code: TelewardBinaryErrorCode, detail: string) {
    super(detail);
    this.name = 'TelewardBinaryError';
    this.code = code;
    this.problem = {
      type: `https://teleward.clinic/errors/${code.toLowerCase()}`,
      title:
        code === 'BINARY_CORRUPT'
          ? 'Corrupted TWEC Binary Waveform Chunk'
          : code === 'MANIFEST_MISMATCH'
            ? 'PTB-XL Index Manifest Mismatch'
            : 'PTB-XL Case Record Not Found',
      status: code === 'CASE_NOT_FOUND' ? 404 : 422,
      detail,
      code,
    };
  }
}

export const PTBXLLoaderError = TelewardBinaryError;

export interface ValidatedHeader {
  magic: 'TWEC';
  version: number;
  recordCount: number;
  leadCount: number;
  sampleRateHz: number;
  samplesPerLeadTile: number;
  crc32: number;
}

export interface LoadedPtbxlDataset {
  header: ValidatedHeader;
  records: PtbxlCaseRecord[];
  recordsById: Map<string, PtbxlCaseRecord>;
  payloadFloats: Float32Array;
}

export function validateBinaryChunk(buffer: ArrayBuffer): ValidatedHeader {
  if (buffer.byteLength !== EXPECTED_BINARY_BYTES) {
    throw new TelewardBinaryError(
      'BINARY_CORRUPT',
      `Expected TWEC binary length ${EXPECTED_BINARY_BYTES} bytes, received ${buffer.byteLength} bytes.`
    );
  }

  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== 'TWEC') {
    throw new TelewardBinaryError(
      'BINARY_CORRUPT',
      `Invalid TWEC magic header: "${magic}".`
    );
  }

  const version = view.getUint32(4, true);
  const recordCount = view.getUint32(8, true);
  const leadCount = view.getUint32(12, true);
  const sampleRateHz = view.getUint32(16, true);
  const samplesPerLeadTile = view.getUint32(20, true);
  const expectedCrc32 = view.getUint32(24, true);

  if (
    version !== 1 ||
    recordCount !== EXPECTED_RECORD_COUNT ||
    leadCount !== EXPECTED_LEAD_COUNT ||
    sampleRateHz !== EXPECTED_SAMPLE_RATE_HZ ||
    samplesPerLeadTile !== EXPECTED_SAMPLES_PER_TILE
  ) {
    throw new TelewardBinaryError(
      'BINARY_CORRUPT',
      `Header dimension mismatch: v=${version}, records=${recordCount}, leads=${leadCount}, sr=${sampleRateHz}, samples=${samplesPerLeadTile}.`
    );
  }

  const payloadBytes = new Uint8Array(buffer, HEADER_BYTE_LENGTH);
  const actualCrc32 = computeCrc32(payloadBytes);
  if (actualCrc32 !== expectedCrc32) {
    throw new TelewardBinaryError(
      'BINARY_CORRUPT',
      `Payload CRC32 mismatch: expected 0x${expectedCrc32.toString(16)}, computed 0x${actualCrc32.toString(16)}.`
    );
  }

  const floats = new Float32Array(buffer, HEADER_BYTE_LENGTH, EXPECTED_PAYLOAD_FLOATS);
  for (let i = 0; i < floats.length; i++) {
    const val = floats[i]!;
    if (!Number.isFinite(val) || val < -5.0 || val > 5.0) {
      throw new TelewardBinaryError(
        'BINARY_CORRUPT',
        `Out-of-range or non-finite sample at float index ${i}: ${val}.`
      );
    }
  }

  return {
    magic: 'TWEC',
    version,
    recordCount,
    leadCount,
    sampleRateHz,
    samplesPerLeadTile,
    crc32: expectedCrc32,
  };
}

export function loadPtbxlBinary(
  buffer: ArrayBuffer,
  manifest: PtbxlIndexManifest
): LoadedPtbxlDataset {
  const header = validateBinaryChunk(buffer);
  if (!manifest || !Array.isArray(manifest.records) || manifest.records.length !== EXPECTED_RECORD_COUNT) {
    throw new TelewardBinaryError(
      'BINARY_CORRUPT',
      `Manifest record count mismatch: expected ${EXPECTED_RECORD_COUNT}.`
    );
  }

  const expectedCrcHex = header.crc32.toString(16).padStart(8, '0').toLowerCase();
  if (
    typeof manifest.crc32Hex !== 'string' ||
    manifest.crc32Hex.toLowerCase() !== expectedCrcHex
  ) {
    throw new TelewardBinaryError(
      'BINARY_CORRUPT',
      `Manifest crc32Hex "${String(manifest.crc32Hex)}" does not match binary header CRC32 "${expectedCrcHex}".`
    );
  }

  const payloadFloats = new Float32Array(buffer, HEADER_BYTE_LENGTH, EXPECTED_PAYLOAD_FLOATS);
  const recordsById = new Map<string, PtbxlCaseRecord>();
  for (let i = 0; i < manifest.records.length; i++) {
    const rec = manifest.records[i]!;
    const expectedCaseId = `ptbxl-${String(i + 1).padStart(3, '0')}`;
    if (
      !rec ||
      typeof rec !== 'object' ||
      rec.recordIndex !== i ||
      rec.caseId !== expectedCaseId ||
      !CASE_ID_REGEX.test(rec.caseId) ||
      typeof rec.rhythmClass !== 'string' ||
      !RHYTHM_CLASSES.includes(rec.rhythmClass) ||
      typeof rec.clinicalSummary !== 'string' ||
      !rec.fiducials ||
      typeof rec.fiducials !== 'object' ||
      recordsById.has(rec.caseId)
    ) {
      throw new PTBXLLoaderError(
        'MANIFEST_MISMATCH',
        `Manifest record index/caseId/schema mismatch at position ${i}: expected ${expectedCaseId}, got recordIndex=${String(rec?.recordIndex)}, caseId=${String(rec?.caseId)}.`
      );
    }
    recordsById.set(rec.caseId, rec);
  }

  return {
    header,
    records: manifest.records,
    recordsById,
    payloadFloats,
  };
}

export function getCaseById(dataset: LoadedPtbxlDataset, caseId: string): PtbxlCaseRecord {
  if (!CASE_ID_REGEX.test(caseId)) {
    throw new TelewardBinaryError(
      'CASE_NOT_FOUND',
      `Invalid or disallowed PTB-XL case identifier: "${caseId}".`
    );
  }
  const found = dataset.recordsById.get(caseId);
  if (!found) {
    throw new TelewardBinaryError(
      'CASE_NOT_FOUND',
      `PTB-XL case "${caseId}" not found in compiled 120-record index.`
    );
  }
  return found;
}

export type CaseWaveforms12Lead = Record<LeadName, Float32Array>;

export function getCaseWaveforms(
  dataset: LoadedPtbxlDataset,
  caseId: string,
  totalSamples = 5000
): CaseWaveforms12Lead {
  const record = getCaseById(dataset, caseId);
  const recordBaseOffset =
    record.recordIndex * EXPECTED_LEAD_COUNT * EXPECTED_SAMPLES_PER_TILE;

  const result = {} as CaseWaveforms12Lead;
  for (let l = 0; l < LEAD_NAMES.length; l++) {
    const leadName = LEAD_NAMES[l]!;
    const leadOffset = recordBaseOffset + l * EXPECTED_SAMPLES_PER_TILE;
    const out = new Float32Array(totalSamples);

    for (let s = 0; s < totalSamples; s++) {
      const tileIdx = s % EXPECTED_SAMPLES_PER_TILE;
      const sampleVal = dataset.payloadFloats[leadOffset + tileIdx]!;
      if (!Number.isFinite(sampleVal) || sampleVal < -5.0 || sampleVal > 5.0) {
        throw new TelewardBinaryError(
          'BINARY_CORRUPT',
          `Out-of-range or non-finite sample encountered in ${caseId} lead ${leadName} at sample ${s}: ${sampleVal}.`
        );
      }
      out[s] = sampleVal;
    }
    result[leadName] = out;
  }

  return result;
}
