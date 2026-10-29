"""Exemplo: carrega os kernels e calcula a geometria Terra-Lua-Sol numa data.

Uso:  python scripts/exemplo_lua.py [data UTC]
      python scripts/exemplo_lua.py 2026-10-29T12:00:00
"""

import os
import sys
from pathlib import Path

import numpy as np
import spiceypy as spice

ROOT = Path(__file__).resolve().parents[1]


def main(utc: str) -> None:
    os.chdir(ROOT)  # o meta-kernel usa caminhos relativos à raiz do projeto
    spice.furnsh("kernels/lunar.tm")

    et = spice.str2et(utc)
    moon, lt = spice.spkpos("MOON", et, "J2000", "LT+S", "EARTH")
    sun, _ = spice.spkpos("SUN", et, "J2000", "LT+S", "EARTH")
    earth_me, _ = spice.spkpos("EARTH", et, "MOON_ME", "LT+S", "MOON")
    _, lon, lat = spice.reclat(earth_me)
    radii = spice.bodvrd("MOON", "RADII", 3)[1]

    print(f"Data (UTC):              {spice.et2utc(et, 'ISOC', 0)}")
    print(f"ET (s desde J2000):      {et:.3f}")
    print(f"Distância Terra-Lua:     {np.linalg.norm(moon):,.1f} km  (tempo-luz {lt:.3f} s)")
    print(f"Distância Terra-Sol:     {np.linalg.norm(sun):,.0f} km")
    print(f"Raio da Lua:             {radii[0]} km")
    print(f"Terra vista da Lua (MOON_ME): lon {np.degrees(lon):+.2f}°, lat {np.degrees(lat):+.2f}°")
    spice.kclear()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "2026-10-29T12:00:00")
