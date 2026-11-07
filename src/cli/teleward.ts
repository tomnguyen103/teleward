import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPtbxlBinary } from '../data/ptbxlLoader.ts';
import {
  TelewardCliValidationError,
  runSimulation,
} from '../engine/aclsEngine.ts';
import type { Rfc7807Error } from '../types/teleward.ts';

function parseArgMap(argv: string[]): Map<string, string | boolean> {
  const map = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        map.set(key, next);
        i += 1;
      } else {
        map.set(key, true);
      }
    }
  }
  return map;
}

export function executeCli(argv: string[]): number {
  const subcommand = argv[0] ?? 'sim';
  const flags = parseArgMap(argv.slice(1));

  try {
    if (subcommand === 'compile') {
      const outDir = typeof flags.get('out-dir') === 'string' ? String(flags.get('out-dir')) : 'public/data';
      const seedStr = typeof flags.get('seed') === 'string' ? String(flags.get('seed')) : '42';
      const out = execFileSync(
        'python',
        [resolve(process.cwd(), 'compiler/compile_ptbxl.py'), '--out-dir', outDir, '--seed', seedStr],
        { encoding: 'utf-8' }
      );
      process.stdout.write(out);
      return 0;
    }

    if (subcommand === 'verify') {
      const binPath = resolve(process.cwd(), 'public/data/ptbxl_120.bin');
      const idxPath = resolve(process.cwd(), 'public/data/ptbxl_index.json');
      const binBuf = readFileSync(binPath);
      const manifest = JSON.parse(readFileSync(idxPath, 'utf-8'));
      const dataset = loadPtbxlBinary(
        binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength),
        manifest
      );
      process.stdout.write(
        JSON.stringify({
          status: 'verified',
          records: dataset.records.length,
          crc32Hex: dataset.header.crc32.toString(16).padStart(8, '0'),
        }) + '\n'
      );
      return 0;
    }

    if (subcommand === 'sim') {
      const scenarioRaw = flags.get('scenario');
      const interventionRaw = flags.get('intervention');
      const atRaw = flags.get('at');
      const durationRaw = flags.get('duration');
      const seedRaw = flags.get('seed');

      const seedNum =
        seedRaw === undefined
          ? 42
          : typeof seedRaw === 'string' && /^-?\d+$/.test(seedRaw.trim())
            ? Number(seedRaw.trim())
            : Number.NaN;

      const atSec =
        atRaw === undefined ? 10 : typeof atRaw === 'string' ? Number(atRaw) : Number.NaN;
      const durationSec =
        durationRaw === undefined
          ? 45
          : typeof durationRaw === 'string'
            ? Number(durationRaw)
            : Number.NaN;

      const result = runSimulation({
        scenario: typeof scenarioRaw === 'string' ? scenarioRaw : '',
        intervention: typeof interventionRaw === 'string' ? interventionRaw : null,
        atSec,
        durationSec,
        seed: seedNum,
      });

      if (flags.get('json')) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stdout.write(
          `[TeleWard ACLS Sim] seed=${result.seed} scenario=${result.scenario} intervention=${result.intervention ?? 'none'} -> outcome=${result.outcome} final=${result.finalVitals.rhythm} BP=${result.finalVitals.sbp}/${result.finalVitals.dbp} EtCO2=${result.finalVitals.etco2}\n`
        );
      }
      return 0;
    }

    const unknownProblem: Rfc7807Error = {
      type: 'https://teleward.clinic/errors/unknown_subcommand',
      title: 'Unknown TeleWard CLI Subcommand',
      status: 422,
      detail: `Unsupported subcommand "${subcommand}". Use "sim", "compile", or "verify".`,
      code: 'UNKNOWN_SUBCOMMAND',
    };
    process.stdout.write(JSON.stringify(unknownProblem) + '\n');
    return 2;
  } catch (err: unknown) {
    if (err instanceof TelewardCliValidationError) {
      process.stdout.write(JSON.stringify(err.problem) + '\n');
      return 2;
    }
    const fallback: Rfc7807Error = {
      type: 'https://teleward.clinic/errors/cli_runtime_error',
      title: 'TeleWard CLI Runtime Error',
      status: 422,
      detail: err instanceof Error ? err.message : String(err),
      code: 'CLI_RUNTIME_ERROR',
    };
    process.stdout.write(JSON.stringify(fallback) + '\n');
    return 2;
  }
}
