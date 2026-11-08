import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPtbxlBinary } from '../data/ptbxlLoader.ts';
import {
  TelewardCliValidationError,
  runSimulation,
} from '../engine/aclsEngine.ts';
import { startTelewardServer } from '../server/apiServer.ts';
import type { Rfc7807Error } from '../types/teleward.ts';

function resolveCompilerScriptPath(): string {
  try {
    const fromModule = fileURLToPath(new URL('../../compiler/compile_ptbxl.py', import.meta.url));
    if (existsSync(fromModule)) {
      return fromModule;
    }
  } catch {
    // Fallback to process.cwd()
  }
  return resolve(process.cwd(), 'compiler/compile_ptbxl.py');
}

function runPythonCompiler(args: string[]): string {
  try {
    return execFileSync('python', args, { encoding: 'utf-8' });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') {
      return execFileSync('python3', args, { encoding: 'utf-8' });
    }
    throw err;
  }
}

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
      const compilerArgs = [resolveCompilerScriptPath(), '--out-dir', outDir, '--seed', seedStr];
      if (typeof flags.get('ptbxl-dir') === 'string') {
        compilerArgs.push('--ptbxl-dir', String(flags.get('ptbxl-dir')));
      }
      const out = runPythonCompiler(compilerArgs);
      process.stdout.write(out);
      return 0;
    }

    if (subcommand === 'verify') {
      const outDir = typeof flags.get('out-dir') === 'string' ? String(flags.get('out-dir')) : 'public/data';
      const binPath = resolve(process.cwd(), outDir, 'ptbxl_120.bin');
      const idxPath = resolve(process.cwd(), outDir, 'ptbxl_index.json');
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

      if (
        interventionRaw === true ||
        (typeof interventionRaw === 'string' && interventionRaw.trim() === '')
      ) {
        throw new TelewardCliValidationError(
          'Flag --intervention requires a valid ACLS intervention name.',
          'INVALID_INTERVENTION'
        );
      }

      const seedNum =
        seedRaw === undefined
          ? 42
          : typeof seedRaw === 'string' && /^-?\d+$/.test(seedRaw.trim())
            ? Number(seedRaw.trim())
            : Number.NaN;

      const atSec =
        atRaw === undefined
          ? undefined
          : typeof atRaw === 'string' && atRaw.trim() !== ''
            ? Number(atRaw.trim())
            : Number.NaN;
      const durationSec =
        durationRaw === undefined
          ? 45
          : typeof durationRaw === 'string' && durationRaw.trim() !== ''
            ? Number(durationRaw.trim())
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

    if (subcommand === 'serve') {
      const portRaw = flags.get('port');
      const port =
        portRaw === undefined
          ? 4173
          : typeof portRaw === 'string' && /^\d+$/.test(portRaw.trim())
            ? Number(portRaw.trim())
            : Number.NaN;

      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new TelewardCliValidationError(
          `Invalid --port "${String(portRaw)}". Must be an integer between 0 and 65535.`,
          'INVALID_PORT'
        );
      }

      void startTelewardServer(port)
        .then((started) => {
          process.stdout.write(
            JSON.stringify({
              status: 'listening',
              service: 'teleward-api',
              port: started.port,
              url: `http://127.0.0.1:${started.port}`,
            }) + '\n'
          );
          if (flags.get('once')) {
            void started.close();
          }
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            JSON.stringify({
              type: 'https://teleward.clinic/errors/server-start-error',
              title: 'TeleWard Server Start Error',
              status: 500,
              detail,
            }) + '\n'
          );
          process.exitCode = 1;
        });
      return 0;
    }

    const unknownProblem: Rfc7807Error = {
      type: 'https://teleward.clinic/errors/unknown_subcommand',
      title: 'Unknown TeleWard CLI Subcommand',
      status: 422,
      detail: `Unsupported subcommand "${subcommand}". Use "sim", "compile", "verify", or "serve".`,
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
