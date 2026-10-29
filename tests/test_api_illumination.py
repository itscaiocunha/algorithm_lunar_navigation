"""Testes dos endpoints /api/* (requerem DEM e kernels; pulados se ausentes)."""

import base64

import numpy as np
import pytest
from fastapi.testclient import TestClient
from rasterio.io import MemoryFile

from lunar_navigator import config, ephemeris
from lunar_navigator.api import app
from lunar_navigator.terrain import DEM

pytestmark = pytest.mark.skipif(not config.DEM_PATH.exists(), reason="DEM LOLA não baixado")
UTC = "2026-11-14T12:00:00Z"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:  # `with` executa o lifespan (carrega kernels e DEM)
        yield c


def pixel_latlon(p):
    """Lat/lon do centro do pixel em que a API encaixou o ponto."""
    u = DEM(np.zeros((1, 1)), 0, 0, 80.0, 1_737_400.0).to_unit_vectors(np.array(p["x_m"]), np.array(p["y_m"]))
    return np.degrees(np.arcsin(u[2])), np.degrees(np.arctan2(u[1], u[0]))


def decode_fraction(b64, shape):
    return np.frombuffer(base64.b64decode(b64), dtype=np.uint8).reshape(shape) / 255.0


def test_info(client):
    info = client.get("/api/info").json()
    assert info["pixel_m"] == 80.0
    assert info["area_shape"] == [750, 750]
    assert info["kernels_loaded"] == 6
    assert info["horizon_limit_deg"] >= 8.13  # cobre a Terra


@pytest.mark.parametrize("body, geometry", [("sun", ephemeris.sun_geometry), ("earth", ephemeris.earth_geometry)])
def test_point_matches_ephemeris(client, body, geometry):
    """Elevação/azimute do Sol e da Terra no ponto batem com o pipeline SPICE (ephemeris.py)."""
    p = client.get("/api/illumination", params={"utc": UTC, "lat": -89.9, "lon": 0.0}).json()
    # A API encaixa o ponto no centro do pixel de 80 m; a 3 km do polo isso muda a longitude
    # em ~1°. Comparamos exatamente nesse centro (a altitude do pixel muda < 0,001°).
    ref = geometry("2026-11-14 12:00:00 UTC", *pixel_latlon(p))
    b = p[body]
    assert 0.0 <= b["fraction"] <= 1.0
    assert b["elevation_deg"] == pytest.approx(ref.elevation_deg, abs=2e-3)
    assert b["azimuth_deg"] == pytest.approx(ref.azimuth_deg, abs=0.01)
    assert b["angular_radius_deg"] == pytest.approx(ref.angular_radius_deg, abs=1e-3)


def test_point_engineering_fields(client):
    p = client.get("/api/illumination", params={"utc": UTC, "lat": -89.5, "lon": 120.0}).json()
    assert 1.18 < p["earth"]["light_time_s"] < 1.37  # atraso de sinal Terra-Lua
    assert 0.89 < p["earth"]["angular_radius_deg"] < 1.03  # disco de ~1,8–2,05°
    assert p["earth"]["level"] in {"banda_larga", "degradado", "emergencia", "los"}
    assert p["sun"]["level"] in {"nominal", "parcial", "sem_energia"}
    assert p["golden"] == (p["sun"]["fraction"] > 0 and p["earth"]["fraction"] > 0)
    assert "·" in p["status"]


@pytest.mark.parametrize("params, msg", [
    ({"utc": "ontem", "lat": -89.9, "lon": 0}, "Data inválida"),
    ({"utc": UTC, "lat": -80.2, "lon": 0}, "fora do DEM"),
])
def test_point_invalid_input(client, params, msg):
    r = client.get("/api/illumination", params=params)
    assert r.status_code == 422
    assert msg in r.json()["detail"]


def test_map_png_small_area(client):
    r = client.get("/api/map", params={"utc": UTC, "half_size_km": 2})
    assert r.status_code == 200
    m = r.json()
    assert m["mode"] == "completo" and m["pixels"] == 50 * 50
    assert base64.b64decode(m["image"].split(",", 1)[1])[:8] == b"\x89PNG\r\n\x1a\n"
    assert m["bounds"]["x_max"] - m["bounds"]["x_min"] == pytest.approx(4000)
    for body, max_elev in (("sun", 2.0), ("earth", 8.2)):
        dx, dy = m[body]["map_dir"]
        assert dx**2 + dy**2 == pytest.approx(1.0)
        assert abs(m[body]["elevation_deg"]) < max_elev
    s = m["stats"]
    # os quatro estados lógicos particionam a área
    assert s["golden_pct"] + s["power_only_pct"] + s["comms_only_pct"] + s["none_pct"] == pytest.approx(100, abs=0.05)
    sun = decode_fraction(m["sun_fraction_b64"], m["shape"])
    earth = decode_fraction(m["earth_fraction_b64"], m["shape"])
    assert 100 * np.mean((sun > 0) & (earth > 0)) == pytest.approx(s["golden_pct"], abs=0.05)


def test_earth_sits_near_meridian_zero(client):
    """Libração em longitude é ±8°: vista do polo, a Terra fica sempre perto da direção +Y do mapa (lon 0°)."""
    m = client.get("/api/map", params={"utc": UTC, "half_size_km": 2}).json()
    dx, dy = m["earth"]["map_dir"]
    assert np.degrees(abs(np.arctan2(dx, dy))) < 9.0
    assert 1.18 < m["earth"]["light_time_s"] < 1.37


def test_sun_direction_matches_point_azimuth(client):
    """map_dir no polo deve apontar para o mesmo azimute que o ray-casting de um ponto vizinho."""
    m = client.get("/api/map", params={"utc": UTC, "half_size_km": 2}).json()
    dx, dy = m["sun"]["map_dir"]
    # num ponto sobre o meridiano 0° (eixo +Y do mapa), o norte local aponta para longe do
    # polo (+Y) e o leste para +X; logo a direção do Sol no mapa é (sen az, cos az)
    p = client.get("/api/illumination", params={"utc": UTC, "lat": -89.5, "lon": 0.0}).json()
    az = np.radians(p["sun"]["azimuth_deg"])
    assert dx == pytest.approx(np.sin(az), abs=0.02)
    assert dy == pytest.approx(np.cos(az), abs=0.02)


def test_terrain(client):
    t = client.get("/api/terrain", params={"step": 3}).json()
    assert t["shape"] == [250, 250]
    heights = np.frombuffer(base64.b64decode(t["heights_b64"]), dtype="<f4").reshape(t["shape"])
    assert heights.min() == pytest.approx(t["min_m"], abs=0.1)
    assert heights.max() == pytest.approx(t["max_m"], abs=0.1)
    assert -6000 < t["min_m"] < t["max_m"] < 6000


def test_map_geotiff(client):
    r = client.get("/api/map", params={"utc": UTC, "half_size_km": 2, "formato": "geotiff"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/tiff"
    with MemoryFile(r.content) as mem, mem.open() as ds:
        assert ds.count == 3
        assert ds.descriptions == ("sun_fraction", "earth_fraction", "golden_zone")
        sun, earth, golden = ds.read()
        assert sun.shape == (50, 50)
        assert ds.crs.to_dict()["proj"] == "stere"
        np.testing.assert_array_equal(golden == 1, (sun > 0) & (earth > 0))


def test_map_fast_mode_matches_full(client):
    if not client.get("/api/info").json()["horizon_cache"]:
        pytest.skip("cache de horizontes ainda não gerado")
    fast = client.get("/api/map", params={"utc": UTC, "modo": "rapido"}).json()
    full = client.get("/api/map", params={"utc": UTC, "modo": "completo"}).json()
    for key in ("lit_pct", "earth_visible_pct", "golden_pct"):
        assert abs(fast["stats"][key] - full["stats"][key]) < 1.0, key
    assert fast["elapsed_s"] < 2.0


def test_basemap(client):
    b = client.get("/api/basemap").json()
    assert b["image"].startswith("data:image/png;base64,")
    assert b["shape"] == [750, 750]


@pytest.mark.parametrize("metric", ["score", "golden_window", "golden_pct", "illumination_pct", "earth_pct"])
def test_annual(client, metric):
    r = client.get("/api/annual", params={"year": 2027, "metric": metric})
    if r.status_code == 404:
        assert "Sol + Terra" in r.json()["detail"]
        pytest.skip("análise anual Sol + Terra ainda não gerada")
    a = r.json()
    assert a["metric"]["id"] == metric
    assert len(a["peaks"]) == 10
    scores = [p["score"] for p in a["peaks"]]
    assert scores == sorted(scores, reverse=True)  # ordenados pela pontuação composta
    assert a["stats"]["psr_km2"] > 0


def test_annual_weights_rerank(client):
    if not config.annual_path(2027).exists():
        pytest.skip("análise anual ainda não gerada")
    window_only = client.get("/api/annual", params={"year": 2027, "a": 1, "b": 0, "c": 0}).json()
    windows = [p["longest_golden_h"] for p in window_only["peaks"]]
    assert windows == sorted(windows, reverse=True)  # A=1, B=C=0 reproduz o ranking só por janela
    balanced = client.get("/api/annual", params={"year": 2027}).json()
    assert balanced["weights"] == {"a": 1.0, "b": 1.0, "c": 1.0}
    assert balanced["peaks"][0]["score"] > 0
    t = balanced["peaks"][0]["score_terms"]
    assert t["window"] + t["golden"] + t["outage"] == pytest.approx(balanced["peaks"][0]["score"], abs=1e-3)


def test_annual_rejects_all_zero_weights(client):
    r = client.get("/api/annual", params={"year": 2027, "a": 0, "b": 0, "c": 0})
    assert r.status_code in (404, 422)
