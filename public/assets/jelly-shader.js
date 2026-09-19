import * as THREE from "three";
import {
  normalWorld,
  positionLocal,
  positionWorld,
  cameraPosition,
  storage,
  uniform,
  uniformGroup,
  vertexIndex,
  wgslFn
} from "three/tsl";

/*
  The WebGPU path is a custom, hand-authored WGSL material. Three owns only the
  entry points, camera transform uniforms and bindings; the vertex and fragment
  functions below own the jelly deformation and all visible shading.

  A raw WGSL @vertex/@fragment pipeline cannot be attached to WebGPURenderer's
  scene graph in r181. `wgslFn` lets Three generate those entry points while
  preserving its WebGL2 fallback, raycasting and dynamic BufferGeometry path.
*/

export const JELLY_FLAVOURS = [
  {
    id: "berry", baseColor: "#C03B7A", rimColor: "#FF8ACF", glowColor: "#FF4FA8",
    base: 0xC03B7A, subsurface: 0xC03B7A, attenuation: 0x8f2458, distance: 2.2,
    absorption: new THREE.Vector3(.24, 1.06, .86)
  },
  {
    id: "mint", baseColor: "#4CCFB2", rimColor: "#9AF5E0", glowColor: "#5FFFE0",
    base: 0x4CCFB2, subsurface: 0x4CCFB2, attenuation: 0x168f79, distance: 2.4,
    absorption: new THREE.Vector3(.78, .20, .60)
  },
  {
    id: "plum", baseColor: "#6A3BAA", rimColor: "#B78CFF", glowColor: "#8F4FFF",
    base: 0x6A3BAA, subsurface: 0x6A3BAA, attenuation: 0x47247f, distance: 2.3,
    absorption: new THREE.Vector3(.62, .94, .19)
  }
];

export const JELLY_NAME_PRESETS = {
  none: { shineIntensity: 1, glowIntensity: 1, rimStrength: 1 },
  steven: { shineIntensity: 1.2, glowIntensity: 1.1, rimStrength: 1.0 },
  karen: { shineIntensity: 1.4, glowIntensity: 1.3, rimStrength: 1.2 }
};

/* WGSL vertex stage: a future compute pass can replace `stressField` without
   changing this material. The current CPU mirror is deliberately tiny: physics
   continues to define the mesh, while stress adds only a sub-millimetre sheen. */
const jellyVertexWGSL = wgslFn(/* wgsl */`
fn jelly_vertex(position: vec3<f32>, stress: f32, time: f32) -> vec3<f32> {
  let radial = normalize(position + vec3<f32>(0.0001));
  let ripple = sin(time * 1.7 + position.y * 6.0 + position.x * 2.0);
  return position + radial * (stress * ripple * 0.002);
}`);

/*
  WGSL fragment stage:
  - GGX with Schlick Fresnel supplies the energy-conserving wet highlight.
  - Beer-Lambert transmittance makes blue attenuate first, keeping the jelly warm.
  - The diffusion/backscatter term is a view-and-light thickness approximation;
    it is intentionally local and stable under the rapidly deforming mesh.
*/
const saturateWGSL = wgslFn(/* wgsl */`
fn jelly_saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}`);

const fresnelSchlickWGSL = wgslFn(/* wgsl */`
fn jelly_fresnel_schlick(cos_theta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - jelly_saturate(cos_theta), 5.0);
}`, [saturateWGSL]);

const distributionGGXWGSL = wgslFn(/* wgsl */`
fn jelly_distribution_ggx(n: vec3<f32>, h: vec3<f32>, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let ndoth = jelly_saturate(dot(n, h));
  let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / max(3.14159265 * denom * denom, 0.0001);
}`, [saturateWGSL]);

const geometrySchlickGGXWGSL = wgslFn(/* wgsl */`
fn jelly_geometry_schlick_ggx(ndotv: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return ndotv / max(ndotv * (1.0 - k) + k, 0.0001);
}`);

const geometrySmithWGSL = wgslFn(/* wgsl */`
fn jelly_geometry_smith(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32) -> f32 {
  return jelly_geometry_schlick_ggx(jelly_saturate(dot(n, v)), roughness) *
    jelly_geometry_schlick_ggx(jelly_saturate(dot(n, l)), roughness);
}`, [saturateWGSL, geometrySchlickGGXWGSL]);

const jellyLightWGSL = wgslFn(/* wgsl */`
fn jelly_light(
  n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, light_color: vec3<f32>,
  base_color: vec3<f32>, roughness: f32, f0: vec3<f32>
) -> vec3<f32> {
  let h = normalize(v + l);
  let ndotl = jelly_saturate(dot(n, l));
  let ndotv = jelly_saturate(dot(n, v));
  let specular = jelly_distribution_ggx(n, h, roughness) * jelly_geometry_smith(n, v, l, roughness) *
    jelly_fresnel_schlick(jelly_saturate(dot(h, v)), f0) / max(4.0 * ndotv * ndotl, 0.0001);
  let diffuse = (vec3<f32>(1.0) - jelly_fresnel_schlick(ndotv, f0)) * base_color / 3.14159265;
  return (diffuse + specular) * light_color * ndotl;
}`, [saturateWGSL, fresnelSchlickWGSL, distributionGGXWGSL, geometrySmithWGSL]);

const jellyFragmentWGSL = wgslFn(/* wgsl */`
fn jelly_fragment(
  normal: vec3<f32>, view_direction: vec3<f32>, world_position: vec3<f32>,
  stress: f32, time: f32, base_color: vec3<f32>, subsurface_color: vec3<f32>,
  absorption: vec3<f32>, rim_color: vec3<f32>, glow_color: vec3<f32>,
  key_direction: vec3<f32>, key_color: vec3<f32>,
  fill_direction: vec3<f32>, fill_color: vec3<f32>, back_direction: vec3<f32>,
  back_color: vec3<f32>, ambient_color: vec3<f32>, roughness: f32, ior: f32,
  absorption_strength: f32, thickness: f32, internal_glow: f32,
  shine_intensity: f32, rim_strength: f32, translucency: f32,
  glow_intensity: f32, glow_decay: f32, stress_effect_strength: f32
) -> vec4<f32> {
  let v = normalize(view_direction);
  let geometric_normal = normalize(normal);
  let tangent_hint = normalize(cross(geometric_normal, vec3<f32>(0.17, 1.0, 0.11)));
  let n = normalize(geometric_normal + tangent_hint * ((stress - 0.5) * stress_effect_strength));
  let key = normalize(key_direction);
  let fill = normalize(fill_direction);
  let back = normalize(back_direction);

  let ndotv = jelly_saturate(dot(n, v));
  let edge = 1.0 - ndotv;
  let path_length = thickness * (0.58 + edge * 0.62) * (1.0 + stress * 0.34);
  let transmittance = exp(-absorption * (absorption_strength * path_length));
  let f0_scalar = pow((ior - 1.0) / (ior + 1.0), 2.0);
  let f0 = vec3<f32>(f0_scalar);

  var surface = ambient_color * base_color * (0.28 + transmittance * 0.24);
  surface += jelly_light(n, v, key, key_color, base_color, roughness, f0) * shine_intensity;
  surface += jelly_light(n, v, fill, fill_color, base_color, roughness, f0) * shine_intensity;
  surface += jelly_light(n, v, back, back_color * 0.34, base_color, roughness, f0) * shine_intensity;

  let key_diffusion = pow(jelly_saturate(dot(v, normalize(-key + n * 0.38))), 2.25);
  let back_diffusion = pow(jelly_saturate(dot(v, normalize(-back + n * 0.24))), 1.75);
  let diffusion_profile = (key_diffusion * 0.38 + back_diffusion) * (0.42 + path_length * 0.82);
  let subsurface = subsurface_color * (key_color * key_diffusion + back_color * back_diffusion) *
    diffusion_profile * transmittance * translucency;

  let animated_glow = 0.94 + sin(time * 0.8 + world_position.y * 3.0) * 0.06;
  let glow = glow_color * internal_glow * glow_intensity * exp(-glow_decay * time) *
    (0.34 + stress * 0.66) * animated_glow;
  let rim = jelly_fresnel_schlick(ndotv, f0) * rim_color * pow(edge, 3.0) * rim_strength;
  return vec4<f32>(surface + subsurface + glow + rim, 1.0);
}`, [saturateWGSL, fresnelSchlickWGSL, jellyLightWGSL]);

function makeFallbackMaterial(flavour) {
  return new THREE.MeshPhysicalMaterial({
    color: flavour.base, roughness: .085, metalness: 0,
    transmission: 1, thickness: .62, ior: 1.36, dispersion: .035,
    attenuationColor: new THREE.Color(flavour.attenuation),
    attenuationDistance: flavour.distance,
    clearcoat: 1, clearcoatRoughness: .06,
    emissive: new THREE.Color(flavour.base), emissiveIntensity: .045
  });
}

function makeWebGPUMaterial(vertexCount, preset = {}) {
  const jellyGroup = uniformGroup("jelly");
  const flavour = JELLY_FLAVOURS[1];

  const state = {
    baseColor: uniform(new THREE.Color(flavour.base), "color").setName("jellyBaseColor").setGroup(jellyGroup),
    subsurfaceColor: uniform(new THREE.Color(flavour.subsurface), "color").setName("jellySubsurfaceColor").setGroup(jellyGroup),
    rimColor: uniform(new THREE.Color(flavour.rimColor), "color").setName("jellyRimColor").setGroup(jellyGroup),
    glowColor: uniform(new THREE.Color(flavour.glowColor), "color").setName("jellyGlowColor").setGroup(jellyGroup),
    absorption: uniform(flavour.absorption.clone(), "vec3").setName("jellyAbsorption").setGroup(jellyGroup),
    roughness: uniform(.14, "float").setName("jellyRoughness").setGroup(jellyGroup),
    ior: uniform(1.45, "float").setName("jellyIOR").setGroup(jellyGroup),
    absorptionStrength: uniform(preset.absorptionStrength ?? 1.12, "float").setName("jellyAbsorptionStrength").setGroup(jellyGroup),
    thickness: uniform(.84, "float").setName("jellyThickness").setGroup(jellyGroup),
    internalGlow: uniform(.045, "float").setName("jellyInternalGlow").setGroup(jellyGroup),
    shineIntensity: uniform(preset.shineIntensity ?? 1, "float").setName("jellyShineIntensity").setGroup(jellyGroup),
    rimStrength: uniform(preset.rimStrength ?? .42, "float").setName("jellyRimStrength").setGroup(jellyGroup),
    translucency: uniform(preset.translucency ?? 1, "float").setName("jellyTranslucency").setGroup(jellyGroup),
    glowIntensity: uniform(preset.glowIntensity ?? 1, "float").setName("jellyGlowIntensity").setGroup(jellyGroup),
    glowDecay: uniform(preset.glowDecay ?? 0, "float").setName("jellyGlowDecay").setGroup(jellyGroup),
    stressEffectStrength: uniform(preset.stressEffectStrength ?? .026, "float").setName("jellyStressEffectStrength").setGroup(jellyGroup),
    time: uniform(0, "float").setName("jellyTime").setGroup(jellyGroup),
    keyDirection: uniform(new THREE.Vector3(-2.2, 4.2, 2.6).normalize(), "vec3").setName("jellyKeyDirection").setGroup(jellyGroup),
    keyColor: uniform(new THREE.Color(0xffffff).multiplyScalar(1.8), "color").setName("jellyKeyColor").setGroup(jellyGroup),
    fillDirection: uniform(new THREE.Vector3(-.7, 1.2, 3.8).normalize(), "vec3").setName("jellyFillDirection").setGroup(jellyGroup),
    fillColor: uniform(new THREE.Color(0xddeaff).multiplyScalar(.42), "color").setName("jellyFillColor").setGroup(jellyGroup),
    backDirection: uniform(new THREE.Vector3(3, 1.4, -3.2).normalize(), "vec3").setName("jellyBackDirection").setGroup(jellyGroup),
    backColor: uniform(new THREE.Color(0xffe2b4).multiplyScalar(1.1), "color").setName("jellyBackColor").setGroup(jellyGroup),
    ambientColor: uniform(new THREE.Color(0xfff6e8).multiplyScalar(.55), "color").setName("jellyAmbientColor").setGroup(jellyGroup)
  };

  const stressAttribute = new THREE.StorageBufferAttribute(vertexCount, 1);
  stressAttribute.setUsage(THREE.DynamicDrawUsage);
  const stressField = storage(stressAttribute, "float", vertexCount).toReadOnly();
  const stress = stressField.element(vertexIndex).toVarying("vJellyStress");

  const material = new THREE.MeshBasicNodeMaterial();
  material.positionNode = jellyVertexWGSL({ position: positionLocal, stress, time: state.time });
  material.fragmentNode = jellyFragmentWGSL({
    normal: normalWorld,
    view_direction: cameraPosition.sub(positionWorld).normalize(),
    world_position: positionWorld,
    stress,
    time: state.time,
    base_color: state.baseColor,
    subsurface_color: state.subsurfaceColor,
    absorption: state.absorption,
    rim_color: state.rimColor,
    glow_color: state.glowColor,
    key_direction: state.keyDirection,
    key_color: state.keyColor,
    fill_direction: state.fillDirection,
    fill_color: state.fillColor,
    back_direction: state.backDirection,
    back_color: state.backColor,
    ambient_color: state.ambientColor,
    roughness: state.roughness,
    ior: state.ior,
    absorption_strength: state.absorptionStrength,
    thickness: state.thickness,
    internal_glow: state.internalGlow,
    shine_intensity: state.shineIntensity,
    rim_strength: state.rimStrength,
    translucency: state.translucency,
    glow_intensity: state.glowIntensity,
    glow_decay: state.glowDecay,
    stress_effect_strength: state.stressEffectStrength
  });

  return { material, state, stressAttribute };
}

export function createJellyMaterial({ isWebGPU, vertexCount, restPositions, preset }) {
  if (!isWebGPU) {
    const material = makeFallbackMaterial(JELLY_FLAVOURS[1]);
    return {
      material,
      setFlavour(index) {
        const flavour = JELLY_FLAVOURS[index];
        material.color.setHex(flavour.base);
        material.attenuationColor.setHex(flavour.attenuation);
        material.attenuationDistance = flavour.distance;
        material.emissive.setHex(flavour.base);
      },
      setInternalGlow(intensity) { material.emissiveIntensity = intensity; },
        setNamePreset() {},
        setAppearance(index) { this.setFlavour(index); },
      update() {}
    };
  }

  const { material, state, stressAttribute } = makeWebGPUMaterial(vertexCount, preset);
  const rest = new Float32Array(restPositions);
  const stress = stressAttribute.array;
  let elapsed = 0;

  return {
    material,
    setFlavour(index) {
      const flavour = JELLY_FLAVOURS[index];
      state.baseColor.value.setHex(flavour.base);
      state.subsurfaceColor.value.setHex(flavour.subsurface);
      state.absorption.value.copy(flavour.absorption);
      state.rimColor.value.set(flavour.rimColor);
      state.glowColor.value.set(flavour.glowColor);
    },
    setNamePreset(name) {
      const namePreset = JELLY_NAME_PRESETS[name] || JELLY_NAME_PRESETS.none;
      state.shineIntensity.value = (preset?.shineIntensity ?? 1) * namePreset.shineIntensity;
      state.glowIntensity.value = (preset?.glowIntensity ?? 1) * namePreset.glowIntensity;
      state.rimStrength.value = (preset?.rimStrength ?? .42) * namePreset.rimStrength;
    },
    setAppearance(index, name = "none") {
      this.setFlavour(index);
      this.setNamePreset(name);
    },
    setInternalGlow(intensity) { state.internalGlow.value = intensity; },
    update(positions, dt) {
      elapsed += Math.min(dt || 0, .1);
      state.time.value = elapsed;
      for (let i = 0; i < vertexCount; i++) {
        const p = i * 3;
        stress[i] = Math.min(1, Math.hypot(
          positions[p] - rest[p], positions[p + 1] - rest[p + 1], positions[p + 2] - rest[p + 2]
        ) / .42);
      }
      stressAttribute.needsUpdate = true;
    }
  };
}
