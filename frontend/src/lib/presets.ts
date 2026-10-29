// Catálogo de alvos de missão. A NASA não publicou coordenadas centrais nem limites das 13 regiões
// candidatas do Artemis III (anúncio de ago/2022: áreas de 15×15 km). Por isso os alvos "Peak Optimized"
// usam o ponto de melhor pontuação composta (sol + Terra + apagões) que o modelo LOLA de 80 m encontra
// junto ao acidente geográfico nomeado — e cada entrada declara a origem e o que o modelo mostra.

export type PresetStatus = 'otimizado' | 'confirmado' | 'informativo'

export interface LandingPreset {
  id: string
  name: string
  program: 'Artemis III' | 'CLPS' | null
  lat: number | null
  lon: number | null
  status: PresetStatus | null
  source: string
  note: string
}

export const CUSTOM_ID = 'custom'

/** Texto comum dos alvos otimizados (exibido como subtítulo no card). */
export const OPTIMIZED_SUBTITLE =
  'Coordenada otimizada pelo modelo: ponto de maior sobrevivência (pontuação composta Sol + Terra − apagões) '
  + 'junto ao alvo nomeado. A NASA não publicou os limites das regiões, então a pertinência exata à região não é verificável.'

export const LANDING_PRESETS: LandingPreset[] = [
  {
    id: CUSTOM_ID, name: 'Coordenada personalizada', program: null, lat: null, lon: null, status: null,
    source: '', note: 'Digite latitude e longitude, ou clique no mapa.',
  },
  {
    id: 'connecting-ridge', name: 'Artemis III: Connecting Ridge (Peak Optimized)', program: 'Artemis III',
    lat: -89.451, lon: -137.1, status: 'otimizado',
    source: 'Candidato nº 1 do ranking deste projeto (pontuação +0,587, pesos 1/1/1, ano de 2027)',
    note: 'Crista entre as crateras Shackleton e de Gerlache: 1957 m, 83,8% de Sol, maior janela de Zona de Ouro de '
      + '15,5 dias e noite máxima de apenas 6 dias.',
  },
  {
    id: 'peak-near-shackleton', name: 'Artemis III: Peak Near Shackleton (Peak Optimized)', program: 'Artemis III',
    lat: -89.78, lon: -156.4, status: 'otimizado',
    source: 'Candidato nº 5 do ranking deste projeto (pontuação +0,538, pesos 1/1/1, ano de 2027)',
    note: 'Pico de 1737 m sobre a borda da Shackleton (a 10,4 km do centro da cratera, ≈ o raio dela): 76,7% de Sol, '
      + '47% do tempo em Zona de Ouro, janela de 15 dias. Substitui a coordenada anterior (lon +129,54°), que caía no fundo da cratera.',
  },
  {
    id: 'malapert', name: 'Artemis III: Malapert Massif', program: 'Artemis III',
    lat: -85.99, lon: 2.93, status: 'informativo',
    source: 'Coordenada de planejamento fornecida; coerente com o modelo',
    note: 'Maciço de ~5,1 km de altitude no modelo. Fica a 122 km do polo: fora do mapa 2D (±30 km), mas visível '
      + 'no relevo 3D (quadtree do DEM inteiro), na telemetria e na contagem regressiva.',
  },
  {
    id: 'mons-mouton', name: 'CLPS: VIPER / Mons Mouton (Nobile oeste)', program: 'CLPS',
    lat: -85.33, lon: 31.69, status: 'confirmado',
    source: 'Coordenada de planejamento fornecida; a NASA descreve o alvo do VIPER como a borda oeste da Nobile',
    note: 'Planalto de 6164 m no modelo — mais alto que 89% do terreno num raio de 24 km —, em vez do centro afundado '
      + 'da Nobile (917 m). O cume de Mons Mouton está listado em ~84,6°S, 31°E; a IM-2 pousou em 84,79°S, 29,20°E. '
      + 'A 143 km do polo: fora do mapa 2D (±30 km), visível no relevo 3D (quadtree).',
  },
]

export function findPreset(id: string): LandingPreset {
  return LANDING_PRESETS.find((p) => p.id === id) ?? LANDING_PRESETS[0]
}
