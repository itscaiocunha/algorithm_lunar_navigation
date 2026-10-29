"""Sobe a API + dashboard e abre o navegador.

Uso:  python scripts/servidor.py            (porta 8000)
      python scripts/servidor.py --porta 8080 --sem-navegador

Para parar: Ctrl+C neste terminal.
"""

import argparse
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def open_when_ready(url: str) -> None:
    for _ in range(120):
        try:
            urllib.request.urlopen(url + "health", timeout=1)
            webbrowser.open(url)
            return
        except OSError:
            time.sleep(0.5)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--porta", type=int, default=8000)
    p.add_argument("--sem-navegador", action="store_true")
    args = p.parse_args()

    url = f"http://127.0.0.1:{args.porta}/"
    print(f"Lunar Navigator em {url}  (API: {url}docs)  —  Ctrl+C para parar")
    if not args.sem_navegador:
        threading.Thread(target=open_when_ready, args=(url,), daemon=True).start()
    uvicorn.run("lunar_navigator.api:app", host="127.0.0.1", port=args.porta, app_dir=str(ROOT / "src"))


if __name__ == "__main__":
    main()
