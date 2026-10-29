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

from lunar_navigator import config, horizon, illumination, render, solar, terrain

_spice_lock = threading.Lock()
_compute_lock = threading.Lock()


class InputError(ValueError):
    """Entrada inválida do usuário (vira HTTP 422)."""


@dataclass
class MapResult:
    fraction: np.ndarray
    area: terrain.DEM
    mode: str
    elapsed_s: float
    steps: int | None
    sun_elevation_deg: tuple[float, float]


class LunarService:
    def __init__(self):
        with _spice_lock:
            spice.kclear()
            solar.load_kernels()
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

    # --- Tempo ------------------------------------------------------------
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
    def sun_m(et: float) -> np.ndarray:
        with _spice_lock:
            return illumination.sun_position_m(et)

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

    # --- Ponto ----------------------------------------------------------------
    def point(self, utc: str, lat: float, lon: float, annual: dict | None = None) -> dict:
        t0 = time.perf_counter()
        et, iso = self.parse_utc(utc)
        pixel = self.latlon_to_pixel(lat, lon)
        sun = self.sun_m(et)
        res = illumination.compute_illumination(pixel, self.dem, sun)
        p = pixel.surface_points().reshape(1, 3)
        up, north, east = horizon.local_basis(p)
        s = sun - p[0]
        az = np.degrees(np.arctan2(s @ east[0], s @ north[0])) % 360
        fraction = float(res.fraction.item())
        out = {
            "utc": iso, "lat": lat, "lon": lon,
            "x_m": pixel.x0 + pixel.pixel / 2, "y_m": pixel.y0 - pixel.pixel / 2,
            "height_m": round(float(pixel.heights.item()), 1),
            "fraction": round(fraction, 4),
            "status": "iluminado" if fraction >= 0.999 else "sombra" if fraction <= 0 else "penumbra",
            "sun_elevation_deg": round(float(res.sun_elevation_deg.item()), 4),
            "sun_azimuth_deg": round(float(az), 2),
            "horizon_deg": round(float(res.horizon_deg.item()), 4),
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
        sun = self.sun_m(et)
        with _compute_lock:
            t0 = time.perf_counter()
            if mode == "rapido":
                area = self.area
                elev, _, _ = self.hmap.sun_angles(sun)
                fraction, steps = self.hmap.illumination(sun), None
            else:
                area = self.dem.crop(0.0, 0.0, half_size_m)
                res = illumination.compute_illumination(area, self.dem, sun, growth=config.GROWTH)
                fraction, steps, elev = res.fraction, res.steps, np.radians(res.sun_elevation_deg)
            result = MapResult(fraction, area, mode, time.perf_counter() - t0, steps,
                               (float(np.degrees(elev.min())), float(np.degrees(elev.max()))))
        self._map_cache[key] = result
        while len(self._map_cache) > 16:
            self._map_cache.popitem(last=False)
        return result

    def sun_in_map(self, et: float) -> dict:
        """Direção do Sol vista do centro da área, no plano do mapa (x, y) + elevação.

        Perto do polo, o eixo X do mapa é +Y do MOON_ME e o eixo Y é +X do MOON_ME.
        """
        center = self.area.to_unit_vectors(np.array(0.0), np.array(0.0)) * self.area.radius
        s = self.sun_m(et) - center
        s /= np.linalg.norm(s)
        up = center / np.linalg.norm(center)
        horiz = s - (s @ up) * up
        dx, dy = float(horiz[1]), float(horiz[0])
        norm = np.hypot(dx, dy)
        return {"map_dir": [dx / norm, dy / norm], "elevation_deg": round(float(np.degrees(np.arcsin(s @ up))), 3)}

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
        rgb = render.colorize(r.fraction, "inferno", 0.0, 1.0)
        return {
            "utc": iso, "mode": r.mode, "elapsed_s": round(r.elapsed_s, 2), "steps": r.steps,
            "pixels": int(r.fraction.size), "shape": list(r.fraction.shape), "pixel_m": r.area.pixel,
            "bounds": self.bounds(r.area), "image": render.png_data_uri(rgb), "sun": self.sun_in_map(et),
            "stats": {
                "lit_pct": round(100 * float(np.mean(r.fraction > 0)), 2),
                "full_disk_pct": round(100 * float(np.mean(r.fraction >= 0.999)), 2),
                "shadow_pct": round(100 * float(np.mean(r.fraction <= 0)), 2),
                "sun_elevation_min_deg": round(r.sun_elevation_deg[0], 3),
                "sun_elevation_max_deg": round(r.sun_elevation_deg[1], 3),
            },
        }

    def map_geotiff(self, utc: str, mode: str, half_size_m: float) -> bytes:
        r = self.compute_map(utc, mode, half_size_m)
        profile = dict(driver="GTiff", height=r.area.shape[0], width=r.area.shape[1], count=1, dtype="float32",
                       crs=self.crs, compress="deflate",
                       transform=from_origin(r.area.x0, r.area.y0, r.area.pixel, r.area.pixel))
        with MemoryFile() as mem:
            with mem.open(**profile) as dst:
                dst.write(r.fraction.astype(np.float32), 1)
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
            data = {k: z[k] for k in ("illumination_pct", "any_sun_pct", "longest_night_h", "psr")}
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
        return {"year": annual["year"],
                "illumination_pct": round(float(annual["illumination_pct"][row, col]), 1),
                "any_sun_pct": round(float(annual["any_sun_pct"][row, col]), 1),
                "longest_night_h": float(annual["longest_night_h"][row, col]),
                "psr": bool(annual["psr"][row, col])}

    def annual_payload(self, annual: dict) -> dict:
        pct = annual["illumination_pct"]
        heat = render.colorize(pct, "inferno", 0.0, 100.0)
        rgb = (0.35 * self.basemap_rgb + 0.65 * heat).astype(np.uint8)
        rgb = render.overlay_mask(rgb, annual["psr"])
        pix_km2 = (annual["meta"]["pixel"] / 1000) ** 2
        return {
            "year": annual["year"], "meta": annual["meta"], "bounds": self.bounds(self.area),
            "image": render.png_data_uri(rgb), "peaks": annual["peaks"],
            "stats": {"psr_km2": round(float(annual["psr"].sum()) * pix_km2, 1),
                      "psr_pct": round(100 * float(annual["psr"].mean()), 2),
                      "over_80pct_km2": round(float((pct > 80).sum()) * pix_km2, 2),
                      "over_50pct_km2": round(float((pct > 50).sum()) * pix_km2, 2),
                      "max_illumination_pct": round(float(pct.max()), 1)},
        }

    def info(self) -> dict:
        years = sorted(int(p.stem.split("_")[1]) for p in config.OUTPUT_DIR.glob("anual_*.npz"))
        return {"dem": config.DEM_PATH.name, "dem_shape": list(self.dem.shape), "pixel_m": self.dem.pixel,
                "area_bounds": self.bounds(self.area), "area_shape": list(self.area.shape),
                "horizon_cache": self.hmap is not None, "n_azimuths": config.N_AZIMUTHS,
                "annual_years": years, "kernels_loaded": self.n_kernels}
