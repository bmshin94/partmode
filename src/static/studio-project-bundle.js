// Deterministic dependency manifest for the canonical self-contained project
// artifact. PartMode stores reusable definitions and imported exact resources
// inside the project document, so this manifest is the pack-and-go contract:
// every referenced definition/resource is present before bytes are exported.

export class StudioProjectBundleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioProjectBundleError';
    this.code = code;
    Object.assign(this, details);
  }
}

const textOrder = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function requiredId(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new StudioProjectBundleError('INVALID_PROJECT_BUNDLE', label + ' must have a non-empty id.');
  }
  return value;
}

function uniqueIdMap(entries, label) {
  if (!Array.isArray(entries)) throw new StudioProjectBundleError('INVALID_PROJECT_BUNDLE', label + ' must be an array.');
  const result = new Map();
  for (const [index, entry] of entries.entries()) {
    const id = requiredId(entry?.id, label + '[' + index + ']');
    if (result.has(id)) throw new StudioProjectBundleError('INVALID_PROJECT_BUNDLE', label + ' repeats id "' + id + '".');
    result.set(id, entry);
  }
  return result;
}

export function createStudioProjectBundleManifest(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new StudioProjectBundleError('INVALID_PROJECT_BUNDLE', 'Project bundle input must be an object.');
  }
  const parts = uniqueIdMap(project.partDefinitions, 'partDefinitions');
  const assemblies = uniqueIdMap(project.assemblyDefinitions, 'assemblyDefinitions');
  const resources = uniqueIdMap(project.resources, 'resources');
  const definitionEdges = [];
  for (const assembly of assemblies.values()) {
    for (const occurrence of assembly.occurrences || []) {
      const definition = occurrence?.definition;
      const targetId = definition?.kind === 'part' ? definition.partId : definition?.assemblyId;
      const target = definition?.kind === 'part' ? parts : definition?.kind === 'assembly' ? assemblies : null;
      if (!target || !target.has(targetId)) {
        throw new StudioProjectBundleError(
          'MISSING_BUNDLE_DEFINITION',
          'Occurrence "' + String(occurrence?.id || '') + '" references a definition that is absent from the project bundle.',
          { assemblyId: assembly.id, occurrenceId: occurrence?.id || null, definitionId: targetId || null },
        );
      }
      definitionEdges.push({ assemblyId: assembly.id, occurrenceId: occurrence.id, kind: definition.kind, definitionId: targetId });
    }
  }

  const resourceReferences = [];
  for (const part of parts.values()) {
    for (const feature of part.features || []) {
      if (feature?.type !== 'imported-step') continue;
      const resourceId = feature.extensions?.studioImportedStep?.resourceId;
      if (!resources.has(resourceId)) {
        throw new StudioProjectBundleError(
          'MISSING_BUNDLE_RESOURCE',
          'Imported STEP feature "' + String(feature?.id || '') + '" references resource "' + String(resourceId || '') + '" that is absent from the project bundle.',
          { partId: part.id, featureId: feature?.id || null, resourceId: resourceId || null },
        );
      }
      resourceReferences.push({ partId: part.id, featureId: feature.id, resourceId });
    }
  }

  definitionEdges.sort((left, right) => textOrder(
    [left.assemblyId, left.occurrenceId, left.kind, left.definitionId].join('\0'),
    [right.assemblyId, right.occurrenceId, right.kind, right.definitionId].join('\0'),
  ));
  resourceReferences.sort((left, right) => textOrder(
    [left.partId, left.featureId, left.resourceId].join('\0'),
    [right.partId, right.featureId, right.resourceId].join('\0'),
  ));
  const referencedResourceIds = new Set(resourceReferences.map((entry) => entry.resourceId));
  const root = project.rootDocument?.kind === 'part'
    ? { kind: 'part', definitionId: project.rootDocument.partId }
    : { kind: 'assembly', definitionId: project.rootDocument?.assemblyId };
  const rootMap = root.kind === 'part' ? parts : assemblies;
  if (!rootMap.has(root.definitionId)) {
    throw new StudioProjectBundleError('MISSING_BUNDLE_DEFINITION', 'The root document definition is absent from the project bundle.', {
      definitionId: root.definitionId || null,
    });
  }
  return {
    schema: 'partmode.project-bundle/v1',
    projectId: String(project.projectId || ''),
    root,
    partDefinitionIds: [...parts.keys()].sort(textOrder),
    assemblyDefinitionIds: [...assemblies.keys()].sort(textOrder),
    definitionEdges,
    resourceIds: [...resources.keys()].sort(textOrder),
    resourceReferences,
    unreferencedResourceIds: [...resources.keys()].filter((id) => !referencedResourceIds.has(id)).sort(textOrder),
    selfContained: true,
  };
}
