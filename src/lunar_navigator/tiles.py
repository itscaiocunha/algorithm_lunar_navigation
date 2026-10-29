"""Quadtree de tiles do DEM para a vista 3D com Nível de Detalhe (LOD).

Grade: o DEM (quadrado de `size_m`) é o tile raiz (z=0). No nível z há 2^z × 2^z tiles,
cada um com TILE_CELLS × TILE_CELLS células ((TILE_CELLS+1)² vértices). O nível máximo é
o primeiro cuja célula fica ≤ ao pixel nativo do DEM (80 m -> z=6, células de 74 m;
um DEM de 10 m chegaria a z=9 sem mudar nada aqui).

Leitura: cada tile lê SÓ a sua janela do GeoTIFF com reamostragem por média. O arquivo é
um COG (blocos de 512 px + overviews 2/4/8/16), então o GDAL escolhe a overview adequada:
3–20 ms por tile em qualquer nível, sem carregar o DEM inteiro na memória. É isso que
permite trocar para os DEMs de 20 m ou 10 m (GB) sem estourar a RAM do servidor.

Camada analítica (Sol + Terra + Zona de Ouro) por tile, sob demanda e com cache por instante.
Quem calcula as frações é injetado pelo serviço (`fractions`): dentro da área com cache de
horizontes, amostra o mapa de horizontes (O(1), o mesmo método do mapa 2D); fora dela, faz
ray-casting direto contra o DEM de 80 m (~0,6 s para 128² células; 64² nos níveis grosseiros).
"""

import io
import math
import threading
from collections import OrderedDict
from dataclasses import dataclass

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

from lunar_navigator import link, render
from lunar_navigator.terrain import DEM

TILE_CELLS = 128
TEXTURE_PX = 256  # relevo: 2 px por célula
NODATA = float("nan")


class _LRU:
    def __init__(self, capacity: int):
        self.capacity, self.data, self.lock = capacity, OrderedDict(), threading.Lock()

    def get(self, key):
        with self.lock:
            if key in self.data:
                self.data.move_to_end(key)
                return self.data[key]
        return None

    def put(self, key, value):
        with self.lock:
            self.data[key] = value
            self.data.move_to_end(key)
            while len(self.data) > self.capacity:
                self.data.popitem(last=False)
        return value


@dataclass(frozen=True)
class TileBounds:
    xmin: float
    ymax: float
    size: float  # lado do tile (m)

    @property
    def cell(self) -> float:
        return self.size / TILE_CELLS


class TileGrid:
    def __init__(self, dem_path, radius_m: float):
        self.path = str(dem_path)
        self.radius = radius_m
        with rasterio.open(self.path) as src:
            b = src.bounds
            self.native_pixel = src.res[0]
            self.size = max(b.right - b.left, b.top - b.bottom)
            self.x0, self.y0 = b.left, b.top
            # escala de cor global do relevo (consistente entre tiles), a partir de uma overview
            ov = src.read(1, out_shape=(512, 512), resampling=Resampling.average, masked=True).compressed()
            self.h_lo, self.h_hi = (float(v) for v in np.percentile(ov, [1, 99]))
            self.h_min, self.h_max = float(ov.min()), float(ov.max())
        self.max_zoom = max(0, math.ceil(math.log2(self.size / (TILE_CELLS * self.native_pixel))))
        self._heights = _LRU(1024)
        self._relief = _LRU(1024)
        self._analytic = _LRU(512)
        self._local = threading.local()  # um dataset rasterio por thread (não é thread-safe)

    def meta(self) -> dict:
        return {"x0": self.x0, "y0": self.y0, "size_m": self.size, "tile_cells": TILE_CELLS,
                "texture_px": TEXTURE_PX, "max_zoom": self.max_zoom, "native_pixel_m": self.native_pixel,
                "leaf_cell_m": self.size / 2**self.max_zoom / TILE_CELLS,
                "height_min_m": self.h_min, "height_max_m": self.h_max}

    def bounds(self, z: int, x: int, y: int) -> TileBounds:
        if not (0 <= z <= self.max_zoom and 0 <= x < 2**z and 0 <= y < 2**z):
            raise ValueError(f"tile fora da grade: {z}/{x}/{y}")
        size = self.size / 2**z
        return TileBounds(self.x0 + x * size, self.y0 - y * size, size)

    def _src(self):
        if getattr(self._local, "src", None) is None:
            self._local.src = rasterio.open(self.path)
        return self._local.src

    def _read(self, xmin, ymax, n, cell) -> np.ndarray:
        """n×n amostras (média) centradas em xmin + (i+½)·cell, ymax − (j+½)·cell. NaN fora do DEM.

        Recorta a janela para dentro do arquivo e preenche o resto com NaN: a leitura `boundless`
        do rasterio passa por um VRT que ignora as overviews do COG (2,6 s no tile raiz contra ~10 ms).
        """
        src = self._src()
        b = src.bounds
        # colunas/linhas de saída que caem dentro do arquivo
        c0 = max(0, math.ceil((b.left - xmin) / cell - 1e-9))
        c1 = min(n, math.floor((b.right - xmin) / cell + 1e-9))
        r0 = max(0, math.ceil((ymax - b.top) / cell - 1e-9))
        r1 = min(n, math.floor((ymax - b.bottom) / cell + 1e-9))
        out = np.full((n, n), np.nan, dtype=np.float32)
        if c1 <= c0 or r1 <= r0:
            return out
        win = from_bounds(xmin + c0 * cell, ymax - r1 * cell, xmin + c1 * cell, ymax - r0 * cell, src.transform)
        a = src.read(1, window=win, out_shape=(r1 - r0, c1 - c0), resampling=Resampling.average, masked=True)
        out[r0:r1, c0:c1] = a.filled(np.nan)
        return out

    # --- Geometria -------------------------------------------------------------
    def heights(self, z: int, x: int, y: int) -> np.ndarray:
        """(TILE_CELLS+1)² alturas (m) nos vértices; NaN fora do DEM (o cliente omite esses triângulos)."""
        key = (z, x, y)
        if (h := self._heights.get(key)) is not None:
            return h
        b = self.bounds(z, x, y)
        # vértice i fica em xmin + i·cell: amostras de uma grade deslocada de meia célula
        h = self._read(b.xmin - b.cell / 2, b.ymax + b.cell / 2, TILE_CELLS + 1, b.cell)
        return self._heights.put(key, h)

    # --- Texturas --------------------------------------------------------------
    def _relief_rgb(self, b: TileBounds) -> tuple[np.ndarray, np.ndarray]:
        px = b.size / TEXTURE_PX
        h = self._read(b.xmin - px, b.ymax + px, TEXTURE_PX + 2, px)  # 1 px de borda p/ o gradiente
        valid = np.isfinite(h)
        hf = np.where(valid, h, np.nanmean(h) if valid.any() else 0.0)
        shade = render.hillshade(hf, px)[1:-1, 1:-1]
        tint = render.colorize(hf[1:-1, 1:-1], "gist_earth", self.h_lo, self.h_hi)
        rgb = (0.75 * shade[..., None] * 255 + 0.25 * tint).astype(np.uint8)
        return rgb, valid[1:-1, 1:-1]

    @staticmethod
    def _png(rgb: np.ndarray, valid: np.ndarray) -> bytes:
        rgba = np.dstack([rgb, np.where(valid, 255, 0).astype(np.uint8)])
        buf = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=False, compress_level=3)
        return buf.getvalue()

    def relief_png(self, z: int, x: int, y: int) -> bytes:
        key = (z, x, y)
        if (png := self._relief.get(key)) is not None:
            return png
        rgb, valid = self._relief_rgb(self.bounds(z, x, y))
        return self._relief.put(key, self._png(rgb, valid))

    def analytic_cells(self, z: int) -> int:
        """Células analíticas por lado: 128 nos dois níveis mais finos, 64 nos grosseiros (pouca área na tela)."""
        return TILE_CELLS if z >= self.max_zoom - 1 else TILE_CELLS // 2

    def analytic_png(self, z: int, x: int, y: int, utc_key: str, fractions, layers: tuple[bool, bool, bool]) -> bytes:
        """Sol (inferno), Terra só-rádio (hachura ciano) e Zona de Ouro (verde) sobre o relevo do tile.

        `fractions(cells: DEM) -> (sol, terra)` calcula as frações nas células do tile.
        """
        key = (z, x, y, utc_key, layers)
        if (png := self._analytic.get(key)) is not None:
            return png
        b = self.bounds(z, x, y)
        n = self.analytic_cells(z)
        cell = b.size / n
        cells = DEM(self._read(b.xmin, b.ymax, n, cell), b.xmin, b.ymax, cell, self.radius)
        ok = np.isfinite(cells.heights)
        cells.heights = np.where(ok, cells.heights, 0.0).astype(np.float32)
        sun, earth = fractions(cells)
        rgb, valid = self._relief_rgb(b)
        up = lambda a: np.repeat(np.repeat(a, TEXTURE_PX // n, 0), TEXTURE_PX // n, 1)  # noqa: E731
        sun_u, earth_u = up(sun), up(earth)
        show_sun, show_earth, show_golden = layers
        out = rgb.astype(np.float32)
        if show_sun:
            out = 0.2 * out + 0.8 * render.colorize(sun_u, "inferno", 0, 1)
        st = link.states(sun_u, earth_u)
        if show_earth:
            ii, jj = np.indices(sun_u.shape)
            stripes = ((ii + jj) % 8) < 2  # hachura diagonal fina, mais fraca com enlace degradado
            comms = (st["comms_only"] if show_golden else earth_u > 0) & stripes
            a = (0.35 + 0.65 * earth_u)[..., None]
            out = np.where(comms[..., None], (1 - a) * out + a * np.array([64, 200, 255]), out)
        if show_golden:
            g = st["golden"][..., None]
            out = np.where(g, 0.15 * out + 0.85 * np.array([52, 211, 153]), out)
        return self._analytic.put(key, self._png(out.astype(np.uint8), valid & up(ok)))
