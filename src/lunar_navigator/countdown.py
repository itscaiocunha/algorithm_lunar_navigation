"""Contagem regressiva até o próximo evento de visibilidade (Sol e Terra) num pixel.

Função de margem (graus), contínua no tempo:

    f(t) = elevação(t) − horizonte(azimute(t)) ± raio_do_disco(t)

com o sinal + para "alguma parte do disco visível" (nascer/pôr, AOS/LOS) e −
para "disco inteiro visível" (início/fim da degradação de RF). O horizonte é
interpolado linearmente entre azimutes, então f é contínua e a bisseção vale.

Algoritmo (por corpo e por limiar):
  1. varredura grossa a cada `step_s` (1 h) com o PERFIL de horizonte do pixel
     (180 azimutes, interpolado) — barata: SPICE em lote + O(1) por instante;
  2. a primeira troca de sinal isola o evento numa janela de 1 h;
  3. a raiz é refinada com o RAY-CASTING EXATO na direção real do alvo (sem
     interpolação de azimute): a janela é expandida hora a hora (até ±6 h) até o
     motor exato confirmar a troca de sinal, e então scipy.optimize.bisect (5 s).

Por que o passo 3: em relevo denteado, a interpolação a cada 2° "apara" entalhes
e picos estreitos; como o Sol desliza ~0,5°/h, isso já errou o nascer em 2,3 h
num teste. O motor exato não tem esse erro.

Por que 1 h é seguro: o Sol anda ~0,51°/h em azimute e o horizonte é amostrado
a cada 2°, então a menor feição resolvida dura ~4 h; a Terra anda < 0,1°/h.

Precisão: a raiz é exata para o modelo, mas o modelo tem incerteza. Perto do
polo o Sol muda de elevação só ~0,003°/h — o pôr acontece pelo deslizamento
lateral (~0,5°/h) atrás do relevo — então 0,05° de erro no horizonte valem
~6 min. A Terra se move ~0,07°/h: o mesmo erro vale ~45 min. Reportamos
segundos, mas a incerteza física é de minutos (Sol) a dezenas de minutos (Terra).
"""

from dataclasses import dataclass

import numpy as np
import spiceypy as spice
from scipy.optimize import bisect

from lunar_navigator import horizon
from lunar_navigator.ephemeris import ABCORR, BODY, EARTH, EARTH_RADIUS_M, FRAME, SUN, SUN_RADIUS_M
from lunar_navigator.terrain import DEM

STEP_S = 3600.0  # varredura grossa
LOOKAHEAD_S = 60 * 86400.0  # ~2 meses sinódicos
XTOL_S = 5.0  # a incerteza física é de minutos; 5 s poupa iterações sem perda real
N_AZIMUTHS = 180
UNCERTAINTY_MIN = {SUN: 6, EARTH: 45}  # incerteza física típica (min) por 0,05° de erro no horizonte


@dataclass
class PixelHorizon:
    """Perfil de horizonte de um único pixel, calculado sob demanda (~0,2 s)."""

    position_m: np.ndarray  # (3,) MOON_ME
    up: np.ndarray
    north: np.ndarray
    east: np.ndarray
    horizon_deg: np.ndarray  # (N_AZIMUTHS,), azimute k·360/N a partir do Norte, horário

    @classmethod
    def compute(cls, terrain: DEM, position_m: np.ndarray, n_azimuths: int = N_AZIMUTHS) -> "PixelHorizon":
        p = position_m.reshape(1, 3)
        up, north, east = (v[0] for v in horizon.local_basis(p))
        az = np.radians(np.arange(n_azimuths) * 360.0 / n_azimuths)
        dirs = np.cos(az)[:, None] * north + np.sin(az)[:, None] * east
        pts = np.repeat(p, n_azimuths, axis=0)
        ups = np.repeat(up[None], n_azimuths, axis=0)
        h = horizon.march_azimuth(pts, ups, dirs, terrain, horizon.elevation_limit(ups))
        return cls(position_m.reshape(3), up, north, east, np.degrees(h))

    def at(self, az_rad: np.ndarray) -> np.ndarray:
        """Horizonte (graus) no azimute dado, interpolação linear periódica."""
        n = len(self.horizon_deg)
        pos = np.mod(az_rad, 2 * np.pi) / (2 * np.pi) * n
        i0 = np.floor(pos).astype(int) % n
        w = pos - np.floor(pos)
        return (1 - w) * self.horizon_deg[i0] + w * self.horizon_deg[(i0 + 1) % n]


def _target_vectors(ets: np.ndarray, observer_km: np.ndarray, target: str) -> np.ndarray:
    """Vetores observador -> alvo (km, MOON_ME), posição aparente LT+S."""
    return np.array([spice.spkcpo(target, et, FRAME, "OBSERVER", ABCORR, observer_km, BODY, FRAME)[0][:3]
                     for et in np.atleast_1d(ets)])


def margins(ets, ph: PixelHorizon, target: str) -> tuple[np.ndarray, np.ndarray]:
    """(margem 'algo visível', margem 'disco inteiro') em graus, para cada instante."""
    v = _target_vectors(ets, ph.position_m / 1000.0, target)
    dist = np.linalg.norm(v, axis=1)
    s = v / dist[:, None]
    elev = np.degrees(np.arcsin(s @ ph.up))
    az = np.arctan2(s @ ph.east, s @ ph.north)
    radius = np.degrees(np.arcsin({SUN: SUN_RADIUS_M, EARTH: EARTH_RADIUS_M}[target] / 1000.0 / dist))
    base = elev - ph.at(az)
    return base + radius, base - radius


MAX_EXPAND_STEPS = 6  # janela de refinamento: até ±6 h em torno da troca vista pelo perfil


def _find_crossing(ets: np.ndarray, values: np.ndarray, fn, exact=None) -> tuple[float, bool] | None:
    """Primeira troca de sinal na varredura (perfil), refinada por bisseção.

    `exact(et) -> float` (só o sinal importa) é o ray-casting exato; sem ele, bisecta o próprio
    perfil. Retorna (ET do evento, confirmado_pelo_motor_exato) ou None.
    """
    positive = values > 0
    change = np.flatnonzero(positive[1:] != positive[:-1])
    if not change.size:
        return None
    k = int(change[0])
    lo, hi = ets[k], ets[k + 1]
    if exact is None:
        return bisect(fn, lo, hi, xtol=XTOL_S), False
    start_positive = bool(positive[0])
    step = ets[1] - ets[0]
    for j in range(MAX_EXPAND_STEPS + 1):
        a, b = max(lo - j * step, ets[0]), hi + j * step
        fa, fb = exact(a), exact(b)
        if (fa > 0) == start_positive and (fb > 0) != start_positive:
            return bisect(exact, a, b, xtol=XTOL_S), True
    return bisect(fn, lo, hi, xtol=XTOL_S), False  # motor exato não confirmou: estimativa do perfil


def body_events(et0: float, ph: PixelHorizon, target: str, step_s: float = STEP_S,
                lookahead_s: float = LOOKAHEAD_S, exact=None) -> dict:
    """Estado atual e próximos eventos de um corpo a partir de et0.

    `exact(et, target) -> (margem_visível, margem_disco_inteiro)` refina as raízes com o ray-casting
    exato (só os sinais são usados).
    """
    ets = et0 + np.arange(0.0, lookahead_s + step_s, step_s)
    vis, full = margins(ets, ph, target)

    def fn_vis(et):
        return float(margins(np.array([et]), ph, target)[0][0])

    def fn_full(et):
        return float(margins(np.array([et]), ph, target)[1][0])

    state = "full" if full[0] > 0 else "partial" if vis[0] > 0 else "hidden"
    events = []
    memo: dict[float, tuple[float, float]] = {}

    def exact_memo(et):  # a expansão da janela reavalia as mesmas pontas
        if et not in memo:
            memo[et] = exact(et, target)
        return memo[et]

    ex_vis = (lambda et: exact_memo(et)[0]) if exact else None
    ex_full = (lambda et: exact_memo(et)[1]) if exact else None
    r_vis = _find_crossing(ets, vis, fn_vis, ex_vis)
    # para o Sol só importa "alguma parte visível" (energia); o limiar de disco inteiro é da Terra (RF)
    r_full = _find_crossing(ets, full, fn_full, ex_full) if target == EARTH else None
    t_vis, t_full = (r[0] if r else None for r in (r_vis, r_full))
    confirmed = {"vis": r_vis[1] if r_vis else None, "full": r_full[1] if r_full else None}
    if target == SUN:
        name_vis = "sunset" if vis[0] > 0 else "sunrise"
        if t_vis is not None:
            events.append((name_vis, t_vis))
    else:
        # Terra: dois limiares — disco inteiro (fim/retorno da banda larga) e qualquer parte (LOS/AOS)
        if t_full is not None:
            events.append(("degradation" if full[0] > 0 else "full_signal", t_full))
        if t_vis is not None:
            events.append(("los" if vis[0] > 0 else "aos", t_vis))
    events.sort(key=lambda e: e[1])
    kind = {"sunset": "vis", "sunrise": "vis", "los": "vis", "aos": "vis", "degradation": "full", "full_signal": "full"}
    out_events = [{"event": name, "seconds": round(et - et0, 1), "utc": spice.et2utc(et, "ISOC", 0) + "Z",
                   "exact": bool(confirmed[kind[name]])} for name, et in events]
    primary = out_events[0] if out_events else None
    if target == EARTH and state != "hidden":
        # para o rádio, o evento crítico é a perda total (LOS), mesmo que a degradação venha antes
        primary = next((e for e in out_events if e["event"] == "los"), primary)
    return {
        "state": state,
        "margin_deg": round(float(vis[0]), 4),
        "event": primary["event"] if primary else None,
        "seconds": primary["seconds"] if primary else None,
        "utc": primary["utc"] if primary else None,
        "events": out_events,
        "searched_days": round(lookahead_s / 86400, 1),
        "uncertainty_min": UNCERTAINTY_MIN[target],
    }


def countdown(et0: float, ph: PixelHorizon, exact=None) -> dict:
    sun = body_events(et0, ph, SUN, exact=exact)
    earth = body_events(et0, ph, EARTH, exact=exact)
    golden = sun["state"] != "hidden" and earth["state"] != "hidden"
    out = {"sun": sun, "earth": earth, "golden": golden}
    if golden:
        ends = [x["seconds"] for x in (sun, earth) if x["seconds"] is not None
                and x["event"] in ("sunset", "los")]
        out["golden_ends_seconds"] = min(ends) if ends else None
    return out
