const clone = (value) => structuredClone(value);

function samePath(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function studioAssemblyEditContext(project, { required = false } = {}) {
  const stored = project?.metadata?.editContext;
  if (!stored) {
    if (required) throw new Error('There is no active assembly edit context.');
    return null;
  }
  const assembly = project.assemblyDefinitions?.find((entry) => entry.id === stored.assemblyId);
  if (!assembly) throw new Error('The owning assembly for this edit context no longer exists.');
  if (!Array.isArray(stored.occurrencePath) || stored.occurrencePath.length !== 1) {
    throw new Error('Assembly edit context currently requires one direct part occurrence.');
  }
  const occurrence = assembly.occurrences?.find((entry) => entry.id === stored.occurrencePath[0]);
  if (!occurrence || occurrence.definition?.kind !== 'part') {
    throw new Error('The edited part occurrence no longer exists in the owning assembly.');
  }
  const part = project.partDefinitions?.find((entry) => entry.id === occurrence.definition.partId);
  if (!part) throw new Error('The edited part definition no longer exists.');
  if (project.rootDocument?.kind !== 'part' || project.rootDocument.partId !== part.id) {
    throw new Error('The active part does not match the stored assembly edit context.');
  }
  return {
    assemblyId: assembly.id,
    assembly,
    occurrence,
    occurrencePath: [...stored.occurrencePath],
    partId: part.id,
    part,
  };
}

export function studioAssemblyEditContextDisplayProject(project) {
  const context = studioAssemblyEditContext(project);
  if (!context) return null;
  const display = clone(project);
  display.rootDocument = { kind: 'assembly', assemblyId: context.assemblyId };
  return display;
}

export function studioAssemblyEditContextRole(project, occurrencePath) {
  const context = studioAssemblyEditContext(project);
  if (!context || !Array.isArray(occurrencePath)) return null;
  return samePath(context.occurrencePath, occurrencePath) ? 'active' : 'surrounding';
}

export function studioAssemblyEditContextBodyId(project, runtimeBody) {
  return studioAssemblyEditContextRole(project, runtimeBody?.occurrenceInstance?.occurrencePath) === 'active'
    ? runtimeBody.sourceBodyId || runtimeBody.bodyId
    : null;
}
