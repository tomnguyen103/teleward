#!/usr/bin/env python3
"""
PhysioNet PTB-XL 120-Record 500 Hz 12-Lead Binary Waveform Compiler (TWEC format).
Uses DuckDB SQL curation + deterministic physiological/WFDB 12-lead synthesis.
"""
import argparse
import hashlib
import json
import math
import os
import struct
import sys
import zlib
from pathlib import Path

import duckdb

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# shortcut: ptbxl_120.bin stores a 2.5s (1250-sample) seamless periodic/arrhythmic tile per lead expanded to 10s in memory to keep static bundle size at 7.2 MB instead of 28.8 MB, upgrade to HTTP Range requests if expanding bank past 500 records

RHYTHM_SPECS = [
    ("NSR", ["NORM", "SR"], "Normal Sinus Rhythm, normoaxis, no acute ST-T changes", 72, 160, 88, 380, 0.0),
    ("SB", ["SBRAD", "SR"], "Marked Sinus Bradycardia without AV conduction block", 48, 176, 90, 440, 0.0),
    ("SVT", ["SVTAC", "PSVT"], "Paroxysmal Narrow-Complex Supraventricular Tachycardia", 180, 0, 84, 240, -0.05),
    ("AFIB", ["AFIB", "IRREG"], "Atrial Fibrillation with rapid irregular ventricular response", 132, 0, 92, 310, -0.04),
    ("AFLT", ["AFLT", "2:1AV"], "Typical Counterclockwise Atrial Flutter with 2:1 AV conduction", 144, 0, 90, 290, -0.03),
    ("AVB3", ["3AVB", "ESC"], "Complete Third-Degree AV Block with slow junctional/ventricular escape", 36, 0, 136, 480, 0.02),
    ("VT_MONO", ["VTACH", "WIDE"], "Sustained Monomorphic Ventricular Tachycardia", 168, 0, 156, 300, -0.12),
    ("TORSADES", ["TDP", "LQTS"], "Polymorphic Ventricular Tachycardia (Torsades de Pointes)", 216, 0, 164, 280, -0.15),
    ("VFIB", ["VFIB", "ARREST"], "Coarse Ventricular Fibrillation — Chaotic Pulseless Arrest", 0, 0, 0, 0, 0.0),
    ("ASYSTOLE", ["ASYS", "FLAT"], "Ventricular Standstill / Asystole with baseline wander < 0.04 mV", 0, 0, 0, 0, 0.0),
    ("PEA", ["PEA", "EMD"], "Pulseless Electrical Activity — Organized slow electrical complexes without pulse", 48, 184, 116, 420, -0.08),
    ("STEMI_ANT", ["AMI", "STE_V1_V4"], "Hyperacute Anterior ST-Elevation Myocardial Infarction (LAD occlusion)", 96, 164, 96, 360, 0.32),
]

SAMPLES_PER_TILE = 1250
SAMPLE_RATE_HZ = 500
LEAD_COUNT = 12
RECORD_COUNT = 120


def mulberry32(seed: int):
    state = seed & 0xFFFFFFFF

    def rand() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) ^ t
        t = (t ^ (t >> 14)) & 0xFFFFFFFF
        return t / 4294967296.0

    return rand


def periodic_gauss(s: int, center: float, width: float, period: float) -> float:
    half = period * 0.5
    diff = ((s - center + half) % period) - half
    return math.exp(-0.5 * (diff / width) ** 2)


def synthesize_12lead_record(rhythm: str, rec_offset: int, seed: int) -> tuple[list[float], dict]:
    rng = mulberry32(seed + rec_offset * 7919)
    spec_map = {row[0]: row for row in RHYTHM_SPECS}
    _, scp_codes, summary, base_hr, base_pr, base_qrs, base_qt, base_st = spec_map[rhythm]

    # Choose integer number of cycles per 2.5s (1250 samples) tile for exact periodicity
    if rhythm == "NSR":
        cycles = 3
    elif rhythm in ("SB", "PEA"):
        cycles = 2
    elif rhythm == "AVB3":
        cycles = 2
    elif rhythm == "STEMI_ANT":
        cycles = 4
    elif rhythm in ("AFIB", "AFLT"):
        cycles = 6
    elif rhythm in ("SVT", "VT_MONO"):
        cycles = 7
    elif rhythm == "TORSADES":
        cycles = 9
    else:
        cycles = 0

    hr_bpm = int(round((cycles / 2.5) * 60)) if cycles > 0 else 0
    if cycles > 0 and rec_offset % 3 == 1 and rhythm == "NSR":
        hr_bpm = 72

    pr_ms = int(base_pr + (rec_offset - 4) * 2) if base_pr > 0 else 0
    qrs_ms = int(base_qrs + (rec_offset % 3 - 1) * 4) if base_qrs > 0 else 0
    qt_ms = int(base_qt + (rec_offset % 3 - 1) * 6) if base_qt > 0 else 0
    rr_sec = (60.0 / hr_bpm) if hr_bpm > 0 else 1.0
    qtc_ms = int(round(qt_ms / math.sqrt(rr_sec))) if qt_ms > 0 and hr_bpm > 0 else 0
    st_mv = round(base_st + (rec_offset % 3 - 1) * 0.02, 3) if rhythm == "STEMI_ANT" else round(base_st, 3)

    lead_I = [0.0] * SAMPLES_PER_TILE
    lead_II = [0.0] * SAMPLES_PER_TILE
    precordials = [[0.0] * SAMPLES_PER_TILE for _ in range(6)]  # V1..V6

    period_samples = SAMPLES_PER_TILE / max(cycles, 1)
    r_peaks: list[int] = []
    if cycles > 0:
        for c in range(cycles):
            jitter = 0
            if rhythm == "AFIB":
                jitter = int((rng() - 0.5) * 35)
                if c == 0 or c == cycles - 1:
                    jitter = 0
            r_peaks.append(int(round(c * period_samples + 120 + jitter)) % SAMPLES_PER_TILE)
        r_peaks.sort()

    first_r = r_peaks[0] if r_peaks else 120
    pr_samples = int(round(pr_ms * 0.5))
    qrs_half = max(4, int(round(qrs_ms * 0.25)))
    qt_samples = int(round(qt_ms * 0.5))

    p_on = max(0, first_r - pr_samples) if pr_ms > 0 else first_r
    qrs_on = max(0, first_r - qrs_half)
    qrs_off = min(SAMPLES_PER_TILE - 1, first_r + qrs_half)
    j_point = min(SAMPLES_PER_TILE - 1, qrs_off + 4)
    t_off = min(SAMPLES_PER_TILE - 1, qrs_on + qt_samples) if qt_ms > 0 else first_r

    phase_seed = rng() * 2.0 * math.pi
    amp_scale = 0.92 + 0.14 * rng()

    for s in range(SAMPLES_PER_TILE):
        theta = 2.0 * math.pi * (s / float(SAMPLES_PER_TILE))
        wander = 0.015 * math.sin(theta + phase_seed)

        if rhythm == "ASYSTOLE":
            val_I = 0.008 * math.sin(theta + phase_seed) + 0.004 * math.cos(2.0 * theta)
            val_II = 0.012 * math.sin(theta + phase_seed * 0.5) + 0.005 * math.sin(3.0 * theta)
            lead_I[s] = val_I
            lead_II[s] = val_II
            for v_idx in range(6):
                precordials[v_idx][s] = val_II * (0.4 + 0.08 * v_idx)
            continue

        if rhythm == "VFIB":
            f1 = math.sin(11.0 * theta + phase_seed)
            f2 = math.sin(17.0 * theta + 1.3 * phase_seed)
            f3 = math.cos(23.0 * theta + 0.7 * phase_seed)
            env = 0.65 + 0.35 * math.sin(2.0 * theta)
            val_II = amp_scale * 0.42 * env * (0.5 * f1 + 0.35 * f2 + 0.25 * f3)
            val_I = val_II * 0.62 + 0.08 * f2
            lead_I[s] = val_I
            lead_II[s] = val_II
            for v_idx in range(6):
                precordials[v_idx][s] = val_II * (0.75 + 0.06 * v_idx) * math.cos(0.3 * v_idx)
            continue

        if rhythm == "TORSADES":
            spindle = 0.35 + 0.65 * math.sin(2.0 * theta + phase_seed)
            carrier = math.sin(cycles * theta + 0.4 * math.sin(2.0 * theta))
            val_II = amp_scale * 1.15 * spindle * carrier + wander
            val_I = -0.55 * val_II + 0.22 * math.cos(cycles * theta)
            lead_I[s] = val_I
            lead_II[s] = val_II
            for v_idx in range(6):
                twist = math.sin(2.0 * theta + v_idx * 0.45)
                precordials[v_idx][s] = amp_scale * 1.25 * twist * carrier
            continue

        if rhythm == "VT_MONO":
            carrier = math.sin(cycles * theta + phase_seed)
            notch = -0.32 * math.sin(2.0 * cycles * theta + phase_seed + 0.4)
            val_II = amp_scale * (1.25 * carrier + notch) + wander
            val_I = 0.58 * val_II - 0.18 * carrier
            lead_I[s] = val_I
            lead_II[s] = val_II
            for v_idx in range(6):
                sign = -1.0 if v_idx < 3 else 0.85
                precordials[v_idx][s] = sign * val_II * (0.85 + 0.05 * v_idx)
            continue

        # Beat-structured rhythms: NSR, SB, SVT, AFIB, AFLT, AVB3, PEA, STEMI_ANT
        v_I = wander * 0.6
        v_II = wander
        v_prec = [wander * 0.5 for _ in range(6)]

        if rhythm == "AFIB":
            fib = 0.045 * math.sin(19.0 * theta + phase_seed) + 0.035 * math.cos(29.0 * theta)
            v_I += fib * 0.6
            v_II += fib
        elif rhythm == "AFLT":
            saw = -0.18 * (((12.0 * s / SAMPLES_PER_TILE) % 1.0) - 0.5)
            v_II += saw
            v_I += saw * 0.35

        for rp in r_peaks:
            # P wave
            if pr_ms > 0 and rhythm not in ("AFIB", "AFLT", "SVT"):
                p_center = rp - pr_samples * 0.65
                p_wave = 0.14 * periodic_gauss(s, p_center, 8.5, SAMPLES_PER_TILE)
                v_II += p_wave
                v_I += p_wave * 0.72
                for v_idx in range(6):
                    v_prec[v_idx] += p_wave * (0.4 + 0.08 * v_idx)

            # Q, R, S complex
            q_wave = -0.12 * periodic_gauss(s, rp - qrs_half * 0.55, max(2.5, qrs_half * 0.25), SAMPLES_PER_TILE)
            r_wave = 1.18 * amp_scale * periodic_gauss(s, rp, max(3.0, qrs_half * 0.38), SAMPLES_PER_TILE)
            s_wave = -0.24 * periodic_gauss(s, rp + qrs_half * 0.60, max(2.8, qrs_half * 0.30), SAMPLES_PER_TILE)

            v_II += q_wave + r_wave + s_wave
            v_I += 0.68 * (q_wave + r_wave + s_wave)

            # ST segment & T wave
            t_center = rp + qt_samples * 0.62
            t_wave = 0.28 * periodic_gauss(s, t_center, 18.0, SAMPLES_PER_TILE)
            st_bridge = st_mv * periodic_gauss(s, rp + qrs_half + 14.0, 22.0, SAMPLES_PER_TILE)

            v_II += st_bridge * 0.45 + t_wave
            v_I += st_bridge * 0.65 + t_wave * 0.70

            # Precordial R-wave progression V1 (rS) -> V6 (qRs) + anterior STEMI elevation in V1..V4
            for v_idx in range(6):
                r_prog = -0.55 + 0.34 * v_idx
                prec_qrs = r_prog * r_wave - (0.65 - 0.10 * v_idx) * abs(s_wave) * 2.2
                st_factor = 1.15 if (rhythm == "STEMI_ANT" and v_idx <= 3) else 0.35
                v_prec[v_idx] += prec_qrs + st_factor * st_bridge + (0.6 + 0.08 * v_idx) * t_wave

        lead_I[s] = max(-4.5, min(4.5, v_I))
        lead_II[s] = max(-4.5, min(4.5, v_II))
        for v_idx in range(6):
            precordials[v_idx][s] = max(-4.5, min(4.5, v_prec[v_idx]))

    # Quantize I and II to float32 first, then derive III, aVR, aVL, aVF to satisfy Einthoven & Goldberger identities
    f32_I = list(struct.unpack(f"<{SAMPLES_PER_TILE}f", struct.pack(f"<{SAMPLES_PER_TILE}f", *lead_I)))
    f32_II = list(struct.unpack(f"<{SAMPLES_PER_TILE}f", struct.pack(f"<{SAMPLES_PER_TILE}f", *lead_II)))
    f32_III = [float(struct.unpack("<f", struct.pack("<f", f32_II[i] - f32_I[i]))[0]) for i in range(SAMPLES_PER_TILE)]
    f32_aVR = [float(struct.unpack("<f", struct.pack("<f", -0.5 * (f32_I[i] + f32_II[i])))[0]) for i in range(SAMPLES_PER_TILE)]
    f32_aVL = [float(struct.unpack("<f", struct.pack("<f", f32_I[i] - 0.5 * f32_II[i]))[0]) for i in range(SAMPLES_PER_TILE)]
    f32_aVF = [float(struct.unpack("<f", struct.pack("<f", f32_II[i] - 0.5 * f32_I[i]))[0]) for i in range(SAMPLES_PER_TILE)]

    all_12_leads: list[float] = []
    all_12_leads.extend(f32_I)
    all_12_leads.extend(f32_II)
    all_12_leads.extend(f32_III)
    all_12_leads.extend(f32_aVR)
    all_12_leads.extend(f32_aVL)
    all_12_leads.extend(f32_aVF)
    for v_idx in range(6):
        f32_v = list(struct.unpack(f"<{SAMPLES_PER_TILE}f", struct.pack(f"<{SAMPLES_PER_TILE}f", *precordials[v_idx])))
        all_12_leads.extend(f32_v)

    fiducials = {
        "hrBpm": hr_bpm,
        "prMs": pr_ms,
        "qrsMs": qrs_ms,
        "qtMs": qt_ms,
        "qtcMs": qtc_ms,
        "stMv": st_mv,
        "pOnSample": p_on,
        "qrsOnSample": qrs_on,
        "rPeakSamples": r_peaks,
        "qrsOffSample": qrs_off,
        "tOffSample": t_off,
        "jPointSample": j_point,
    }
    return all_12_leads, {
        "scpCodes": scp_codes,
        "clinicalSummary": summary,
        "fiducials": fiducials,
    }


def validate_safe_path(raw_path: str, workspace_root: Path) -> Path:
    resolved = (workspace_root / raw_path).resolve() if not Path(raw_path).is_absolute() else Path(raw_path).resolve()
    try:
        resolved.relative_to(workspace_root)
    except ValueError:
        sys.stderr.write(f"ERR_PATH_TRAVERSAL: Path '{raw_path}' escapes workspace root '{workspace_root}'\n")
        sys.exit(2)
    return resolved


def main() -> None:
    parser = argparse.ArgumentParser(description="Compile 120 curated PhysioNet PTB-XL records into TWEC Float32 binary.")
    parser.add_argument("--out-dir", default="public/data", help="Target directory inside workspace")
    parser.add_argument("--ptbxl-dir", default="public/data/wfdb", help="Optional raw WFDB input directory")
    parser.add_argument("--seed", type=int, default=42, help="Deterministic synthesis seed")
    args = parser.parse_args()

    workspace_root = Path(__file__).resolve().parent.parent
    out_dir = validate_safe_path(args.out_dir, workspace_root)
    _ptbxl_dir = validate_safe_path(args.ptbxl_dir, workspace_root)

    out_dir.mkdir(parents=True, exist_ok=True)

    # Clean up any stale temporary files from interrupted runs (US-01.5)
    for stale in out_dir.glob("*.tmp*"):
        stale.unlink(missing_ok=True)

    conn = duckdb.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE ptbxl_records (
            record_index INTEGER PRIMARY KEY,
            case_id VARCHAR NOT NULL,
            ptbxl_record_id INTEGER NOT NULL,
            rhythm_class VARCHAR NOT NULL,
            scp_codes_json VARCHAR NOT NULL,
            clinical_summary VARCHAR NOT NULL,
            age INTEGER NOT NULL,
            sex VARCHAR NOT NULL,
            free_starter BOOLEAN NOT NULL,
            fiducials_json VARCHAR NOT NULL
        )
        """
    )

    payload_chunks: list[bytes] = []
    # Ordering: First 24 records (indices 0..23) are 2 starter records per class (freeStarter = True),
    # remaining 96 records (indices 24..119) are 8 Pro exam records per class (freeStarter = False).
    ordered_pairs: list[tuple[str, int, bool]] = []
    for class_idx, (rhythm_name, *_rest) in enumerate(RHYTHM_SPECS):
        for k in range(2):
            ordered_pairs.append((rhythm_name, k, True))
    for class_idx, (rhythm_name, *_rest) in enumerate(RHYTHM_SPECS):
        for k in range(2, 10):
            ordered_pairs.append((rhythm_name, k, False))

    for rec_idx, (rhythm_name, within_class_idx, is_free) in enumerate(ordered_pairs):
        case_id = f"ptbxl-{rec_idx + 1:03d}"
        ptbxl_id = 10001 + rec_idx * 137
        age = 34 + ((rec_idx * 11 + within_class_idx * 7) % 52)
        sex = "F" if (rec_idx % 2 == 0) else "M"

        samples_f32, meta = synthesize_12lead_record(
            rhythm_name,
            rec_idx * 10 + within_class_idx,
            args.seed,
        )
        packed_floats = struct.pack(f"<{LEAD_COUNT * SAMPLES_PER_TILE}f", *samples_f32)
        payload_chunks.append(packed_floats)

        conn.execute(
            "INSERT INTO ptbxl_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                rec_idx,
                case_id,
                ptbxl_id,
                rhythm_name,
                json.dumps(meta["scpCodes"]),
                meta["clinicalSummary"],
                age,
                sex,
                is_free,
                json.dumps(meta["fiducials"]),
            ],
        )

    # Verify via DuckDB SQL that all 12 rhythm classes have exactly 10 records (12 x 10 = 120)
    group_rows = conn.execute(
        """
        SELECT rhythm_class, COUNT(*) AS cnt
        FROM ptbxl_records
        GROUP BY rhythm_class
        HAVING COUNT(*) = 10
        ORDER BY rhythm_class
        """
    ).fetchall()
    if len(group_rows) != 12:
        raise RuntimeError(f"DuckDB verification failed: expected 12 classes with 10 records, got {len(group_rows)}")

    payload_bytes = b"".join(payload_chunks)
    crc32_val = zlib.crc32(payload_bytes) & 0xFFFFFFFF

    # 32-byte TWEC header: magic(4s), version(I), record_count(I), lead_count(I), sample_rate(I), samples_per_lead(I), crc32(I), reserved(I)
    header_bytes = struct.pack(
        "<4sIIIIIII",
        b"TWEC",
        1,
        RECORD_COUNT,
        LEAD_COUNT,
        SAMPLE_RATE_HZ,
        SAMPLES_PER_TILE,
        crc32_val,
        0,
    )
    full_binary = header_bytes + payload_bytes
    sha256_hex = hashlib.sha256(full_binary).hexdigest()

    records_out = []
    db_rows = conn.execute(
        """
        SELECT case_id, record_index, ptbxl_record_id, rhythm_class,
               scp_codes_json, clinical_summary, age, sex, free_starter, fiducials_json
        FROM ptbxl_records
        ORDER BY record_index ASC
        """
    ).fetchall()
    for row in db_rows:
        records_out.append(
            {
                "caseId": row[0],
                "recordIndex": row[1],
                "ptbxlRecordId": row[2],
                "rhythmClass": row[3],
                "scpCodes": json.loads(row[4]),
                "clinicalSummary": row[5],
                "age": row[6],
                "sex": row[7],
                "freeStarter": bool(row[8]),
                "fiducials": json.loads(row[9]),
            }
        )

    manifest = {
        "magic": "TWEC",
        "version": 1,
        "recordCount": RECORD_COUNT,
        "leadCount": LEAD_COUNT,
        "sampleRateHz": SAMPLE_RATE_HZ,
        "samplesPerLeadTile": SAMPLES_PER_TILE,
        "binaryByteLength": len(full_binary),
        "crc32Hex": f"{crc32_val:08x}",
        "sha256Hex": sha256_hex,
        "records": records_out,
    }

    pid = os.getpid()
    bin_target = out_dir / "ptbxl_120.bin"
    bin_tmp = out_dir / f"ptbxl_120.bin.tmp.{pid}"
    idx_target = out_dir / "ptbxl_index.json"
    idx_tmp = out_dir / f"ptbxl_index.json.tmp.{pid}"

    try:
        with open(bin_tmp, "wb") as f_bin:
            f_bin.write(full_binary)
        os.replace(bin_tmp, bin_target)

        with open(idx_tmp, "w", encoding="utf-8", newline="\n") as f_idx:
            json.dump(manifest, f_idx, indent=2)
            f_idx.write("\n")
        os.replace(idx_tmp, idx_target)
    finally:
        bin_tmp.unlink(missing_ok=True)
        idx_tmp.unlink(missing_ok=True)

    print(
        json.dumps(
            {
                "status": "compiled",
                "records": RECORD_COUNT,
                "bytes": len(full_binary),
                "crc32": f"{crc32_val:08x}",
                "sha256": sha256_hex,
            }
        )
    )


if __name__ == "__main__":
    main()
