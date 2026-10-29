"""Testes do cálculo de elevação solar (requer kernels em kernels/)."""

import numpy as np
import pytest
import spiceypy as spice

from lunar_navigator import solar

REQUIRED = ["latest_leapseconds.tls", "de440.bsp", "pck00011.tpc",
            "moon_pa_de440_200625.bpc", "moon_de440_250416.tf"]
missing = [n for n in REQUIRED if not (solar.ROOT / "kernels" / n).exists()]
pytestmark = pytest.mark.skipif(bool(missing), reason=f"kernels ausentes: {missing}")

UTC = "2026-11-14 12:00:00 UTC"
SHACKLETON = (-89.9, 0.0)


@pytest.fixture(scope="module", autouse=True)
def kernels():
    spice.kclear()
    solar.load_kernels()
    yield
    spice.kclear()


def test_utc_to_et_matches_j2000_offset():
    # J2000 = 2000-01-01 12:00:00 TDB = 11:58:55.816 UTC
    assert solar.utc_to_et("2000-01-01 11:58:55.816 UTC") == pytest.approx(0.0, abs=1e-3)


def test_surface_point_is_on_moon_radius():
    p = solar.surface_point(*SHACKLETON)
    assert np.linalg.norm(p) == pytest.approx(1737.4)
    assert p[2] == pytest.approx(-1737.4 * np.sin(np.radians(89.9)))


def test_topocentric_matrix_axes():
    p = solar.surface_point(*SHACKLETON)
    m = solar.topocentric_matrix(p)
    np.testing.assert_allclose(m @ m.T, np.eye(3), atol=1e-12)
    np.testing.assert_allclose(m @ spice.vhat(p), [0, 0, 1], atol=1e-12)  # zênite


def test_elevation_matches_angle_to_zenith():
    g = solar.sun_geometry(UTC, *SHACKLETON)
    zenith_angle = np.degrees(spice.vsep(g.observer_position, g.sun_vector))
    assert g.elevation_deg == pytest.approx(90.0 - zenith_angle, abs=1e-9)


@pytest.mark.parametrize("utc", [UTC, "2026-11-28 00:00:00 UTC", "2027-03-01 06:00:00 UTC"])
@pytest.mark.parametrize("lat, lon", [SHACKLETON, (0.0, 0.0), (45.0, -30.0)])
def test_matches_spice_azlcpo(utc, lat, lon):
    """Valida o pipeline manual contra a rotina pronta do CSPICE."""
    g = solar.sun_geometry(utc, lat, lon)
    azl, _ = spice.azlcpo("ELLIPSOID", "SUN", g.et, solar.ABCORR, False, True,
                          g.observer_position, solar.BODY, solar.FRAME)
    assert g.elevation_deg == pytest.approx(np.degrees(azl[2]), abs=1e-9)
    assert g.azimuth_deg == pytest.approx(np.degrees(azl[1]) % 360, abs=1e-6)


def test_polar_sun_stays_near_horizon():
    """No polo sul o Sol nunca sobe muito: obliquidade lunar ~1.5° + 0.1° de colatitude."""
    for day in range(0, 30, 3):
        et = solar.utc_to_et(UTC) + day * spice.spd()
        utc = spice.et2utc(et, "ISOC", 0)
        assert abs(solar.sun_geometry(utc, *SHACKLETON).elevation_deg) < 2.0
