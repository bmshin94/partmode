import { canonicalStudioV5Project } from './studio-v5-runtime-document.js';

const EXTENSION_KEY = 'partmodeSceneSettings';
const SCHEMA = 'partmode.scene-settings/v1';
const clone = (value) => JSON.parse(JSON.stringify(value));

export const STUDIO_SCENE_PRESETS = Object.freeze({
  studio: Object.freeze({
    label: 'CAD studio', background: '#101820', skyColor: '#ffffff', groundColor: '#586878',
    hemisphereIntensity: 1.5, keyColor: '#ffffff', keyIntensity: 1.2, keyPosition: [60, 120, 90], gridColor: '#2b3b4b',
  }),
  softbox: Object.freeze({
    label: 'Softbox', background: '#20252b', skyColor: '#fff7ed', groundColor: '#68717a',
    hemisphereIntensity: 1.8, keyColor: '#ffe8cf', keyIntensity: 1.45, keyPosition: [-75, 110, 65], gridColor: '#4b535b',
  }),
  daylight: Object.freeze({
    label: 'Daylight', background: '#b8cee0', skyColor: '#eaf7ff', groundColor: '#62745e',
    hemisphereIntensity: 1.25, keyColor: '#fff2ce', keyIntensity: 2, keyPosition: [120, 180, 45], gridColor: '#7890a0',
  }),
  darkroom: Object.freeze({
    label: 'Dark room', background: '#05080c', skyColor: '#7fa7cf', groundColor: '#131a22',
    hemisphereIntensity: 0.65, keyColor: '#a9d2ff', keyIntensity: 1.65, keyPosition: [45, 95, -80], gridColor: '#1d2a35',
  }),
});

export function defaultStudioSceneSettings() {
  return { schema: SCHEMA, preset: 'studio', exposure: 1, realView: false, shadows: false };
}

export function normalizeStudioSceneSettings(value) {
  if (value === undefined || value === null) return defaultStudioSceneSettings();
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== SCHEMA) {
    throw new Error('Scene settings schema is unsupported.');
  }
  if (!Object.hasOwn(STUDIO_SCENE_PRESETS, value.preset)) throw new Error('Scene preset is unsupported.');
  if (!Number.isFinite(value.exposure) || value.exposure < 0.4 || value.exposure > 2.5) {
    throw new Error('Scene exposure must be between 0.4 and 2.5.');
  }
  if (typeof value.realView !== 'boolean' || typeof value.shadows !== 'boolean') {
    throw new Error('RealView and shadows settings must be boolean.');
  }
  return { schema: SCHEMA, preset: value.preset, exposure: value.exposure, realView: value.realView, shadows: value.shadows };
}

export function studioSceneSettings(project) {
  return normalizeStudioSceneSettings(project?.extensions?.[EXTENSION_KEY]);
}

export function saveStudioSceneSettings(project, input) {
  const candidate = canonicalStudioV5Project(project);
  const settings = normalizeStudioSceneSettings({ schema: SCHEMA, ...input });
  candidate.extensions = { ...(candidate.extensions || {}), [EXTENSION_KEY]: clone(settings) };
  return canonicalStudioV5Project(candidate);
}

export function studioSceneRenderState(value) {
  const settings = normalizeStudioSceneSettings(value);
  const preset = STUDIO_SCENE_PRESETS[settings.preset];
  return {
    ...settings,
    preset: clone(preset),
    toneMapping: settings.realView ? 'aces-filmic' : 'linear',
    shadowMap: settings.realView && settings.shadows,
    contactShadowOpacity: settings.realView && settings.shadows ? 0.22 : 0,
  };
}
