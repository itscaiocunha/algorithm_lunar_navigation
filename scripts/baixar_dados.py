"""Baixa os dados de entrada (kernels SPICE + DEM LOLA) das fontes oficiais, com verificação SHA-256.

Uso:  python scripts/baixar_dados.py                 # kernels + DEM na raiz do projeto
      python scripts/baixar_dados.py --sem-dem       # só kernels (~133 MB)
      python scripts/baixar_dados.py --destino /app  # outra raiz (Dockerfile)
      python scripts/baixar_dados.py --verificar     # só confere o que já existe

Usado pelo Dockerfile e pelo CI. Só biblioteca padrão: roda numa imagem Python limpa.
Os hashes fixam a versão exata dos dados: se a NASA trocar um arquivo, o download falha
em vez de mudar os resultados em silêncio. Arquivos já presentes e íntegros são pulados.
"""

import argparse
import hashlib
import sys
import time
import urllib.request
from pathlib import Path

NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"
ROOT = Path(__file__).resolve().parents[1]

# (destino relativo à raiz, URL, sha256, bytes)
KERNELS = [
    # naif0012.tls salvo com o nome que o meta-kernel espera (o "latest" da NAIF muda com o tempo)
    ("kernels/latest_leapseconds.tls", f"{NAIF}/lsk/naif0012.tls",
     "678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b", 5_257),
    ("kernels/de440.bsp", f"{NAIF}/spk/planets/de440.bsp",
     "a4ce9bf9b3282becc9f4b2ac3cebe03a2ae7599981aabd7265fd8482fff7c4b5", 119_799_808),
    ("kernels/pck00011.tpc", f"{NAIF}/pck/pck00011.tpc",
     "3dff7b1dbeceaa01f25467767d3fa25816051c85d162d1edf04acb310ee28bb1", 131_226),
    ("kernels/moon_pa_de440_200625.bpc", f"{NAIF}/pck/moon_pa_de440_200625.bpc",
     "60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f", 12_863_488),
    ("kernels/moon_de440_250416.tf", f"{NAIF}/fk/satellites/moon_de440_250416.tf",
     "a47c71e9c9f33796bdafb2c9d69a7ee447b6016ecad80f71cd6f3e479f9cf768", 19_478),
]
DEM = [
    ("data/dem/LDEM_80S_80MPP_ADJ.TIF", "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF",
     "82030dcbdd7c4bb0c7d858e9b4b293b9f2cda5a543ba31ec0f42784bd6beee5a", 189_158_392),
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, size: int, retries: int = 3) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "lunar-navigator/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r, tmp.open("wb") as f:
                done, last = 0, 0.0
                while chunk := r.read(1 << 20):
                    f.write(chunk)
                    done += len(chunk)
                    if time.monotonic() - last > 2:
                        last = time.monotonic()
                        print(f"    {done / 2**20:7.1f} / {size / 2**20:.1f} MB", flush=True)
            tmp.replace(dest)  # só aparece com o nome final depois de completo
            return
        except OSError as exc:
            print(f"    tentativa {attempt}/{retries} falhou: {exc}", flush=True)
            time.sleep(2 * attempt)
    raise SystemExit(f"não foi possível baixar {url}")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--destino", type=Path, default=ROOT)
    p.add_argument("--sem-dem", action="store_true")
    p.add_argument("--verificar", action="store_true", help="não baixa: só confere hashes")
    args = p.parse_args()

    bad = 0
    for rel, url, digest, size in KERNELS + ([] if args.sem_dem else DEM):
        dest = args.destino / rel
        if dest.exists() and dest.stat().st_size == size and sha256(dest) == digest:
            print(f"ok      {rel}")
            continue
        if args.verificar:
            print(f"FALTA   {rel}" if not dest.exists() else f"DIFERE  {rel}")
            bad += 1
            continue
        print(f"baixando {rel}  ({size / 2**20:.1f} MB)  <- {url}", flush=True)
        dest.parent.mkdir(parents=True, exist_ok=True)
        download(url, dest, size)
        if (got := sha256(dest)) != digest:
            dest.unlink()
            raise SystemExit(f"SHA-256 não confere para {rel}: {got} (esperado {digest})")
        print(f"ok      {rel}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
