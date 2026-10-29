"""Calcula a elevação do Sol vista de um ponto na superfície lunar.

Uso:
    python scripts/elevacao_solar.py
    python scripts/elevacao_solar.py --utc "2026-11-20 00:00:00 UTC" --lat -89.9 --lon 0
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import spiceypy as spice

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lunar_navigator import ephemeris  # noqa: E402

# Borda da cratera Shackleton, polo sul lunar
DEFAULT_LAT = -89.9
DEFAULT_LON = 0.0
DEFAULT_UTC = "2026-11-14 12:00:00 UTC"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--utc", default=DEFAULT_UTC)
    parser.add_argument("--lat", type=float, default=DEFAULT_LAT, help="graus (sul < 0)")
    parser.add_argument("--lon", type=float, default=DEFAULT_LON, help="graus leste")
    args = parser.parse_args()

    print("1. Carregando kernels...")
    ephemeris.load_kernels()
    print(f"   {spice.ktotal('ALL')} kernels na memória")

    et = ephemeris.utc_to_et(args.utc)
    print(f"2. {args.utc}  ->  ET = {et:.3f} s desde J2000")

    observer = ephemeris.surface_point(args.lat, args.lon)
    print(f"3. Observador lat {args.lat}°, lon {args.lon}°")
    print(f"   (X, Y, Z) em {ephemeris.FRAME} = {np.array2string(observer, precision=3)} km")

    vector, light_time = ephemeris.sun_vector(et, observer)
    print(f"4. Vetor observador -> Sol ({ephemeris.FRAME}, {ephemeris.ABCORR})")
    print("   (X, Y, Z) = (" + ", ".join(f"{c:,.0f}" for c in vector) + ") km")
    print(f"   distância {np.linalg.norm(vector):,.0f} km, tempo-luz {light_time:.1f} s")

    elevation, azimuth = ephemeris.topocentric_angles(vector, observer)
    print("5. Coordenadas no horizonte local")
    print(f"   Elevação do Sol: {elevation:+.4f}°  ({'acima' if elevation > 0 else 'abaixo'} do horizonte)")
    print(f"   Azimute:         {azimuth:.2f}°  (a partir do Norte, sentido horário)")

    spice.kclear()


if __name__ == "__main__":
    main()
