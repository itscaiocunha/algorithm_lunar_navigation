"""Mapas de horizonte: pré-cálculo do relevo para iluminação instantânea.

O relevo não muda; só o Sol se move. Então, para cada pixel, calculamos
UMA vez a elevação do horizonte topográfico em N azimutes (o mesmo
ray-marching vetorizado de `illumination.py`, mas com raios horizontais).
Depois, a iluminação em qualquer instante é só:

    fração = disco_visível(elevação_do_Sol − horizonte(azimute_do_Sol))

com interpolação linear entre os dois azimutes vizinhos — ~50 ms por
instante em vez de ~14 s. Método de Mazarico et al. (2011), ver REFERENCIAS.md.

Faixa útil: perto do polo o Sol nunca passa de (colatitude + ~1,6°) de
elevação (inclinação do equador lunar em relação à eclíptica). Horizontes
fora de [−teto, +teto] são cortados, o que permite parar os raios cedo.
"""

import hashlib
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from lunar_navigator.illumination import SUN_RADIUS_M, visible_disk_fraction
from lunar_navigator.terrain import DEM, ROOT, load_dem

CACHE_DIR = ROOT / "data" / "cache"
MAX_SUN_DECLINATION_DEG = 1.6  # máxima "declinação" do Sol vista da Lua (~1,54°)
SUN_DISK_MARGIN_DEG = 0.3  # raio aparente do disco solar (~0,27°) com folga


def local_basis(points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Vetores unitários (zênite, norte, leste) em cada ponto, MOON_ME. points: (N, 3)."""
    up = points / np.linalg.norm(points, axis=1, keepdims=True)
    north = np.array([0.0, 0.0, 1.0]) - up[:, 2:3] * up
    norm = np.linalg.norm(north, axis=1, keepdims=True)
    at_pole = norm[:, 0] < 1e-12  # norte indefinido no polo: usa o meridiano 0° (+X)
    north[at_pole] = [1.0, 0.0, 0.0]
    norm[at_pole] = 1.0
    north /= norm
    east = np.cross(north, up)
    return up, north, east


def elevation_limit(up: np.ndarray) -> np.ndarray:
    """Maior |elevação| que o Sol (com o disco) pode atingir em cada ponto, em radianos."""
    colatitude = np.pi / 2 - np.abs(np.arcsin(up[:, 2]))
    return colatitude + np.radians(MAX_SUN_DECLINATION_DEG + SUN_DISK_MARGIN_DEG)


CHUNK = 65_536  # pixels por bloco: arrays temporários cabem no cache da CPU (~2x mais rápido)


def march_azimuth(points, up, direction, terrain: DEM, limit, growth=0.01, chunk=CHUNK):
    """Horizonte (rad) de cada ponto ao longo de `direction` (vetores horizontais unitários).

    Para quando: o raio sai do mapa; o horizonte passa do teto (Sol nunca
    aparece por cima); ou nenhum terreno mais distante pode subir o horizonte
    (a elevação do pico mais alto possível naquela distância já é menor).
    """
    return np.concatenate([
        _march_block(points[i:i + chunk], up[i:i + chunk], direction[i:i + chunk], terrain, limit[i:i + chunk], growth)
        for i in range(0, len(points), chunk)
    ])


def _march_block(points, up, direction, terrain: DEM, limit, growth):
    ceiling = terrain.radius + terrain.max_height
    horizon = np.full(len(points), -np.pi / 2)
    active = np.arange(len(points))
    t = terrain.pixel
    while active.size:
        p, n = points[active], up[active]
        q = p + t * direction[active]
        r = np.linalg.norm(q, axis=1)
        x, y = terrain.to_map(q)

        v = q * ((terrain.radius + terrain.sample(x, y)) / r)[:, None] - p
        elev = np.arcsin(np.einsum("ij,ij->i", v, n) / np.linalg.norm(v, axis=1))
        h = np.maximum(horizon[active], elev)
        horizon[active] = h

        vc = q * (ceiling / r)[:, None] - p
        best_possible = np.arcsin(np.einsum("ij,ij->i", vc, n) / np.linalg.norm(vc, axis=1))
        lim = limit[active]
        done = ~terrain.contains(x, y) | (best_possible < np.maximum(h, -lim)) | (h >= lim)
        active = active[~done]
        t += max(terrain.pixel, growth * t)
    return np.clip(horizon, -limit, limit)


@dataclass
class HorizonMap:
    area: DEM
    horizon_deg: np.ndarray  # (n_azimutes, N) float16; azimute k = k·360/n, a partir do Norte, horário
    _geometry: tuple = field(default=None, repr=False)

    @property
    def n_azimuths(self) -> int:
        return self.horizon_deg.shape[0]

    def geometry(self):
        if self._geometry is None:
            points = self.area.surface_points().reshape(-1, 3)
            self._geometry = (points, *local_basis(points))
        return self._geometry

    def sun_angles(self, sun_m: np.ndarray):
        """Elevação, azimute e raio aparente do Sol (rad) em cada pixel."""
        points, up, north, east = self.geometry()
        to_sun = sun_m - points
        dist = np.linalg.norm(to_sun, axis=1)
        s = to_sun / dist[:, None]
        elev = np.arcsin(np.einsum("ij,ij->i", s, up))
        az = np.arctan2(np.einsum("ij,ij->i", s, east), np.einsum("ij,ij->i", s, north)) % (2 * np.pi)
        return elev, az, np.arcsin(SUN_RADIUS_M / dist)

    def horizon_at(self, az: np.ndarray) -> np.ndarray:
        """Horizonte (rad) de cada pixel no azimute dado, interpolando entre amostras."""
        pos = az / (2 * np.pi) * self.n_azimuths
        i0 = np.floor(pos).astype(np.intp) % self.n_azimuths
        i1 = (i0 + 1) % self.n_azimuths
        w = (pos - np.floor(pos)).astype(np.float32)
        k = np.arange(len(az))
        h = (1 - w) * self.horizon_deg[i0, k].astype(np.float32) + w * self.horizon_deg[i1, k].astype(np.float32)
        return np.radians(h.astype(np.float64))

    def illumination(self, sun_m: np.ndarray) -> np.ndarray:
        """Fração do disco solar visível em cada pixel (rows, cols)."""
        elev, az, radius = self.sun_angles(sun_m)
        return visible_disk_fraction(elev, self.horizon_at(az), radius).reshape(self.area.shape)


# --- Cálculo paralelo (um processo por grupo de azimutes) ---------------------
_worker: dict = {}


def _init_worker(dem_path, downsample, area_args, growth):
    terrain = load_dem(dem_path, downsample=downsample)
    area = DEM(*area_args)
    points = area.surface_points().reshape(-1, 3)
    up, north, east = local_basis(points)
    _worker.update(terrain=terrain, points=points, up=up, north=north, east=east,
                   limit=elevation_limit(up), growth=growth)


def _azimuth_task(azimuth_deg: float) -> np.ndarray:
    w = _worker
    a = np.radians(azimuth_deg)
    direction = np.cos(a) * w["north"] + np.sin(a) * w["east"]
    h = march_azimuth(w["points"], w["up"], direction, w["terrain"], w["limit"], w["growth"])
    return np.degrees(h).astype(np.float16)


def cache_path(area: DEM, dem_path: Path, n_azimuths: int, growth: float) -> Path:
    key = f"{Path(dem_path).name}|{area.x0}|{area.y0}|{area.pixel}|{area.shape}|{n_azimuths}|{growth}"
    return CACHE_DIR / f"horizon_{hashlib.sha1(key.encode()).hexdigest()[:12]}.npz"


def compute_horizons(area: DEM, dem_path: Path, downsample: int = 1, n_azimuths: int = 180,
                     growth: float = 0.01, workers: int | None = None, progress=None) -> HorizonMap:
    """Calcula (ou lê do cache) o mapa de horizontes de `area`."""
    path = cache_path(area, dem_path, n_azimuths, growth)
    if path.exists():
        return HorizonMap(area, np.load(path)["horizon_deg"])

    workers = workers or max(1, (os.cpu_count() or 2) - 2)
    azimuths = np.arange(n_azimuths) * 360.0 / n_azimuths
    area_args = (area.heights, area.x0, area.y0, area.pixel, area.radius)
    result = np.empty((n_azimuths, area.heights.size), dtype=np.float16)
    with ProcessPoolExecutor(workers, initializer=_init_worker,
                             initargs=(dem_path, downsample, area_args, growth)) as pool:
        for i, h in enumerate(pool.map(_azimuth_task, azimuths)):
            result[i] = h
            if progress:
                progress(i + 1, n_azimuths)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.savez(path, horizon_deg=result)
    return HorizonMap(area, result)
