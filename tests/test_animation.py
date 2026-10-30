"""Endpoints da animação: quadro compacto (/api/map/frame) e série de efemérides (/api/ephemeris)."""

import base64
from datetime import datetime, timedelta

import numpy as np
import pytest
from fastapi.testclient import TestClient

from lunar_navigator import config
from lunar_navigator.api import app

pytestmark = pytest.mark.skipif(not config.DEM_PATH.exists(), reason="DEM LOLA não baixado")
UTC = "2026-11-20T00:00:00Z"
SITE = {"lat": -89.45, "lon": -137.1}  # Connecting Ridge


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        if not c.get("/api/info").json()["horizon_cache"]:
            pytest.skip("cache de horizontes ausente (modo rápido indisponível)")
        yield c


def test_frame_preserves_states_of_full_map(client):
    """Nibbles de 4 bits arredondados para cima: os estados por pixel são os da física (f > 0).

    Compara com as frações cruas: o uint8 de /api/map arredonda para o mais próximo e zera
    frações < 1/510 (~0,04% dos pixels), que para link.states ainda são "visível".
    """
    from lunar_navigator.api import state

    r = client.get("/api/map/frame", params={"utc": UTC})
    assert r.status_code == 200
    rows, cols = map(int, r.headers["X-Shape"].split(","))
    frame = np.frombuffer(r.content, dtype=np.uint8).reshape(rows, cols)
    raw = state["service"].compute_map(UTC, "rapido")
    assert (rows, cols) == raw.sun.shape
    np.testing.assert_array_equal(frame >> 4 > 0, raw.sun > 0)
    np.testing.assert_array_equal(frame & 15 > 0, raw.earth > 0)
    np.testing.assert_array_equal(frame >> 4 == 15, raw.sun > 14 / 15)
    assert np.abs((frame >> 4) / 15 - raw.sun).max() <= 1 / 15 + 1e-9
    m = client.get("/api/map", params={"utc": UTC, "modo": "rapido"}).json()
    assert r.headers["X-Utc"] == m["utc"]
    sun = np.frombuffer(base64.b64decode(m["sun_fraction_b64"]), np.uint8).reshape(m["shape"])
    assert np.mean((frame >> 4 > 0) != (sun > 0)) < 1e-3  # só as frações minúsculas divergem


def test_frame_is_gzipped_but_png_tiles_are_not(client):
    """Deploy remoto: o quadro trafega comprimido (~8×); PNG já comprimido passa direto."""
    r = client.get("/api/map/frame", params={"utc": UTC}, headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip"
    assert int(r.headers["content-length"]) < len(r.content) / 4  # bytes no fio vs. decodificados
    t = client.get("/api/tiles/0/0/0/relief.png", headers={"Accept-Encoding": "gzip"})
    assert t.status_code == 200 and "content-encoding" not in t.headers


def test_ephemeris_center_matches_map_payload(client):
    e = client.get("/api/ephemeris", params={"start": UTC, "hours": 24, "step_min": 60}).json()
    assert e["n"] == 25 and e["step_s"] == 3600
    m = client.get("/api/map", params={"utc": UTC, "modo": "rapido"}).json()
    for body in ("sun", "earth"):
        c = e["center"][body]
        assert len(c["elevation_deg"]) == 25
        assert c["elevation_deg"][0] == pytest.approx(m[body]["elevation_deg"], abs=1e-3)
        dx, dy = m[body]["map_dir"]
        assert c["map_az_deg"][0] == pytest.approx(np.degrees(np.arctan2(dx, dy)) % 360, abs=0.05)
    # o Sol dá uma volta no céu por dia lunar: ~0,5°/h em azimute, quase sem mudar de elevação
    az = np.unwrap(np.radians(e["center"]["sun"]["map_az_deg"]))
    assert abs(np.degrees(az[-1] - az[0])) == pytest.approx(24 * 360 / (29.53 * 24), rel=0.1)


def test_point_margins_agree_with_countdown(client):
    """O sinal da margem no pixel é o estado do countdown, e a troca de sinal cai no evento da bisseção."""
    cd = client.get("/api/countdown", params={"utc": UTC, **SITE}).json()
    e = client.get("/api/ephemeris", params={"start": UTC, "hours": 24 * 30, "step_min": 30, **SITE}).json()
    p = e["point"]
    for body in ("sun", "earth"):
        margin = np.array(p[body]["margin_deg"])
        assert (margin[0] > 0) == (cd[body]["state"] != "hidden")
        main = cd[body]
        if main["event"] in ("sunset", "sunrise", "los", "aos"):
            flip = int(np.flatnonzero((margin[1:] > 0) != (margin[:-1] > 0))[0])
            t_flip = flip * e["step_s"]
            # o perfil é interpolado a cada 2° de azimute; o motor exato pode deslocar o evento algumas horas
            assert abs(t_flip - main["seconds"]) <= 6 * 3600, body
    assert p["x_m"] == pytest.approx(cd["x_m"]) and p["y_m"] == pytest.approx(cd["y_m"])
    assert len(p["earth"]["margin_full_deg"]) == e["n"]


LOS_SITE = {"lat": -89.0107, "lon": 53.13}  # na área de ±30 km: AOS e depois LOS na semana de 20/11/2026


def test_window_events_are_the_countdown_bisection(client):
    """Todos os eventos da janela; o LOS bate com o countdown pedido de dentro da janela (mesma bisseção)."""
    import time

    t0 = time.perf_counter()
    e = client.get("/api/ephemeris", params={"start": UTC, "hours": 168, "step_min": 30, **LOS_SITE}).json()
    elapsed = time.perf_counter() - t0
    ev = e["point"]["earth"]["events"]
    kinds = [x["event"] for x in ev if x["event"] in ("aos", "los")]
    assert kinds[:2] == ["aos", "los"]  # começa oculta: nasce e depois se põe na mesma semana
    assert all(x["exact"] for x in ev)
    aos = next(x for x in ev if x["event"] == "aos")
    los = next(x for x in ev if x["event"] == "los")
    # countdown pedido 1 h depois do AOS: o próximo evento principal é o LOS
    start = datetime.fromisoformat(UTC.replace("Z", "+00:00"))
    later = start + timedelta(seconds=aos["seconds"] + 3600)
    cd = client.get("/api/countdown", params={"utc": later.strftime("%Y-%m-%dT%H:%M:%SZ"), **LOS_SITE}).json()
    assert cd["earth"]["event"] == "los"
    assert cd["earth"]["seconds"] + aos["seconds"] + 3600 == pytest.approx(los["seconds"], abs=30)
    # estados alternam: margem do perfil antes/depois de cada evento
    m = np.array(e["point"]["earth"]["margin_deg"])
    assert m[0] < 0 and m[int(aos["seconds"] // e["step_s"]) + 4] > 0
    assert elapsed < 10


def test_point_horizon_constant_for_fixed_direction(client):
    """Margem = elevação − horizonte + raio (consistência interna da série)."""
    e = client.get("/api/ephemeris", params={"start": UTC, "hours": 6, "step_min": 60, **SITE}).json()
    s = e["point"]["sun"]
    for el, hor, vis, full in zip(s["elevation_deg"], s["horizon_deg"], s["margin_deg"], s["margin_full_deg"], strict=True):
        assert vis - full == pytest.approx(2 * 0.2666, abs=0.01)  # diâmetro do disco solar
        assert (vis + full) / 2 == pytest.approx(el - hor, abs=2e-4)


@pytest.mark.parametrize("params", [
    {"start": UTC, "hours": 2000},
    {"start": UTC, "step_min": 1},
    {"start": "ontem"},
    {"start": UTC, "lat": -70, "lon": 0},
])
def test_ephemeris_rejects_bad_input(client, params):
    assert client.get("/api/ephemeris", params=params).status_code == 422


def test_frames_for_a_week_are_fast(client):
    """O motor de buffer pede ~1 quadro a cada 0,3 s: o servidor tem de acompanhar."""
    import time

    t0 = time.perf_counter()
    start = datetime(2026, 11, 21)
    for k in range(4):
        utc = (start + timedelta(hours=4 * k)).strftime("%Y-%m-%dT%H:%M:%SZ")
        assert client.get("/api/map/frame", params={"utc": utc}).status_code == 200
    assert (time.perf_counter() - t0) / 4 < 1.5
