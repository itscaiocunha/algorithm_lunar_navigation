"""Compara o ray-casting vetorizado com um loop pixel a pixel e com o ephemeris.py.

Uso:  python scripts/benchmark_iluminacao.py
"""

import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from lunar_navigator import ephemeris, illumination, terrain  # noqa: E402

UTC = "2026-11-14 12:00:00 UTC"
N_LOOP = 300  # pixels medidos no modo loop (o resto é extrapolado)


def main():
    ephemeris.load_kernels()
    et = ephemeris.utc_to_et(UTC)
    sun = illumination.sun_position_m(et)
    dem = terrain.load_dem()
    area = dem.crop(0.0, 0.0, 30_000.0)
    total = area.heights.size

    # 1. Consistência com o pipeline SPICE (ephemeris.py), mesmo ponto e raio
    row, col = area.shape[0] // 3, area.shape[1] // 3
    single = terrain.DEM(area.heights[row:row + 1, col:col + 1],
                         area.x0 + col * area.pixel, area.y0 - row * area.pixel, area.pixel, area.radius)
    lat, lon = (v.item() for v in single.lat_lon())
    res = illumination.compute_illumination(single, dem, sun)
    point_km = single.surface_points().reshape(3) / 1000
    vec, _ = ephemeris.sun_vector(et, point_km)
    elev_spice, _ = ephemeris.topocentric_angles(vec, point_km)
    print(f"Ponto lat {lat:.4f}°, lon {lon:.4f}°")
    print(f"  elevação do Sol  vetorizado: {res.elevation_deg.item():+.6f}°   ephemeris.py/SPICE: {elev_spice:+.6f}°")

    # 2. Velocidade: vetorizado vs. um pixel por vez
    t0 = time.perf_counter()
    full = illumination.compute_illumination(area, dem, sun)
    t_vec = time.perf_counter() - t0

    points = area.surface_points().reshape(-1, 3)
    pick = np.random.default_rng(0).choice(total, N_LOOP, replace=False)
    t0 = time.perf_counter()
    loop_fraction = [illumination._march(points[i:i + 1], sun, dem, dem.pixel, 0.01, np.inf)[0][0] for i in pick]
    t_loop = (time.perf_counter() - t0) / N_LOOP * total

    assert np.array_equal(loop_fraction, full.fraction.reshape(-1)[pick]), "resultados divergentes"
    print(f"\n{total:,} pixels")
    print(f"  vetorizado:        {t_vec:8.1f} s")
    print(f"  loop por pixel:    {t_loop:8.1f} s  (extrapolado de {N_LOOP} pixels)")
    print(f"  ganho:             {t_loop / t_vec:8.0f}x  — resultados idênticos")


if __name__ == "__main__":
    main()
