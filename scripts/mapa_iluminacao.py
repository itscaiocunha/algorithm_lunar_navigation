"""Gera um frame de iluminação solar do polo sul lunar (DEM LOLA + SPICE).

Uso:
    python scripts/mapa_iluminacao.py
    python scripts/mapa_iluminacao.py --utc "2026-11-20 00:00 UTC" --half-size-km 50
    python scripts/mapa_iluminacao.py --center-lat -89.67 --center-lon 129.8 --half-size-km 20

Saídas em output/: PNG (visualização) e GeoTIFF (fração iluminada, abre em QGIS).
"""

import argparse
import re
import sys
import time
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import rasterio  # noqa: E402
import spiceypy as spice  # noqa: E402
from rasterio.transform import from_origin  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from lunar_navigator import illumination, solar, terrain  # noqa: E402


def parse_args():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--utc", default="2026-11-14 12:00:00 UTC")
    p.add_argument("--dem", type=Path, default=terrain.DEFAULT_DEM)
    p.add_argument("--center-lat", type=float, default=-90.0)
    p.add_argument("--center-lon", type=float, default=0.0)
    p.add_argument("--half-size-km", type=float, default=30.0, help="meia largura da área de saída")
    p.add_argument("--downsample", type=int, default=1, help="reduz a resolução do DEM (1 = 80 m)")
    p.add_argument("--growth", type=float, default=0.01, help="crescimento do passo do raio")
    p.add_argument("--out", type=Path, default=ROOT / "output")
    return p.parse_args()


def main():
    args = parse_args()
    solar.load_kernels()
    et = solar.utc_to_et(args.utc)
    sun = illumination.sun_position_m(et)

    t0 = time.perf_counter()
    dem = terrain.load_dem(args.dem, downsample=args.downsample)
    lat, lon = np.radians(args.center_lat), np.radians(args.center_lon)
    center = np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])
    cx, cy = dem.to_map(center)
    area = dem.crop(float(cx), float(cy), args.half_size_km * 1000)
    t1 = time.perf_counter()
    print(f"DEM {dem.shape[0]}x{dem.shape[1]} px @ {dem.pixel:.0f} m  (carregado em {t1 - t0:.1f} s)")
    print(f"Área de saída {area.shape[0]}x{area.shape[1]} = {area.heights.size:,} px")

    res = illumination.compute_illumination(area, dem, sun, growth=args.growth)
    t2 = time.perf_counter()
    lit = res.fraction > 0
    print(f"Ray-casting: {t2 - t1:.1f} s, {res.steps} passos, {area.heights.size / (t2 - t1):,.0f} px/s")
    print(f"Elevação do Sol na área: {res.sun_elevation_deg.min():+.2f}° a {res.sun_elevation_deg.max():+.2f}°")
    print(f"Pixels com Sol visível: {lit.mean():.1%}  (disco inteiro: {(res.fraction == 1).mean():.1%})")

    args.out.mkdir(parents=True, exist_ok=True)
    stem = "iluminacao_" + re.sub(r"[^0-9]", "", spice.et2utc(et, "ISOC", 0))[:12]
    save_geotiff(args.out / f"{stem}.tif", area, res.fraction, args.dem)
    save_png(args.out / f"{stem}.png", area, res, args.utc)
    print(f"Salvo: {args.out / stem}.png / .tif")
    spice.kclear()


def save_geotiff(path, area, fraction, source):
    with rasterio.open(source) as src:
        crs = src.crs
    profile = dict(driver="GTiff", height=area.shape[0], width=area.shape[1], count=1,
                   dtype="float32", crs=crs, compress="deflate",
                   transform=from_origin(area.x0, area.y0, area.pixel, area.pixel))
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(fraction.astype(np.float32), 1)


def hillshade(h, pixel, azimuth_deg=315, altitude_deg=45):
    dy, dx = np.gradient(h, pixel)
    slope = np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(-dx, dy)
    az, alt = np.radians(azimuth_deg), np.radians(altitude_deg)
    return np.clip(np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1)


def save_png(path, area, res, utc):
    extent_km = np.array([area.x0, area.x0 + area.shape[1] * area.pixel,
                          area.y0 - area.shape[0] * area.pixel, area.y0]) / 1000
    fig, axes = plt.subplots(1, 2, figsize=(14, 6.5), constrained_layout=True)

    ax = axes[0]
    ax.imshow(hillshade(area.heights, area.pixel), cmap="gray", extent=extent_km)
    im = ax.imshow(area.heights / 1000, cmap="terrain", alpha=0.45, extent=extent_km)
    fig.colorbar(im, ax=ax, label="Altura (km, ref. 1737,4 km)", shrink=0.85)
    ax.set_title("Topografia LOLA")

    ax = axes[1]
    im = ax.imshow(res.fraction, cmap="inferno", vmin=0, vmax=1, extent=extent_km)
    fig.colorbar(im, ax=ax, label="Fração do disco solar visível", shrink=0.85)
    ax.set_title(f"Iluminação — {utc}")

    for ax in axes:
        ax.set_xlabel("X (km)")
        ax.set_ylabel("Y (km)")
        ax.plot(0, 0, "c+", ms=12, mew=2)  # polo sul
    fig.savefig(path, dpi=130)
    plt.close(fig)


if __name__ == "__main__":
    main()
