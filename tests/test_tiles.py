"""Quadtree de tiles do DEM (LOD da vista 3D)."""

import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from lunar_navigator import config, terrain, tiles
from lunar_navigator.api import app

pytestmark = pytest.mark.skipif(not config.DEM_PATH.exists(), reason="DEM LOLA não baixado")
N = tiles.TILE_CELLS + 1


@pytest.fixture(scope="module")
def grid():
    return tiles.TileGrid(config.DEM_PATH, 1_737_400.0)


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_grid_levels(grid):
    m = grid.meta()
    assert m["max_zoom"] == 6  # 608 km / 2^6 / 128 = 74 m ≤ pixel de 80 m
    assert m["leaf_cell_m"] <= m["native_pixel_m"] < 2 * m["leaf_cell_m"]
    with pytest.raises(ValueError):
        grid.bounds(7, 0, 0)
    with pytest.raises(ValueError):
        grid.bounds(2, 4, 0)


def test_children_tile_the_parent(grid):
    p = grid.bounds(3, 5, 2)
    kids = [grid.bounds(4, 2 * 5 + dx, 2 * 2 + dy) for dx in (0, 1) for dy in (0, 1)]
    assert {k.size for k in kids} == {p.size / 2}
    assert min(k.xmin for k in kids) == p.xmin and max(k.ymax for k in kids) == p.ymax


SKIRT_MIN_M = 300  # profundidade mínima das saias no cliente (QuadtreeTerrain.tsx)


@pytest.mark.parametrize("z", [2, 4, 6])
def test_neighbor_edge_mismatch_is_covered_by_skirts(grid, z):
    """Leituras independentes reamostram janelas com deslocamento fracionário de pixel (célula de
    74 m sobre pixel de 80 m), então a mesma borda pode diferir alguns metros entre vizinhos. As
    saias verticais do cliente (≥ 300 m) cobrem essa fresta — a mesma técnica do Cesium/Flight Sim."""
    n = 2**z
    x, y = n // 2 - 1, n // 2 - 1
    a, right, below = grid.heights(z, x, y), grid.heights(z, x + 1, y), grid.heights(z, x, y + 1)
    assert a.shape == (N, N)
    worst = max(np.nanmax(np.abs(a[:, -1] - right[:, 0])), np.nanmax(np.abs(a[-1, :] - below[0, :])))
    assert worst < SKIRT_MIN_M / 10


def test_leaf_heights_match_dem(grid):
    dem = terrain.load_dem(config.DEM_PATH)
    b = grid.bounds(6, 30, 33)
    h = grid.heights(6, 30, 33)
    ii = np.arange(0, N, 16)
    X, Y = np.meshgrid(b.xmin + ii * b.cell, b.ymax - ii * b.cell)
    # média sobre células de 74 m contra o pixel de 80 m mais próximo: diferença de subpixel
    assert np.max(np.abs(h[np.ix_(ii, ii)] - dem.sample(X, Y))) < 60


def test_coarse_tile_is_cheap_to_read(grid):
    """A raiz (608 km) é lida pela overview do COG, não pelo DEM inteiro."""
    import time

    grid._relief = tiles._LRU(8)  # sem cache
    t = time.perf_counter()
    grid.relief_png(0, 0, 0)
    assert time.perf_counter() - t < 1.0


def test_relief_png(grid):
    img = Image.open(io.BytesIO(grid.relief_png(2, 1, 2)))
    assert img.mode == "RGBA" and img.size == (tiles.TEXTURE_PX, tiles.TEXTURE_PX)


def test_api_tiles(client):
    meta = client.get("/api/tiles/meta").json()
    assert meta["tile_cells"] == tiles.TILE_CELLS
    r = client.get("/api/tiles/6/32/32/heights")
    assert r.headers["content-type"] == "application/octet-stream"
    assert len(r.content) == N * N * 4
    assert "max-age" in r.headers["cache-control"]
    assert client.get("/api/tiles/1/0/0/relief.png").headers["content-type"] == "image/png"
    assert client.get("/api/tiles/9/0/0/heights").status_code == 422


def test_api_analytic_tile_layers_and_cache(client):
    params = {"utc": "2026-11-20T00:00:00Z"}
    full = client.get("/api/tiles/6/31/33/analytic.png", params=params)
    assert full.status_code == 200
    again = client.get("/api/tiles/6/31/33/analytic.png", params=params)
    assert again.content == full.content  # cache por (tile, instante, camadas)
    relief_only = client.get("/api/tiles/6/31/33/analytic.png", params={**params, "sun": False, "earth": False, "golden": False})
    assert relief_only.content != full.content
    img = np.asarray(Image.open(io.BytesIO(full.content)))
    green = (img[..., 1] > 180) & (img[..., 0] < 120) & (img[..., 2] > 120) & (img[..., 2] < 190)
    assert green.mean() > 0.01  # tile perto do Connecting Ridge tem Zona de Ouro nesse instante
