// Curvatura lunar na GPU: os tiles chegam no plano polar estereográfico (como o DEM) e o vertex
// shader os leva à esfera. Mesma matemática em GLSL (render) e em TS (marcadores, câmera, clique).
//
// Cena (km): X = x do mapa, Y = altitude (para cima), Z = −y do mapa; polo na origem.
// Inversa estereográfica (a mesma de terrain.py), com ρ² = x² + y²:
//     u = (4R·y, 4R·x, ρ² − 4R²) / (ρ² + 4R²)          (vetor unitário no MOON_ME)
// e o vértice vai para r·u com r = R + h·exagero (o exagero vale só para o relevo, não para a esfera).
// No referencial tangente ao polo sul (Y para cima = −Z do MOON_ME):
//     X = r·u_y      Y = −r·u_z − R      Z = −r·u_x
// No polo: Y = h·exagero; a 300 km do polo a superfície "cai" 25,7 km.

export const MOON_RADIUS_KM = 1737.4

export type Vec3 = [number, number, number]

/** Vértice da cena: (x, y do mapa, altitude) em km -> posição curvada (curvature=1) ou plana (0). */
export function curvedPoint(xKm: number, yKm: number, hKm: number, exaggeration: number, curvature = 1): Vec3 {
  const flat: Vec3 = [xKm, hKm * exaggeration, -yKm]
  if (!curvature) return flat
  const R = MOON_RADIUS_KM
  const rho2 = xKm * xKm + yKm * yKm
  const d = rho2 + 4 * R * R
  const ux = (4 * R * yKm) / d, uy = (4 * R * xKm) / d, uz = (rho2 - 4 * R * R) / d
  const r = R + hKm * exaggeration
  const curved: Vec3 = [r * uy, -r * uz - R, -r * ux]
  return [0, 1, 2].map((i) => flat[i] + (curved[i] - flat[i]) * curvature) as Vec3
}

/** "Para cima" local da cena (vertical do lugar) no ponto do mapa — o mesmo `up` de lunarNormal. */
export function localUp(xKm: number, yKm: number, curvature = 1): Vec3 {
  const R = MOON_RADIUS_KM
  const rho2 = xKm * xKm + yKm * yKm
  const d = rho2 + 4 * R * R
  const ux = (4 * R * yKm) / d, uy = (4 * R * xKm) / d, uz = (rho2 - 4 * R * R) / d
  const v: Vec3 = [uy * curvature, 1 + (-uz - 1) * curvature, -ux * curvature]
  const n = Math.hypot(...v)
  return [v[0] / n, v[1] / n, v[2] / n]
}

/** Queda (km) da superfície esférica abaixo do plano tangente, a `rhoKm` do polo no mapa. */
export function curvatureDropKm(rhoKm: number): number {
  const theta = 2 * Math.atan(rhoKm / (2 * MOON_RADIUS_KM)) // ângulo ao centro (estereográfica)
  return MOON_RADIUS_KM * (1 - Math.cos(theta))
}

/** Declarações GLSL (uniforms + funções), inseridas após `#include <common>` do vertex shader. */
export const CURVATURE_GLSL = /* glsl */ `
uniform float uMoonR;
uniform float uExaggeration;
uniform float uCurvature;

vec3 lunarUnit(vec3 p) {            // p: (x, h, -y) em km -> vetor unitário MOON_ME
  float x = p.x, y = -p.z;
  float rho2 = x * x + y * y;
  float d = rho2 + 4.0 * uMoonR * uMoonR;
  return vec3(4.0 * uMoonR * y / d, 4.0 * uMoonR * x / d, (rho2 - 4.0 * uMoonR * uMoonR) / d);
}

vec3 lunarPosition(vec3 p) {
  vec3 flatP = vec3(p.x, p.y * uExaggeration, p.z);
  vec3 u = lunarUnit(p);
  float r = uMoonR + p.y * uExaggeration;
  vec3 curved = vec3(r * u.y, -r * u.z - uMoonR, -r * u.x);
  return mix(flatP, curved, uCurvature);
}

vec3 lunarNormal(vec3 p, vec3 n) {
  // 1. exagero vertical: normais se transformam pela inversa-transposta de diag(1, e, 1)
  vec3 m = normalize(vec3(n.x, n.y / uExaggeration, n.z));
  // 2. inclinação: rotação que leva o "para cima" do polo (0,1,0) ao "para cima" local (radial)
  vec3 u = lunarUnit(p);
  vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), vec3(u.y, -u.z, -u.x), uCurvature));
  vec3 k = vec3(up.z, 0.0, -up.x);   // (0,1,0) × up
  float s = length(k);
  if (s < 1e-7) return m;
  k /= s;
  float c = up.y;
  return m * c + cross(k, m) * s + k * dot(k, m) * (1.0 - c);   // Rodrigues
}
`

/** Injeta a curvatura nos chunks de posição e normal de um material padrão do three.js. */
export function injectCurvature(
  shader: { vertexShader: string; uniforms: Record<string, { value: unknown }> },
  uniforms: Record<string, { value: number }>,
): void {
  Object.assign(shader.uniforms, uniforms) // mesmos objetos: mudar .value afeta todos os tiles
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${CURVATURE_GLSL}`)
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = lunarNormal(position, objectNormal);')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = lunarPosition(transformed);')
}
