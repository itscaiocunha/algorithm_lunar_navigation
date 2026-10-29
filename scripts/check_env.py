"""Verificação rápida do ambiente: importa cada biblioteca e mostra a versão.

Uso:  python scripts/check_env.py
"""

import importlib
import sys

LIBRARIES = ["numpy", "spiceypy", "fastapi", "uvicorn", "pydantic", "pytest", "httpx"]


def main() -> int:
    print(f"Python {sys.version.split()[0]}  ({sys.executable})")
    in_venv = sys.prefix != sys.base_prefix
    print(f"venv ativo: {'sim' if in_venv else 'NÃO'}\n")

    failures = 0
    for name in LIBRARIES:
        try:
            module = importlib.import_module(name)
            print(f"  [OK]   {name:<10} {getattr(module, '__version__', '?')}")
        except ImportError as exc:
            failures += 1
            print(f"  [FALHA] {name:<10} {exc}")

    if not failures:
        import spiceypy

        print(f"\nCSPICE: {spiceypy.tkvrsn('TOOLKIT')}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
