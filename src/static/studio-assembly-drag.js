import { solveStudioV5Assembly } from './studio-v5-assembly.js';

export const STUDIO_ASSEMBLY_DRAG_SCHEMA = 'partmode.assembly-drag/v1';

const clone = (value) => structuredClone(value);

function dragError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function finiteRigidTransform(value, label = 'target transform') {
  if (!Array.isArray(value) || value.length !== 16 || value.some((entry) => !Number.isFinite(entry))) {
    throw dragError('ASSEMBLY_DRAG_TRANSFORM_INVALID', `${label} must contain 16 finite numbers.`);
  }
  const tolerance = 1e-6;
  if (Math.abs(value[3]) > tolerance || Math.abs(value[7]) > tolerance
    || Math.abs(value[11]) > tolerance || Math.abs(value[15] - 1) > tolerance) {
    throw dragError('ASSEMBLY_DRAG_TRANSFORM_INVALID', `${label} must be affine with a [0, 0, 0, 1] final row.`);
  }
  const axes = [
    [value[0], value[1], value[2]],
    [value[4], value[5], value[6]],
    [value[8], value[9], value[10]],
  ];
  const dot = (left, right) => left.reduce((total, entry, index) => total + entry * right[index], 0);
  if (axes.some((axis) => Math.abs(dot(axis, axis) - 1) > tolerance)
    || Math.abs(dot(axes[0], axes[1])) > tolerance
    || Math.abs(dot(axes[0], axes[2])) > tolerance
    || Math.abs(dot(axes[1], axes[2])) > tolerance) {
    throw dragError('ASSEMBLY_DRAG_TRANSFORM_INVALID', `${label} must be rigid without scale or shear.`);
  }
  const determinant = axes[0][0] * (axes[1][1] * axes[2][2] - axes[1][2] * axes[2][1])
    - axes[1][0] * (axes[0][1] * axes[2][2] - axes[0][2] * axes[2][1])
    + axes[2][0] * (axes[0][1] * axes[1][2] - axes[0][2] * axes[1][1]);
  if (Math.abs(determinant - 1) > tolerance) {
    throw dragError('ASSEMBLY_DRAG_TRANSFORM_INVALID', `${label} must be right-handed without reflection.`);
  }
  return [...value];
}

function transformChanged(left, right, tolerance = 1e-8) {
  return left.some((value, index) => Math.abs(value - right[index]) > tolerance);
}

function sameTransform(left, right, tolerance = 1e-7) {
  return !transformChanged(left, right, tolerance);
}

export function previewStudioAssemblyDrag(project, occurrenceId, targetTransform) {
  if (project?.schemaVersion !== 5 || project.rootDocument?.kind !== 'assembly') {
    throw dragError('ASSEMBLY_DRAG_DOCUMENT_REQUIRED', 'Drag with mates requires an active schema-5 assembly document.');
  }
  const assemblyId = project.rootDocument.assemblyId;
  const sourceAssembly = project.assemblyDefinitions?.find((entry) => entry.id === assemblyId);
  if (!sourceAssembly) throw dragError('ASSEMBLY_DRAG_DOCUMENT_REQUIRED', `Assembly "${assemblyId}" is missing.`);
  const sourceOccurrence = sourceAssembly.occurrences?.find((entry) => entry.id === occurrenceId);
  if (!sourceOccurrence) {
    throw dragError('ASSEMBLY_DRAG_OCCURRENCE_MISSING', `Occurrence "${occurrenceId}" is not a direct child of the active assembly.`);
  }
  if (sourceOccurrence.fixed || sourceOccurrence.suppressed) {
    throw dragError('ASSEMBLY_DRAG_OCCURRENCE_FIXED', `Occurrence "${occurrenceId}" is fixed or suppressed and cannot be dragged.`);
  }
  if ((sourceAssembly.mates || []).some((mate) => !mate.suppressed && mate.kind === 'fixed'
    && mate.occurrenceIds?.includes(occurrenceId))) {
    throw dragError('ASSEMBLY_DRAG_OCCURRENCE_FIXED', `Occurrence "${occurrenceId}" has an active Fixed mate and cannot be dragged.`);
  }
  const target = finiteRigidTransform(targetTransform);
  const driven = clone(project);
  const drivenAssembly = driven.assemblyDefinitions.find((entry) => entry.id === assemblyId);
  const drivenOccurrence = drivenAssembly.occurrences.find((entry) => entry.id === occurrenceId);
  drivenOccurrence.baseTransform = target;
  drivenOccurrence.fixed = true;
  const drivenSolution = solveStudioV5Assembly(driven, assemblyId);
  if (drivenSolution.errors.length || drivenSolution.usedLastValid) {
    throw dragError('ASSEMBLY_DRAG_UNSATISFIED', 'The mate graph cannot satisfy the requested component drag.', {
      errors: clone(drivenSolution.errors),
      conflicts: clone(drivenSolution.conflicts),
    });
  }
  const solvedTarget = drivenSolution.transforms.get(occurrenceId);
  if (!solvedTarget || !sameTransform(solvedTarget, target)) {
    throw dragError('ASSEMBLY_DRAG_TARGET_REJECTED', 'The solved drag did not retain the requested driver transform.');
  }

  const candidate = clone(project);
  const candidateAssembly = candidate.assemblyDefinitions.find((entry) => entry.id === assemblyId);
  const occurrenceTransforms = {};
  for (const occurrence of candidateAssembly.occurrences) {
    const solved = drivenSolution.transforms.get(occurrence.id);
    if (!solved) throw dragError('ASSEMBLY_DRAG_SOLUTION_INCOMPLETE', `The solver omitted occurrence "${occurrence.id}".`);
    occurrence.baseTransform = [...solved];
    occurrenceTransforms[occurrence.id] = [...solved];
  }
  const settled = solveStudioV5Assembly(candidate, assemblyId);
  if (settled.errors.length || settled.usedLastValid) {
    throw dragError('ASSEMBLY_DRAG_SETTLEMENT_FAILED', 'The mate-driven placement did not remain valid after removing the temporary drag driver.', {
      errors: clone(settled.errors),
    });
  }
  for (const occurrence of candidateAssembly.occurrences) {
    const settledTransform = settled.transforms.get(occurrence.id);
    if (!settledTransform || !sameTransform(settledTransform, occurrence.baseTransform)) {
      throw dragError('ASSEMBLY_DRAG_SETTLEMENT_FAILED', `Occurrence "${occurrence.id}" moved after the drag driver was removed.`);
    }
  }
  const affectedOccurrenceIds = sourceAssembly.occurrences
    .filter((occurrence) => transformChanged(occurrence.baseTransform, occurrenceTransforms[occurrence.id]))
    .map((occurrence) => occurrence.id);
  return {
    schema: STUDIO_ASSEMBLY_DRAG_SCHEMA,
    project: candidate,
    assemblyId,
    driverOccurrenceId: occurrenceId,
    affectedOccurrenceIds,
    occurrenceTransforms,
    solver: {
      state: settled.state,
      rank: settled.solverRank,
      iterations: drivenSolution.matePasses,
      degreesOfFreedom: Object.fromEntries(settled.degreesOfFreedom),
    },
  };
}
