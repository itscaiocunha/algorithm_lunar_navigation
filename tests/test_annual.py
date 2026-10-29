"""Lógica da análise de longo prazo e dos estados de enlace, com séries sintéticas."""

import numpy as np
import pytest

from lunar_navigator import annual, link


@pytest.fixture
def run_series(monkeypatch):
    """accumulate com frações pré-definidas (instantes × pixels), sem SPICE: o instante i é et = i."""
    monkeypatch.setattr(annual.spice, "et2utc", lambda et, *_: f"t{et:.0f}")

    def run(sun_series, earth_series, step_hours=12.0):
        sun_series, earth_series = np.asarray(sun_series, float), np.asarray(earth_series, float)
        n_t, n_px = sun_series.shape
        monkeypatch.setattr(annual, "time_grid", lambda *_: np.arange(n_t, dtype=float))

        def fractions_at(et):
            i = int(et)
            return sun_series[i].reshape(1, n_px), earth_series[i].reshape(1, n_px)

        return annual.accumulate(fractions_at, (1, n_px), "", "", step_hours)

    return run


def test_runs_track_longest_streak():
    r = annual._Runs((1, 1))
    for v in [1, 1, 0, 1, 1, 1, 0, 1]:
        r.update(np.array([[bool(v)]]))
    assert r.longest[0, 0] == 3


def test_coinciding_windows_beat_more_sunlight(run_series):
    """Pixel A: 60% de Sol, sempre junto com a Terra. Pixel B: 80% de Sol, Terra oculta nos picos de energia."""
    sun_a = [1] * 6 + [0] * 4
    earth_a = [1] * 6 + [0] * 4
    sun_b = [1] * 8 + [0] * 2
    earth_b = [0, 1, 0, 1, 0, 1, 0, 1, 1, 1]  # Terra alterna justamente quando há Sol
    res = run_series(np.array([sun_a, sun_b]).T, np.array([earth_a, earth_b]).T)
    a, b = 0, 1
    assert res.illumination_pct[0, a] == pytest.approx(60)
    assert res.illumination_pct[0, b] == pytest.approx(80)
    assert res.longest_golden_h[0, a] == 6 * 12  # 3 dias contínuos
    assert res.longest_golden_h[0, b] == 1 * 12  # nunca mais que 12 h
    assert res.longest_golden_h[0, a] > res.longest_golden_h[0, b]


def test_metrics_and_psr(run_series):
    sun = [[0.0, 1.0], [0.0, 0.5], [0.0, 0.0], [0.0, 1.0]]
    earth = [[1.0, 0.2], [1.0, 0.0], [0.0, 0.0], [1.0, 1.0]]
    res = run_series(sun, earth)
    assert res.psr[0].tolist() == [True, False]
    assert res.illumination_pct[0, 1] == pytest.approx(100 * 2.5 / 4)
    assert res.any_sun_pct[0, 1] == pytest.approx(75)
    assert res.any_earth_pct[0].tolist() == pytest.approx([75, 50])
    assert res.golden_pct[0].tolist() == pytest.approx([0, 50])
    assert res.longest_night_h[0].tolist() == [48, 12]
    assert res.longest_los_h[0].tolist() == [12, 24]


def test_landing_candidates_ranked_by_golden_window():
    from lunar_navigator.terrain import DEM

    area = DEM(np.zeros((3, 40)), -1600.0, 120.0, 80.0, 1_737_400.0)
    shape = area.shape
    res = annual.AnnualResult(
        illumination_pct=np.full(shape, 90.0), any_sun_pct=np.full(shape, 90.0),
        longest_night_h=np.zeros(shape), psr=np.zeros(shape, bool), earth_pct=np.zeros(shape),
        any_earth_pct=np.zeros(shape), longest_los_h=np.zeros(shape), golden_pct=np.zeros(shape),
        longest_golden_h=np.zeros(shape), n_samples=1, step_hours=12, start_utc="", end_utc="")
    res.illumination_pct[1, 5] = 99.0  # mais Sol, janela curta
    res.longest_golden_h[1, 5] = 24
    res.longest_golden_h[1, 30] = 240  # menos Sol, janela longa
    peaks = annual.landing_candidates(res, area, n_peaks=2)
    assert (peaks[0]["longest_golden_h"], peaks[1]["longest_golden_h"]) == (240, 24)


@pytest.mark.parametrize("fraction, code", [(1.0, "banda_larga"), (0.7, "degradado"), (0.2, "emergencia"), (0.0, "los")])
def test_rf_levels(fraction, code):
    assert link.rf_level(fraction)[0] == code


def test_status_text_and_states():
    assert link.status_text(1.0, 0.45) == "Comms parcial · Energia nominal"
    assert link.status_text(0.0, 0.0) == "Sem comms (LOS) · Sem energia solar"
    st = link.states(np.array([1.0, 1.0, 0.0, 0.0]), np.array([0.3, 0.0, 1.0, 0.0]))
    assert [k for i in range(4) for k, v in st.items() if v[i]] == ["golden", "power_only", "comms_only", "none"]
