"""Mapa anual do polo sul: Sol (energia), Terra (comunicação DTE) e Zona de Ouro.

Uso:
    python scripts/mapa_anual.py                      # 2027, a cada 12 h (método de horizontes)
    python scripts/mapa_anual.py --passo-horas 1      # resolução horária (segundos a mais)
    python scripts/mapa_anual.py --validar 5          # compara com o motor direto em 5 instantes
    python scripts/mapa_anual.py --direto --passo-horas 24   # itera o motor direto (lento, ~1,5 h)

1ª execução: pré-calcula os horizontes (~10 min, paralelo) e guarda em data/cache/.
Saídas em output/: anual_<ano>.npz (usado pela API), .tif (4 bandas), .png e _picos.json.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
import spiceypy as spice
from rasterio.transform import from_origin

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from lunar_navigator import annual, config, ephemeris, horizon, illumination, link, render, terrain  # noqa: E402


def progress_bar(label):
    t0 = time.perf_counter()

    def update(done, total):
        el = time.perf_counter() - t0
        eta = el / done * (total - done)
        bar = "#" * int(30 * done / total)
        print(f"\r  {label} [{bar:<30}] {done}/{total}  {el:6.0f}s  (faltam ~{eta:.0f}s)  ", end="", flush=True)
        if done == total:
            print()

    return update


def parse_args():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--ano", type=int, default=2027)
    p.add_argument("--passo-horas", type=float, default=12.0)
    p.add_argument("--half-size-km", type=float, default=config.HALF_SIZE_M / 1000)
    p.add_argument("--azimutes", type=int, default=config.N_AZIMUTHS)
    p.add_argument("--workers", type=int, default=None)
    p.add_argument("--validar", type=int, default=0, help="nº de instantes para comparar com o motor direto")
    p.add_argument("--direto", action="store_true", help="itera o motor direto (sem horizontes)")
    return p.parse_args()


def main():
    args = parse_args()
    ephemeris.load_kernels()
    dem = terrain.load_dem(config.DEM_PATH)
    area = dem.crop(0.0, 0.0, args.half_size_km * 1000)
    start, end = f"{args.ano}-01-01T00:00:00", f"{args.ano + 1}-01-01T00:00:00"
    print(f"Área: {area.shape[0]}x{area.shape[1]} px de {area.pixel:.0f} m  (±{args.half_size_km:g} km do polo)")

    t0 = time.perf_counter()
    if args.direto:
        def fractions_at(et):
            sun = illumination.compute_illumination(area, dem, illumination.sun_position_m(et)).fraction
            earth = illumination.compute_illumination(area, dem, illumination.earth_position_m(et),
                                                      ephemeris.EARTH_RADIUS_M).fraction
            return sun, earth
    else:
        cached = horizon.cache_path(area, config.DEM_PATH, args.azimutes, config.GROWTH).exists()
        print("1. Horizontes:", "lidos do cache" if cached else f"calculando {args.azimutes} azimutes em paralelo")
        hmap = horizon.compute_horizons(area, config.DEM_PATH, n_azimuths=args.azimutes, growth=config.GROWTH,
                                        workers=args.workers, progress=progress_bar("azimutes"))
        print(f"   pronto em {time.perf_counter() - t0:.0f} s")
        fractions_at = annual.horizon_fractions(hmap)
        if args.validar:
            validate(hmap, area, dem, args.ano, args.validar)

    print(f"2. Sol e Terra de {start[:10]} a {end[:10]}, a cada {args.passo_horas:g} h")
    t1 = time.perf_counter()
    result = annual.accumulate(fractions_at, area.shape, start, end, args.passo_horas, progress_bar("instantes"))
    print(f"   {result.n_samples} instantes em {time.perf_counter() - t1:.1f} s")

    peaks = annual.landing_candidates(result, area)
    report(result, area, peaks)
    save(result, area, peaks, args.ano)


def validate(hmap, area, dem, year, n):
    print(f"   Validação contra o motor direto em {n} instantes aleatórios de {year}:")
    rng = np.random.default_rng(42)
    ets = annual.time_grid(f"{year}-01-01T00:00:00", f"{year + 1}-01-01T00:00:00", 1.0)
    for et in np.sort(rng.choice(ets, n, replace=False)):
        for name, pos, radius in (("Sol  ", illumination.sun_position_m(et), ephemeris.SUN_RADIUS_M),
                                  ("Terra", illumination.earth_position_m(et), ephemeris.EARTH_RADIUS_M)):
            direct = illumination.compute_illumination(area, dem, pos, radius).fraction
            fast = hmap.disk_fraction(pos, radius)
            agree = np.mean((direct > 0) == (fast > 0))
            print(f"     {spice.et2utc(et, 'ISOC', 0)} {name}  visível/oculto iguais em {agree:.2%}  "
                  f"|Δfração| médio {np.abs(direct - fast).mean():.4f}")


def report(result, area, peaks):
    pix_km2 = (area.pixel / 1000) ** 2
    print()
    print("=== Resultado ===")
    print(f"Sem Sol em todo o período (PSR):   {result.psr.sum() * pix_km2:,.1f} km²  ({result.psr.mean():.1%} da área)")
    print(f"Terra nunca visível:               {(result.any_earth_pct == 0).sum() * pix_km2:,.1f} km²")
    print(f"Alguma Zona de Ouro no ano:        {(result.golden_pct > 0).sum() * pix_km2:,.1f} km²")
    print(f"Janela de ouro contínua ≥ 7 dias:  {(result.longest_golden_h >= 168).sum() * pix_km2:,.2f} km²")
    print()
    a, b, c = link.DEFAULT_WEIGHTS
    print(f"Candidatos a pouso — Score = {a:g}·janela/T + {b:g}·fração de ouro − {c:g}·pior apagão/T  "
          f"(T = {link.SYNODIC_MONTH_D} d)")
    print(f"{'#':>2} {'score':>7} {'lat':>9} {'lon':>8} {'alt':>6} {'janela':>8} {'ouro %':>7} {'Sol %':>6} "
          f"{'noite':>7} {'LOS':>7} {'PSR':>8}")
    for p in peaks:
        print(f"{p['rank']:>2} {p['score']:>+7.3f} {p['lat']:>9.4f} {p['lon']:>8.2f} {p['height_m']:>6.0f} "
              f"{p['longest_golden_h'] / 24:>6.1f} d {p['golden_pct']:>7.1f} {p['illumination_pct']:>6.1f} "
              f"{p['longest_night_h'] / 24:>5.1f} d {p['longest_los_h'] / 24:>5.1f} d {p['distance_to_psr_km']:>5.2f} km")


def save(result, area, peaks, year):
    out = config.OUTPUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    meta = dict(x0=area.x0, y0=area.y0, pixel=area.pixel, n_samples=result.n_samples,
                step_hours=result.step_hours, start_utc=result.start_utc, end_utc=result.end_utc)
    arrays = {name: getattr(result, name) for name in annual.AnnualResult.ARRAYS}
    np.savez_compressed(config.annual_path(year), meta=json.dumps(meta), peaks=json.dumps(peaks),
                        **{k: (v if v.dtype == bool else v.astype(np.float32)) for k, v in arrays.items()})

    with rasterio.open(config.DEM_PATH) as src:
        crs = src.crs
    profile = dict(driver="GTiff", height=area.shape[0], width=area.shape[1], count=len(arrays), dtype="float32",
                   crs=crs, compress="deflate", transform=from_origin(area.x0, area.y0, area.pixel, area.pixel))
    with rasterio.open(out / f"anual_{year}.tif", "w", **profile) as dst:
        for i, (name, band) in enumerate(arrays.items(), start=1):
            dst.write(band.astype(np.float32), i)
            dst.set_band_description(i, name)

    (out / f"anual_{year}_picos.json").write_text(json.dumps(peaks, indent=2, ensure_ascii=False), encoding="utf-8")
    save_png(out / f"anual_{year}.png", result, area, peaks, year)
    print()
    print(f"Salvo em {out}: anual_{year}.npz / .tif ({len(arrays)} bandas) / .png / _picos.json")


def save_png(path, result, area, peaks, year):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    extent = np.array([area.x0, area.x0 + area.shape[1] * area.pixel,
                       area.y0 - area.shape[0] * area.pixel, area.y0]) / 1000
    fig, ax = plt.subplots(figsize=(9, 8), constrained_layout=True)
    ax.imshow(render.hillshade(area.heights, area.pixel), cmap="gray", extent=extent)
    heat = np.ma.masked_where(result.psr, np.clip(annual.scores(result)[0], 0, None))
    im = ax.imshow(heat, cmap="viridis", vmin=0, alpha=0.85, extent=extent)
    psr = np.ma.masked_where(~result.psr, np.ones_like(result.illumination_pct))
    ax.imshow(psr, cmap=matplotlib.colors.ListedColormap([np.array(render.PSR_COLOR) / 255]), extent=extent, alpha=0.9)
    fig.colorbar(im, ax=ax, label="Pontuação composta do local (pesos 1, 1, 1)", shrink=0.8)
    for p in peaks:
        ax.plot(p["x_m"] / 1000, p["y_m"] / 1000, "o", mfc="none", mec="lime", ms=10, mew=1.5)
        ax.annotate(str(p["rank"]), (p["x_m"] / 1000, p["y_m"] / 1000), color="lime", fontsize=9,
                    xytext=(6, 6), textcoords="offset points")
    ax.plot(0, 0, "w+", ms=12, mew=2)
    ax.set_title(f"Iluminação solar {year} — polo sul lunar\n"
                 f"ciano = sem Sol o ano todo (sombra permanente)  ·  verde = Picos da Luz Eterna")
    ax.set_xlabel("X (km)")
    ax.set_ylabel("Y (km)")
    fig.savefig(path, dpi=130)
    plt.close(fig)


if __name__ == "__main__":
    main()
