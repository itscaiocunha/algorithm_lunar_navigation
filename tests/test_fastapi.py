"""Testes da API FastAPI usando o TestClient (sem subir servidor)."""

import pytest
from fastapi.testclient import TestClient

from lunar_navigator.api import app

client = TestClient(app)


def test_root_redirects_to_docs():
    response = client.get("/", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/docs"


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_versions():
    data = client.get("/versions").json()
    assert set(data) == {"python", "numpy", "spiceypy", "cspice_toolkit"}


def test_rect_to_spherical():
    response = client.post(
        "/convert/rect-to-spherical", json={"x": 1.0, "y": 1.0, "z": 0.0}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["radius"] == pytest.approx(2**0.5)
    assert data["colatitude_deg"] == pytest.approx(90.0)
    assert data["longitude_deg"] == pytest.approx(45.0)


def test_validation_error():
    response = client.post("/convert/rect-to-spherical", json={"x": "abc"})
    assert response.status_code == 422
