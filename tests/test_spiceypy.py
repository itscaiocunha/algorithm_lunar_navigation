"""Testes de sanidade do SpiceyPy (wrapper do CSPICE da NASA/NAIF).

Estes testes não precisam de kernels: usam apenas rotinas matemáticas
e constantes embutidas no toolkit. O último teste confirma que o
tratamento de erros do SPICE funciona (falha esperada sem kernel de tempo).
"""

import numpy as np
import pytest
import spiceypy as spice
from spiceypy.utils.exceptions import SpiceyError


def test_toolkit_version():
    assert spice.tkvrsn("TOOLKIT").startswith("CSPICE")


def test_constants():
    assert spice.pi() == pytest.approx(np.pi)
    assert spice.rpd() == pytest.approx(np.pi / 180)
    assert spice.j2000() == 2451545.0  # Data juliana da época J2000
    assert spice.spd() == 86400.0  # Segundos por dia
    assert spice.clight() == pytest.approx(299792.458)  # km/s


def test_vector_routines():
    v = np.array([3.0, 4.0, 0.0])
    assert spice.vnorm(v) == 5.0
    np.testing.assert_allclose(spice.vhat(v), [0.6, 0.8, 0.0])
    np.testing.assert_allclose(spice.vcrss([1, 0, 0], [0, 1, 0]), [0, 0, 1])


def test_rotation_matches_numpy():
    angle = np.radians(90)
    # spice.rotate devolve a matriz de rotação de *referencial* em torno de Z
    m = spice.rotate(angle, 3)
    rotated = spice.mxv(m, [1.0, 0.0, 0.0])
    np.testing.assert_allclose(rotated, [0.0, -1.0, 0.0], atol=1e-15)


def test_coordinate_conversion_roundtrip():
    rect = np.array([1000.0, 2000.0, 3000.0])
    radius, lon, lat = spice.reclat(rect)
    np.testing.assert_allclose(spice.latrec(radius, lon, lat), rect)


def test_error_without_leapseconds_kernel():
    spice.kclear()
    with pytest.raises(SpiceyError):
        spice.str2et("2026-10-29T12:00:00")
