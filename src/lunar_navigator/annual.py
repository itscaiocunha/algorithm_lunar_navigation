"""Estatísticas de longo prazo: Sol (energia), Terra (comunicação DTE) e a intersecção.

Para cada instante (ex.: a cada 12 h em 2027) calcula, em todos os pixels, a
fração visível do disco solar e do disco terrestre, e acumula:

Energia (Sol)
- illumination_pct: média da fração visível (% do tempo com Sol, ponderado pelo disco);
- any_sun_pct: % dos instantes com qualquer parte do Sol visível;
- longest_night_h: maior sequência contínua sem Sol (horas) — dimensiona baterias;
- psr: nenhum Sol em todo o período (candidata a sombra permanente / gelo).

Comunicação direta com a Terra (DTE)
- earth_pct: média da fração visível do disco da Terra;
- any_earth_pct: % dos instantes com alguma parte da Terra visível (enlace possível);
- longest_los_h: maior sequência contínua sem Terra (Loss of Signal).

Zona de Ouro (Sol E Terra no mesmo instante)
- golden_pct: % dos instantes em que as duas condições valem juntas;
- longest_golden_h: maior janela contínua de Zona de Ouro.

Os candidatos a pouso são ordenados pela pontuação composta link.site_score,
que pondera janela de ouro, fração de ouro e o pior apagão contínuo (noite ou
LOS): sozinha, a janela de ouro satura em ~17 dias (teto da libração) e não
separa os candidatos.

A resolução das janelas é o passo de tempo (ex.: 12 h).
"""

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import spiceypy as spice
from scipy import ndimage

from lunar_navigator import ephemeris, link
from lunar_navigator.horizon import HorizonMap
from lunar_navigator.illumination import earth_position_m, sun_position_m

FractionsAt = Callable[[float], tuple[np.ndarray, np.ndarray]]  # et -> (fração do Sol, fração da Terra)


@dataclass
class AnnualResult:
    illumination_pct: np.ndarray
    any_sun_pct: np.ndarray
    longest_night_h: np.ndarray
    psr: np.ndarray
    earth_pct: np.ndarray
    any_earth_pct: np.ndarray
    longest_los_h: np.ndarray
    golden_pct: np.ndarray
    longest_golden_h: np.ndarray
    n_samples: int
    step_hours: float
    start_utc: str
    end_utc: str

    ARRAYS = ("illumination_pct", "any_sun_pct", "longest_night_h", "psr", "earth_pct", "any_earth_pct",
              "longest_los_h", "golden_pct", "longest_golden_h")


def horizon_fractions(hmap: HorizonMap) -> FractionsAt:
    """Frações do Sol e da Terra via mapa de horizontes (O(1) por pixel e instante)."""
    return lambda et: (hmap.illumination(sun_position_m(et)), hmap.earth_visibility(earth_position_m(et)))


def time_grid(start_utc: str, end_utc: str, step_hours: float) -> np.ndarray:
    et0, et1 = ephemeris.utc_to_et(start_utc), ephemeris.utc_to_et(end_utc)
    return np.arange(et0, et1, step_hours * 3600.0)


class _Runs:
    """Maior sequência contínua de instantes em que `mask` é verdadeira, por pixel."""

    def __init__(self, shape):
        self.current = np.zeros(shape, dtype=np.int32)
        self.longest = np.zeros(shape, dtype=np.int32)

    def update(self, mask: np.ndarray) -> None:
        self.current = np.where(mask, self.current + 1, 0)
        np.maximum(self.longest, self.current, out=self.longest)


def accumulate(fractions_at: FractionsAt, shape: tuple[int, int], start_utc: str, end_utc: str,
               step_hours: float = 12.0, progress=None) -> AnnualResult:
    """`fractions_at(et)` devolve (fração do Sol, fração da Terra), cada uma (rows, cols)."""
    ets = time_grid(start_utc, end_utc, step_hours)
    sun_total, earth_total = np.zeros(shape), np.zeros(shape)
    any_sun, any_earth, golden = (np.zeros(shape, dtype=np.int32) for _ in range(3))
    night, los, golden_runs = _Runs(shape), _Runs(shape), _Runs(shape)

    for i, et in enumerate(ets):
        sun, earth = fractions_at(et)
        sun_total += sun
        earth_total += earth
        power, comms = sun > 0, earth > 0
        any_sun += power
        any_earth += comms
        golden += power & comms
        night.update(~power)
        los.update(~comms)
        golden_runs.update(power & comms)
        if progress:
            progress(i + 1, len(ets))

    n = len(ets)
    return AnnualResult(
        illumination_pct=100.0 * sun_total / n,
        any_sun_pct=100.0 * any_sun / n,
        longest_night_h=night.longest * step_hours,
        psr=any_sun == 0,
        earth_pct=100.0 * earth_total / n,
        any_earth_pct=100.0 * any_earth / n,
        longest_los_h=los.longest * step_hours,
        golden_pct=100.0 * golden / n,
        longest_golden_h=golden_runs.longest * step_hours,
        n_samples=n,
        step_hours=step_hours,
        start_utc=spice.et2utc(ets[0], "ISOC", 0),
        end_utc=spice.et2utc(ets[-1], "ISOC", 0),
    )


def distance_to_psr_m(result: AnnualResult, area, min_psr_area_km2: float = 0.1) -> np.ndarray:
    """Distância (m) de cada pixel até a sombra permanente mais próxima com área ≥ min_psr_area_km2."""
    pix_km2 = (area.pixel / 1000) ** 2
    labels, n = ndimage.label(result.psr)
    sizes = ndimage.sum(np.ones_like(labels), labels, index=np.arange(1, n + 1)) * pix_km2
    big_psr = np.isin(labels, np.flatnonzero(sizes >= min_psr_area_km2) + 1)
    if not big_psr.any():
        return np.full(area.shape, np.inf)
    return ndimage.distance_transform_edt(~big_psr) * area.pixel


def scores(result: AnnualResult, weights=link.DEFAULT_WEIGHTS):
    """Pontuação composta de todos os pixels (ver link.site_score)."""
    return link.site_score(result.longest_golden_h, result.golden_pct, result.longest_night_h,
                           result.longest_los_h, weights)


def landing_candidates(result: AnnualResult, area, n_peaks: int = 10, min_separation_m: float = 1500.0,
                       weights=link.DEFAULT_WEIGHTS, dist_m: np.ndarray | None = None) -> list[dict]:
    """Melhores locais (máximos separados ≥ min_separation_m), ordenados pela pontuação composta.

    Desempate (raro com a pontuação contínua): % de iluminação. `dist_m` pode vir de um cache.
    """
    dist_m = distance_to_psr_m(result, area) if dist_m is None else dist_m
    score, terms = scores(result, weights)
    lat, lon = area.lat_lon()
    xs, ys = area.pixel_centers()
    order = np.lexsort((result.illumination_pct.ravel(), score.ravel()))[::-1]  # última chave é a primária
    sep2 = (min_separation_m / area.pixel) ** 2
    chosen: list[tuple[int, int]] = []
    peaks = []
    for flat in order:
        r, c = divmod(int(flat), area.shape[1])
        if any((r - rr) ** 2 + (c - cc) ** 2 < sep2 for rr, cc in chosen):
            continue
        chosen.append((r, c))
        peaks.append({
            "rank": len(peaks) + 1,
            "score": round(float(score[r, c]), 4),
            "score_terms": {k: round(float(v[r, c]), 4) for k, v in terms.items()},
            "lat": round(float(lat[r, c]), 4),
            "lon": round(float(lon[r, c]), 4),
            "x_m": float(xs[r, c]),
            "y_m": float(ys[r, c]),
            "height_m": round(float(area.heights[r, c]), 1),
            "longest_golden_h": float(result.longest_golden_h[r, c]),
            "golden_pct": round(float(result.golden_pct[r, c]), 1),
            "illumination_pct": round(float(result.illumination_pct[r, c]), 1),
            "any_sun_pct": round(float(result.any_sun_pct[r, c]), 1),
            "earth_pct": round(float(result.earth_pct[r, c]), 1),
            "any_earth_pct": round(float(result.any_earth_pct[r, c]), 1),
            "longest_night_h": float(result.longest_night_h[r, c]),
            "longest_los_h": float(result.longest_los_h[r, c]),
            "worst_outage_h": float(max(result.longest_night_h[r, c], result.longest_los_h[r, c])),
            "distance_to_psr_km": round(float(dist_m[r, c]) / 1000, 2),
        })
        if len(peaks) == n_peaks:
            break
    return peaks


def result_from_arrays(data: dict, meta: dict) -> AnnualResult:
    """Reconstrói um AnnualResult a partir do .npz salvo (para re-ranquear sem recalcular)."""
    return AnnualResult(**{k: data[k] for k in AnnualResult.ARRAYS}, n_samples=meta["n_samples"],
                        step_hours=meta["step_hours"], start_utc=meta["start_utc"], end_utc=meta["end_utc"])
