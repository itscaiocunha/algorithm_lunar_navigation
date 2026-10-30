"""Mede a "escada" de otimizações do cálculo de oclusão (Sol, ±30 km, 562 500 px) num mesmo instante.

Uso:  python scripts/benchmark_escada.py            # ~3–5 min; grava output/benchmark_escada.json

Degraus (todos com o mesmo instante, os mesmos pixels e o mesmo resultado físico):
  1. o mesmo código NumPy aplicado a um pixel por vez (300 pixels medidos, extrapolado);
  2. vetorizado sobre a malha inteira de uma vez;
  3. vetorizado em blocos de 65 536 pixels (cache da CPU);
  4. vetorizado em blocos, mas com passo FIXO de 80 m (mede o ganho do passo crescente);
  5. mapa de horizontes: avaliação por instante (o pré-cálculo é lido do log da geração do cache).
"""

import json
import re
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from lunar_navigator import config, ephemeris, horizon, illumination, terrain  # noqa: E402

UTC = "2026-11-14 12:00:00 UTC"
N_LOOP = 300


def timed(fn, repeat=1):
    best = np.inf
    for _ in range(repeat):
        t0 = time.perf_counter()
        out = fn()
        best = min(best, time.perf_counter() - t0)
    return out, best


def main():
    ephemeris.load_kernels()
    sun = illumination.sun_position_m(ephemeris.utc_to_et(UTC))
    dem = terrain.load_dem(config.DEM_PATH)
    area = dem.crop(0.0, 0.0, config.HALF_SIZE_M)
    total = area.heights.size
    out: dict = {"utc": UTC, "pixels": total}

    chunked, t = timed(lambda: illumination.compute_illumination(area, dem, sun))
    out["vetorizado_blocos_s"] = round(t, 2)
    out["passos_raio"] = int(chunked.steps)
    print(f"vetorizado, blocos de 65 536:   {t:8.2f} s   ({chunked.steps} passos no raio mais longo)")

    whole, t = timed(lambda: illumination.compute_illumination(area, dem, sun, chunk_size=total))
    out["vetorizado_inteiro_s"] = round(t, 2)
    print(f"vetorizado, malha inteira:      {t:8.2f} s")
    assert np.array_equal(whole.fraction, chunked.fraction)

    fixed, t = timed(lambda: illumination.compute_illumination(area, dem, sun, growth=0.0))
    out["passo_fixo_s"] = round(t, 2)
    out["passos_raio_passo_fixo"] = int(fixed.steps)
    same = float(np.mean((fixed.fraction > 0) == (chunked.fraction > 0)))
    out["passo_fixo_concordancia_luz_sombra"] = round(same, 5)
    print(f"vetorizado, passo fixo de 80 m: {t:8.2f} s   ({fixed.steps} passos; luz/sombra iguais em {same:.2%})")

    points = area.surface_points().reshape(-1, 3)
    pick = np.random.default_rng(0).choice(total, N_LOOP, replace=False)
    t0 = time.perf_counter()
    loop = [illumination._march(points[i:i + 1], sun, illumination.SUN_RADIUS_M, dem, dem.pixel, 0.01, np.inf)[0][0]
            for i in pick]
    t = (time.perf_counter() - t0) / N_LOOP * total
    assert np.allclose(loop, chunked.fraction.reshape(-1)[pick]), "resultados divergentes"
    out["pixel_a_pixel_s"] = round(t, 0)
    print(f"um pixel por vez (extrapolado): {t:8.0f} s  = {t / 3600:.1f} h")

    hpath = horizon.cache_path(area, config.DEM_PATH, config.N_AZIMUTHS, config.GROWTH)
    if hpath.exists():
        hmap = horizon.HorizonMap(area, np.load(hpath)["horizon_deg"])
        hmap.geometry()  # pré-aquecido na API também
        frac, t = timed(lambda: hmap.illumination(sun), repeat=5)
        out["horizontes_por_instante_s"] = round(t, 3)
        same = float(np.mean((frac > 0) == (chunked.fraction > 0)))
        out["horizontes_concordancia_luz_sombra"] = round(same, 5)
        out["horizontes_delta_fracao_medio"] = round(float(np.mean(np.abs(frac - chunked.fraction))), 5)
        print(f"mapa de horizontes, por instante: {t * 1000:6.0f} ms   (luz/sombra iguais ao direto em {same:.2%})")
        log = ROOT / "output" / "horizons_log.txt"
        if log.exists() and (m := re.search(r"pronto\s+([\d.]+)", log.read_text())):
            out["horizontes_precalculo_s"] = round(float(m.group(1)), 0)
            print(f"   pré-cálculo (uma vez, do log):   {float(m.group(1)):.0f} s")
    dest = ROOT / "output" / "benchmark_escada.json"
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n-> {dest.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
