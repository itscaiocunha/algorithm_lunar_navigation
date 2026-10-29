"""Testes de integração com os kernels reais (pulados se kernels/ não tiver os arquivos)."""

import os
from pathlib import Path

import numpy as np
import pytest
import spiceypy as spice

ROOT = Path(__file__).resolve().parents[1]
META_KERNEL = ROOT / "kernels" / "lunar.tm"
REQUIRED = [
    "latest_leapseconds.tls",
    "de440.bsp",
    "pck00011.tpc",
    "moon_pa_de440_200625.bpc",
    "moon_de440_250416.tf",
]

missing = [name for name in REQUIRED if not (ROOT / "kernels" / name).exists()]
pytestmark = pytest.mark.skipif(bool(missing), reason=f"kernels ausentes: {missing}")


@pytest.fixture(scope="module", autouse=True)
def kernels():
    cwd = os.getcwd()
    os.chdir(ROOT)  # PATH_VALUES do meta-kernel é relativo à raiz
    spice.kclear()
    spice.furnsh(str(META_KERNEL))
    yield
    spice.kclear()
    os.chdir(cwd)


def test_time_conversion_roundtrip():
    et = spice.str2et("2026-10-29T12:00:00")
    assert spice.et2utc(et, "ISOC", 3) == "2026-10-29T12:00:00.000"
    # TDB - UTC = 37 leap seconds + 32.184 s (desde 2017)
    assert spice.deltet(et, "ET") == pytest.approx(69.184, abs=0.01)


def test_earth_moon_sun_ephemeris():
    et = spice.str2et("2026-10-29T12:00:00")
    moon, _ = spice.spkpos("MOON", et, "J2000", "NONE", "EARTH")
    sun, _ = spice.spkpos("SUN", et, "J2000", "NONE", "EARTH")
    assert 356_000 < np.linalg.norm(moon) < 407_000  # perigeu/apogeu lunar (km)
    assert 1.47e8 < np.linalg.norm(sun) < 1.53e8  # ~1 UA (km)


def test_moon_radii():
    radii = spice.bodvrd("MOON", "RADII", 3)[1]
    np.testing.assert_allclose(radii, [1737.4] * 3)


def test_moon_body_fixed_frames():
    et = spice.str2et("2026-10-29T12:00:00")
    for frame in ("MOON_ME", "MOON_PA"):
        rot = spice.pxform("J2000", frame, et)
        np.testing.assert_allclose(rot @ rot.T, np.eye(3), atol=1e-12)
    # A Terra fica aproximadamente na direção +X do frame MOON_ME (face visível)
    earth, _ = spice.spkpos("EARTH", et, "MOON_ME", "NONE", "MOON")
    _, lon, lat = spice.reclat(earth)
    assert abs(np.degrees(lon)) < 10 and abs(np.degrees(lat)) < 10
