"""Contagem regressiva: varredura + bisseção, refinamento exato e consistência com o motor direto."""

import numpy as np
import pytest
from fastapi.testclient import TestClient

from lunar_navigator import config, countdown, ephemeris, illumination
from lunar_navigator.api import app

HOUR = 3600.0


# --- Busca de raízes (sem SPICE) ---------------------------------------------------
def test_bisection_finds_root_within_tolerance():
    ets = np.arange(0, 48) * HOUR
    root = 7.3 * HOUR
    fn = lambda t: root - t  # noqa: E731  positivo -> negativo (ex.: pôr do Sol)
    t_ev, exact = countdown._find_crossing(ets, fn(ets), fn)
    assert t_ev == pytest.approx(root, abs=countdown.XTOL_S)
    assert exact is False


def test_no_crossing_returns_none():
    ets = np.arange(0, 48) * HOUR
    assert countdown._find_crossing(ets, np.ones(48), lambda t: 1.0) is None


def test_exact_engine_corrects_profile_outside_window():
    """O perfil vê a troca às 7,3 h, mas o motor exato (relevo denteado) a coloca às 9,6 h:
    a janela se expande e a raiz final segue o motor exato."""
    ets = np.arange(0, 48) * HOUR
    profile = lambda t: 7.3 * HOUR - t  # noqa: E731
    exact = lambda t: 9.6 * HOUR - t  # noqa: E731
    t_ev, confirmed = countdown._find_crossing(ets, profile(ets), profile, exact)
    assert confirmed is True
    assert t_ev == pytest.approx(9.6 * HOUR, abs=countdown.XTOL_S)


def test_falls_back_to_profile_when_exact_disagrees_far_away():
    ets = np.arange(0, 48) * HOUR
    profile = lambda t: 7.3 * HOUR - t  # noqa: E731
    exact = lambda t: 40 * HOUR - t  # noqa: E731  troca a 33 h de distância: fora de ±6 h
    t_ev, confirmed = countdown._find_crossing(ets, profile(ets), profile, exact)
    assert confirmed is False
    assert t_ev == pytest.approx(7.3 * HOUR, abs=countdown.XTOL_S)


# --- Dados reais -------------------------------------------------------------------
needs_dem = pytest.mark.skipif(not config.DEM_PATH.exists(), reason="DEM LOLA não baixado")
UTC = "2026-11-20T00:00:00Z"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@needs_dem
def test_pixel_profile_matches_cached_horizon_map(client):
    """O perfil sob demanda de um pixel reproduz a linha do cache de horizontes (mesma marcha)."""
    from lunar_navigator.api import state

    svc = state["service"]
    if svc.hmap is None:
        pytest.skip("cache de horizontes ainda não gerado")
    r, c = 400, 300
    ph = countdown.PixelHorizon.compute(svc.dem, svc.area.surface_points()[r, c])
    cached = svc.hmap.horizon_deg[:, r * svc.area.shape[1] + c].astype(float)
    np.testing.assert_allclose(ph.horizon_deg, cached, atol=0.01)  # float16 no cache


@needs_dem
@pytest.mark.parametrize("lat, lon", [(-89.9, 0.0), (-89.6, 60.0)])
def test_events_flip_state_in_direct_engine(client, lat, lon):
    """Validação independente: o estado (pelo ray-casting direto) muda entre −2 min e +2 min de cada evento."""
    from lunar_navigator.api import state

    svc = state["service"]
    d = client.get("/api/countdown", params={"utc": UTC, "lat": lat, "lon": lon}).json()
    pixel = svc.latlon_to_pixel(lat, lon)
    et0 = ephemeris.utc_to_et(UTC.rstrip("Z"))
    checked = 0
    for body, target, radius in (("sun", "SUN", ephemeris.SUN_RADIUS_M), ("earth", "EARTH", ephemeris.EARTH_RADIUS_M)):
        for ev in d[body]["events"]:
            if ev["event"] not in ("sunset", "sunrise", "los", "aos"):
                continue
            assert ev["exact"] is True
            f = [illumination.compute_illumination(pixel, svc.dem, ephemeris.body_position_m(et0 + ev["seconds"] + dt, target),
                                                   radius).fraction.item() for dt in (-120, 120)]
            assert (f[0] > 0) != (f[1] > 0), (body, ev)
            checked += 1
    assert checked >= 2


@needs_dem
def test_countdown_endpoint_shape(client):
    r = client.get("/api/countdown", params={"utc": UTC, "lat": -89.6, "lon": 60.0})
    assert r.status_code == 200
    d = r.json()
    assert d["sun"]["event"] in {"sunset", "sunrise", None}
    assert d["earth"]["event"] in {"los", "aos", "degradation", "full_signal", None}
    assert d["sun"]["uncertainty_min"] < d["earth"]["uncertainty_min"]  # a Terra se move mais devagar
    for body in ("sun", "earth"):
        secs = [e["seconds"] for e in d[body]["events"]]
        assert secs == sorted(secs) and all(s > 0 for s in secs)
    if d["golden"]:
        ends = [d[b]["seconds"] for b in ("sun", "earth") if d[b]["event"] in ("sunset", "los")]
        assert d["golden_ends_seconds"] == min(ends)


@needs_dem
def test_earth_in_full_view_reports_los_after_degradation(client):
    d = client.get("/api/countdown", params={"utc": UTC, "lat": -89.4512, "lon": -137.14}).json()
    e = d["earth"]
    assert e["state"] == "full"
    names = [x["event"] for x in e["events"]]
    assert names[:2] == ["degradation", "los"]  # primeiro perde a banda larga, depois o sinal
    assert e["event"] == "los"  # o evento crítico para o rádio é a perda total


@needs_dem
def test_countdown_rejects_bad_input(client):
    assert client.get("/api/countdown", params={"utc": "ontem", "lat": -89.6, "lon": 0}).status_code == 422
