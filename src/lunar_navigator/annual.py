"""Estatísticas de iluminação de longo prazo a partir de um mapa de horizontes.

Para cada instante (ex.: a cada 12 h em 2027) calcula a fração do disco
solar visível em todos os pixels e acumula:

- illumination_pct: média da fração visível (% do tempo com Sol, ponderado
  pelo disco — proporcional à energia que um painel vertical receberia);
- any_sun_pct: % dos instantes com qualquer parte do Sol visível;
- longest_night_h: maior sequência contínua sem Sol (horas) — dimensiona baterias;
- psr: pixels que não viram o Sol em nenhum instante do período
  (candidatos a sombra permanente / armadilhas frias de gelo).

E identifica os "Picos da Luz Eterna": máximos locais de iluminação, com a
distância até a sombra permanente mais próxima.
"""

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import spiceypy as spice
from scipy import ndimage

from lunar_navigator import solar
from lunar_navigator.horizon import HorizonMap
from lunar_navigator.illumination import sun_position_m


@dataclass
class AnnualResult:
    illumination_pct: np.ndarray
    any_sun_pct: np.ndarray
    longest_night_h: np.ndarray
    psr: np.ndarray
    n_samples: int
    step_hours: float
    start_utc: str
    end_utc: str


def horizon_fraction(hmap: HorizonMap) -> Callable[[float], np.ndarray]:
    return lambda et: hmap.illumination(sun_position_m(et))


def time_grid(start_utc: str, end_utc: str, step_hours: float) -> np.ndarray:
    et0, et1 = solar.utc_to_et(start_utc), solar.utc_to_et(end_utc)
    return np.arange(et0, et1, step_hours * 3600.0)


def accumulate(fraction_at: Callable[[float], np.ndarray], shape: tuple[int, int], start_utc: str,
               end_utc: str, step_hours: float = 12.0, progress=None) -> AnnualResult:
    """`fraction_at(et)` devolve a fração do disco visível (rows, cols) no instante et.

    Use `horizon_fraction(hmap)` (rápido) ou o motor direto
    `lambda et: compute_illumination(area, dem, sun_position_m(et)).fraction`.
    """
    ets = time_grid(start_utc, end_utc, step_hours)
    total = np.zeros(shape)
    any_sun = np.zeros(shape, dtype=np.int32)
    night = np.zeros(shape, dtype=np.int32)
    longest = np.zeros(shape, dtype=np.int32)

    for i, et in enumerate(ets):
        fraction = fraction_at(et)
        total += fraction
        sun_up = fraction > 0
        any_sun += sun_up
        night = np.where(sun_up, 0, night + 1)
        np.maximum(longest, night, out=longest)
        if progress:
            progress(i + 1, len(ets))

    n = len(ets)
    return AnnualResult(
        illumination_pct=100.0 * total / n,
        any_sun_pct=100.0 * any_sun / n,
        longest_night_h=longest * step_hours,
        psr=any_sun == 0,
        n_samples=n,
        step_hours=step_hours,
        start_utc=spice.et2utc(ets[0], "ISOC", 0),
        end_utc=spice.et2utc(ets[-1], "ISOC", 0),
    )


def eternal_light_peaks(result: AnnualResult, area, n_peaks: int = 10, min_separation_m: float = 1500.0,
                        min_psr_area_km2: float = 0.1) -> list[dict]:
    """Pixels mais iluminados (máximos locais separados) + distância à sombra permanente."""
    pix_km2 = (area.pixel / 1000) ** 2
    labels, n = ndimage.label(result.psr)
    sizes = ndimage.sum(np.ones_like(labels), labels, index=np.arange(1, n + 1)) * pix_km2
    big_psr = np.isin(labels, np.flatnonzero(sizes >= min_psr_area_km2) + 1)
    if big_psr.any():
        dist_m = ndimage.distance_transform_edt(~big_psr) * area.pixel
    else:
        dist_m = np.full(area.shape, np.inf)

    lat, lon = area.lat_lon()
    xs, ys = area.pixel_centers()
    order = np.argsort(result.illumination_pct, axis=None)[::-1]
    sep_px = min_separation_m / area.pixel
    chosen: list[tuple[int, int]] = []
    peaks = []
    for flat in order:
        r, c = divmod(int(flat), area.shape[1])
        if any((r - rr) ** 2 + (c - cc) ** 2 < sep_px**2 for rr, cc in chosen):
            continue
        chosen.append((r, c))
        peaks.append({
            "rank": len(peaks) + 1,
            "lat": round(float(lat[r, c]), 4),
            "lon": round(float(lon[r, c]), 4),
            "x_m": float(xs[r, c]),
            "y_m": float(ys[r, c]),
            "height_m": round(float(area.heights[r, c]), 1),
            "illumination_pct": round(float(result.illumination_pct[r, c]), 1),
            "any_sun_pct": round(float(result.any_sun_pct[r, c]), 1),
            "longest_night_h": float(result.longest_night_h[r, c]),
            "distance_to_psr_km": round(float(dist_m[r, c]) / 1000, 2),
        })
        if len(peaks) == n_peaks:
            break
    return peaks
