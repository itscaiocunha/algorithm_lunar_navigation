KPL/MK

Meta-kernel do Lunar Navigator
==============================

   Carregar com:  spiceypy.furnsh("kernels/lunar.tm")
   (PATH_VALUES é relativo ao diretório de execução: rode a partir da raiz do projeto.)

   latest_leapseconds.tls     LSK  Leap seconds (UTC <-> TDB/ET)
   de440.bsp                  SPK  Efemérides DE440: Sol, planetas, Terra, Lua (1550-2650)
   pck00011.tpc               PCK  Raios e modelos de rotação IAU (inclui Lua)
   moon_pa_de440_200625.bpc   PCK  Orientação de alta precisão da Lua (frame MOON_PA_DE440)
   moon_de440_250416.tf       FK   Define os frames MOON_PA e MOON_ME

   A ordem importa: o FK e o PCK binário vêm depois do pck00011.tpc para que a
   orientação de alta precisão da Lua tenha prioridade sobre o modelo IAU.

\begindata

   PATH_VALUES  = ( 'kernels' )
   PATH_SYMBOLS = ( 'K' )

   KERNELS_TO_LOAD = (
      '$K/latest_leapseconds.tls'
      '$K/de440.bsp'
      '$K/pck00011.tpc'
      '$K/moon_pa_de440_200625.bpc'
      '$K/moon_de440_250416.tf'
   )

\begintext
