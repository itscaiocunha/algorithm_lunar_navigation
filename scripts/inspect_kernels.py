"""Inspeciona kernels SPICE: tipo, corpos e cobertura temporal (SPK), leap seconds (LSK).

Uso:  python scripts/inspect_kernels.py kernels/arquivo1 kernels/arquivo2 ...
"""

import re
import sys
from pathlib import Path

import spiceypy as spice


def inspect_lsk(path: Path) -> None:
    text = path.read_text(errors="replace")
    entries = re.findall(r"\d+,\s*@(\d{4}-[A-Z]{3}-\d+)", text)
    print(f"  {len(entries)} leap seconds; último: {entries[-1] if entries else '?'}")


def inspect_spk(path: Path) -> None:
    ids = spice.spkobj(str(path))
    for i in range(spice.card(ids)):
        body = ids[i]
        cover = spice.spkcov(str(path), body)
        start, end = spice.wnfetd(cover, 0)
        _, last_end = spice.wnfetd(cover, spice.wncard(cover) - 1)
        name = spice.bodc2s(body)
        print(
            f"  {body:>4} {name:<24} "
            f"{spice.et2utc(start, 'C', 0)[:11]} -> {spice.et2utc(last_end, 'C', 0)[:11]}"
        )


def main(paths: list[str]) -> None:
    lsks = [p for p in paths if p.lower().endswith(".tls")]
    for lsk in lsks:
        spice.furnsh(lsk)  # necessário para et2utc

    for raw in paths:
        path = Path(raw)
        _, kind = spice.getfat(str(path))
        print(f"\n{path.name}  [{kind}]  {path.stat().st_size / 1e6:.1f} MB")
        if kind == "LSK":
            inspect_lsk(path)
        elif kind == "SPK":
            inspect_spk(path)
    spice.kclear()


if __name__ == "__main__":
    main(sys.argv[1:])
