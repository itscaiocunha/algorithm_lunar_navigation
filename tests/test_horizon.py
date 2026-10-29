"""Mapa de horizontes: deve reproduzir o motor direto (illumination.compute_illumination)."""

import numpy as np
import pytest

from lunar_navigator import horizon, illumination
from tests.test_illumination import POLE, sun_at, wall_dem


def build_horizon_map(area, terrain, n_azimuths):
    points = area.surface_points().reshape(-1, 3)
    up, north, east = horizon.local_basis(points)
    limit = horizon.elevation_limit(up)
    layers = []
    for az in np.arange(n_azimuths) * 360.0 / n_azimuths:
        a = np.radians(az)
        h = horizon.march_azimuth(points, up, np.cos(a) * north + np.sin(a) * east, terrain, limit)
        layers.append(np.degrees(h).astype(np.float16))
    return horizon.HorizonMap(area, np.stack(layers))


def test_local_basis_is_orthonormal():
    pts = np.array([[1000.0, 2000.0, -1_737_000.0], [5e4, -3e4, -1.73e6]])
    up, north, east = horizon.local_basis(pts)
    for a, b in [(up, north), (up, east), (north, east)]:
        np.testing.assert_allclose(np.einsum("ij,ij->i", a, b), 0, atol=1e-12)
    # leste = norte × zênite (mesma convenção de ephemeris.py: azimute horário a partir do Norte)
    np.testing.assert_allclose(np.cross(north, up), east)


def test_sun_angles_match_solar_convention():
    """Azimute/elevação do HorizonMap batem com o pipeline topocêntrico do ephemeris.py."""
    from lunar_navigator import ephemeris

    dem = wall_dem()
    area = dem.crop(3000.0, -2000.0, 200.0)
    hmap = horizon.HorizonMap(area, np.zeros((4, area.heights.size), np.float16))
    sun = sun_at(POLE, 1.3, [0.6, 0.8, 0])
    elev, az, _ = hmap.sun_angles(sun)
    point = hmap.geometry()[0][0]
    e_ref, az_ref = ephemeris.topocentric_angles(sun - point, point)
    assert np.degrees(elev[0]) == pytest.approx(e_ref, abs=1e-9)
    assert np.degrees(az[0]) == pytest.approx(az_ref, abs=1e-6)


def low_wall_dem():
    """Parede de 150 m a 8 km: horizonte ~0,94° visto do polo (dentro do teto de ~1,9°)."""
    dem = wall_dem()
    dem.heights = np.where(dem.heights > 0, 150.0, 0.0)
    return dem


@pytest.fixture(scope="module")
def wall_case():
    dem = low_wall_dem()
    area = dem.crop(0.0, 0.0, 800.0)
    return dem, area, build_horizon_map(area, dem, n_azimuths=180)


@pytest.mark.parametrize("elev", [-0.5, 0.0, 0.5, 0.9, 1.0, 1.5])
def test_matches_direct_engine(wall_case, elev):
    """Fração do disco pelo mapa de horizontes (180 azimutes) ≈ ray-casting direto."""
    dem, area, hmap = wall_case
    sun = sun_at(POLE, elev, [0, 1, 0])  # Sol na direção da parede (+Y MOON_ME = +X do mapa)
    direct = illumination.compute_illumination(area, dem, sun).fraction
    fast = hmap.illumination(sun)
    assert np.mean(np.abs(fast - direct) < 0.05) > 0.98
    assert np.abs(fast - direct).max() < 0.25


def test_horizon_limit_covers_sun_and_earth():
    """O teto padrão do cache cobre a Terra (libração ±7,1° + disco ≤ 1,03°), e portanto o Sol."""
    up = np.array([[0.0, 0.0, -1.0]])  # polo: colatitude 0
    assert np.degrees(horizon.elevation_limit(up, horizon.SUN_LIMIT_DEG)[0]) == pytest.approx(1.9)
    earth_limit = np.degrees(horizon.elevation_limit(up)[0])
    assert earth_limit == pytest.approx(horizon.EARTH_LIMIT_DEG)
    assert earth_limit >= 7.10 + 1.03  # extremos medidos com SPICE (2026–2035)


def test_sun_only_cache_would_hide_earth_occlusion():
    """Regressão: com teto do Sol, uma parede de 5° vira ~1,9° e a Terra a 4° pareceria visível."""
    dem = low_wall_dem()
    dem.heights = np.where(dem.heights > 0, 830.0, 0.0)  # ~5,8° de horizonte a 8 km
    area = dem.crop(0.0, 0.0, 40.0)
    pts = area.surface_points().reshape(-1, 3)
    up, north, east = horizon.local_basis(pts)
    direction = np.cos(np.pi / 2) * north + np.sin(np.pi / 2) * east  # leste = rumo à parede
    cut = np.degrees(horizon.march_azimuth(pts, up, direction, dem, horizon.elevation_limit(up, horizon.SUN_LIMIT_DEG)))
    full = np.degrees(horizon.march_azimuth(pts, up, direction, dem, horizon.elevation_limit(up)))
    assert cut[0] == pytest.approx(1.9, abs=0.01)  # cortado
    assert full[0] > 5.0  # horizonte real, acima da Terra a 4°


def thick_wall_dem(height=830.0, width_px=3):
    """Parede de `width_px` pixels a ~8 km do polo: horizonte ~5,8° (alto o bastante para ocultar a Terra)."""
    from tests.test_illumination import WALL_COL

    dem = wall_dem()
    dem.heights = np.zeros_like(dem.heights)
    dem.heights[:, WALL_COL:WALL_COL + width_px] = height
    return dem


def earth_toward_wall(elev):
    """Terra a 384 000 km, na elevação dada, na direção da parede (+Y MOON_ME)."""
    return POLE + (sun_at(POLE, elev, [0, 1, 0]) - POLE) / 1.496e11 * 3.84e8


@pytest.mark.parametrize("elev", [3.0, 5.0, 5.8, 6.5, 7.5])
def test_earth_disk_matches_direct_engine(elev):
    """Terra alta (até 7,5°) atrás de uma parede de ~5,8°: horizontes com teto da Terra ≡ motor direto."""
    from lunar_navigator.ephemeris import EARTH_RADIUS_M

    dem = thick_wall_dem()
    area = dem.crop(0.0, 0.0, 400.0)
    hmap = build_horizon_map(area, dem, n_azimuths=180)
    earth = earth_toward_wall(elev)
    direct = illumination.compute_illumination(area, dem, earth, EARTH_RADIUS_M).fraction
    fast = hmap.earth_visibility(earth)
    assert np.mean(np.abs(fast - direct) < 0.05) > 0.98
    assert np.abs(fast - direct).max() < 0.25


def test_known_limitation_thin_distant_wall_can_be_skipped():
    """Limitação documentada: a partir de ~8 km o passo (1% da distância) passa de 80 m e uma
    parede de 1 pixel pode ser pulada. Com passo menor (growth) o raio volta a encontrá-la."""
    from lunar_navigator.ephemeris import EARTH_RADIUS_M

    dem = thick_wall_dem(width_px=1)
    area = dem.crop(0.0, 0.0, 400.0)
    earth = earth_toward_wall(5.8)
    coarse = illumination.compute_illumination(area, dem, earth, EARTH_RADIUS_M, growth=0.01).fraction
    fine = illumination.compute_illumination(area, dem, earth, EARTH_RADIUS_M, growth=0.002).fraction
    assert coarse.max() == 1.0  # algum raio pulou a parede
    assert fine.max() < 0.7  # passo fino: a parede oculta parte do disco em todos os pixels (nenhum vê 100%)
