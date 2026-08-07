// Deterministic assembly drawing plan, BOM, and balloon annotations.
//
// Geometry remains an exact-kernel responsibility: the worker consumes the
// projection requests below, places every solved occurrence, runs one complete
// OCCT HLR pass per view, and evaluates exact camera-frame B-rep support only
// for deterministic BOM representatives. This module refuses projection bounds
// without that evidence, so a display mesh or guessed box cannot masquerade as
// a drawing result.

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalKey(value) {
  return JSON.stringify(canonical(value));
}

export function assemblyDrawingCanonicalFingerprint(value) {
  const source = canonicalKey(value);
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4].map((entry) => (entry >>> 0).toString(16).padStart(8, '0')).join('');
}

function finiteTransform(value, label) {
  if (!Array.isArray(value) || value.length !== 16 || value.some((entry) => !Number.isFinite(entry))) {
    throw new Error(label + ' must contain sixteen finite numbers.');
  }
  return value.map(Number);
}

function catalogConfiguredPartNumber(part, parameterOverrides) {
  const catalog = part.extensions?.standardPartCatalog;
  if (!catalog || !catalog.configurationData) return null;
  const overridesKey = canonicalKey(parameterOverrides || {});
  if (overridesKey === canonicalKey({})) return null;
  for (const entry of Object.values(catalog.configurationData)) {
    if (entry && canonicalKey(entry.dimensions || {}) === overridesKey) {
      return String(entry.partNumber);
    }
  }
  throw new Error('Standard-part occurrence overrides for family "' + String(catalog.familyId)
    + '" match no catalog configuration; the BOM cannot assign an orderable part number.');
}

function partIdentity(part, parameterOverrides) {
  const metadata = part.metadata || {};
  const extensions = part.extensions || {};
  const partNumber = catalogConfiguredPartNumber(part, parameterOverrides)
    || String(metadata.partNumber || extensions.partNumber || part.id);
  const revision = String(metadata.revision || extensions.revision || '');
  const configurationKey = canonicalKey(parameterOverrides || {});
  return {
    key: canonicalKey({ partNumber, revision, configurationKey, partId: part.id }),
    partId: part.id,
    partNumber,
    revision,
    configurationKey,
    configuration: canonical(parameterOverrides || {}),
    description: String(metadata.description || part.name || part.id),
    material: metadata.material || extensions.material || null,
  };
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' });
}

function defaultViews(requested) {
  const accepted = new Set(['front', 'top', 'right', 'left', 'bottom', 'back', 'iso']);
  const values = Array.isArray(requested) && requested.length ? requested : ['front', 'top', 'right', 'iso'];
  const views = [...new Set(values.map(String))];
  if (!views.length || views.length > 16 || views.some((view) => !accepted.has(view) && !/^drawing-view-\d{6}$/u.test(view))) {
    throw new Error('Assembly drawing contains an unsupported projection view.');
  }
  return views;
}

export function createAssemblyDrawingPlan(project, assemblySolution, options = {}) {
  if (!project || typeof project !== 'object' || !assemblySolution || typeof assemblySolution !== 'object') {
    throw new Error('Assembly drawing requires a project and solved assembly.');
  }
  const assemblyId = String(assemblySolution.assembly?.id || options.assemblyId || project.rootDocument?.assemblyId || '');
  const assembly = (project.assemblyDefinitions || []).find((entry) => entry.id === assemblyId);
  if (!assembly) throw new Error('Assembly drawing root does not resolve.');
  if (assemblySolution.usedLastValid) throw new Error('Assembly drawing refuses a last-valid fallback placement.');
  if (Array.isArray(assemblySolution.errors) && assemblySolution.errors.length) throw new Error('Assembly drawing refuses a solve with mate errors.');
  if (assemblySolution.state === 'conflicting' || assemblySolution.state === 'over-constrained') {
    throw new Error('Assembly drawing refuses a conflicting mate solution.');
  }
  const parts = new Map((project.partDefinitions || []).map((part) => [part.id, part]));
  const leaves = Array.isArray(assemblySolution.leafOccurrences) ? assemblySolution.leafOccurrences : [];
  const instances = [];
  const instanceIds = new Set();
  for (const leaf of leaves) {
    if (leaf?.suppressed === true || leaf?.definition?.kind !== 'part') continue;
    const part = parts.get(leaf.definition.partId);
    if (!part) throw new Error('Assembly drawing occurrence references missing part "' + leaf.definition.partId + '".');
    const occurrencePath = Array.isArray(leaf.occurrencePath) ? leaf.occurrencePath.map(String) : [];
    if (!occurrencePath.length) throw new Error('Assembly drawing occurrence has no persistent occurrence path.');
    const instanceId = String(leaf.id || occurrencePath.join('/'));
    if (!instanceId || instanceIds.has(instanceId)) throw new Error('Assembly drawing occurrence instance ids are missing or ambiguous.');
    instanceIds.add(instanceId);
    const identity = partIdentity(part, leaf.parameterOverrides || {});
    instances.push({
      instanceId,
      occurrencePath,
      occurrenceName: String(leaf.name || part.name || part.id),
      definitionPartId: part.id,
      transform: finiteTransform(leaf.transform, 'assembly drawing occurrence "' + instanceId + '" transform'),
      visible: leaf.visible !== false,
      identity,
      patternInstance: leaf.patternInstance ? canonical(leaf.patternInstance) : null,
    });
  }
  if (!instances.length) throw new Error('Assembly drawing has no unsuppressed part occurrences.');
  instances.sort((left, right) => compareText(left.instanceId, right.instanceId));

  const grouped = new Map();
  for (const instance of instances) {
    if (!grouped.has(instance.identity.key)) grouped.set(instance.identity.key, []);
    grouped.get(instance.identity.key).push(instance);
  }
  const bom = [...grouped].map(([key, entries]) => ({
    key,
    ...entries[0].identity,
    quantity: entries.length,
    instanceIds: entries.map((entry) => entry.instanceId).sort(compareText),
    occurrencePaths: entries.map((entry) => entry.occurrencePath),
  })).sort((left, right) =>
    compareText(left.partNumber, right.partNumber) ||
    compareText(left.revision, right.revision) ||
    compareText(left.configurationKey, right.configurationKey) ||
    compareText(left.partId, right.partId));
  bom.forEach((entry, index) => { entry.itemNumber = index + 1; });
  const itemByInstance = new Map(bom.flatMap((entry) => entry.instanceIds.map((instanceId) => [instanceId, entry.itemNumber])));
  const instanceLedger = instances.map((entry) => ({
    instanceId: entry.instanceId,
    occurrencePath: entry.occurrencePath,
    definitionPartId: entry.definitionPartId,
    occurrenceName: entry.occurrenceName,
    transform: entry.transform,
    visible: entry.visible,
    bomItemNumber: itemByInstance.get(entry.instanceId),
    patternInstance: entry.patternInstance,
  }));
  const projectionInstances = instanceLedger.filter((entry) => entry.visible);
  if (!projectionInstances.length) throw new Error('Assembly drawing has no visible occurrence to project.');
  const views = defaultViews(options.views);
  const annotationProjectionView = views.includes('front') ? 'front' : views[0];
  const visibleInstanceIds = new Set(projectionInstances.map((entry) => entry.instanceId));
  const annotationRepresentatives = bom.flatMap((item) => {
    const instanceId = item.instanceIds.find((entry) => visibleInstanceIds.has(entry));
    return instanceId ? [{ itemNumber: item.itemNumber, instanceId }] : [];
  });
  const placementLedgerFingerprint = assemblyDrawingCanonicalFingerprint(instanceLedger.map((entry) => ({
    instanceId: entry.instanceId,
    occurrencePath: entry.occurrencePath,
    definitionPartId: entry.definitionPartId,
    transform: entry.transform,
    visible: entry.visible,
  })));
  const revisionKey = String(options.revisionKey || canonicalKey({
    assemblyId,
    instances: instances.map((entry) => ({ id: entry.instanceId, path: entry.occurrencePath, transform: entry.transform })),
  }));
  return {
    schema: 'partmode.assembly-drawing-plan/v2',
    assemblyId,
    assemblyName: String(assembly.name || assembly.id),
    units: project.units || 'mm',
    revisionKey,
    solverState: assemblySolution.state,
    annotationProjectionView,
    placementLedgerFingerprint,
    annotationRepresentatives,
    warnings: assemblySolution.state === 'under-constrained'
      ? [{ code: 'ASSEMBLY_DRAWING_UNDER_CONSTRAINED', message: 'Drawing uses the persisted position of an under-constrained assembly.' }]
      : [],
    bom,
    instances: instanceLedger,
    projectionRequests: views.map((view) => ({
      view,
      exactAssemblyPass: {
        kind: 'occt-hlr-placed-compound',
        placementLedgerFingerprint,
        instanceCount: projectionInstances.length,
      },
      exactOccurrencePass: {
        kind: view === annotationProjectionView
          ? 'occt-brep-camera-support'
          : 'not-required-outside-annotation-view',
        instanceIds: view === annotationProjectionView
          ? annotationRepresentatives.map((entry) => entry.instanceId)
          : [],
      },
    })),
  };
}

function normalizedBox(value, label) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((entry) => !Number.isFinite(entry)) || value[2] < 0 || value[3] < 0) {
    throw new Error(label + ' must contain finite x, y, width, and height values.');
  }
  return value.map(Number);
}

function unionBoxes(boxes) {
  const minimumX = Math.min(...boxes.map((box) => box[0]));
  const minimumY = Math.min(...boxes.map((box) => box[1]));
  const maximumX = Math.max(...boxes.map((box) => box[0] + box[2]));
  const maximumY = Math.max(...boxes.map((box) => box[1] + box[3]));
  return [minimumX, minimumY, maximumX - minimumX, maximumY - minimumY];
}

function finiteVector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length || value.some((entry) => !Number.isFinite(entry))) {
    throw new Error(label + ' must contain ' + length + ' finite numbers.');
  }
  return value.map(Number);
}

function vectorDot(left, right) {
  return left.reduce((sum, entry, index) => sum + entry * right[index], 0);
}

function vectorCross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function vectorLength(value) {
  return Math.hypot(...value);
}

function closeNumber(left, right, tolerance = 1e-8) {
  return Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(left), Math.abs(right));
}

function closeVector(left, right, tolerance = 1e-8) {
  return left.length === right.length && left.every((entry, index) => closeNumber(entry, right[index], tolerance));
}

function exactCameraFrame(value, label) {
  const direction = finiteVector(value?.direction, 3, label + ' direction');
  const xAxis = finiteVector(value?.xAxis, 3, label + ' x-axis');
  const yAxis = finiteVector(value?.yAxis, 3, label + ' y-axis');
  if (!closeNumber(vectorLength(direction), 1) || !closeNumber(vectorLength(xAxis), 1)
    || !closeNumber(vectorLength(yAxis), 1) || Math.abs(vectorDot(direction, xAxis)) > 1e-8
    || !closeVector(vectorCross(direction, xAxis), yAxis)) {
    throw new Error(label + ' is not an orthonormal drawing camera frame.');
  }
  return { direction, xAxis, yAxis };
}

function matrixVector(matrix, vector) {
  return matrix.slice(0, 3).map((row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);
}

function matrixDeterminant(matrix) {
  const [a, b, c] = matrix;
  return a[0] * (b[1] * c[2] - b[2] * c[1])
    - a[1] * (b[0] * c[2] - b[2] * c[0])
    + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

function exactSupportRecord(value, frame, label) {
  if (value?.rangeMethod !== 'rigid-camera-frame-AddOptimal') {
    throw new Error(label + ' did not use exact rigid camera-frame AddOptimal support.');
  }
  const x = finiteVector(value.x, 2, label + ' x range');
  const y = finiteVector(value.y, 2, label + ' y range');
  const depth = finiteVector(value.depth, 2, label + ' depth range');
  if (!(x[1] > x[0]) || !(y[1] > y[0]) || !(depth[1] >= depth[0])) {
    throw new Error(label + ' contains an inverted or empty exact support range.');
  }
  const transform = value.cameraTransform;
  const matrix = Array.isArray(transform?.matrix4x4) && transform.matrix4x4.length === 4
    ? transform.matrix4x4.map((row, index) => finiteVector(row, 4, label + ' camera matrix row ' + (index + 1)))
    : null;
  const linearRows = matrix?.slice(0, 3).map((row) => row.slice(0, 3)) || [];
  const linearColumns = linearRows.length === 3
    ? [0, 1, 2].map((column) => linearRows.map((row) => row[column]))
    : [];
  const orthonormalBasis = (basis) => basis.length === 3
    && basis.every((vector) => closeNumber(vectorLength(vector), 1))
    && Math.abs(vectorDot(basis[0], basis[1])) <= 1e-8
    && Math.abs(vectorDot(basis[0], basis[2])) <= 1e-8
    && Math.abs(vectorDot(basis[1], basis[2])) <= 1e-8;
  if (!matrix || transform.rigid !== true || !closeNumber(Number(transform.determinant), 1)
    || !closeVector(matrix[3], [0, 0, 0, 1]) || !closeNumber(matrixDeterminant(matrix), 1)
    || !orthonormalBasis(linearRows) || !orthonormalBasis(linearColumns)) {
    throw new Error(label + ' camera transform is not a current rigid transform.');
  }
  const sourceNormal = finiteVector(transform.sourceNormal, 3, label + ' source normal');
  const sourceXAxis = finiteVector(transform.sourceXAxis, 3, label + ' source x-axis');
  const targetNormal = finiteVector(transform.targetNormal, 3, label + ' target normal');
  const targetXAxis = finiteVector(transform.targetXAxis, 3, label + ' target x-axis');
  if (!closeVector(sourceNormal, frame.direction) || !closeVector(sourceXAxis, frame.xAxis)
    || !closeVector(targetNormal, [0, 0, 1]) || !closeVector(targetXAxis, [1, 0, 0])
    || !closeVector(matrixVector(matrix, sourceNormal), targetNormal)
    || !closeVector(matrixVector(matrix, sourceXAxis), targetXAxis)
    || !closeVector(matrixVector(matrix, frame.yAxis), [0, 1, 0])) {
    throw new Error(label + ' camera transform does not bind the supplied exact frame.');
  }
  return {
    rangeMethod: value.rangeMethod,
    x, y, depth,
    cameraTransform: canonical(transform),
  };
}

function exactOccurrenceSupport(entry, view, revisionKey) {
  const instanceId = String(entry?.instanceId || '');
  const label = 'assembly occurrence projection "' + instanceId + '"';
  const evidence = entry?.evidence;
  if (!instanceId || evidence?.schema !== 'partmode.drawing-brep-camera-support/v1'
    || evidence.kind !== 'occt-brep-camera-support' || evidence.revisionKey !== revisionKey) {
    throw new Error('Assembly drawing occurrence projection evidence is not current exact B-rep camera support.');
  }
  const frame = exactCameraFrame(evidence.frame, label + ' frame');
  if (!Array.isArray(evidence.supports) || !evidence.supports.length
    || !Number.isInteger(evidence.sourceBodyCount) || evidence.sourceBodyCount !== evidence.supports.length) {
    throw new Error('Assembly drawing occurrence projection evidence has incomplete exact body support.');
  }
  const supports = evidence.supports.map((support, index) => exactSupportRecord(
    support, frame, label + ' body ' + (index + 1),
  ));
  const expectedFingerprint = assemblyDrawingCanonicalFingerprint({
    revisionKey, view, instanceId, frame, supports,
  });
  if (evidence.supportFingerprint !== expectedFingerprint) {
    throw new Error('Assembly drawing occurrence projection support fingerprint is stale or altered.');
  }
  const supportBox = unionBoxes(supports.map((support) => [
    support.x[0], -support.y[1], support.x[1] - support.x[0], support.y[1] - support.y[0],
  ]));
  const viewBox = normalizedBox(entry.viewBox, label);
  if (!closeVector(viewBox, supportBox)) {
    throw new Error('Assembly drawing occurrence projection box does not match its exact B-rep support.');
  }
  return { instanceId, viewBox, frameKey: canonicalKey(frame), supportFingerprint: expectedFingerprint };
}

export function finalizeAssemblyDrawingAnnotations(plan, projectionEvidence, options = {}) {
  if (plan?.schema !== 'partmode.assembly-drawing-plan/v2') throw new Error('Assembly drawing plan schema is unsupported.');
  if (!projectionEvidence || projectionEvidence.kind !== 'occt-hlr-exact') {
    throw new Error('Assembly drawing annotations require exact OCCT HLR evidence.');
  }
  if (projectionEvidence.revisionKey !== plan.revisionKey) throw new Error('Assembly drawing projection evidence is stale.');
  if (!Array.isArray(plan.instances)) throw new Error('Assembly drawing plan placement ledger is missing.');
  const currentPlacementLedgerFingerprint = assemblyDrawingCanonicalFingerprint(plan.instances.map((entry) => ({
    instanceId: entry.instanceId,
    occurrencePath: entry.occurrencePath,
    definitionPartId: entry.definitionPartId,
    transform: entry.transform,
    visible: entry.visible,
  })));
  if (plan.placementLedgerFingerprint !== currentPlacementLedgerFingerprint) {
    throw new Error('Assembly drawing plan placement ledger fingerprint is stale or altered.');
  }
  if (projectionEvidence.placementLedgerFingerprint !== plan.placementLedgerFingerprint) {
    throw new Error('Assembly drawing projection evidence has a stale or altered placement ledger.');
  }
  const requestedViews = new Set(plan.projectionRequests.map((entry) => entry.view));
  const requestsByView = new Map(plan.projectionRequests.map((entry) => [entry.view, entry]));
  if (!Array.isArray(projectionEvidence.views)) throw new Error('Assembly drawing projection evidence has no views.');
  const views = new Map();
  for (const view of projectionEvidence.views) {
    if (!requestedViews.has(view?.view)) throw new Error('Assembly drawing projection evidence contains an unrequested view.');
    if (views.has(view.view)) throw new Error('Assembly drawing projection evidence repeats a requested view.');
    if (!Array.isArray(view.occurrences)) throw new Error('Assembly drawing occurrence projection evidence is missing.');
    const request = requestsByView.get(view.view);
    if (view.occurrencePassKind !== request.exactOccurrencePass.kind) {
      throw new Error('Assembly drawing occurrence projection evidence uses the wrong exact pass.');
    }
    const expectedInstanceIds = request.exactOccurrencePass.instanceIds;
    if (!Array.isArray(expectedInstanceIds)) throw new Error('Assembly drawing occurrence projection plan is malformed.');
    const occurrences = new Map();
    const supportFingerprints = new Map();
    let frameKey = null;
    for (const entry of view.occurrences) {
      const instanceId = String(entry?.instanceId || '');
      if (!instanceId || occurrences.has(instanceId)) throw new Error('Assembly drawing occurrence projection evidence is ambiguous.');
      if (request.exactOccurrencePass.kind === 'occt-brep-camera-support') {
        const support = exactOccurrenceSupport(entry, view.view, plan.revisionKey);
        if (frameKey != null && support.frameKey !== frameKey) {
          throw new Error('Assembly drawing occurrence projections do not share one exact camera frame.');
        }
        frameKey = support.frameKey;
        occurrences.set(instanceId, support.viewBox);
        supportFingerprints.set(instanceId, support.supportFingerprint);
      } else {
        occurrences.set(instanceId, normalizedBox(entry.viewBox, 'assembly occurrence projection "' + instanceId + '"'));
      }
    }
    if (occurrences.size !== expectedInstanceIds.length
      || expectedInstanceIds.some((instanceId) => !occurrences.has(instanceId))) {
      throw new Error('Assembly drawing occurrence projection evidence is incomplete for view "' + view.view + '".');
    }
    views.set(view.view, {
      view: view.view,
      assemblyViewBox: normalizedBox(view.assemblyViewBox, 'assembly projection "' + view.view + '"'),
      occurrences,
      supportFingerprints,
    });
  }
  if (views.size !== requestedViews.size || [...requestedViews].some((view) => !views.has(view))) {
    throw new Error('Assembly drawing projection evidence is missing a requested view.');
  }
  const balloonViewName = String(options.balloonView || plan.annotationProjectionView
    || (views.has('front') ? 'front' : views.keys().next().value || ''));
  const balloonView = views.get(balloonViewName);
  if (!balloonView) throw new Error('Assembly drawing balloon view has no exact projection.');
  const representatives = [];
  const diagnostics = [];
  for (const item of plan.bom) {
    const representative = plan.annotationRepresentatives.find((entry) => entry.itemNumber === item.itemNumber);
    if (!representative) {
      diagnostics.push({ code: 'ASSEMBLY_BOM_ITEM_NOT_VISIBLE', itemNumber: item.itemNumber, instanceIds: item.instanceIds });
      continue;
    }
    const instanceId = representative.instanceId;
    if (!balloonView.occurrences.has(instanceId)) {
      throw new Error('Assembly drawing projection is missing BOM representative "' + instanceId + '".');
    }
    const box = balloonView.occurrences.get(instanceId);
    representatives.push({
      itemNumber: item.itemNumber,
      quantity: item.quantity,
      instanceId,
      anchor: [box[0] + box[2], box[1] + box[3] / 2],
    });
  }
  representatives.sort((left, right) => left.anchor[1] - right.anchor[1] || left.itemNumber - right.itemNumber);
  const overall = balloonView.assemblyViewBox || unionBoxes([...balloonView.occurrences.values()]);
  const gap = Math.max(5, overall[2] * 0.08);
  const labelX = overall[0] + overall[2] + gap;
  const slotSpacing = Math.max(5, overall[3] / Math.max(1, representatives.length));
  const balloons = representatives.map((entry, index) => ({
    ...entry,
    view: balloonViewName,
    label: [labelX, overall[1] + slotSpacing * (index + 0.5)],
    leader: [entry.anchor, [labelX - gap * 0.35, overall[1] + slotSpacing * (index + 0.5)]],
    evidence: {
      kind: 'occt-brep-camera-support',
      revisionKey: projectionEvidence.revisionKey,
      supportFingerprint: balloonView.supportFingerprints.get(entry.instanceId),
      assemblyProjectionKind: projectionEvidence.kind,
    },
  }));
  return {
    ...plan,
    annotations: {
      balloonView: balloonViewName,
      balloons,
      diagnostics,
    },
    exactProjectionEvidence: {
      kind: projectionEvidence.kind,
      revisionKey: projectionEvidence.revisionKey,
      placementLedgerFingerprint: projectionEvidence.placementLedgerFingerprint,
      views: [...views.keys()].sort(compareText),
    },
  };
}
