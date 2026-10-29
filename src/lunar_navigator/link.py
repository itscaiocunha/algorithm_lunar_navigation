"""Estados lógicos por pixel: energia (Sol), comunicação direta com a Terra (DTE) e Zona de Ouro.

- Sobrevivência: alguma parte do Sol visível (fração > 0) — gera energia.
- Operação: alguma parte da Terra visível (fração > 0) — enlace DTE possível.
- Zona de Ouro: as duas ao mesmo tempo.

Níveis de enlace por fração visível do disco da Terra (HEURÍSTICOS, ilustrativos):
a fração do disco é um indicador de quanto o relevo "morde" a linha de visada,
mas o enlace real depende da posição de uma estação específica da DSN no disco
terrestre e da difração na borda do relevo (ITU-R P.526) — um link budget
completo está fora do escopo deste modelo.
"""

import numpy as np

FULL = 0.999  # tolerância numérica para "disco inteiro visível"

# (fração mínima, código, rótulo)
RF_LEVELS = [
    (FULL, "banda_larga", "Banda larga (enlace nominal)"),
    (0.5, "degradado", "RF degradada"),
    (1e-9, "emergencia", "Telemetria de emergência"),
    (0.0, "los", "Perda de sinal (LOS)"),
]
POWER_LEVELS = [
    (FULL, "nominal", "Energia nominal"),
    (1e-9, "parcial", "Energia parcial"),
    (0.0, "sem_energia", "Sem energia solar"),
]


def _level(fraction: float, levels) -> tuple[str, str]:
    for threshold, code, label in levels:
        if fraction >= threshold:
            return code, label
    return levels[-1][1], levels[-1][2]


def rf_level(earth_fraction: float) -> tuple[str, str]:
    return _level(earth_fraction, RF_LEVELS)


def power_level(sun_fraction: float) -> tuple[str, str]:
    return _level(sun_fraction, POWER_LEVELS)


def status_text(sun_fraction: float, earth_fraction: float) -> str:
    """Ex.: 'Comms parcial · Energia nominal'."""
    comms = ("Comms nominal" if earth_fraction >= FULL else "Comms parcial" if earth_fraction > 0
             else "Sem comms (LOS)")
    return f"{comms} · {power_level(sun_fraction)[1]}"


def states(sun: np.ndarray, earth: np.ndarray) -> dict[str, np.ndarray]:
    """Máscaras booleanas dos quatro estados exclusivos."""
    power, comms = sun > 0, earth > 0
    return {"golden": power & comms, "power_only": power & ~comms, "comms_only": ~power & comms,
            "none": ~power & ~comms}
