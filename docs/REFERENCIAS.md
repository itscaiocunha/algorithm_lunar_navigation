# Fontes e referências

Fontes dos dados, referências científicas e software usados no Lunar
Navigator, com a indicação de **onde cada uma é usada no código**.

Bibliografia conferida em 29/10/2026 nas páginas dos editores, na NASA
NTRS/ADS e nas páginas dos produtos de dados.

---

## 1. Dados

### 1.1 Kernels SPICE (NASA/JPL — NAIF)

Repositório: <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/>

| Arquivo | Tipo | URL | Uso no projeto |
|---|---|---|---|
| `latest_leapseconds.tls` (= `naif0012.tls`) | LSK | [lsk/latest_leapseconds.tls](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/latest_leapseconds.tls) | Conversão UTC ↔ ET (`solar.utc_to_et`) |
| `de440.bsp` | SPK | [spk/planets/de440.bsp](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440.bsp) | Posição do Sol, Terra e Lua (`solar.sun_vector`, `illumination.sun_position_m`) |
| `pck00011.tpc` | PCK texto | [pck/pck00011.tpc](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc) | Raio da Lua, 1737,4 km (`solar.surface_point`) |
| `moon_pa_de440_200625.bpc` | PCK binário | [pck/moon_pa_de440_200625.bpc](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc) | Orientação precisa da Lua (frame `MOON_PA_DE440`) |
| `moon_de440_250416.tf` | FK | [fk/satellites/moon_de440_250416.tf](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf) | Define os frames `MOON_ME` e `MOON_PA` |

Todos são carregados por `kernels/lunar.tm`. Cada arquivo traz no cabeçalho
a documentação completa, que é a referência primária para o seu conteúdo.

### 1.2 Topografia do polo sul (LRO / LOLA)

| Item | Valor |
|---|---|
| Produto | *A New View of the Lunar South Pole from LOLA* — NASA GSFC PGDA |
| Página | <https://pgda.gsfc.nasa.gov/products/90> |
| Arquivo usado | [`LDEM_80S_80MPP_ADJ.TIF`](https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF) — 80 m/px, 80°S–90°S |
| DOI do conjunto de dados | [10.60903/gsfcpgda-lola-spole](https://doi.org/10.60903/gsfcpgda-lola-spole) |
| Citação pedida pela página | Barker et al. (2023) — ver [R5](#r5) |
| Uso no projeto | `terrain.load_dem`, `illumination.compute_illumination` |

---

## 2. Referências científicas

### Efemérides e sistema SPICE

<a id="r1"></a>**[R1]** Acton, C. H. (1996). Ancillary data services of NASA's
Navigation and Ancillary Information Facility. *Planetary and Space Science*,
44(1), 65–70. <https://doi.org/10.1016/0032-0633(95)00107-7>
— Referência oficial do SPICE (pedida pela NAIF).

<a id="r2"></a>**[R2]** Acton, C., Bachman, N., Semenov, B., & Wright, E. (2017).
A look toward the future in the handling of space science mission geometry.
*Planetary and Space Science*.
<https://doi.org/10.1016/j.pss.2017.02.013>
— Segunda referência pedida pela NAIF ([credit.html](https://naif.jpl.nasa.gov/naif/credit.html)).

<a id="r3"></a>**[R3]** Park, R. S., Folkner, W. M., Williams, J. G., & Boggs, D. H. (2021).
The JPL Planetary and Lunar Ephemerides DE440 and DE441. *The Astronomical
Journal*, 161(3), 105. <https://doi.org/10.3847/1538-3881/abd414>
— Efemérides em `de440.bsp`, orientação lunar em `moon_pa_de440_200625.bpc` e frames em `moon_de440_250416.tf`.

### Constantes e sistemas de coordenadas

<a id="r4"></a>**[R4]** Archinal, B. A., et al. (2018). Report of the IAU Working Group
on Cartographic Coordinates and Rotational Elements: 2015. *Celestial
Mechanics and Dynamical Astronomy*, 130, 22.
<https://doi.org/10.1007/s10569-017-9805-5>
(Correção: <https://doi.org/10.1007/s10569-019-9925-1>)
— Raios e modelos de rotação de `pck00011.tpc` (raio lunar de 1737,4 km).

<a id="r6"></a>**[R6]** Prša, A., et al. (2016). Nominal values for selected solar and
planetary quantities: IAU 2015 Resolution B3. *The Astronomical Journal*,
152(2), 41. <https://doi.org/10.3847/0004-6256/152/2/41>
— Raio solar nominal de 695 700 km (`illumination.SUN_RADIUS_M`).

<a id="r9"></a>**[R9]** Snyder, J. P. (1987). *Map Projections: A Working Manual*.
U.S. Geological Survey Professional Paper 1395.
<https://purl.fdlp.gov/GPO/gpo93084>
— Projeção polar estereográfica (fórmulas de `terrain.to_map` / `to_unit_vectors`).

### Topografia e iluminação lunar

<a id="r5"></a>**[R5]** Barker, M. K., et al. (2023). A New View of the Lunar South Pole
from the Lunar Orbiter Laser Altimeter (LOLA). *The Planetary Science
Journal*, 4, 183. <https://doi.org/10.3847/PSJ/acf3e1>
— Fonte do DEM `LDEM_80S_80MPP_ADJ.TIF` (citação pedida pelo PGDA).

<a id="r7"></a>**[R7]** Barker, M. K., Mazarico, E., Neumann, G. A., Smith, D. E.,
Zuber, M. T., & Head, J. W. (2021). Improved LOLA elevation maps for south
pole landing sites: Error estimates and their impact on illumination
conditions. *Planetary and Space Science*, 203, 105119.
<https://doi.org/10.1016/j.pss.2020.105119>
— Método de ajuste das trilhas do LOLA e impacto dos erros de altura na iluminação.

<a id="r8"></a>**[R8]** Mazarico, E., Neumann, G. A., Smith, D. E., Zuber, M. T., &
Torrence, M. H. (2011). Illumination conditions of the lunar polar regions
using LOLA topography. *Icarus*, 211(2).
<https://doi.org/10.1016/j.icarus.2010.10.030>
— Método de referência para iluminação polar com horizontes topográficos,
base conceitual de `illumination.py` (horizonte na direção do Sol + fração do disco).

<a id="r11"></a>**[R11]** Bussey, D. B. J., et al. (2010). Illumination conditions of the
south pole of the Moon derived using Kaguya topography. *Icarus*, 208,
558–564. <https://doi.org/10.1016/j.icarus.2010.03.028>
— Ponto mais iluminado do polo sul (88,74°S, 124,5°E; 86%), usado como
comparação em `docs/ILUMINACAO.md`.

<a id="r10"></a>**[R10]** Gläser, P., et al. (2014). Illumination conditions at the
lunar south pole using high resolution Digital Terrain Models from LOLA.
*Icarus*, 243, 78–90. <https://ui.adsabs.harvard.edu/abs/2014Icar..243...78G>
— Estudo complementar de iluminação no polo sul com DTMs de alta resolução.

---

## 3. Software

| Biblioteca | Versão | Referência / documentação |
|---|---|---|
| CSPICE (NAIF) | N0067 | <https://naif.jpl.nasa.gov/naif/toolkit_C.html> — ver [R1], [R2] |
| SpiceyPy | 8.3.0 | Annex, A. M., et al. (2020). SpiceyPy: a Pythonic Wrapper for the SPICE Toolkit. *JOSS*, 5(46), 2050. <https://doi.org/10.21105/joss.02050> |
| NumPy | 2.5.4 | Harris, C. R., et al. (2020). Array programming with NumPy. *Nature*, 585, 357–362. <https://doi.org/10.1038/s41586-020-2649-2> |
| rasterio | 1.5.2 (GDAL 3.12.2) | <https://rasterio.readthedocs.io> |
| SciPy | 1.18.1 | Virtanen, P., et al. (2020). SciPy 1.0: fundamental algorithms for scientific computing in Python. *Nature Methods*, 17, 261–272. <https://doi.org/10.1038/s41592-019-0686-2> |
| Matplotlib | 3.11.2 | <https://matplotlib.org> |
| FastAPI | 0.162.0 | <https://fastapi.tiangolo.com> |
| Uvicorn | 0.54.0 | <https://www.uvicorn.org> |
| pytest | 9.2.0 | <https://docs.pytest.org> |

Frontend (`frontend/package.json`):

| Biblioteca | Versão | Documentação |
|---|---|---|
| React | 19.3 | <https://react.dev> |
| TypeScript | 7.0 | <https://www.typescriptlang.org> |
| Vite | 8.3 | <https://vite.dev> |
| deck.gl | 9.4 | <https://deck.gl> |
| React Three Fiber / drei / three.js | 9.8 / 10.7 / 0.186 | <https://r3f.docs.pmnd.rs> · <https://threejs.org> |
| Tailwind CSS | 4.3 | <https://tailwindcss.com> |
| lucide-react | 1.64 | <https://lucide.dev> |
| vitest | 5.0 | <https://vitest.dev> |

Documentação das rotinas SPICE usadas (todas em
<https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/>):
`furnsh`, `str2et`, `et2utc`, `deltet`, `bodvrd`, `latrec`, `reclat`,
`spkpos`, `spkcpo`, `pxform`, `twovec`, `azlcpo` (usada na validação).

---

## 4. Constantes usadas no código

| Constante | Valor | Fonte | Onde |
|---|---|---|---|
| Raio da Lua | 1737,4 km | `pck00011.tpc` [R4] | `solar.surface_point` (via `bodvrd`) |
| Raio de referência do DEM | 1 737 400 m | CRS do GeoTIFF [R5] | `terrain.DEM.radius` |
| Raio do Sol | 695 700 km | IAU 2015 B3 [R6] | `illumination.SUN_RADIUS_M` |
| TDB − UTC (desde 2017) | 69,184 s (37 s + 32,184 s) | `latest_leapseconds.tls` | `tests/test_kernels.py` |
| Correção de aberração | `LT+S` | Documentação de `spkpos` (NAIF) | `solar.ABCORR` |

---

## 5. Como citar este projeto

Ao publicar resultados, cite no mínimo: SPICE [R1, R2], efemérides DE440
[R3], o DEM LOLA [R5] e o seu DOI de dados, SpiceyPy e NumPy. Se usar o
método de iluminação, cite também [R8].
