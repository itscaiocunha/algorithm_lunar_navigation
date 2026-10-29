"""Parâmetros compartilhados entre scripts e API (mesmo recorte => mesmo cache)."""

from lunar_navigator.terrain import DEFAULT_DEM, ROOT

DEM_PATH = DEFAULT_DEM
HALF_SIZE_M = 30_000.0  # área de análise: ±30 km em torno do polo sul
N_AZIMUTHS = 180  # horizonte amostrado a cada 2°
GROWTH = 0.01  # passo do raio: Δt = max(pixel, 1%·t)
OUTPUT_DIR = ROOT / "output"


def annual_path(year: int):
    return OUTPUT_DIR / f"anual_{year}.npz"
