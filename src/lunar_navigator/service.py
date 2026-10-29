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

from lunar_navigator import config, ephemeris, horizon, illumination, link, render, terrain
from lunar_navigator.ephemeris import EARTH, EARTH_RADIUS_M, SUN, SUN_RADIUS_M

_spice_lock = threading.Lock()
_compute_lock = threading.Lock()

ANNUAL_METRICS = {
    # métrica: (rótulo, colormap, unidade, transformação, vmax fixo ou None)
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

    def annual_payload(self, annual: dict, metric: str = "golden_window") -> dict:
        if metric not in ANNUAL_METRICS:
            raise InputError(f"métrica deve ser uma de {list(ANNUAL_METRICS)}")
        label, cmap, unit, transform, vmax = ANNUAL_METRICS[metric]
        values = transform(annual)
        vmax = vmax or float(np.ceil(values.max()))
        rgb = (0.35 * self.basemap_rgb + 0.65 * render.colorize(values, cmap, 0.0, vmax)).astype(np.uint8)
        rgb = render.overlay_mask(rgb, annual["psr"])
        pix_km2 = (annual["meta"]["pixel"] / 1000) ** 2
        km2 = lambda mask: round(float(mask.sum()) * pix_km2, 2)  # noqa: E731
        return {
            "year": annual["year"], "meta": annual["meta"], "bounds": self.bounds(self.area),
            "metric": {"id": metric, "label": label, "colormap": cmap, "unit": unit, "vmax": vmax},
            "image": render.png_data_uri(rgb), "peaks": annual["peaks"],
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
