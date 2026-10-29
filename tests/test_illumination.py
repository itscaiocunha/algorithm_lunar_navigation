"""Testes do DEM e do ray-casting com terrenos sintéticos de resposta conhecida."""

import numpy as np
import pytest
import rasterio.warp
from rasterio.crs import CRS

from lunar_navigator import illumination, terrain
from lunar_navigator.terrain import DEM

R = 1_737_400.0
PIXEL = 80.0
HALF = 200  # grade de 401 x 401 pixels centrada no polo sul (~32 km)
AU = 1.496e11


def flat_dem(heights=None) -> DEM:
    size = 2 * HALF + 1
    h = np.zeros((size, size)) if heights is None else heights
    edge = (HALF + 0.5) * PIXEL
    return DEM(h, -edge, edge, PIXEL, R)


def sun_at(point, elev_deg, azimuth_axis):
    """Sol a 1 UA, na elevação dada, no plano vertical que contém `azimuth_axis` (polo sul)."""
    e = np.radians(elev_deg)
    up = np.array([0.0, 0.0, -1.0])  # zênite no polo sul
    direction = np.cos(e) * np.asarray(azimuth_axis, float) + np.sin(e) * up
    return point + AU * direction


def pole_pixel_fraction(dem, sun):
    area = dem.crop(0.0, 0.0, PIXEL / 2)  # só o pixel do polo
    assert area.shape == (1, 1)
    return illumination.compute_illumination(area, dem, sun)


POLE = np.array([0.0, 0.0, -R])


# --- Projeção -----------------------------------------------------------------
def test_projection_roundtrip():
    dem = flat_dem()
    x, y = dem.pixel_centers()
    xb, yb = dem.to_map(dem.to_unit_vectors(x, y) * (R + 500.0))
    np.testing.assert_allclose(xb, x, atol=1e-6)
    np.testing.assert_allclose(yb, y, atol=1e-6)


def test_projection_matches_proj_library():
    """Confere a fórmula fechada contra o PROJ (via GDAL/rasterio)."""
    stere = CRS.from_proj4(f"+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R={R} +units=m +no_defs")
    geo = CRS.from_proj4(f"+proj=longlat +R={R} +no_defs")
    xs, ys = [12_000.0, -150_000.0, 3_000.0], [-40_000.0, 90_000.0, 250_000.0]
    lons, lats = rasterio.warp.transform(stere, geo, xs, ys)
    u = flat_dem().to_unit_vectors(np.array(xs), np.array(ys))
    np.testing.assert_allclose(np.degrees(np.arcsin(u[:, 2])), lats, atol=1e-9)
    np.testing.assert_allclose(np.degrees(np.arctan2(u[:, 1], u[:, 0])), lons, atol=1e-9)


# --- Disco solar ------------------------------------------------------------------
@pytest.mark.parametrize("d, expected", [(1.0, 1.0), (-1.0, 0.0), (0.0, 0.5), (2.0, 1.0), (-3.0, 0.0)])
def test_visible_disk_fraction(d, expected):
    alpha = np.radians(0.267)
    f = illumination.visible_disk_fraction(np.array([d * alpha]), np.array([0.0]), np.array([alpha]))
    assert f[0] == pytest.approx(expected, abs=1e-12)


# --- Terreno plano (esfera) --------------------------------------------------------
@pytest.mark.parametrize("elev, expected", [(1.0, 1.0), (-1.0, 0.0), (0.0, 0.5)])
def test_flat_sphere(elev, expected):
    res = pole_pixel_fraction(flat_dem(), sun_at(POLE, elev, [1, 0, 0]))
    assert res.sun_elevation_deg.item() == pytest.approx(elev, abs=1e-6)
    assert res.fraction.item() == pytest.approx(expected, abs=0.01)


# --- Parede sintética --------------------------------------------------------------
WALL_HEIGHT = 1000.0
WALL_COL = HALF + 100  # 8 km a leste do polo (+X do mapa = +Y do MOON_ME)


def wall_dem() -> DEM:
    h = np.zeros((2 * HALF + 1, 2 * HALF + 1))
    h[:, WALL_COL] = WALL_HEIGHT
    return flat_dem(h)


def wall_horizon_deg(edge: int = 0) -> float:
    """Elevação exata do topo da parede vista do polo (inclui curvatura).

    edge=0: borda próxima da célula da parede; edge=1: borda distante.
    """
    dem = wall_dem()
    x = dem.x0 + (WALL_COL + edge) * PIXEL
    top = dem.to_unit_vectors(np.array(x), np.array(0.0)) * (R + WALL_HEIGHT)
    v = top - POLE
    return np.degrees(np.arcsin(v @ np.array([0, 0, -1.0]) / np.linalg.norm(v)))


def test_wall_casts_shadow():
    toward_wall = [0, 1, 0]  # +Y do MOON_ME aponta para +X do mapa
    h = wall_horizon_deg()  # ~7°
    dark = pole_pixel_fraction(wall_dem(), sun_at(POLE, h - 1.0, toward_wall))
    lit = pole_pixel_fraction(wall_dem(), sun_at(POLE, h + 1.0, toward_wall))
    assert dark.fraction.item() == 0.0
    assert lit.fraction.item() == 1.0
    # o raio amostra algum ponto dentro da célula de 80 m da parede
    assert wall_horizon_deg(edge=1) <= dark.horizon_deg.item() <= h


def test_wall_behind_does_not_shadow():
    away_from_wall = [0, -1, 0]
    res = pole_pixel_fraction(wall_dem(), sun_at(POLE, 2.0, away_from_wall))
    assert res.fraction.item() == 1.0


def test_whole_map_shadow_geometry():
    """No mapa todo: com o Sol baixo atrás da parede, a sombra começa logo após ela."""
    dem = wall_dem()
    res = illumination.compute_illumination(dem, dem, sun_at(POLE, 3.0, [0, -1, 0]))
    row = res.fraction[HALF]
    assert row[WALL_COL + 1] == 0.0  # imediatamente a leste da parede: sombra
    assert row[WALL_COL - 1] == 1.0  # face iluminada a oeste
    assert row[HALF] == 1.0  # polo, longe do lado sombreado


def test_crop_shape_is_stable_under_float_noise():
    dem = flat_dem()
    assert dem.crop(6e-11, -3e-11, 4000.0).shape == dem.crop(0.0, 0.0, 4000.0).shape == (100, 100)


def test_chunking_does_not_change_result():
    dem = wall_dem()
    area = dem.crop(4000.0, 0.0, 2000.0)
    sun = sun_at(POLE, 4.0, [0, 1, 0])
    a = illumination.compute_illumination(area, dem, sun)
    b = illumination.compute_illumination(area, dem, sun, chunk_size=97)
    np.testing.assert_array_equal(a.fraction, b.fraction)


# --- DEM real (opcional) -----------------------------------------------------------
@pytest.mark.skipif(not terrain.DEFAULT_DEM.exists(), reason="DEM LOLA não baixado")
def test_real_dem_loads():
    dem = terrain.load_dem(downsample=8)
    assert dem.radius == pytest.approx(R)
    assert dem.pixel == pytest.approx(640.0)
    valid = dem.heights[dem.heights > terrain.NODATA_HEIGHT]
    assert -12_000 < valid.min() < valid.max() < 12_000  # metros
    lat, _ = dem.lat_lon()
    rows, cols = dem.shape
    assert lat.min() < -89.9  # o polo está no centro
    assert lat[rows // 2, 0] == pytest.approx(-80.0, abs=0.1)  # meio da borda: 80°S
    assert lat.max() == pytest.approx(-75.9, abs=0.1)  # cantos do quadrado
