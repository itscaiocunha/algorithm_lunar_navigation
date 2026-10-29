"""Testes do cálculo de elevação solar (requer kernels em kernels/)."""

import numpy as np
import pytest
import spiceypy as spice

from lunar_navigator import ephemeris

REQUIRED = ["latest_leapseconds.tls", "de440.bsp", "pck00011.tpc",
            "moon_pa_de440_200625.bpc", "moon_de440_250416.tf"]
missing = [n for n in REQUIRED if not (ephemeris.ROOT / "kernels" / n).exists()]
pytestmark = pytest.mark.skipif(bool(missing), reason=f"kernels ausentes: {missing}")

UTC = "2026-11-14 12:00:00 UTC"
SHACKLETON = (-89.9, 0.0)


@pytest.fixture(scope="module", autouse=True)
def kernels():
    spice.kclear()
    ephemeris.load_kernels()
    yield
    spice.kclear()


def test_utc_to_et_matches_j2000_offset():
    # J2000 = 2000-01-01 12:00:00 TDB = 11:58:55.816 UTC
    assert ephemeris.utc_to_et("2000-01-01 11:58:55.816 UTC") == pytest.approx(0.0, abs=1e-3)


def test_surface_point_is_on_moon_radius():
    p = ephemeris.surface_point(*SHACKLETON)
    assert np.linalg.norm(p) == pytest.approx(1737.4)
    assert p[2] == pytest.approx(-1737.4 * np.sin(np.radians(89.9)))


def test_topocentric_matrix_axes():
    p = ephemeris.surface_point(*SHACKLETON)
    m = ephemeris.topocentric_matrix(p)
    np.testing.assert_allclose(m @ m.T, np.eye(3), atol=1e-12)
    np.testing.assert_allclose(m @ spice.vhat(p), [0, 0, 1], atol=1e-12)  # zênite


def test_elevation_matches_angle_to_zenith():
    g = ephemeris.sun_geometry(UTC, *SHACKLETON)
    zenith_angle = np.degrees(spice.vsep(g.observer_position, g.vector))
    assert g.elevation_deg == pytest.approx(90.0 - zenith_angle, abs=1e-9)


@pytest.mark.parametrize("utc", [UTC, "2026-11-28 00:00:00 UTC", "2027-03-01 06:00:00 UTC"])
@pytest.mark.parametrize("lat, lon", [SHACKLETON, (0.0, 0.0), (45.0, -30.0)])
def test_matches_spice_azlcpo(utc, lat, lon):
    """Valida o pipeline manual contra a rotina pronta do CSPICE."""
    g = ephemeris.sun_geometry(utc, lat, lon)
    azl, _ = spice.azlcpo("ELLIPSOID", "SUN", g.et, ephemeris.ABCORR, False, True,
                          g.observer_position, ephemeris.BODY, ephemeris.FRAME)
    assert g.elevation_deg == pytest.approx(np.degrees(azl[2]), abs=1e-9)
    assert g.azimuth_deg == pytest.approx(np.degrees(azl[1]) % 360, abs=1e-6)


def test_polar_sun_stays_near_horizon():
    """No polo sul o Sol nunca sobe muito: obliquidade lunar ~1.5° + 0.1° de colatitude."""
    for day in range(0, 30, 3):
        et = ephemeris.utc_to_et(UTC) + day * spice.spd()
        utc = spice.et2utc(et, "ISOC", 0)
        assert abs(ephemeris.sun_geometry(utc, *SHACKLETON).elevation_deg) < 2.0


# --- Terra (DTE) -----------------------------------------------------------------
@pytest.mark.parametrize("utc", [UTC, "2027-03-01 06:00:00 UTC", "2029-07-15 00:00:00 UTC"])
def test_earth_geometry_ranges(utc):
    g = ephemeris.earth_geometry(utc, *SHACKLETON)
    assert 356_000 < np.linalg.norm(g.vector) < 407_000  # km
    assert 1.18 < g.light_time < 1.37  # atraso do sinal de rádio (LT+S)
    assert 0.89 < g.angular_radius_deg < 1.03  # disco de ~1,8–2,05°
    assert abs(g.elevation_deg) < 7.2  # libração em latitude + 0,1° de colatitude


@pytest.mark.parametrize("lat, lon", [SHACKLETON, (0.0, 0.0), (-45.0, 30.0)])
def test_earth_matches_spice_azlcpo(lat, lon):
    g = ephemeris.earth_geometry(UTC, lat, lon)
    azl, _ = spice.azlcpo("ELLIPSOID", "EARTH", g.et, ephemeris.ABCORR, False, True,
                          g.observer_position, ephemeris.BODY, ephemeris.FRAME)
    assert g.elevation_deg == pytest.approx(np.degrees(azl[2]), abs=1e-9)
    assert g.azimuth_deg == pytest.approx(np.degrees(azl[1]) % 360, abs=1e-6)


def test_earth_hovers_while_sun_circles():
    """Rotação sincronizada: em 1 mês o azimute do Sol dá a volta; o da Terra oscila poucos graus."""
    ets = ephemeris.utc_to_et(UTC) + np.arange(0, 30) * spice.spd()
    sun_az, earth_az = [], []
    for et in ets:
        utc = spice.et2utc(et, "ISOC", 0)
        sun_az.append(ephemeris.sun_geometry(utc, -89.0, 0.0).azimuth_deg)
        earth_az.append(ephemeris.earth_geometry(utc, -89.0, 0.0).azimuth_deg)
    spread = lambda a: np.degrees(np.ptp(np.unwrap(np.radians(a))))  # noqa: E731
    assert spread(sun_az) > 300
    assert spread(earth_az) < 20
