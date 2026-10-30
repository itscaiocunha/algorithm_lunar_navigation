"""Gera o gráfico da "escada" de otimizações (SVG claro e escuro) a partir de output/benchmark_escada.json.

Uso:  python scripts/benchmark_escada.py   # mede (uma vez)
      python scripts/grafico_escada.py     # -> docs/img/escada-otimizacao-{claro,escuro}.svg

Barras horizontais em escala log (um só tom: é uma única série; o valor fica na ponta da barra).
"""

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

THEMES = {  # tokens do guia de visualização: superfície, tintas, grade e a cor da série
    "claro": dict(surface="#fcfcfb", ink="#0b0b0b", ink2="#52514e", muted="#898781", grid="#e1e0d9",
                  base="#c3c2b7", bar="#2a78d6"),
    "escuro": dict(surface="#1a1a19", ink="#f0efec", ink2="#c3c2b7", muted="#898781", grid="#2c2c2a",
                   base="#383835", bar="#3987e5"),
}
W, LEFT, PLOT_W, TOP, ROW, BAR = 820, 290, 420, 92, 46, 20
DOMAIN = (0.05, 7200.0)  # s
TICKS = [(0.1, "0,1 s"), (1, "1 s"), (10, "10 s"), (60, "1 min"), (600, "10 min"), (3600, "1 h")]


def fmt(s: float) -> str:
    if s < 1:
        return f"{s * 1000:.0f} ms"
    if s < 60:
        return f"{s:.1f} s".replace(".", ",")
    return f"{s / 60:.0f} min"


def x(s: float) -> float:
    lo, hi = (math.log10(v) for v in DOMAIN)
    return LEFT + (math.log10(s) - lo) / (hi - lo) * PLOT_W


def bar_path(x0: float, x1: float, y: float, r: float = 4) -> str:
    """Base reta no eixo, ponta arredondada (4 px) no valor."""
    r = min(r, (x1 - x0) / 2)
    return (f"M{x0:.1f},{y:.1f} H{x1 - r:.1f} Q{x1:.1f},{y:.1f} {x1:.1f},{y + r:.1f} V{y + BAR - r:.1f} "
            f"Q{x1:.1f},{y + BAR:.1f} {x1 - r:.1f},{y + BAR:.1f} H{x0:.1f} Z")


def svg(rows: list[tuple[str, str, float]], t: dict, pixels: int) -> str:
    h = TOP + ROW * len(rows) + 54
    font = "font-family=\"-apple-system,'Segoe UI',Helvetica,Arial,sans-serif\""
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{h}" viewBox="0 0 {W} {h}" {font} '
           f'role="img" aria-labelledby="t d">',
           '<title id="t">Tempo de cálculo de luz e sombra por instante</title>',
           '<desc id="d">' + "; ".join(f"{a} ({b}): {fmt(s)}" for a, b, s in rows) + "</desc>",
           f'<rect width="{W}" height="{h}" rx="10" fill="{t["surface"]}"/>',
           f'<text x="24" y="36" font-size="17" font-weight="600" fill="{t["ink"]}">'
           'Tempo para calcular luz e sombra de um instante</text>',
           f'<text x="24" y="58" font-size="12.5" fill="{t["ink2"]}">{pixels:,} pixels de 80 m ao redor do polo sul · '
           'escala logarítmica</text>'.replace(",", ".")]
    bottom = TOP + ROW * len(rows) - 10
    for s, label in TICKS:  # grade: hairline sólida, recessiva
        out.append(f'<line x1="{x(s):.1f}" x2="{x(s):.1f}" y1="{TOP - 8}" y2="{bottom}" stroke="{t["grid"]}" stroke-width="1"/>')
        out.append(f'<text x="{x(s):.1f}" y="{bottom + 18}" font-size="11.5" fill="{t["muted"]}" '
                   f'text-anchor="middle">{label}</text>')
    out.append(f'<line x1="{LEFT}" x2="{LEFT}" y1="{TOP - 8}" y2="{bottom}" stroke="{t["base"]}" stroke-width="1"/>')
    for i, (name, detail, s) in enumerate(rows):
        y = TOP + i * ROW
        out.append(f'<text x="{LEFT - 14}" y="{y + 9}" font-size="13" font-weight="600" fill="{t["ink"]}" '
                   f'text-anchor="end">{name}</text>')
        out.append(f'<text x="{LEFT - 14}" y="{y + 25}" font-size="11.5" fill="{t["ink2"]}" text-anchor="end">{detail}</text>')
        out.append(f'<path d="{bar_path(LEFT, x(s), y)}" fill="{t["bar"]}"/>')
        out.append(f'<text x="{x(s) + 8:.1f}" y="{y + 15}" font-size="13" font-weight="600" fill="{t["ink"]}">{fmt(s)}</text>')
    out.append("</svg>")
    return "\n".join(out)


def main():
    b = json.loads((ROOT / "output" / "benchmark_escada.json").read_text(encoding="utf-8"))
    pre_min = round(b["horizontes_precalculo_s"] / 60)
    rows = [
        ("Laço em Python, pixel a pixel", "mesmo código, um pixel por chamada", b["pixel_a_pixel_s"]),
        ("NumPy, malha inteira", "laço sobre a distância, não sobre o pixel", b["vetorizado_inteiro_s"]),
        ("NumPy em blocos de 65 536 px", "idêntico às duas acima, bit a bit", b["vetorizado_blocos_s"]),
        ("Mapa de horizontes", f"pré-cálculo único de {pre_min} min · ~99,8% igual", b["horizontes_por_instante_s"]),
    ]
    dest = ROOT / "docs" / "img"
    dest.mkdir(parents=True, exist_ok=True)
    for name, theme in THEMES.items():
        (dest / f"escada-otimizacao-{name}.svg").write_text(svg(rows, theme, b["pixels"]), encoding="utf-8")
        print(f"-> docs/img/escada-otimizacao-{name}.svg")


if __name__ == "__main__":
    main()
