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
    # leste = norte × zênite (mesma convenção de solar.py: azimute horário a partir do Norte)
    np.testing.assert_allclose(np.cross(north, up), east)


def test_sun_angles_match_solar_convention():
    """Azimute/elevação do HorizonMap batem com o pipeline topocêntrico do solar.py."""
    from lunar_navigator import solar

    dem = wall_dem()
    area = dem.crop(3000.0, -2000.0, 200.0)
    hmap = horizon.HorizonMap(area, np.zeros((4, area.heights.size), np.float16))
    sun = sun_at(POLE, 1.3, [0.6, 0.8, 0])
    elev, az, _ = hmap.sun_angles(sun)
    point = hmap.geometry()[0][0]
    e_ref, az_ref = solar.topocentric_angles(sun - point, point)
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


def test_horizon_limit_never_hides_reachable_sun():
    """Horizontes são cortados no teto; Sol abaixo do teto deve ser calculado normalmente."""
    up = np.array([[0.0, 0.0, -1.0]])
    lim = horizon.elevation_limit(up)
    assert np.degrees(lim[0]) == pytest.approx(horizon.MAX_SUN_DECLINATION_DEG + horizon.SUN_DISK_MARGIN_DEG)
