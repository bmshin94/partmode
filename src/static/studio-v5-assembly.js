import {
  evaluateStudioV5Expression,
  resolveStudioV5Datums,
  resolveStudioV5PathPreview,
} from './studio-v5-modeling.js';
import { solveAssemblyConstraintSystem } from './studio-assembly-constraint-core.js';

export const studioV5IdentityMatrix = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function studioV5MultiplyMatrices(left, right) {
  const out = Array(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    for (let inner = 0; inner < 4; inner++) out[column * 4 + row] += left[inner * 4 + row] * right[column * 4 + inner];
  }
  return out;
}

export const studioV5TranslationMatrix = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const multiply = (vector, scalar) => vector.map((value) => value * scalar);
const add = (left, right) => left.map((value, index) => value + right[index]);
const subtract = (left, right) => left.map((value, index) => value - right[index]);
const dot = (left, right) => left.reduce((total, value, index) => total + value * right[index], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (vector) => Math.hypot(...vector);
const normalize = (vector) => {
  const magnitude = length(vector);
  if (!(magnitude > 1e-12)) throw new Error('assembly reference direction has zero length');
  return multiply(vector, 1 / magnitude);
};

const ADVANCED_MATE_KINDS = new Set([
  'width',
  'symmetry',
  'path',
  'linear-coupler',
  'limit-distance',
  'limit-angle',
]);
const MECHANICAL_MATE_KINDS = new Set(['gear', 'hinge']);
const MECHANICAL_MATE_ROLES = Object.freeze({
  gear: Object.freeze(['gear-first-axis', 'gear-second-axis']),
  hinge: Object.freeze(['hinge-first-axis', 'hinge-second-axis']),
});

export function studioV5TransformPoint(matrix, [x, y, z]) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

export function studioV5TransformVector(matrix, [x, y, z]) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z,
    matrix[1] * x + matrix[5] * y + matrix[9] * z,
    matrix[2] * x + matrix[6] * y + matrix[10] * z,
  ];
}

export function studioV5RigidInverse(matrix) {
  const out = studioV5IdentityMatrix();
  out[0] = matrix[0]; out[1] = matrix[4]; out[2] = matrix[8];
  out[4] = matrix[1]; out[5] = matrix[5]; out[6] = matrix[9];
  out[8] = matrix[2]; out[9] = matrix[6]; out[10] = matrix[10];
  const translation = [-matrix[12], -matrix[13], -matrix[14]];
  const moved = studioV5TransformVector(out, translation);
  out[12] = moved[0]; out[13] = moved[1]; out[14] = moved[2];
  return out;
}

function perpendicular(vector) {
  const candidate = Math.abs(vector[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(vector, candidate));
}

export function studioV5RotationMatrix(axisInput, degrees) {
  const [x, y, z] = normalize(axisInput);
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle); const s = Math.sin(angle); const t = 1 - c;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

function rotateAround(matrix, pivot) {
  return studioV5MultiplyMatrices(
    studioV5TranslationMatrix(pivot),
    studioV5MultiplyMatrices(matrix, studioV5TranslationMatrix(multiply(pivot, -1))),
  );
}

function frameDirection(frame) {
  return frame.direction || frame.normal || frame.zDirection || [0, 0, 1];
}

function transformedFrame(frame, matrix) {
  const localDirection = normalize(frameDirection(frame));
  const localXDirection = frame.xDirection || perpendicular(localDirection);
  return {
    geometryKind: frame.geometryKind || 'plane',
    origin: studioV5TransformPoint(matrix, frame.origin || [0, 0, 0]),
    direction: normalize(studioV5TransformVector(matrix, localDirection)),
    xDirection: normalize(studioV5TransformVector(matrix, localXDirection)),
  };
}

function finiteMateVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(label + ' must contain three finite numbers');
  const vector = value.map(Number);
  if (vector.some((entry) => !Number.isFinite(entry))) throw new Error(label + ' must contain three finite numbers');
  return vector;
}

function bodyMateFrame(signature) {
  const kind = signature.topologyKind;
  if (kind === 'planar-face') {
    const origin = finiteMateVector(signature.p, 'mate planar-face origin');
    const direction = normalize(finiteMateVector(signature.n, 'mate planar-face normal'));
    return { geometryKind: 'plane', origin, direction, xDirection: perpendicular(direction) };
  }
  if (kind === 'cylindrical-face' || kind === 'conical-face') {
    const label = kind === 'cylindrical-face' ? 'cylindrical' : 'conical';
    const origin = finiteMateVector(signature.a, 'mate ' + label + '-face axis point');
    const direction = normalize(finiteMateVector(signature.d, 'mate ' + label + '-face axis direction'));
    if (!(Number(signature.r) > 0)) throw new Error('mate ' + label + '-face radius must be positive');
    if (kind === 'conical-face' && !(Number(signature.semiAngle) > 0 && Number(signature.semiAngle) < Math.PI / 2)) {
      throw new Error('mate conical-face semi-angle must be between zero and pi over two');
    }
    return { geometryKind: label === 'cylindrical' ? 'cylinder' : 'cone', origin, direction, xDirection: perpendicular(direction) };
  }
  if (kind === 'spherical-face') {
    const origin = finiteMateVector(signature.c, 'mate spherical-face center');
    if (!(Number(signature.r) > 0)) throw new Error('mate spherical-face radius must be positive');
    const direction = normalize(finiteMateVector(signature.n || [0, 0, 1], 'mate spherical-face orientation'));
    return { geometryKind: 'sphere', origin, direction, xDirection: perpendicular(direction) };
  }
  throw new Error('mate body reference must contain a planar, cylindrical, conical, or spherical face topology signature');
}

function parametersFor(project, assembly) {
  const definitions = [...(project.parameters || []), ...(assembly.parameters || [])];
  const resolved = new Map();
  const resolving = new Set();
  const byName = new Map(definitions.map((parameter) => [parameter.name, parameter.value]));
  const resolve = (name) => {
    if (resolved.has(name)) return resolved.get(name);
    if (!byName.has(name)) throw new Error('unknown assembly parameter "' + name + '"');
    if (resolving.has(name)) throw new Error('cyclic assembly parameter "' + name + '"');
    resolving.add(name);
    const value = evaluateStudioV5Expression(byName.get(name), { has: (key) => byName.has(key), get: (key) => resolve(key) });
    resolving.delete(name);
    resolved.set(name, value);
    return value;
  };
  for (const name of byName.keys()) resolve(name);
  return resolved;
}

function mateValue(mate, parameters) {
  return mate.value == null ? 0 : evaluateStudioV5Expression(mate.value, parameters);
}

function advancedMateValues(mate, parameters) {
  const recipe = mate.extensions?.advancedMate;
  if (!recipe || recipe.family !== mate.kind) {
    throw new Error('advanced mate is missing its source-owned family recipe');
  }
  if (mate.kind === 'linear-coupler') {
    return {
      ratio: evaluateStudioV5Expression(recipe.ratio, parameters),
      offset: evaluateStudioV5Expression(recipe.offset, parameters),
    };
  }
  if (mate.kind === 'limit-distance' || mate.kind === 'limit-angle') {
    return {
      minimum: evaluateStudioV5Expression(recipe.minimum, parameters),
      maximum: evaluateStudioV5Expression(recipe.maximum, parameters),
    };
  }
  return {};
}

function mechanicalMateValues(mate, parameters) {
  const recipe = mate.extensions?.mechanicalMate;
  if (!recipe || recipe.family !== mate.kind) {
    throw new Error('mechanical mate is missing its source-owned family recipe');
  }
  if (mate.kind === 'gear') {
    return {
      ratio: evaluateStudioV5Expression(recipe.ratio, parameters),
      offset: evaluateStudioV5Expression(recipe.offset, parameters),
    };
  }
  return {
    minimum: recipe.minimum === null ? null : evaluateStudioV5Expression(recipe.minimum, parameters),
    maximum: recipe.maximum === null ? null : evaluateStudioV5Expression(recipe.maximum, parameters),
  };
}

function centeredPlanarPair(first, second, label) {
  if (first.geometryKind !== 'plane' || second.geometryKind !== 'plane') {
    throw new Error(label + ' requires two planar references');
  }
  if (Math.abs(dot(first.direction, second.direction)) < 1 - 1e-8) {
    throw new Error(label + ' planar references must be parallel or opposing');
  }
  const separation = Math.abs(dot(subtract(second.origin, first.origin), first.direction));
  if (!(separation > 1e-9)) throw new Error(label + ' planar references must be distinct');
  return {
    geometryKind: 'plane',
    origin: multiply(add(first.origin, second.origin), 0.5),
    direction: first.direction,
    xDirection: first.xDirection,
  };
}

function occurrencePatternTransforms(pattern, sourceTransform, parameters) {
  const count = pattern.generatedCount;
  const definition = pattern.definition || {};
  const transforms = [];
  if (pattern.kind === 'circular') {
    const axis = definition.axis || [0, 0, 1];
    const center = definition.center || [0, 0, 0];
    const totalAngle = Number(evaluateStudioV5Expression(definition.totalAngle ?? 360, parameters));
    for (let index = 1; index <= count; index++) {
      const rotation = rotateAround(studioV5RotationMatrix(axis, totalAngle / (count + 1) * index), center);
      transforms.push(studioV5MultiplyMatrices(rotation, sourceTransform));
    }
  } else {
    const direction = normalize(definition.direction || [1, 0, 0]);
    const spacing = Number(evaluateStudioV5Expression(definition.spacing ?? 10, parameters));
    for (let index = 1; index <= count; index++) transforms.push(studioV5MultiplyMatrices(studioV5TranslationMatrix(multiply(direction, spacing * index)), sourceTransform));
  }
  return transforms;
}

export function solveStudioV5Assembly(project, assemblyId, options = {}) {
  const assemblies = new Map((project.assemblyDefinitions || []).map((assembly) => [assembly.id, assembly]));
  const parts = new Map((project.partDefinitions || []).map((part) => [part.id, part]));
  const solving = new Set();
  const previousByAssembly = options.previousByAssembly || new Map();
  const resolveBodyReference = typeof options.resolveBodyReference === 'function'
    ? options.resolveBodyReference
    : null;
  const enumerateOnly = options.enumerateOnly === true;
  // Local datum frames are transform-independent; resolving them once per
  // (part, datum) keeps multi-pass solving linear instead of re-walking the
  // datum graph for every mate application.
  const datumFrameCache = new Map();
  const localDatumFrame = (partId, datumId) => {
    const key = partId + '|' + datumId;
    let frame = datumFrameCache.get(key);
    if (!frame) {
      frame = resolveStudioV5Datums(project, partId).resolve(datumId);
      datumFrameCache.set(key, frame);
    }
    return frame;
  };

  function solve(owningAssemblyId) {
    if (solving.has(owningAssemblyId)) throw new Error('cyclic subassembly containment at "' + owningAssemblyId + '"');
    const assembly = assemblies.get(owningAssemblyId);
    if (!assembly) throw new Error('missing assembly "' + owningAssemblyId + '"');
    solving.add(owningAssemblyId);
    const parameters = parametersFor(project, assembly);
    const directById = new Map(assembly.occurrences.map((occurrence) => [occurrence.id, occurrence]));
    let transforms = new Map(assembly.occurrences.map((occurrence) => [occurrence.id, [...occurrence.baseTransform]]));
    let degreesOfFreedom = new Map(assembly.occurrences.map((occurrence) => [occurrence.id, occurrence.fixed ? 0 : 6]));
    const subassemblies = new Map();
    for (const occurrence of assembly.occurrences) {
      if (occurrence.definition.kind === 'assembly') subassemblies.set(occurrence.id, solve(occurrence.definition.assemblyId));
    }
    const errors = [];
    const conflicts = [];
    const redundantMateIds = [];
    const residuals = [];
    let matePasses = 0;
    let solverRank = 0;
    let solverComponents = [];
    let solverDiagnostics = [];
    let simultaneousState = 'under-constrained';

    function localReferenceContext(reference, topOccurrenceId) {
      const path = reference.occurrencePath?.length ? reference.occurrencePath : [reference.ownerId];
      if (path[0] !== topOccurrenceId) {
        throw new Error('mate reference does not belong to occurrence "' + topOccurrenceId + '"');
      }
      let innerTransform = studioV5IdentityMatrix();
      let definition = directById.get(path[0])?.definition;
      let terminalOccurrence = directById.get(path[0]);
      let sub = subassemblies.get(path[0]);
      for (let index = 1; index < path.length; index++) {
        const nextTransform = sub?.transforms.get(path[index]);
        const nextOccurrence = sub?.directById.get(path[index]);
        if (!nextTransform || !nextOccurrence) throw new Error('mate reference path does not resolve through the subassembly');
        innerTransform = studioV5MultiplyMatrices(innerTransform, nextTransform);
        definition = nextOccurrence.definition;
        terminalOccurrence = nextOccurrence;
        sub = sub?.subassemblies.get(path[index]);
      }
      return { path, innerTransform, definition, terminalOccurrence };
    }

    function localReferenceFrame(reference, topOccurrenceId) {
      const context = localReferenceContext(reference, topOccurrenceId);
      const { path, innerTransform, definition, terminalOccurrence } = context;
      let local;
      if (reference.ownerKind === 'occurrence') {
        local = { geometryKind: 'plane', origin: [0, 0, 0], direction: [0, 0, 1], xDirection: [1, 0, 0] };
      } else if (reference.ownerKind === 'body' && definition?.kind === 'part') {
        const part = parts.get(definition.partId);
        if (!part?.bodies.some((body) => body.id === reference.ownerId)) throw new Error('mate topology owner body is missing');
        const persistentName = reference.semanticPath?.name;
        let signature = reference.signature || {};
        if (persistentName) {
          if (!resolveBodyReference) {
            throw new Error('named mate topology requires the current exact body-reference resolver');
          }
          signature = resolveBodyReference({
            project,
            assemblyId: owningAssemblyId,
            reference,
            topOccurrenceId,
            occurrencePath: [...path],
            definition,
            occurrence: terminalOccurrence,
            part,
          });
          if (!signature || typeof signature !== 'object') {
            throw new Error('named mate topology did not resolve to one current exact analytic face');
          }
        }
        local = bodyMateFrame(signature);
      } else if (reference.ownerKind === 'datum' && definition?.kind === 'part') {
        const part = parts.get(definition.partId);
        if (!part) throw new Error('mate datum owner part is missing');
        local = localDatumFrame(part.id, reference.ownerId);
      } else {
        throw new Error('mate reference must resolve to an occurrence, part datum, or supported analytic body face');
      }
      return transformedFrame(local, innerTransform);
    }

    function localPathSegments(reference, topOccurrenceId) {
      const { innerTransform, definition } = localReferenceContext(reference, topOccurrenceId);
      if (reference.ownerKind !== 'sketch' || definition?.kind !== 'part') {
        throw new Error('path mate path reference must resolve to a part path sketch');
      }
      const path = resolveStudioV5PathPreview(project, reference.ownerId, definition.partId);
      if (!path.exactPointEvaluation || !path.exactTangentEvaluation || !Array.isArray(path.projectionSegments)) {
        throw new Error('path mate requires exact line or cubic-spline spans');
      }
      return path.projectionSegments.map((segment) => {
        const points = segment.points.map((point) => studioV5TransformPoint(innerTransform, point));
        if (segment.kind === 'line') return { kind: 'line', points };
        if (segment.kind === 'bezier') return { kind: 'cubic-bezier', points };
        throw new Error('path mate encountered an unsupported exact path span');
      });
    }

    const referenceForRole = (mate, role) => {
      const matches = (mate.references || []).filter((reference) => reference.semanticPath?.role === role);
      if (matches.length !== 1) throw new Error(mate.kind + ' mate requires exactly one "' + role + '" reference');
      return matches[0];
    };

    const frameForRole = (mate, role, occurrenceId) =>
      localReferenceFrame(referenceForRole(mate, role), occurrenceId);

    function adaptAdvancedMate(mate) {
      const occurrenceIds = [...mate.occurrenceIds];
      const advanced = advancedMateValues(mate, parameters);
      if (mate.kind === 'width') {
        const width = centeredPlanarPair(
          frameForRole(mate, 'width-first', occurrenceIds[0]),
          frameForRole(mate, 'width-second', occurrenceIds[0]),
          'width mate width selection',
        );
        const tab = centeredPlanarPair(
          frameForRole(mate, 'tab-first', occurrenceIds[1]),
          frameForRole(mate, 'tab-second', occurrenceIds[1]),
          'width mate tab selection',
        );
        return { id: mate.id, kind: mate.kind, occurrenceIds, frames: [width, tab], advanced };
      }
      if (mate.kind === 'symmetry') {
        return {
          id: mate.id,
          kind: mate.kind,
          occurrenceIds,
          frames: [
            frameForRole(mate, 'symmetric-first', occurrenceIds[0]),
            frameForRole(mate, 'symmetric-second', occurrenceIds[1]),
            frameForRole(mate, 'symmetry-plane', occurrenceIds[2]),
          ],
          advanced,
        };
      }
      if (mate.kind === 'path') {
        const pathReference = referenceForRole(mate, 'path');
        const segments = localPathSegments(pathReference, occurrenceIds[0]);
        return {
          id: mate.id,
          kind: mate.kind,
          occurrenceIds,
          frames: [
            { geometryKind: 'plane', origin: [0, 0, 0], direction: [0, 0, 1], xDirection: [1, 0, 0] },
            frameForRole(mate, 'follower', occurrenceIds[1]),
          ],
          path: { segments },
          advanced,
        };
      }
      const roles = mate.kind === 'linear-coupler'
        ? ['first-axis', 'second-axis']
        : ['anchor', 'moving'];
      return {
        id: mate.id,
        kind: mate.kind,
        occurrenceIds,
        frames: roles.map((role, index) => frameForRole(mate, role, occurrenceIds[index])),
        advanced,
      };
    }

    function adaptMechanicalMate(mate) {
      const occurrenceIds = [...mate.occurrenceIds];
      return {
        id: mate.id,
        kind: mate.kind,
        occurrenceIds,
        frames: MECHANICAL_MATE_ROLES[mate.kind].map((role, index) =>
          frameForRole(mate, role, occurrenceIds[index])),
        advanced: mechanicalMateValues(mate, parameters),
      };
    }

    const adaptedMates = [];
    for (const mate of enumerateOnly ? [] : assembly.mates) {
      if (mate.suppressed) continue;
      try {
        if (mate.kind === 'fixed') {
          adaptedMates.push({ id: mate.id, kind: mate.kind, occurrenceIds: [...mate.occurrenceIds] });
          continue;
        }
        if (ADVANCED_MATE_KINDS.has(mate.kind)) {
          adaptedMates.push(adaptAdvancedMate(mate));
          continue;
        }
        if (MECHANICAL_MATE_KINDS.has(mate.kind)) {
          adaptedMates.push(adaptMechanicalMate(mate));
          continue;
        }
        if (mate.occurrenceIds.length !== 2 || mate.occurrenceIds[0] === mate.occurrenceIds[1]) {
          throw new Error(mate.kind + ' mate requires two different occurrences');
        }
        const frames = mate.occurrenceIds.map((occurrenceId) => {
          const matches = (mate.references || []).filter((reference) =>
            (reference.occurrencePath?.[0] || reference.ownerId) === occurrenceId);
          if (matches.length !== 1) {
            throw new Error('mate must provide exactly one reference for occurrence "' + occurrenceId + '"');
          }
          return localReferenceFrame(matches[0], occurrenceId);
        });
        adaptedMates.push({
          id: mate.id,
          kind: mate.kind,
          occurrenceIds: [...mate.occurrenceIds],
          value: mateValue(mate, parameters),
          flip: mate.extensions?.flip === true,
          frames,
        });
      } catch (error) {
        errors.push({ mateId: mate.id, kind: 'mate', message: String(error?.message || error), conflictSet: [] });
      }
    }

    try {
      if (enumerateOnly) throw new Error('__PARTMODE_ENUMERATE_ONLY__');
      const simultaneous = solveAssemblyConstraintSystem({
        occurrences: assembly.occurrences.map((occurrence) => ({
          id: occurrence.id,
          transform: occurrence.baseTransform,
          fixed: occurrence.fixed === true,
        })),
        mates: adaptedMates,
      }, Number.isFinite(options.residualTolerance) && options.residualTolerance > 0
        ? { residualTolerance: options.residualTolerance }
        : {});
      transforms = simultaneous.transforms;
      degreesOfFreedom = simultaneous.degreesOfFreedom;
      redundantMateIds.push(...simultaneous.redundantMateIds);
      residuals.push(...simultaneous.residuals.map((entry) => ({
        ...entry,
        residual: entry.maxScaledResidual,
      })));
      conflicts.push(...simultaneous.conflicts.map((entry) => [...entry.mateIds]));
      for (const conflict of simultaneous.conflicts) {
        errors.push({
          mateId: conflict.mateIds[0] || null,
          kind: 'mate',
          message: conflict.message,
          conflictSet: [...conflict.mateIds],
        });
      }
      const conflictedMateIds = new Set(simultaneous.conflicts.flatMap((entry) => entry.mateIds));
      const convergenceDiagnostic = simultaneous.diagnostics.find((entry) => entry.code === 'ASSEMBLY_CONVERGENCE_FAILED');
      if (convergenceDiagnostic) {
        errors.push({
          mateId: null,
          kind: 'mate',
          code: convergenceDiagnostic.code,
          message: convergenceDiagnostic.message,
          conflictSet: [],
          reason: convergenceDiagnostic.reason,
          iterations: convergenceDiagnostic.iterations,
          iterationLimit: convergenceDiagnostic.iterationLimit,
          residual: convergenceDiagnostic.maxScaledResidual,
          solutionAccepted: false,
        });
      }
      for (const entry of simultaneous.residuals) {
        if (entry.satisfied || conflictedMateIds.has(entry.mateId)) continue;
        errors.push({
          mateId: entry.mateId,
          kind: 'mate',
          message: 'mate simultaneous-solve residual is ' + entry.maxScaledResidual.toPrecision(6),
          conflictSet: [],
          residual: entry.maxScaledResidual,
        });
      }
      matePasses = simultaneous.iterations;
      solverRank = simultaneous.rank;
      solverComponents = simultaneous.components;
      solverDiagnostics = simultaneous.diagnostics;
      simultaneousState = simultaneous.state === 'over-constrained' ? 'conflicting' : simultaneous.state;
    } catch (error) {
      if (String(error?.message || error) === '__PARTMODE_ENUMERATE_ONLY__') {
        simultaneousState = 'under-constrained';
      } else {
      errors.push({ mateId: null, kind: 'mate', message: String(error?.message || error), conflictSet: [] });
      simultaneousState = 'conflicting';
      }
    }


    let usedLastValid = false;
    if (errors.length && previousByAssembly.get(owningAssemblyId)) {
      const previous = previousByAssembly.get(owningAssemblyId);
      for (const [occurrenceId, matrix] of previous.transforms) if (transforms.has(occurrenceId)) transforms.set(occurrenceId, [...matrix]);
      usedLastValid = true;
    }

    const leafOccurrences = [];
    for (const occurrence of assembly.occurrences) {
      if (occurrence.suppressed) continue;
      const localTransform = transforms.get(occurrence.id);
      if (occurrence.definition.kind === 'part') {
        leafOccurrences.push({
          id: occurrence.id, name: occurrence.name, occurrencePath: [occurrence.id], definition: occurrence.definition,
          transform: localTransform, visible: occurrence.visible, suppressed: occurrence.suppressed, sourceOccurrenceId: occurrence.id,
          parameterOverrides: occurrence.parameterOverrides || {},
        });
      } else {
        const child = subassemblies.get(occurrence.id);
        for (const leaf of child.leafOccurrences) leafOccurrences.push({
          ...leaf,
          id: occurrence.id + '/' + leaf.id,
          name: occurrence.name + ' / ' + leaf.name,
          occurrencePath: [occurrence.id, ...leaf.occurrencePath],
          transform: studioV5MultiplyMatrices(localTransform, leaf.transform),
          visible: occurrence.visible && leaf.visible,
          suppressed: occurrence.suppressed || leaf.suppressed,
        });
      }
    }
    const unpatternedLeaves = [...leafOccurrences];
    for (const pattern of assembly.occurrencePatterns) {
      if (pattern.suppressed) continue;
      for (const sourceId of pattern.sourceOccurrenceIds) {
        const sources = unpatternedLeaves.filter((leaf) => leaf.occurrencePath[0] === sourceId);
        for (const source of sources) {
          const generated = occurrencePatternTransforms(pattern, source.transform, parameters);
          generated.forEach((transform, index) => {
            const generatedOccurrenceId = pattern.id + '-instance-' + (index + 1) + '-' + sourceId;
            const nestedPath = source.occurrencePath.slice(1);
            leafOccurrences.push({
              ...source,
              id: [generatedOccurrenceId, ...nestedPath].join('/'),
              name: pattern.name + ' ' + (index + 2) + ' / ' + source.name,
              occurrencePath: [generatedOccurrenceId, ...nestedPath],
              transform,
              sourceOccurrenceId: sourceId,
              patternInstance: { patternId: pattern.id, index: index + 1, sourceOccurrenceId: sourceId },
            });
          });
        }
      }
    }

    const nestedSolutions = [...subassemblies.values()];
    const aggregateErrors = [...errors, ...nestedSolutions.flatMap((child) => child.errors)];
    const aggregateConflicts = [...conflicts, ...nestedSolutions.flatMap((child) => child.conflicts)];
    const aggregateRedundantMateIds = [...redundantMateIds, ...nestedSolutions.flatMap((child) => child.redundantMateIds)];
    const aggregateResiduals = [...residuals, ...nestedSolutions.flatMap((child) => child.residuals)];
    const aggregateSolverDiagnostics = [...solverDiagnostics, ...nestedSolutions.flatMap((child) => child.solverDiagnostics || [])];
    const aggregateSolverRank = solverRank + nestedSolutions.reduce((total, child) => total + (child.solverRank || 0), 0);
    const aggregateSolverComponents = [...solverComponents, ...nestedSolutions.flatMap((child) => child.solverComponents || [])];
    const aggregateDegreesOfFreedom = new Map(degreesOfFreedom);
    for (const child of nestedSolutions) for (const [occurrenceId, value] of child.degreesOfFreedom) aggregateDegreesOfFreedom.set(occurrenceId, value);
    const aggregateUsedLastValid = usedLastValid || nestedSolutions.some((child) => child.usedLastValid);
    solving.delete(owningAssemblyId);
    return {
      assembly, directById, transforms, degreesOfFreedom: aggregateDegreesOfFreedom, errors: aggregateErrors,
      conflicts: aggregateConflicts, redundantMateIds: aggregateRedundantMateIds,
      residuals: aggregateResiduals,
      subassemblies, leafOccurrences, usedLastValid: aggregateUsedLastValid, matePasses,
      solverRank: aggregateSolverRank,
      solverComponents: aggregateSolverComponents,
      solverDiagnostics: aggregateSolverDiagnostics,
      state: aggregateErrors.length || simultaneousState === 'conflicting'
        ? 'conflicting'
        : [...aggregateDegreesOfFreedom.values()].every((value) => value === 0)
          ? 'fully-constrained'
          : 'under-constrained',
    };
  }

  return solve(assemblyId);
}

export function studioV5TransformBounds(bounds, matrix) {
  if (!bounds) return null;
  const points = [];
  for (const x of [bounds[0][0], bounds[1][0]]) for (const y of [bounds[0][1], bounds[1][1]]) for (const z of [bounds[0][2], bounds[1][2]]) {
    points.push(studioV5TransformPoint(matrix, [x, y, z]));
  }
  return [
    [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))),
    [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))),
  ];
}
