"""Modelo de terreno (DEM LOLA em GeoTIFF) como matriz NumPy.

O DEM do PGDA/LOLA está em projeção polar estereográfica sul (X/Y em
metros), com alturas em metros relativas a uma esfera de referência de
raio R. Este módulo carrega o raster e faz, de forma vetorizada:

    (x, y) do mapa  <->  vetor 3D no frame MOON_ME (metros)

Sem trigonometria: a projeção estereográfica sul é a projeção a partir do
polo norte, então para um vetor Q qualquer (r = |Q|):

    x = 2R·Qy / (r − Qz)        y = 2R·Qx / (r − Qz)

e a inversa (vetor unitário a partir de x, y, com ρ² = x² + y²):

    u = (4R·y, 4R·x, ρ² − 4R²) / (ρ² + 4R²)

(Convenção do PROJ para lat_0 = −90, lon_0 = 0: x = ρ·sen λ, y = ρ·cos λ.)
"""

from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DEM = ROOT / "data" / "dem" / "LDEM_80S_80MPP_ADJ.TIF"
NODATA_HEIGHT = -1e5  # células sem dado nunca bloqueiam a luz


@dataclass
class DEM:
    heights: np.ndarray  # (linhas, colunas) metros acima da esfera R
    x0: float  # coordenada X da borda esquerda (m)
    y0: float  # coordenada Y da borda superior (m)
    pixel: float  # tamanho do pixel (m); linhas crescem para Y negativo
    radius: float  # raio da esfera de referência (m)

    @property
    def shape(self) -> tuple[int, int]:
        return self.heights.shape

    @cached_property
    def max_height(self) -> float:
        """Pico mais alto do DEM (m), ignorando células sem dado (calculado uma vez)."""
        return float(self.heights[self.heights > NODATA_HEIGHT].max())

    def pixel_centers(self) -> tuple[np.ndarray, np.ndarray]:
        """Grades (X, Y) dos centros dos pixels, em metros."""
        rows, cols = self.shape
        xs = self.x0 + (np.arange(cols) + 0.5) * self.pixel
        ys = self.y0 - (np.arange(rows) + 0.5) * self.pixel
        return np.meshgrid(xs, ys)

    def sample(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Altura no ponto (x, y) por vizinho mais próximo; fora do mapa -> NODATA."""
        col = np.floor((x - self.x0) / self.pixel).astype(np.intp)
        row = np.floor((self.y0 - y) / self.pixel).astype(np.intp)
        rows, cols = self.shape
        inside = (row >= 0) & (row < rows) & (col >= 0) & (col < cols)
        out = np.full(x.shape, NODATA_HEIGHT)
        out[inside] = self.heights[row[inside], col[inside]]
        return out

    def contains(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        x1 = self.x0 + self.shape[1] * self.pixel
        y1 = self.y0 - self.shape[0] * self.pixel
        return (x >= self.x0) & (x < x1) & (y <= self.y0) & (y > y1)

    # --- Projeção --------------------------------------------------------
    def to_unit_vectors(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """(x, y) do mapa -> vetores unitários MOON_ME, shape (..., 3)."""
        four_r2 = 4.0 * self.radius**2
        rho2 = x**2 + y**2
        d = rho2 + four_r2
        return np.stack([2 * self.radius * 2 * y / d, 2 * self.radius * 2 * x / d, (rho2 - four_r2) / d], axis=-1)

    def to_map(self, q: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Vetores MOON_ME (..., 3) -> (x, y) do mapa."""
        r = np.linalg.norm(q, axis=-1)
        k = 2.0 * self.radius / (r - q[..., 2])
        return k * q[..., 1], k * q[..., 0]

    def surface_points(self) -> np.ndarray:
        """Posição 3D (m, MOON_ME) do centro de cada pixel na superfície."""
        x, y = self.pixel_centers()
        return self.to_unit_vectors(x, y) * (self.radius + self.heights.astype(np.float64))[..., None]

    def lat_lon(self) -> tuple[np.ndarray, np.ndarray]:
        """Latitude e longitude (graus) dos centros dos pixels."""
        u = self.to_unit_vectors(*self.pixel_centers())
        return np.degrees(np.arcsin(u[..., 2])), np.degrees(np.arctan2(u[..., 1], u[..., 0]))

    def crop(self, x_center: float, y_center: float, half_size: float) -> "DEM":
        """Recorte quadrado (2·half_size) em torno de (x, y) — usado para a área de saída."""
        # round(): evita que ruído de ponto flutuante acrescente uma linha/coluna
        c0 = round((x_center - half_size - self.x0) / self.pixel)
        c1 = round((x_center + half_size - self.x0) / self.pixel)
        r0 = round((self.y0 - (y_center + half_size)) / self.pixel)
        r1 = round((self.y0 - (y_center - half_size)) / self.pixel)
        r0, c0 = max(r0, 0), max(c0, 0)
        return DEM(
            self.heights[r0:r1, c0:c1],
            self.x0 + c0 * self.pixel,
            self.y0 - r0 * self.pixel,
            self.pixel,
            self.radius,
        )


def _reference_radius(crs) -> float:
    params = crs.to_dict()
    if params.get("proj") != "stere" or float(params.get("lat_0", 0)) != -90:
        raise ValueError(f"DEM não está em polar estereográfica sul: {crs}")
    if float(params.get("lon_0", 0)) != 0 or float(params.get("k", params.get("k_0", 1))) != 1:
        raise ValueError(f"Parâmetros de projeção não suportados: {params}")
    radius = params.get("R", params.get("a"))
    if radius is None:
        raise ValueError(f"Raio de referência não encontrado no CRS: {params}")
    return float(radius)


def load_dem(path: Path = DEFAULT_DEM, downsample: int = 1, window: Window | None = None) -> DEM:
    """Lê o GeoTIFF como matriz NumPy (metros). `downsample` reduz a resolução por média."""
    with rasterio.open(path) as src:
        win = window or Window(0, 0, src.width, src.height)
        out_shape = (int(win.height) // downsample, int(win.width) // downsample)
        data = src.read(1, window=win, out_shape=out_shape, resampling=Resampling.average, masked=True)
        transform = src.window_transform(win) * src.transform.scale(downsample, downsample)
        if not np.isclose(transform.a, -transform.e) or transform.b or transform.d:
            raise ValueError("Esperado pixel quadrado e sem rotação")
        # float32: precisão sub-milimétrica nas alturas e metade da memória (231 MB a 80 m)
        heights = np.asarray(data.filled(np.nan), dtype=np.float32)
        heights[~np.isfinite(heights)] = NODATA_HEIGHT
        scale = src.scales[0] if src.scales else 1.0
        offset = src.offsets[0] if src.offsets else 0.0
        if scale != 1.0 or offset != 0.0:
            valid = heights != NODATA_HEIGHT
            heights[valid] = heights[valid] * scale + offset
        return DEM(heights, transform.c, transform.f, transform.a, _reference_radius(src.crs))
