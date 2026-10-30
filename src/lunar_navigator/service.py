"""Camada de serviço da API: mantém kernels, DEM e caches em memória.

Thread-safety: o CSPICE NÃO é thread-safe e o FastAPI executa endpoints
síncronos em um pool de threads. Toda chamada SPICE passa por `_spice_lock`;
os cálculos pesados de malha passam por `_compute_lock` (um por vez).
"""

import base64
import json
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

import numpy as np
import rasterio
import spiceypy as spice
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from spiceypy.utils.exceptions import SpiceyError

from lunar_navigator import annual as annual_mod
from lunar_navigator import config, countdown, ephemeris, horizon, illumination, link, render, terrain, tiles
from lunar_navigator.ephemeris import EARTH, EARTH_RADIUS_M, SUN, SUN_RADIUS_M

_spice_lock = threading.Lock()
_compute_lock = threading.Lock()

ANNUAL_METRICS = {
    # métrica: (rótulo, colormap, unidade, transformação, vmax fixo ou None)
    "score": ("Pontuação composta do local", "viridis", "", lambda a: a["_score"], None),
    "golden_window": ("Maior janela contínua Sol + Terra", "viridis", "dias", lambda a: a["longest_golden_h"] / 24, None),
    "golden_pct": ("Tempo em Zona de Ouro", "viridis", "%", lambda a: a["golden_pct"], 100.0),
    "illumination_pct": ("Tempo com Sol", "inferno", "%", lambda a: a["illumination_pct"], 100.0),
    "earth_pct": ("Tempo com visada para a Terra", "cividis", "%", lambda a: a["any_earth_pct"], 100.0),
}


class InputError(ValueError):
    """Entrada inválida do usuário (vira HTTP 422)."""


@dataclass
class MapResult:
    sun: np.ndarray  # fração do disco solar visível
    earth: np.ndarray  # fração do disco terrestre visível
    area: terrain.DEM
    mode: str
    elapsed_s: float
    steps: int | None
    sun_elevation_deg: tuple[float, float]
    earth_elevation_deg: tuple[float, float]


def _uint8_b64(fraction: np.ndarray) -> str:
    return base64.b64encode(np.round(np.clip(fraction, 0, 1) * 255).astype(np.uint8).tobytes()).decode("ascii")


def _range_deg(elev_rad: np.ndarray) -> tuple[float, float]:
    return float(np.degrees(elev_rad.min())), float(np.degrees(elev_rad.max()))


class LunarService:
    def __init__(self):
        with _spice_lock:
            spice.kclear()
            ephemeris.load_kernels()
            self.n_kernels = spice.ktotal("ALL")
        with rasterio.open(config.DEM_PATH) as src:
            self.crs = src.crs
        self.dem = terrain.load_dem(config.DEM_PATH)
        self.area = self.dem.crop(0.0, 0.0, config.HALF_SIZE_M)
        hpath = horizon.cache_path(self.area, config.DEM_PATH, config.N_AZIMUTHS, config.GROWTH)
        self.hmap = horizon.HorizonMap(self.area, np.load(hpath)["horizon_deg"]) if hpath.exists() else None
        if self.hmap is not None:
            self.hmap.geometry()  # pré-aquece (pontos 3D e base local)
        self.basemap_rgb = render.basemap_rgb(self.area.heights, self.area.pixel)
        self._map_cache: OrderedDict = OrderedDict()
        self._profile_cache: OrderedDict = OrderedDict()  # perfis de horizonte por pixel (countdown)
        self.tiles = tiles.TileGrid(config.DEM_PATH, self.dem.radius)  # quadtree LOD da vista 3D

    # --- Tempo e efemérides ------------------------------------------------
    @staticmethod
    def parse_utc(utc: str) -> tuple[float, str]:
        text = utc.strip().rstrip("Zz").replace(" UTC", "")
        try:
            with _spice_lock:
                et = spice.str2et(text)
                return et, spice.et2utc(et, "ISOC", 0) + "Z"
        except SpiceyError as exc:
            raise InputError(f"Data inválida: {utc!r}") from exc

    @staticmethod
    def body_m(et: float, target: str) -> np.ndarray:
        with _spice_lock:
            return ephemeris.body_position_m(et, target)

    @staticmethod
    def light_time_s(et: float, observer_km: np.ndarray, target: str) -> float:
        with _spice_lock:
            return float(ephemeris.target_vector(et, observer_km, target)[1])

    # --- Geometria ----------------------------------------------------------
    def bounds(self, area: terrain.DEM) -> dict:
        return {"x_min": area.x0, "x_max": area.x0 + area.shape[1] * area.pixel,
                "y_min": area.y0 - area.shape[0] * area.pixel, "y_max": area.y0}

    def latlon_to_pixel(self, lat: float, lon: float) -> terrain.DEM:
        if not -90 <= lat <= -80.5:
            raise InputError("Latitude fora do DEM: use entre -90 e -80.5 (polo sul)")
        la, lo = np.radians(lat), np.radians(lon)
        x, y = self.dem.to_map(np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)]))
        col = int(np.floor((float(x) - self.dem.x0) / self.dem.pixel))
        row = int(np.floor((self.dem.y0 - float(y)) / self.dem.pixel))
        h = self.dem.heights[row:row + 1, col:col + 1]
        if h.size == 0 or h[0, 0] <= terrain.NODATA_HEIGHT:
            raise InputError("Ponto sem dados de altitude no DEM")
        return terrain.DEM(h, self.dem.x0 + col * self.dem.pixel, self.dem.y0 - row * self.dem.pixel,
                           self.dem.pixel, self.dem.radius)

    def body_in_map(self, target_m: np.ndarray) -> dict:
        """Direção do alvo vista do centro da área, no plano do mapa (x, y) + elevação.

        Perto do polo, o eixo X do mapa é +Y do MOON_ME e o eixo Y é +X do MOON_ME.
        """
        center = self.area.to_unit_vectors(np.array(0.0), np.array(0.0)) * self.area.radius
        s = target_m - center
        s /= np.linalg.norm(s)
        up = center / np.linalg.norm(center)
        horiz = s - (s @ up) * up
        dx, dy = float(horiz[1]), float(horiz[0])
        norm = np.hypot(dx, dy)
        return {"map_dir": [dx / norm, dy / norm], "elevation_deg": round(float(np.degrees(np.arcsin(s @ up))), 3)}

    # --- Ponto ----------------------------------------------------------------
    def _point_body(self, pixel: terrain.DEM, target_m: np.ndarray, radius_m: float) -> dict:
        res = illumination.compute_illumination(pixel, self.dem, target_m, radius_m)
        p = pixel.surface_points().reshape(1, 3)
        _, north, east = horizon.local_basis(p)
        s = target_m - p[0]
        az = np.degrees(np.arctan2(s @ east[0], s @ north[0])) % 360
        return {"fraction": round(float(res.fraction.item()), 4),
                "elevation_deg": round(float(res.elevation_deg.item()), 4),
                "azimuth_deg": round(float(az), 2),
                "horizon_deg": round(float(res.horizon_deg.item()), 4),
                "angular_radius_deg": round(float(np.degrees(np.arcsin(radius_m / np.linalg.norm(s)))), 4)}

    def point(self, utc: str, lat: float, lon: float, annual: dict | None = None) -> dict:
        """Telemetria de engenharia de um pixel: Sol (energia) e Terra (enlace DTE), por ray-casting exato."""
        t0 = time.perf_counter()
        et, iso = self.parse_utc(utc)
        pixel = self.latlon_to_pixel(lat, lon)
        sun = self._point_body(pixel, self.body_m(et, SUN), SUN_RADIUS_M)
        earth = self._point_body(pixel, self.body_m(et, EARTH), EARTH_RADIUS_M)
        sun["level"], sun["label"] = link.power_level(sun["fraction"])
        earth["level"], earth["label"] = link.rf_level(earth["fraction"])
        earth["light_time_s"] = round(self.light_time_s(et, pixel.surface_points().reshape(3) / 1000, EARTH), 4)
        out = {
            "utc": iso, "lat": lat, "lon": lon,
            "x_m": pixel.x0 + pixel.pixel / 2, "y_m": pixel.y0 - pixel.pixel / 2,
            "height_m": round(float(pixel.heights.item()), 1),
            "sun": sun, "earth": earth,
            "golden": sun["fraction"] > 0 and earth["fraction"] > 0,
            "status": link.status_text(sun["fraction"], earth["fraction"]),
            "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
        }
        if annual:
            out["annual"] = self.annual_at(annual, out["x_m"], out["y_m"])
        return out

    # --- Tiles (quadtree LOD) ----------------------------------------------------
    def _tile_call(self, fn, *args):
        try:
            return fn(*args)
        except ValueError as exc:
            raise InputError(str(exc)) from exc

    def tiles_meta(self) -> dict:
        """Metadados da quadtree + região onde a camada analítica é O(1) (área com cache de horizontes)."""
        return {**self.tiles.meta(), "fast_bounds": self.bounds(self.area) if self.hmap is not None else None}

    def tile_heights(self, z: int, x: int, y: int) -> bytes:
        return self._tile_call(self.tiles.heights, z, x, y).astype("<f4").tobytes()

    def tile_relief(self, z: int, x: int, y: int) -> bytes:
        return self._tile_call(self.tiles.relief_png, z, x, y)

    def _area_fractions(self, et: float, iso: str) -> tuple[np.ndarray, np.ndarray] | None:
        """Frações do Sol e da Terra na área inteira pelo mapa de horizontes (~0,4 s, cache por instante)."""
        if self.hmap is None:
            return None
        cache = self.__dict__.setdefault("_area_fraction_cache", OrderedDict())
        if iso not in cache:
            sun_m, earth_m = self.body_m(et, SUN), self.body_m(et, EARTH)
            cache[iso] = (self.hmap.illumination(sun_m), self.hmap.earth_visibility(earth_m))
            while len(cache) > 8:
                cache.popitem(last=False)
        return cache[iso]

    def tile_analytic(self, z: int, x: int, y: int, utc: str, layers: tuple[bool, bool, bool]) -> bytes:
        """Sol + Terra + Zona de Ouro do tile no instante, com cache.

        Híbrido por célula: dentro da área com cache de horizontes, amostra o mapa de horizontes
        (O(1), o mesmo método do mapa 2D); só as células de fora pagam o ray-casting direto.
        """
        et, iso = self.parse_utc(utc)
        sun_m, earth_m = self.body_m(et, SUN), self.body_m(et, EARTH)
        a = self.bounds(self.area)

        def fractions(cells: terrain.DEM):
            xs, ys = cells.pixel_centers()
            inside = (xs >= a["x_min"]) & (xs < a["x_max"]) & (ys > a["y_min"]) & (ys <= a["y_max"])
            area_fr = self._area_fractions(et, iso) if inside.any() else None
            if area_fr is None:
                inside[:] = False
            sun, earth = np.zeros(cells.shape), np.zeros(cells.shape)
            if inside.any():
                col = ((xs[inside] - self.area.x0) // self.area.pixel).astype(int).clip(0, self.area.shape[1] - 1)
                row = ((self.area.y0 - ys[inside]) // self.area.pixel).astype(int).clip(0, self.area.shape[0] - 1)
                sun[inside], earth[inside] = area_fr[0][row, col], area_fr[1][row, col]
            out = ~inside
            if out.any():
                pts = cells.surface_points()[out]
                sun[out] = illumination.march_points(pts, self.dem, sun_m, SUN_RADIUS_M)[0]
                earth[out] = illumination.march_points(pts, self.dem, earth_m, EARTH_RADIUS_M)[0]
            return sun, earth

        return self._tile_call(self.tiles.analytic_png, z, x, y, iso, fractions, layers)

    # --- Contagem regressiva --------------------------------------------------
    def countdown(self, utc: str, lat: float, lon: float) -> dict:
        """Tempo até o próximo pôr/nascer do Sol e LOS/AOS da Terra no pixel (varredura 1 h + bisseção)."""
        t0 = time.perf_counter()
        et, iso = self.parse_utc(utc)
        pixel = self.latlon_to_pixel(lat, lon)
        key = (pixel.x0, pixel.y0)
        profile = self._profile_cache.get(key)
        if profile is None:
            profile = countdown.PixelHorizon.compute(self.dem, pixel.surface_points().reshape(3))
            self._profile_cache[key] = profile
            while len(self._profile_cache) > 256:
                self._profile_cache.popitem(last=False)
        radii = {SUN: SUN_RADIUS_M, EARTH: EARTH_RADIUS_M}

        def exact(et_k: float, target: str) -> tuple[float, float]:
            """Margens pelo ray-casting exato do pixel (sinal confiável; usado só no refinamento)."""
            res = illumination.compute_illumination(pixel, self.dem, ephemeris.body_position_m(et_k, target), radii[target])
            elev, hor = float(res.elevation_deg.item()), float(res.horizon_deg.item())
            dist = np.linalg.norm(ephemeris.body_position_m(et_k, target) - pixel.surface_points().reshape(3))
            r = float(np.degrees(np.arcsin(radii[target] / dist)))
            return elev - hor + r, elev - hor - r

        with _spice_lock:
            result = countdown.countdown(et, profile, exact)
        return {"utc": iso, "lat": lat, "lon": lon, "x_m": pixel.x0 + pixel.pixel / 2, "y_m": pixel.y0 - pixel.pixel / 2,
                **result, "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1)}

    # --- Malha ----------------------------------------------------------------
    def compute_map(self, utc: str, mode: str = "completo", half_size_m: float = config.HALF_SIZE_M) -> MapResult:
        et, iso = self.parse_utc(utc)
        if mode not in ("completo", "rapido"):
            raise InputError("modo deve ser 'completo' ou 'rapido'")
        if mode == "rapido" and (self.hmap is None or half_size_m != config.HALF_SIZE_M):
            raise InputError("modo 'rapido' exige o cache de horizontes da área padrão (rode scripts/mapa_anual.py)")
        if not 1_000 <= half_size_m <= 60_000:
            raise InputError("half_size_km deve estar entre 1 e 60")

        key = (iso, mode, half_size_m)
        if key in self._map_cache:
            return self._map_cache[key]
        sun_m, earth_m = self.body_m(et, SUN), self.body_m(et, EARTH)
        with _compute_lock:
            t0 = time.perf_counter()
            if mode == "rapido":
                area = self.area
                sun_elev = self.hmap.target_angles(sun_m, SUN_RADIUS_M)[0]
                earth_elev = self.hmap.target_angles(earth_m, EARTH_RADIUS_M)[0]
                sun, earth, steps = self.hmap.illumination(sun_m), self.hmap.earth_visibility(earth_m), None
            else:
                area = self.dem.crop(0.0, 0.0, half_size_m)
                rs = illumination.compute_illumination(area, self.dem, sun_m, SUN_RADIUS_M, growth=config.GROWTH)
                re = illumination.compute_illumination(area, self.dem, earth_m, EARTH_RADIUS_M, growth=config.GROWTH)
                sun, earth, steps = rs.fraction, re.fraction, max(rs.steps, re.steps)
                sun_elev, earth_elev = np.radians(rs.elevation_deg), np.radians(re.elevation_deg)
            result = MapResult(sun, earth, area, mode, time.perf_counter() - t0, steps,
                               _range_deg(sun_elev), _range_deg(earth_elev))
        self._map_cache[key] = result
        while len(self._map_cache) > 16:
            self._map_cache.popitem(last=False)
        return result

    def terrain_payload(self, step: int = 3) -> dict:
        """Malha de altitudes (m) reduzida para a vista 3D, em Float32 little-endian base64."""
        h = self.area.heights
        rows, cols = h.shape
        h = h[: rows - rows % step, : cols - cols % step]
        small = h.reshape(rows // step, step, cols // step, step).mean(axis=(1, 3)).astype("<f4")
        return {"shape": list(small.shape), "bounds": self.bounds(self.area),
                "min_m": round(float(small.min()), 1), "max_m": round(float(small.max()), 1),
                "heights_b64": base64.b64encode(small.tobytes()).decode("ascii")}

    def map_payload(self, utc: str, mode: str, half_size_m: float) -> dict:
        r = self.compute_map(utc, mode, half_size_m)
        et, iso = self.parse_utc(utc)
        center_km = r.area.to_unit_vectors(np.array(0.0), np.array(0.0)) * r.area.radius / 1000
        pct = lambda mask: round(100 * float(np.mean(mask)), 2)  # noqa: E731
        st = link.states(r.sun, r.earth)
        return {
            "utc": iso, "mode": r.mode, "elapsed_s": round(r.elapsed_s, 2), "steps": r.steps,
            "pixels": int(r.sun.size), "shape": list(r.sun.shape), "pixel_m": r.area.pixel,
            "bounds": self.bounds(r.area),
            "image": render.png_data_uri(render.colorize(r.sun, "inferno", 0.0, 1.0)),
            # frações cruas (uint8, 0..255, linha a linha) para o frontend compor hachura e Zona de Ouro
            "sun_fraction_b64": _uint8_b64(r.sun),
            "earth_fraction_b64": _uint8_b64(r.earth),
            "sun": self.body_in_map(self.body_m(et, SUN)),
            "earth": {**self.body_in_map(self.body_m(et, EARTH)),
                      "light_time_s": round(self.light_time_s(et, center_km, EARTH), 4)},
            "stats": {
                "lit_pct": pct(r.sun > 0),
                "full_disk_pct": pct(r.sun >= link.FULL),
                "shadow_pct": pct(r.sun <= 0),
                "sun_elevation_min_deg": round(r.sun_elevation_deg[0], 3),
                "sun_elevation_max_deg": round(r.sun_elevation_deg[1], 3),
                "earth_visible_pct": pct(r.earth > 0),
                "earth_full_pct": pct(r.earth >= link.FULL),
                "earth_elevation_min_deg": round(r.earth_elevation_deg[0], 3),
                "earth_elevation_max_deg": round(r.earth_elevation_deg[1], 3),
                "golden_pct": pct(st["golden"]),
                "power_only_pct": pct(st["power_only"]),
                "comms_only_pct": pct(st["comms_only"]),
                "none_pct": pct(st["none"]),
            },
        }

    def map_geotiff(self, utc: str, mode: str, half_size_m: float) -> bytes:
        r = self.compute_map(utc, mode, half_size_m)
        bands = [("sun_fraction", r.sun), ("earth_fraction", r.earth),
                 ("golden_zone", link.states(r.sun, r.earth)["golden"])]
        profile = dict(driver="GTiff", height=r.area.shape[0], width=r.area.shape[1], count=len(bands),
                       dtype="float32", crs=self.crs, compress="deflate",
                       transform=from_origin(r.area.x0, r.area.y0, r.area.pixel, r.area.pixel))
        with MemoryFile() as mem:
            with mem.open(**profile) as dst:
                for i, (name, band) in enumerate(bands, start=1):
                    dst.write(band.astype(np.float32), i)
                    dst.set_band_description(i, name)
            return mem.read()

    def basemap_payload(self) -> dict:
        h = self.area.heights
        return {"bounds": self.bounds(self.area), "pixel_m": self.area.pixel, "shape": list(h.shape),
                "height_min_m": round(float(h.min()), 1), "height_max_m": round(float(h.max()), 1),
                "image": render.png_data_uri(self.basemap_rgb)}

    # --- Anual ------------------------------------------------------------------
    @staticmethod
    def load_annual(year: int) -> dict | None:
        path = config.annual_path(year)
        if not path.exists():
            return None
        with np.load(path) as z:
            if "longest_golden_h" not in z.files:
                return None  # análise antiga (só Sol): precisa ser refeita com scripts/mapa_anual.py
            data = {k: z[k] for k in z.files if k not in ("meta", "peaks")}
            data["meta"] = json.loads(str(z["meta"]))
            data["peaks"] = json.loads(str(z["peaks"]))
        data["year"] = year
        data["_result"] = annual_mod.result_from_arrays(data, data["meta"])
        return data

    @staticmethod
    def annual_at(annual: dict, x: float, y: float) -> dict | None:
        m = annual["meta"]
        col = int(np.floor((x - m["x0"]) / m["pixel"]))
        row = int(np.floor((m["y0"] - y) / m["pixel"]))
        rows, cols = annual["psr"].shape
        if not (0 <= row < rows and 0 <= col < cols):
            return None
        v = lambda k: float(annual[k][row, col])  # noqa: E731
        return {"year": annual["year"],
                "illumination_pct": round(v("illumination_pct"), 1), "any_sun_pct": round(v("any_sun_pct"), 1),
                "longest_night_h": v("longest_night_h"), "psr": bool(annual["psr"][row, col]),
                "any_earth_pct": round(v("any_earth_pct"), 1), "longest_los_h": v("longest_los_h"),
                "golden_pct": round(v("golden_pct"), 1), "longest_golden_h": v("longest_golden_h")}

    def annual_payload(self, annual: dict, metric: str = "score",
                       weights: tuple[float, float, float] = link.DEFAULT_WEIGHTS) -> dict:
        """Mapa anual + candidatos re-ranqueados com os pesos dados (~0,2 s, sem recalcular a física)."""
        if metric not in ANNUAL_METRICS:
            raise InputError(f"métrica deve ser uma de {list(ANNUAL_METRICS)}")
        if any(w < 0 for w in weights) or not any(w > 0 for w in weights):
            raise InputError("pesos devem ser ≥ 0 e pelo menos um positivo")
        result = annual["_result"]
        if "_dist_psr_m" not in annual:  # cache: a distância às sombras não depende dos pesos
            annual["_dist_psr_m"] = annual_mod.distance_to_psr_m(result, self.area)
        score, _ = annual_mod.scores(result, weights)
        peaks = annual_mod.landing_candidates(result, self.area, weights=weights, dist_m=annual["_dist_psr_m"])
        label, cmap, unit, transform, vmax = ANNUAL_METRICS[metric]
        values = transform({**annual, "_score": score})
        vmin = 0.0
        if metric == "score":
            # pode ser negativa; abaixo de −1 (um mês de apagão além dos benefícios) é igualmente
            # inviável, então a escala vai de max(percentil 5, −1) ao máximo
            vmin = max(float(np.floor(np.percentile(values[~annual["psr"]], 5) * 10) / 10), -1.0)
        vmax = vmax or max(float(np.ceil(values.max() * 10) / 10), vmin + 0.1)
        rgb = (0.35 * self.basemap_rgb + 0.65 * render.colorize(values, cmap, vmin, vmax)).astype(np.uint8)
        rgb = render.overlay_mask(rgb, annual["psr"])
        pix_km2 = (annual["meta"]["pixel"] / 1000) ** 2
        km2 = lambda mask: round(float(mask.sum()) * pix_km2, 2)  # noqa: E731
        return {
            "year": annual["year"], "meta": annual["meta"], "bounds": self.bounds(self.area),
            "metric": {"id": metric, "label": label, "colormap": cmap, "unit": unit, "vmin": vmin, "vmax": vmax},
            "weights": {"a": weights[0], "b": weights[1], "c": weights[2]},
            "image": render.png_data_uri(rgb), "peaks": peaks,
            "stats": {"psr_km2": km2(annual["psr"]),
                      "earth_never_km2": km2(annual["any_earth_pct"] == 0),
                      "golden_any_km2": km2(annual["golden_pct"] > 0),
                      "golden_7d_km2": km2(annual["longest_golden_h"] >= 168),
                      "max_golden_window_d": round(float(annual["longest_golden_h"].max()) / 24, 1),
                      "max_illumination_pct": round(float(annual["illumination_pct"].max()), 1)},
        }

    def info(self) -> dict:
        years = sorted(int(p.stem.split("_")[1]) for p in config.OUTPUT_DIR.glob("anual_*.npz"))
        return {"dem": config.DEM_PATH.name, "dem_shape": list(self.dem.shape), "pixel_m": self.dem.pixel,
                "area_bounds": self.bounds(self.area), "area_shape": list(self.area.shape),
                "horizon_cache": self.hmap is not None, "n_azimuths": config.N_AZIMUTHS,
                "horizon_limit_deg": horizon.EARTH_LIMIT_DEG,
                "annual_years": years, "kernels_loaded": self.n_kernels,
                "annual_metrics": {k: v[0] for k, v in ANNUAL_METRICS.items()}}
