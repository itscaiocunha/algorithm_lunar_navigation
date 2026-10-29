"""Testes dos endpoints /api/* (requerem DEM e kernels; pulados se ausentes)."""

import base64

import numpy as np
import pytest
from fastapi.testclient import TestClient
from rasterio.io import MemoryFile

from lunar_navigator import config, solar
from lunar_navigator.api import app
from lunar_navigator.terrain import DEM

pytestmark = pytest.mark.skipif(not config.DEM_PATH.exists(), reason="DEM LOLA não baixado")
UTC = "2026-11-14T12:00:00Z"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:  # `with` executa o lifespan (carrega kernels e DEM)
        yield c


def test_info(client):
    info = client.get("/api/info").json()
    assert info["pixel_m"] == 80.0
    assert info["area_shape"] == [750, 750]
    assert info["kernels_loaded"] == 6


def test_point_matches_solar_pipeline(client):
    r = client.get("/api/illumination", params={"utc": UTC, "lat": -89.9, "lon": 0.0})
    assert r.status_code == 200
    p = r.json()
    assert 0.0 <= p["fraction"] <= 1.0
    assert p["status"] in {"iluminado", "penumbra", "sombra"}
    # A API encaixa o ponto no centro do pixel de 80 m; a 3 km do polo isso muda a longitude
    # em ~1°. Comparamos com o solar.py exatamente nesse centro (a altitude muda < 0,001°).
    u = DEM(np.zeros((1, 1)), 0, 0, 80.0, 1_737_400.0).to_unit_vectors(np.array(p["x_m"]), np.array(p["y_m"]))
    lat, lon = np.degrees(np.arcsin(u[2])), np.degrees(np.arctan2(u[1], u[0]))
    ref = solar.sun_geometry("2026-11-14 12:00:00 UTC", lat, lon)
    assert p["sun_elevation_deg"] == pytest.approx(ref.elevation_deg, abs=1e-3)
    assert p["sun_azimuth_deg"] == pytest.approx(ref.azimuth_deg, abs=0.01)


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
    assert m["image"].startswith("data:image/png;base64,")
    assert base64.b64decode(m["image"].split(",", 1)[1])[:8] == b"\x89PNG\r\n\x1a\n"
    assert m["bounds"]["x_max"] - m["bounds"]["x_min"] == pytest.approx(4000)
    assert 0 <= m["stats"]["lit_pct"] <= 100


def test_map_geotiff(client):
    r = client.get("/api/map", params={"utc": UTC, "half_size_km": 2, "formato": "geotiff"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/tiff"
    with MemoryFile(r.content) as mem, mem.open() as ds:
        band = ds.read(1)
        assert band.shape == (50, 50)
        assert ds.crs.to_dict()["proj"] == "stere"
        assert np.all((band >= 0) & (band <= 1))


def test_map_fast_mode_matches_full(client):
    if not client.get("/api/info").json()["horizon_cache"]:
        pytest.skip("cache de horizontes ainda não gerado")
    fast = client.get("/api/map", params={"utc": UTC, "modo": "rapido"}).json()
    full = client.get("/api/map", params={"utc": UTC, "modo": "completo"}).json()
    assert abs(fast["stats"]["lit_pct"] - full["stats"]["lit_pct"]) < 1.0
    assert fast["elapsed_s"] < 2.0


def test_basemap(client):
    b = client.get("/api/basemap").json()
    assert b["image"].startswith("data:image/png;base64,")
    assert b["shape"] == [750, 750]


def test_annual(client):
    r = client.get("/api/annual", params={"year": 2027})
    if not config.annual_path(2027).exists():
        assert r.status_code == 404
        return
    a = r.json()
    assert len(a["peaks"]) == 10
    assert a["peaks"][0]["illumination_pct"] >= a["peaks"][-1]["illumination_pct"]
    assert a["stats"]["psr_km2"] > 0
