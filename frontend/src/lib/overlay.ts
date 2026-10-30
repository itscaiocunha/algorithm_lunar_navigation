// Camada animada sobre os tiles da quadtree: UMA textura (o quadro atual da área de ±30 km),
// amostrada no fragment shader pela coordenada do mapa de cada fragmento.
//
// Os tiles continuam com o próprio relevo; o shader só mistura o quadro onde ele existe. Trocar de
// quadro = reescrever os pixels da mesma DataTexture (texSubImage2D) — nenhum material, textura ou
// tile é recriado, e nenhuma requisição por tile é feita durante a animação.

export interface OverlayUniforms {
  uOverlay: { value: unknown } // THREE.Texture
  uOverlayBox: { value: [number, number, number, number] } // (x_min, y_max, largura, altura) em km
  uOverlayOn: { value: number }
}

export const OVERLAY_VERTEX_GLSL = /* glsl */ `
varying vec2 vLunarMap;
`

export const OVERLAY_FRAGMENT_GLSL = /* glsl */ `
varying vec2 vLunarMap;
uniform sampler2D uOverlay;
uniform vec4 uOverlayBox;
uniform float uOverlayOn;
`

// a linha 0 do quadro é o norte (y_max): v = (y_max − y) / altura, e a DataTexture não é invertida
const APPLY = /* glsl */ `
if (uOverlayOn > 0.5) {
  vec2 ouv = vec2((vLunarMap.x - uOverlayBox.x) / uOverlayBox.z, (uOverlayBox.y - vLunarMap.y) / uOverlayBox.w);
  if (ouv.x >= 0.0 && ouv.x <= 1.0 && ouv.y >= 0.0 && ouv.y <= 1.0) {
    vec4 ov = texture2D(uOverlay, ouv);
    diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, ov.a);
  }
}
`

/** Injeta a camada animada num MeshStandardMaterial (depois de injectCurvature, que usa `position` plano). */
export function injectOverlay(
  shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> },
  uniforms: OverlayUniforms,
): void {
  Object.assign(shader.uniforms, uniforms)
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${OVERLAY_VERTEX_GLSL}`)
    // coordenada do mapa ANTES da curvatura: o atributo `position` é o plano (x, h, −y)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLunarMap = vec2(position.x, -position.z);')
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${OVERLAY_FRAGMENT_GLSL}`)
    .replace('#include <map_fragment>', `#include <map_fragment>\n${APPLY}`)
}
