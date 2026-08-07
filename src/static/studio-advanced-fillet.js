export const STUDIO_ADVANCED_FILLET_SCHEMA = 'partmode.advanced-fillet/v1';

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function studioFaceFilletExtension() {
  return {
    schema: STUDIO_ADVANCED_FILLET_SCHEMA,
    mode: 'adjacent-face-pair',
    exactKernel: true,
    selectionBoundary: 'exactly-two-adjacent-faces-with-one-shared-edge',
  };
}

export function studioAdvancedFilletDefinition(feature) {
  const definition = feature?.extensions?.advancedFillet;
  return definition?.schema === STUDIO_ADVANCED_FILLET_SCHEMA ? definition : null;
}

export function assertStudioAdvancedFilletFeature(feature, path = 'feature') {
  const definition = studioAdvancedFilletDefinition(feature);
  if (!definition) throw new Error(path + '.extensions.advancedFillet must use schema ' + STUDIO_ADVANCED_FILLET_SCHEMA + '.');
  if (feature.type !== 'fillet') throw new Error(path + '.extensions.advancedFillet is only valid on Fillet.');
  if (definition.mode !== 'adjacent-face-pair' || definition.exactKernel !== true
      || definition.selectionBoundary !== 'exactly-two-adjacent-faces-with-one-shared-edge') {
    throw new Error(path + '.extensions.advancedFillet contains an unsupported or weakened face-fillet contract.');
  }
  if (!Array.isArray(feature.faces) || feature.faces.length !== 2 || feature.faces.some((entry) => !isRecord(entry))) {
    throw new Error(path + '.faces must contain exactly two topology references for an adjacent face fillet.');
  }
  if (!Array.isArray(feature.edges) || feature.edges.length !== 0) {
    throw new Error(path + '.edges must remain empty because the exact shared edge is derived from the selected faces.');
  }
  if (feature.variableRadii !== undefined) throw new Error(path + '.variableRadii is not valid on an adjacent face fillet.');
  if (feature.tangentPropagation === true) throw new Error(path + '.tangentPropagation is unavailable on an adjacent face fillet.');
  return definition;
}
