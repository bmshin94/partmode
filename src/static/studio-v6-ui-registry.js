// Source-owned inventory for literal CAD Studio UI parity.
//
// This registry is deliberately broader than the currently implemented V6
// semantic adapter set. It is the release denominator: a human-operable
// production control cannot disappear merely because an agent adapter has not
// been written yet.

const clone = (value) => structuredClone(value);

const attributeBinding = (attribute, value) => Object.freeze({ kind: 'attribute', attribute, value });
const idBinding = (elementId) => Object.freeze({ kind: 'element-id', elementId });
const dynamicBinding = (family) => Object.freeze({ kind: 'dynamic-family', family });
const controlIdBinding = (controlId) => attributeBinding('data-v6-control-id', controlId);

function control(id, label, group, humanBindings, {
  kind = 'action',
  workspaceId = null,
  semanticAction = 'control.invoke',
  adapter = 'missing',
  permission = 'ui.navigate',
  operationKinds = [],
  fields = [],
  variants = [],
  contextualReasonCode = null,
  adapterTool = null,
  completionTool = null,
  commandId = null,
  commandResolver = null,
  templateId = null,
  sectionId = null,
  fieldId = null,
  semanticActions = null,
  permissions = null,
} = {}) {
  return Object.freeze({
    id,
    label,
    group,
    kind,
    workspaceId,
    humanBindings: Object.freeze(humanBindings),
    semanticAction,
    adapter,
    permission,
    operationKinds: Object.freeze(operationKinds),
    fields: Object.freeze(fields),
    variants: Object.freeze(variants),
    contextualReasonCode,
    adapterTool,
    completionTool,
    commandId,
    commandResolver,
    templateId,
    sectionId,
    fieldId,
    semanticActions,
    permissions,
  });
}

const variant = (id, label, options = {}) => Object.freeze({ id, label, ...options });
const controlBoundVariant = (id, label, options = {}) => variant(id, label, {
  humanBindings: Object.freeze([controlIdBinding(options.controlId || id)]),
  ...options,
});
const familyVariant = (parentControlId, id, label, options = {}) =>
  controlBoundVariant(id, label, { controlId: `${parentControlId}.${id}`, ...options });
const familyDocumentEditVariant = (parentControlId, id, label, operationKind) =>
  familyVariant(parentControlId, id, label, {
    semanticAction: 'document.previewCommit',
    adapter: 'available',
    permission: 'project.edit',
    adapterTool: 'cad_preview',
    completionTool: 'cad_commit',
    operationKinds: Object.freeze([operationKind]),
  });
const familyFeatureEditVariant = (parentControlId, id, label) =>
  familyVariant(parentControlId, id, label, {
    semanticAction: 'command.open',
    adapter: 'available',
    permission: 'ui.command-draft',
    commandResolver: 'selected-feature-kind',
  });
const familyEntityEditVariant = (parentControlId, id, label, commandId, commandResolver = null) =>
  familyVariant(parentControlId, id, label, {
    semanticAction: 'command.open',
    adapter: 'available',
    permission: 'ui.command-draft',
    commandId,
    commandResolver,
  });

const commandBinding = (value) => attributeBinding('data-v5-command', value);
const assemblyBinding = (value) => attributeBinding('data-assembly-command', value);
const mateBinding = (value) => attributeBinding('data-assembly-mate', value);
const inspectionBinding = (value) => attributeBinding('data-inspection-command', value);
const displayBinding = (value) => attributeBinding('data-display-mode', value);
const viewBindings = (value) => Object.freeze([
  attributeBinding('data-view', value),
  ...(['top', 'iso', 'fit'].includes(value) ? [attributeBinding('data-command-view', value)] : []),
  attributeBinding('data-cube-view', value),
]);

const TRANSFORM_FIELDS = Object.freeze([
  { id: 'occurrence', label: 'Component occurrence', kind: 'selection', required: true, minItems: 1, maxItems: 1, selectionKinds: ['occurrence'] },
  { id: 'gizmoMode', label: 'Handle mode', kind: 'enum', values: ['translate', 'rotate'], required: true },
  { id: 'gizmoSnap', label: 'Handle snap', kind: 'number-or-expression', required: true },
  { id: 'transform', label: 'Rigid 4×4 transform', kind: 'matrix4', required: true, finite: true },
]);

const textField = (id, label, options = {}) => Object.freeze({ id, label, kind: 'text', ...options });
const numberField = (id, label, options = {}) => Object.freeze({ id, label, kind: 'number-or-expression', ...options });
const literalNumberField = (id, label, options = {}) => Object.freeze({ id, label, kind: 'number', finite: true, ...options });
const booleanField = (id, label) => Object.freeze({ id, label, kind: 'boolean' });
const enumField = (id, label, values, options = {}) => Object.freeze({ id, label, kind: 'enum', values: Object.freeze(values), ...options });
const selectionField = (id, label, selectionKinds, options = {}) => Object.freeze({
  id,
  label,
  kind: 'selection',
  selectionKinds: Object.freeze(selectionKinds),
  ...options,
});
const vector3Field = (id, label, options = {}) => Object.freeze({ id, label, kind: 'vector3', finite: true, ...options });
const listField = (id, label, itemKind, options = {}) => Object.freeze({ id, label, kind: 'list', itemKind, ...options });
const pointsField = (id, label, dimensions, options = {}) => Object.freeze({ id, label, kind: 'points', dimensions, ...options });

const RESULT_POLICY_FIELDS = Object.freeze([
  enumField('resultPolicy', 'Result policy', ['new-body', 'add', 'subtract', 'intersect'], { required: true }),
  textField('bodyName', 'Result body name'),
  selectionField('targetBody', 'Target body', ['body'], { maxItems: 1 }),
]);

const SKETCH_FEATURE_FIELDS = Object.freeze([
  selectionField('supportFace', 'Sketch support face', ['face'], { maxItems: 1 }),
  listField('sketch', 'Sketch shapes', 'sketch-shape', { required: true, minItems: 1 }),
  numberField('height', 'Distance', { required: true }),
  enumField('patternKind', 'Feature pattern type', ['none', 'linear', 'circular'], { required: true }),
  numberField('patternCount', 'Feature pattern count', { required: true }),
  numberField('patternA', 'Feature pattern first spacing', { required: true }),
  numberField('patternB', 'Feature pattern second spacing', { required: true }),
  ...RESULT_POLICY_FIELDS,
]);

const CUT_FEATURE_FIELDS = Object.freeze(SKETCH_FEATURE_FIELDS.map((field) =>
  field.id === 'resultPolicy'
    ? enumField('resultPolicy', 'Result policy', ['subtract'], { required: true })
    : field));

const EDGE_FEATURE_FIELDS = Object.freeze([
  selectionField('edges', 'Edges', ['edge'], { required: true, minItems: 1 }),
  numberField('radius', 'Radius', { required: true }),
]);

const FILLET_EDGE_FEATURE_FIELDS = Object.freeze([
  ...EDGE_FEATURE_FIELDS,
  booleanField('tangentPropagation', 'Propagate exact tangent chain'),
]);

const BODY_SELECTION_FIELD = selectionField('body', 'Body', ['body'], {
  required: true,
  minItems: 1,
  maxItems: 1,
});

const MOVE_BODY_FIELDS = Object.freeze([
  BODY_SELECTION_FIELD,
  vector3Field('translation', 'Translation', { required: true }),
  numberField('gizmoSnap', 'Handle snap', { required: true }),
]);

const ROTATE_BODY_FIELDS = Object.freeze([
  BODY_SELECTION_FIELD,
  selectionField('axisDatum', 'Rotation axis', ['datum'], { required: true, minItems: 1, maxItems: 1 }),
  numberField('angle', 'Angle', { required: true }),
  numberField('gizmoSnap', 'Handle snap', { required: true }),
]);

const MIRROR_BODY_FIELDS = Object.freeze([
  BODY_SELECTION_FIELD,
  selectionField('planeDatum', 'Mirror plane', ['datum'], { required: true, minItems: 1, maxItems: 1 }),
  booleanField('moveOriginal', 'Move original instead of creating a linked mirror'),
]);

const SCALE_BODY_FIELDS = Object.freeze([
  BODY_SELECTION_FIELD,
  numberField('factor', 'Uniform factor', { required: true }),
  vector3Field('center', 'Scale center', { required: true }),
]);

const ALIGN_BODY_FIELDS = Object.freeze([
  BODY_SELECTION_FIELD,
  selectionField('fromDatum', 'From reference', ['datum'], { required: true, minItems: 1, maxItems: 1 }),
  selectionField('toDatum', 'To reference', ['datum'], { required: true, minItems: 1, maxItems: 1 }),
  numberField('offset', 'Alignment offset', { required: true }),
  booleanField('flip', 'Flip alignment'),
]);

const MATE_FIELDS = Object.freeze([
  textField('name', 'Mate name', { required: true }),
  selectionField('anchorOccurrence', 'Anchor component', ['occurrence'], { minItems: 1, maxItems: 1 }),
  selectionField('movingOccurrence', 'Moving component', ['occurrence'], { required: true, minItems: 1, maxItems: 1 }),
  selectionField('anchorReference', 'Anchor topology reference', ['occurrence', 'datum', 'face', 'edge'], { maxItems: 1 }),
  selectionField('movingReference', 'Moving topology reference', ['occurrence', 'datum', 'face', 'edge'], { maxItems: 1 }),
  numberField('value', 'Offset, distance, or angle'),
  booleanField('flip', 'Flip alignment direction'),
]);

const ADVANCED_MATE_FRAME_REFERENCE_KINDS = Object.freeze(['occurrence', 'datum']);
const advancedMateOccurrenceField = (id, label) =>
  selectionField(id, label, ['occurrence'], { required: true, minItems: 1, maxItems: 1 });
const advancedMateReferenceField = (id, label, selectionKinds = ADVANCED_MATE_FRAME_REFERENCE_KINDS) =>
  selectionField(id, label, selectionKinds, { required: true, minItems: 1, maxItems: 1 });

const WIDTH_MATE_FIELDS = Object.freeze([
  textField('name', 'Mate name', { required: true }),
  advancedMateOccurrenceField('widthOccurrence', 'Width component'),
  advancedMateReferenceField('widthFirstReference', 'First width reference'),
  advancedMateReferenceField('widthSecondReference', 'Second width reference'),
  advancedMateOccurrenceField('tabOccurrence', 'Tab component'),
  advancedMateReferenceField('tabFirstReference', 'First tab reference'),
  advancedMateReferenceField('tabSecondReference', 'Second tab reference'),
]);

const SYMMETRY_MATE_FIELDS = Object.freeze([
  textField('name', 'Mate name', { required: true }),
  advancedMateOccurrenceField('symmetryFirstOccurrence', 'First symmetric component'),
  advancedMateReferenceField('symmetryFirstReference', 'First symmetric reference'),
  advancedMateOccurrenceField('symmetrySecondOccurrence', 'Second symmetric component'),
  advancedMateReferenceField('symmetrySecondReference', 'Second symmetric reference'),
  advancedMateOccurrenceField('symmetryPlaneOccurrence', 'Symmetry-plane component'),
  advancedMateReferenceField('symmetryPlaneReference', 'Symmetry-plane reference'),
]);

const PATH_MATE_FIELDS = Object.freeze([
  textField('name', 'Mate name', { required: true }),
  advancedMateOccurrenceField('pathOccurrence', 'Path component'),
  advancedMateReferenceField('pathReference', 'Path reference', ['sketch']),
  advancedMateOccurrenceField('followerOccurrence', 'Follower component'),
  advancedMateReferenceField('followerReference', 'Follower reference'),
]);

const LINEAR_COUPLER_MATE_FIELDS = Object.freeze([
  textField('name', 'Mate name', { required: true }),
  advancedMateOccurrenceField('firstOccurrence', 'First component'),
  advancedMateReferenceField('firstReference', 'First axis reference'),
  advancedMateOccurrenceField('secondOccurrence', 'Second component'),
  advancedMateReferenceField('secondReference', 'Second axis reference'),
  numberField('ratio', 'Motion ratio', { required: true }),
  numberField('offset', 'Motion offset', { required: true }),
]);

const LIMIT_MATE_FIELDS = Object.freeze([
  textField('name', 'Mate name', { required: true }),
  advancedMateOccurrenceField('anchorOccurrence', 'Anchor component'),
  advancedMateReferenceField('anchorReference', 'Anchor reference'),
  advancedMateOccurrenceField('movingOccurrence', 'Moving component'),
  advancedMateReferenceField('movingReference', 'Moving reference'),
  numberField('minimum', 'Minimum limit', { required: true }),
  numberField('maximum', 'Maximum limit', { required: true }),
]);

// Mechanical mates constrain rotation about persistent axis datums only, so
// their reference fields deliberately exclude component-origin selections.
const GEAR_MATE_FIELDS = Object.freeze([
  textField('name', 'Mate name', { required: true }),
  advancedMateOccurrenceField('gearFirstOccurrence', 'First gear component'),
  advancedMateReferenceField('gearFirstReference', 'First gear axis reference', ['datum']),
  advancedMateOccurrenceField('gearSecondOccurrence', 'Second gear component'),
  advancedMateReferenceField('gearSecondReference', 'Second gear axis reference', ['datum']),
  numberField('ratio', 'Gear ratio', { required: true }),
  numberField('offset', 'Angular offset', { required: true }),
]);

const HINGE_MATE_FIELDS = Object.freeze([
  textField('name', 'Mate name', { required: true }),
  advancedMateOccurrenceField('hingeFirstOccurrence', 'First hinge component'),
  advancedMateReferenceField('hingeFirstReference', 'First hinge axis reference', ['datum']),
  advancedMateOccurrenceField('hingeSecondOccurrence', 'Second hinge component'),
  advancedMateReferenceField('hingeSecondReference', 'Second hinge axis reference', ['datum']),
  numberField('minimum', 'Minimum angle limit'),
  numberField('maximum', 'Maximum angle limit'),
]);

const COMMAND_FIELD_CONTRACTS = Object.freeze({
  'model.extrude': SKETCH_FEATURE_FIELDS,
  'model.cut': Object.freeze([...CUT_FEATURE_FIELDS, booleanField('through', 'Through all')]),
  'model.revolve': Object.freeze([
    listField('sketch', 'Sketch shapes', 'sketch-shape', { required: true, minItems: 1 }),
    ...RESULT_POLICY_FIELDS,
  ]),
  'model.fillet': FILLET_EDGE_FEATURE_FIELDS,
  'model.chamfer': EDGE_FEATURE_FIELDS,
  'model.shell': Object.freeze([
    selectionField('body', 'Body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('faces', 'Faces to remove', ['face'], { required: true, minItems: 1 }),
    numberField('thickness', 'Wall thickness', { required: true }),
  ]),
  'model.split': Object.freeze([
    textField('name', 'Split name', { required: true }),
    selectionField('targetBody', 'Target body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('toolBody', 'Splitting tool body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
    booleanField('keepOriginal', 'Keep original target visible'),
    booleanField('keepTools', 'Keep tool bodies visible'),
  ]),
  'model.plane': Object.freeze([
    textField('name', 'Plane name', { required: true }),
    enumField('mode', 'Plane definition', ['offset', 'angle', 'three-point', 'point-normal', 'midplane', 'curve-normal'], { required: true }),
    selectionField('referenceDatum', 'Reference plane', ['datum'], { maxItems: 1 }),
    selectionField('axisDatum', 'Rotation axis', ['datum'], { maxItems: 1 }),
    selectionField('firstDatum', 'First mid-plane reference', ['datum'], { maxItems: 1 }),
    selectionField('secondDatum', 'Second mid-plane reference', ['datum'], { maxItems: 1 }),
    selectionField('pointDatum', 'Point datum', ['datum'], { maxItems: 1 }),
    numberField('offset', 'Offset'),
    numberField('angle', 'Angle'),
    pointsField('points', 'Plane points', 3, { minItems: 3, maxItems: 3 }),
    vector3Field('normal', 'Normal'),
  ]),
  'model.coordinate-system': Object.freeze([
    textField('name', 'Coordinate-system name', { required: true }),
    vector3Field('origin', 'Origin', { required: true }),
    vector3Field('xDirection', 'X direction', { required: true }),
    vector3Field('zDirection', 'Z direction', { required: true }),
  ]),
  'model.curve-point': Object.freeze([
    textField('name', 'Point name', { required: true }),
    selectionField('pathSketch', 'Curve path', ['sketch'], { required: true, minItems: 1, maxItems: 1 }),
    numberField('parameter', 'Normalized path parameter', { required: true, min: 0, max: 1 }),
  ]),
  'model.reference-curve': Object.freeze([
    textField('name', 'Reference-curve name', { required: true }),
    enumField('referenceKind', 'Curve definition', ['projected', 'composite', 'helix'], { required: true }),
    selectionField('sourcePaths', 'Source paths', ['sketch'], { minItems: 0, maxItems: 64 }),
    selectionField('planeDatum', 'Projection plane', ['datum'], { maxItems: 1 }),
    selectionField('axisDatum', 'Helix axis', ['datum'], { maxItems: 1 }),
    numberField('radius', 'Helix radius'),
    numberField('pitch', 'Helix pitch'),
    numberField('turns', 'Helix turns'),
    numberField('startAngle', 'Helix start angle'),
    enumField('handedness', 'Helix handedness', ['right', 'left']),
  ]),
  'model.align': ALIGN_BODY_FIELDS,
  'model.profile': Object.freeze([
    textField('name', 'Profile name', { required: true }),
    enumField('curveKind', 'Curve kind', ['spline', 'polyline'], { required: true }),
    selectionField('planeDatum', 'Profile plane', ['datum'], { required: true, minItems: 1, maxItems: 1 }),
    pointsField('points', 'Profile points', 2, { required: true, minItems: 2 }),
  ]),
  'model.path': Object.freeze([
    textField('name', 'Path name', { required: true }),
    enumField('curveKind', 'Curve kind', ['spline', 'polyline'], { required: true }),
    pointsField('points', 'Path points', 3, { required: true, minItems: 2 }),
  ]),
  'model.loft': Object.freeze([
    textField('name', 'Loft name', { required: true }),
    selectionField('sections', 'Profile sections', ['sketch'], { required: true, minItems: 2 }),
    selectionField('guideSketch', 'Guide rail', ['sketch'], { maxItems: 1 }),
    selectionField('centerlineSketch', 'Centerline', ['sketch'], { maxItems: 1 }),
    enumField('startContinuity', 'Start continuity', ['free', 'tangent', 'curvature'], { required: true }),
    enumField('endContinuity', 'End continuity', ['free', 'tangent', 'curvature'], { required: true }),
    booleanField('ruled', 'Ruled loft'),
  ]),
  'model.sweep': Object.freeze([
    textField('name', 'Sweep name', { required: true }),
    selectionField('profileSketch', 'Profile', ['sketch'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('pathSketch', 'Path', ['sketch'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('guideSketch', 'Guide rail', ['sketch'], { maxItems: 1 }),
    enumField('orientation', 'Orientation', ['path-normal', 'minimum-twist', 'fixed', 'reference', 'guide'], { required: true }),
    numberField('twistAngle', 'Twist angle'),
    numberField('scaleEnd', 'End scale'),
    vector3Field('referenceDirection', 'Reference direction'),
  ]),
  'model.revolve-advanced': Object.freeze([
    textField('name', 'Revolve name', { required: true }),
    selectionField('profileSketch', 'Profile', ['sketch'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('axisDatum', 'Axis', ['datum'], { required: true, minItems: 1, maxItems: 1 }),
    numberField('angle', 'Sweep angle', { required: true }),
    numberField('startAngle', 'Start angle'),
    booleanField('symmetric', 'Symmetric'),
  ]),
  'model.draft': Object.freeze([
    textField('name', 'Draft name', { required: true }),
    selectionField('body', 'Body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('neutralPlane', 'Neutral plane', ['datum'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('faces', 'Faces', ['face'], { required: true, minItems: 1 }),
    numberField('angle', 'Draft angle', { required: true }),
    booleanField('flip', 'Flip angle'),
  ]),
  'model.thicken': Object.freeze([
    textField('name', 'Thicken name', { required: true }),
    selectionField('body', 'Body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('faces', 'Source face', ['face'], { required: true, minItems: 1, maxItems: 1 }),
    textField('bodyName', 'New body name', { required: true }),
    numberField('thickness', 'Thickness', { required: true }),
    booleanField('symmetric', 'Symmetric thickness'),
    booleanField('flip', 'Flip direction'),
  ]),
  'model.variable-fillet': Object.freeze([
    textField('name', 'Variable fillet name', { required: true }),
    selectionField('body', 'Body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('edges', 'Edges', ['edge'], { required: true, minItems: 1 }),
    numberField('startRadius', 'Start radius', { required: true }),
    numberField('endRadius', 'End radius', { required: true }),
  ]),
  'model.face-fillet': Object.freeze([
    textField('name', 'Face fillet name', { required: true }),
    selectionField('body', 'Body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('faces', 'Adjacent faces', ['face'], { required: true, minItems: 2, maxItems: 2 }),
    numberField('radius', 'Radius', { required: true }),
  ]),
  'model.weld-bead': Object.freeze([
    textField('name', 'Weld-bead name', { required: true }),
    selectionField('supports', 'Two persistent structural-member face/edge supports', ['face', 'edge'], {
      required: true,
      minItems: 4,
      maxItems: 4,
    }),
    literalNumberField('sizeMm', 'Equal leg size in millimetres', {
      required: true,
      minimum: 0.0000001,
      maximum: 10_000,
    }),
    textField('process', 'Weld process'),
  ]),
  'model.pattern': Object.freeze([
    textField('name', 'Pattern name', { required: true }),
    selectionField('sourceBody', 'Source body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
    enumField('patternKind', 'Pattern type', ['circular', 'linear', 'curve', 'mirror', 'sketch', 'fill', 'variable'], { required: true }),
    enumField('outputMode', 'Output mode', ['linked', 'union'], { required: true }),
    numberField('count', 'Count', { required: true }),
    selectionField('axisDatum', 'Axis', ['datum'], { maxItems: 1 }),
    selectionField('directionDatums', 'Directions', ['datum'], { maxItems: 2 }),
    selectionField('planeDatum', 'Mirror plane', ['datum'], { maxItems: 1 }),
    selectionField('pathSketch', 'Curve path', ['sketch'], { maxItems: 1 }),
    selectionField('pointSketch', 'Solved point sketch', ['sketch'], { maxItems: 1 }),
    selectionField('boundarySketch', 'Closed fill boundary', ['sketch'], { maxItems: 1 }),
    enumField('distribution', 'Distribution', ['full', 'spacing', 'extent', 'equal', 'table', 'points', 'fill'], { required: true }),
    enumField('orientation', 'Orientation', ['rotate', 'preserve', 'alternating', 'tangent', 'fixed'], { required: true }),
    numberField('spacing', 'Linear spacing', { required: true }),
    numberField('extent', 'Linear extent', { required: true }),
    numberField('count2', 'Second direction count', { required: true }),
    numberField('spacing2', 'Second direction spacing', { required: true }),
    numberField('extent2', 'Second direction extent', { required: true }),
    numberField('totalAngle', 'Total angle', { required: true }),
    numberField('spacingAngle', 'Spacing angle', { required: true }),
    numberField('radialOffset', 'Radial offset', { required: true }),
    numberField('axialOffset', 'Axial offset', { required: true }),
    booleanField('symmetric', 'Symmetric distribution'),
    booleanField('symmetric2', 'Symmetric second direction'),
    listField('tableValues', 'Table values', 'number-or-expression'),
    listField('tableValues2', 'Second direction table values', 'number-or-expression'),
    listField('skippedIndices', 'Skipped indices', 'integer'),
    listField('pointIds', 'Ordered solved point IDs', 'stable-id'),
    enumField('fillLayout', 'Fill lattice', ['square', 'triangular']),
    numberField('fillRotation', 'Fill lattice rotation'),
    numberField('boundaryMargin', 'Fill boundary margin'),
    numberField('seedX', 'Fill seed X'),
    numberField('seedY', 'Fill seed Y'),
    literalNumberField('maximumCount', 'Fill occurrence safety cap', { minimum: 2, maximum: 5_000 }),
    listField('variableInstances', 'Variable rows', 'pattern-variable-instance'),
  ]),
  'model.move': MOVE_BODY_FIELDS,
  'model.copy': MOVE_BODY_FIELDS,
  'model.rotate': ROTATE_BODY_FIELDS,
  'model.mirror': MIRROR_BODY_FIELDS,
  'model.scale': SCALE_BODY_FIELDS,
  'assembly.create': Object.freeze([
    textField('name', 'Assembly name', { required: true }),
    textField('occurrenceName', 'First occurrence name', { required: true }),
    booleanField('fixed', 'Fix first component'),
  ]),
  'assembly.insert': Object.freeze([
    selectionField('definition', 'Reusable definition', ['part', 'assembly'], { required: true, minItems: 1, maxItems: 1 }),
    textField('name', 'Occurrence name', { required: true }),
    vector3Field('translation', 'Translation'),
    booleanField('fixed', 'Fix component'),
  ]),
  'assembly.smart-fastener': Object.freeze([
    selectionField('targetOccurrence', 'Fixed direct component with one clearance Hole Wizard hole', ['occurrence'], {
      required: true,
      minItems: 1,
      maxItems: 1,
    }),
    textField('name', 'Smart Fastener name', { required: true }),
    Object.freeze({
      id: 'plan',
      label: 'Current exact recognition plan',
      kind: 'exact-plan',
      required: true,
      readOnly: true,
      schema: 'partmode.smart-fastener-plan/v1',
    }),
  ]),
  'assembly.feature': Object.freeze([
    selectionField('targetBodies', 'Direct occurrence bodies', ['body'], {
      required: true,
      minItems: 1,
      maxItems: 64,
    }),
    textField('name', 'Assembly feature name', { required: true }),
    enumField('kind', 'Feature family', ['cut', 'hole'], { required: true }),
    vector3Field('origin', 'Assembly-space origin', { required: true }),
    vector3Field('direction', 'Through-all direction', { required: true }),
    vector3Field('xDirection', 'Profile X direction', { required: true }),
    literalNumberField('width', 'Rectangular cut width', { minimum: 0.001, maximum: 100_000 }),
    literalNumberField('height', 'Rectangular cut height', { minimum: 0.001, maximum: 100_000 }),
    literalNumberField('diameter', 'Circular hole diameter', { minimum: 0.001, maximum: 100_000 }),
    booleanField('suppressed', 'Suppress assembly feature'),
  ]),
  'assembly.linked': Object.freeze([
    selectionField('occurrence', 'Source occurrence', ['occurrence'], { required: true, minItems: 1, maxItems: 1 }),
    textField('name', 'Occurrence name', { required: true }),
    vector3Field('translation', 'Translation'),
  ]),
  'assembly.independent': Object.freeze([
    selectionField('occurrence', 'Source occurrence', ['occurrence'], { required: true, minItems: 1, maxItems: 1 }),
    textField('name', 'Independent part name', { required: true }),
  ]),
  'assembly.replace': Object.freeze([
    selectionField('occurrence', 'Occurrence', ['occurrence'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('definition', 'Replacement definition', ['part', 'assembly'], { required: true, minItems: 1, maxItems: 1 }),
  ]),
  'assembly.variant': Object.freeze([
    selectionField('occurrence', 'Occurrence', ['occurrence'], { required: true, minItems: 1, maxItems: 1 }),
    listField('parameterOverrides', 'Parameter overrides', 'name-expression'),
  ]),
  'assembly.component-transform': TRANSFORM_FIELDS,
  'assembly.edit-context': Object.freeze([
    selectionField('occurrence', 'Occurrence', ['occurrence'], { required: true, minItems: 1, maxItems: 1 }),
  ]),
  'assembly.exit-context': Object.freeze([]),
  'assembly.pattern': Object.freeze([
    selectionField('occurrence', 'Source occurrence', ['occurrence'], { required: true, minItems: 1, maxItems: 1 }),
    textField('name', 'Pattern name', { required: true }),
    enumField('patternKind', 'Pattern type', ['circular', 'linear'], { required: true }),
    numberField('generatedCount', 'Generated count', { required: true, integer: true, minimum: 1 }),
    numberField('spacing', 'Spacing'),
    numberField('totalAngle', 'Total angle'),
  ]),
  ...Object.fromEntries([
    'fixed', 'coincident', 'concentric', 'distance', 'angle',
    'parallel', 'perpendicular', 'tangent', 'revolute', 'slider',
  ].map((kind) => [`assembly.mate.${kind}`, MATE_FIELDS])),
  'assembly.mate.width': WIDTH_MATE_FIELDS,
  'assembly.mate.symmetry': SYMMETRY_MATE_FIELDS,
  'assembly.mate.path': PATH_MATE_FIELDS,
  'assembly.mate.linear-coupler': LINEAR_COUPLER_MATE_FIELDS,
  'assembly.mate.limit-distance': LIMIT_MATE_FIELDS,
  'assembly.mate.limit-angle': LIMIT_MATE_FIELDS,
  'assembly.mate.gear': GEAR_MATE_FIELDS,
  'assembly.mate.hinge': HINGE_MATE_FIELDS,
  'inspection.section': Object.freeze([
    textField('name', 'Section name', { required: true }),
    enumField('sectionKind', 'Section mode', ['plane', 'quarter', 'box'], { required: true }),
    numberField('offset', 'Offset', { required: true }),
    selectionField('scopeOccurrence', 'Scope occurrence', ['occurrence'], { maxItems: 1 }),
    booleanField('cap', 'Section cap'),
    booleanField('reverse', 'Reverse'),
    numberField('hatchSpacing', 'Hatch spacing', { required: true }),
    numberField('hatchAngle', 'Hatch angle', { required: true }),
    textField('capFillColor', 'Cap fill color', { format: 'color' }),
    textField('hatchColor', 'Hatch color', { format: 'color' }),
  ]),
  'inspection.explode': Object.freeze([
    textField('name', 'View name', { required: true }),
    selectionField('occurrence', 'Occurrence', ['occurrence'], { required: true, minItems: 1, maxItems: 1 }),
    vector3Field('translation', 'Translation', { required: true }),
  ]),
  'inspection.stage': Object.freeze([
    textField('name', 'Stage group name', { required: true }),
    listField('occurrenceIds', 'Ordered occurrences', 'occurrence-id', { required: true, minItems: 1 }),
    listField('distanceMateIds', 'Distance mates', 'mate-id', { required: true, minItems: 1 }),
    numberField('start', 'First station', { required: true }),
    numberField('spacing', 'Stage spacing', { required: true }),
    booleanField('visible', 'Group visibility'),
  ]),
  'inspection.material': Object.freeze([
    selectionField('body', 'Body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('material', 'Material', ['material'], { required: true, minItems: 1, maxItems: 1 }),
  ]),
  'inspection.measure': Object.freeze([
    textField('name', 'Measurement name', { required: true }),
    enumField('measurementKind', 'Measurement type', ['bounding-box', 'minimum-clearance'], { required: true }),
    selectionField('bodies', 'Bodies', ['body'], { required: true, minItems: 1, maxItems: 2 }),
  ]),
});

const projectControls = [
  control('history.undo', 'Undo', 'project', [idBinding('bw-undo'), attributeBinding('data-command-target', 'bw-undo')], { semanticAction: 'history.undo', adapter: 'available', permission: 'project.edit' }),
  control('history.redo', 'Redo', 'project', [idBinding('bw-redo'), attributeBinding('data-command-target', 'bw-redo')], { semanticAction: 'history.redo', adapter: 'available', permission: 'project.edit' }),
  control('diagnostics.design-check', 'Design check and feature diagnosis', 'project', [idBinding('bw-design-check')], { semanticAction: 'diagnostics.show', adapter: 'available', permission: 'ui.navigate', adapterTool: 'cad_ui' }),
  control('project.templates', 'Template library', 'project', [idBinding('bw-templates-open'), attributeBinding('data-command-target', 'bw-templates-open')], { adapter: 'available' }),
  control('project.save', 'Save project file', 'project', [idBinding('bw-save-file'), attributeBinding('data-command-target', 'bw-save-file')], { semanticAction: 'artifact.export-project', adapter: 'available', permission: 'artifact.export-project' }),
  control('project.open', 'Open project, STEP, or DXF profile', 'project', [idBinding('bw-open-btn'), idBinding('bw-open-file'), attributeBinding('data-command-target', 'bw-open-btn')], {
    semanticAction: 'artifact.import',
    adapter: 'available',
    permission: 'project.replace',
    adapterTool: 'cad_artifact',
  }),
  control('project.recover', 'Recover local project', 'project', [idBinding('bw-recover-open'), attributeBinding('data-command-target', 'bw-recover-open')], { semanticAction: 'recovery.open', adapter: 'available', permission: 'project.recover' }),
  control('project.clear', 'Clear project', 'project', [idBinding('bw-clear'), attributeBinding('data-command-target', 'bw-clear')], { adapter: 'available' }),
  control('export.step', 'Export STEP', 'project', [idBinding('bw-export-step'), attributeBinding('data-command-target', 'bw-export-step')], { semanticAction: 'artifact.export-step', adapter: 'available', permission: 'artifact.export-step' }),
  control('export.stl', 'Export STL', 'project', [idBinding('bw-export-stl'), attributeBinding('data-command-target', 'bw-export-stl')], { semanticAction: 'artifact.export-stl', adapter: 'available', permission: 'artifact.export-stl' }),
  control('export.amf', 'Export AMF', 'project', [idBinding('bw-export-amf'), attributeBinding('data-command-target', 'bw-export-amf')], { semanticAction: 'artifact.export-amf', adapter: 'available', permission: 'artifact.export-amf' }),
  control('export.3mf', 'Export 3MF', 'project', [idBinding('bw-export-3mf'), attributeBinding('data-command-target', 'bw-export-3mf')], { semanticAction: 'artifact.export-3mf', adapter: 'available', permission: 'artifact.export-3mf' }),
  control('export.drawing', 'Export 2D drawing', 'project', [idBinding('bw-export-drawing'), attributeBinding('data-command-target', 'bw-export-drawing')], { semanticAction: 'artifact.export-drawing', adapter: 'available', permission: 'artifact.export-drawing' }),
  control('export.drawing-dxf', 'Export DXF drawing', 'project', [idBinding('bw-export-dxf'), attributeBinding('data-command-target', 'bw-export-dxf')], { semanticAction: 'artifact.export-drawing-dxf', adapter: 'available', permission: 'artifact.export-drawing' }),
  control('export.drawing-pdf', 'Print or export drawing PDF', 'project', [idBinding('bw-export-pdf-open'), attributeBinding('data-command-target', 'bw-export-pdf-open')], { semanticAction: 'artifact.configure-drawing-pdf', adapter: 'available', permission: 'artifact.export-drawing' }),
  control('app.help', 'Help', 'application', [idBinding('bw-help-open'), idBinding('bw-help-status'), attributeBinding('data-command-target', 'bw-help-open')], { adapter: 'available' }),
  control('app.fullscreen', 'Full screen', 'application', [idBinding('bw-fullscreen'), attributeBinding('data-command-target', 'bw-fullscreen')], {
    semanticAction: 'application.fullscreen',
    adapter: 'contextual',
    contextualReasonCode: 'BROWSER_TRANSIENT_ACTIVATION_REQUIRED',
  }),
  control('app.exit', 'Exit Studio', 'application', [attributeBinding('href', '/')], {
    semanticAction: 'application.navigate',
    adapter: 'available',
    permission: 'ui.navigate',
    adapterTool: 'cad_ui',
  }),
  control('app.agent-activity', 'Agent activity', 'application', [dynamicBinding('agent.activity')], {
    semanticAction: 'session.manage',
    adapter: 'contextual',
    permission: 'session.connect',
    contextualReasonCode: 'HUMAN_AUTHORITY_BOUNDARY',
    variants: [
      familyVariant('app.agent-activity', 'open', 'Open agent activity'),
      familyVariant('app.agent-activity', 'close', 'Close agent activity'),
      familyVariant('app.agent-activity', 'pause', 'Pause connected agent'),
      familyVariant('app.agent-activity', 'resume', 'Resume connected agent'),
      familyVariant('app.agent-activity', 'disconnect', 'Disconnect connected agent'),
    ],
  }),
  control('app.agent.connection-deny', 'Deny agent connection', 'application', [controlIdBinding('app.agent.connection-deny')], {
    semanticAction: 'session.connection-deny',
    adapter: 'contextual',
    permission: 'session.connect',
    contextualReasonCode: 'HUMAN_AUTHORITY_BOUNDARY',
  }),
  control('app.agent.connection-approve', 'Approve agent connection', 'application', [controlIdBinding('app.agent.connection-approve')], {
    semanticAction: 'session.connection-approve',
    adapter: 'contextual',
    permission: 'session.connect',
    contextualReasonCode: 'HUMAN_AUTHORITY_BOUNDARY',
  }),
  control('app.agent.preview-reject', 'Reject agent preview', 'application', [controlIdBinding('app.agent.preview-reject')], {
    semanticAction: 'session.preview-reject',
    adapter: 'contextual',
    permission: 'project.edit',
    contextualReasonCode: 'HUMAN_AUTHORITY_BOUNDARY',
  }),
  control('app.agent.preview-approve', 'Approve agent preview', 'application', [controlIdBinding('app.agent.preview-approve')], {
    semanticAction: 'session.preview-approve',
    adapter: 'contextual',
    permission: 'project.edit',
    contextualReasonCode: 'HUMAN_AUTHORITY_BOUNDARY',
  }),
];

const workspaceControls = ['home', 'sketch', 'solid', 'assembly', 'view', 'manage', 'output'].map((id) =>
  control(`workspace.${id}`, `${id} workspace`, 'workspace', [attributeBinding('data-workspace', id)], {
    kind: 'workspace',
    workspaceId: id,
    semanticAction: 'workspace.activate',
    adapter: id === 'sketch' ? 'contextual' : 'available',
    contextualReasonCode: id === 'sketch' ? 'REQUIRES_ACTIVE_SKETCH' : null,
  }));

const basicFeatureControls = [
  ['extrude', 'Extrude', 'feature.extrude'],
  ['cut', 'Cut', 'feature.cut'],
  ['revolve', 'Revolve', 'feature.revolve'],
  ['fillet', 'Fillet edge', 'feature.fillet'],
  ['chamfer', 'Chamfer edge', 'feature.chamfer'],
  ['shell', 'Shell body', 'feature.shell'],
].map(([id, label, operationKind]) =>
  control(`model.${id}`, label, 'modeling', [
    attributeBinding('data-feat', id),
    attributeBinding('data-command-feat', id),
  ], {
    kind: 'command',
    workspaceId: 'solid',
    semanticAction: 'command.open',
    adapter: 'available',
    permission: 'ui.command-draft',
    operationKinds: [operationKind],
  }));

const holeWizardControl = control('model.hole-wizard', 'Hole Wizard', 'modeling', [
  idBinding('bw-hole-wizard-open'),
], {
  kind: 'action',
  workspaceId: 'solid',
  semanticAction: 'document.previewCommit',
  adapter: 'available',
  permission: 'project.edit',
  adapterTool: 'cad_preview',
  completionTool: 'cad_commit',
  operationKinds: ['feature.cut'],
  fields: [
    enumField('kind', 'Hole type', ['clearance', 'tapped', 'counterbore', 'countersink'], { required: true }),
    enumField('designation', 'Metric size', ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12'], { required: true }),
    numberField('x', 'Center X', { required: true }),
    numberField('y', 'Center Y', { required: true }),
    numberField('sketchZ', 'Support plane Z', { required: true }),
    selectionField('targetBody', 'Target body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
  ],
});

const threadControl = control('model.thread', 'Thread', 'modeling', [
  idBinding('bw-thread-open'),
], {
  kind: 'action',
  workspaceId: 'solid',
  semanticAction: 'document.previewCommit',
  adapter: 'available',
  permission: 'project.edit',
  adapterTool: 'cad_preview',
  completionTool: 'cad_commit',
  operationKinds: ['feature.thread', 'feature.update', 'feature.delete'],
  fields: [
    textField('name', 'Name', { required: true, maxLength: 200 }),
    selectionField('targetFace', 'Cylindrical face', ['face'], { required: true, minItems: 1, maxItems: 1 }),
    enumField('mode', 'Representation', ['cosmetic', 'modeled'], { required: true }),
    enumField('threadKind', 'Thread side', ['external', 'internal'], { required: true }),
    enumField('designation', 'Metric size', ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12'], { required: true }),
    enumField('handedness', 'Handedness', ['right', 'left'], { required: true }),
    enumField('toleranceClass', 'Maximum-material reference', ['6g', '6H'], { required: true }),
    enumField('spanMode', 'Axial span', ['fraction', 'offset'], { required: true }),
    numberField('spanStart', 'Axial span start', { required: true }),
    numberField('spanEnd', 'Axial span end', { required: true }),
    enumField('runout', 'Runout form', ['full-profile', 'one-pitch-taper'], { required: true }),
  ],
});

const structuralMemberControl = control('model.structural-member', 'Structural member', 'modeling', [
  idBinding('bw-structural-member-open'),
], {
  kind: 'action',
  workspaceId: 'solid',
  semanticAction: 'document.previewCommit',
  adapter: 'available',
  permission: 'project.edit',
  adapterTool: 'cad_preview',
  completionTool: 'cad_commit',
  operationKinds: ['structural.member.create', 'structural.member.update'],
  fields: [
    textField('name', 'Member name', { required: true }),
    selectionField('pathSketchId', 'Direct two-point polyline Path', ['sketch'], { required: true, minItems: 1, maxItems: 1 }),
    enumField('familyId', 'Profile family', ['rectangular-bar', 'equal-angle', 'channel', 'i-section', 'tee'], { required: true }),
    enumField('presetId', 'Profile preset', [
      'rect-20x10', 'rect-40x20', 'rect-60x30',
      'angle-30x30x3', 'angle-40x40x4', 'angle-50x50x5',
      'channel-50x25x4', 'channel-80x40x5', 'channel-100x50x6',
      'i-80x40x5', 'i-100x50x6', 'i-120x60x6',
      'tee-50x40x5', 'tee-70x50x6', 'tee-90x60x6',
    ], { required: true }),
    enumField('anchor', 'Insertion point', [
      'top-left', 'top-center', 'top-right',
      'middle-left', 'center', 'middle-right',
      'bottom-left', 'bottom-center', 'bottom-right',
    ], { required: true }),
    literalNumberField('rotationDegrees', 'Rotation in degrees', { required: true }),
    literalNumberField('offsetX', 'Profile offset X in millimetres', { required: true }),
    literalNumberField('offsetY', 'Profile offset Y in millimetres', { required: true }),
  ],
});

const sheetMetalFlangeControl = control('model.sheet-metal-flange', 'Sheet metal flange', 'modeling', [
  idBinding('bw-sheet-metal-open'),
], {
  kind: 'action',
  workspaceId: 'solid',
  semanticAction: 'document.previewCommit',
  adapter: 'available',
  permission: 'project.edit',
  adapterTool: 'cad_preview',
  completionTool: 'cad_commit',
  operationKinds: ['sheetMetal.flange.create', 'sheetMetal.flange.update'],
  fields: [
    textField('name', 'Flange name', { required: true }),
    enumField('kind', 'Flange kind', ['base-flange', 'edge-flange'], { required: true }),
    selectionField('profileSketchId', 'Closed polyline profile sketch', ['sketch'], { minItems: 1, maxItems: 1 }),
    literalNumberField('thickness', 'Sheet thickness in millimetres', { minimum: 0.05, maximum: 100 }),
    literalNumberField('kFactor', 'Neutral-axis K-factor', { minimum: 0.01, maximum: 1 }),
    literalNumberField('bendRadius', 'Inner bend radius in millimetres', { minimum: 0.05, maximum: 1000 }),
    selectionField('baseFeatureId', 'Base flange feature', ['feature'], { minItems: 1, maxItems: 1 }),
    literalNumberField('segmentIndex', 'Base profile segment index', { minimum: 0, maximum: 63 }),
    enumField('side', 'Bend side', ['up', 'down']),
    literalNumberField('flangeLength', 'Flange length in millimetres', { minimum: 0.05, maximum: 10_000 }),
  ],
});

const structuralTreatmentControl = control('model.structural-treatment', 'Structural treatment', 'modeling', [
  idBinding('bw-structural-treatment-open'),
], {
  kind: 'action',
  workspaceId: 'solid',
  semanticAction: 'document.previewCommit',
  adapter: 'available',
  permission: 'project.edit',
  adapterTool: 'cad_preview',
  completionTool: 'cad_commit',
  operationKinds: ['structural.treatment.create', 'structural.treatment.update', 'structural.treatment.delete'],
  fields: [
    textField('name', 'Treatment name', { required: true }),
    enumField('kind', 'Treatment kind', ['trim-extend', 'corner', 'gusset', 'end-cap'], { required: true }),
    selectionField('memberId', 'Structural member', ['feature'], { minItems: 1, maxItems: 1 }),
    enumField('end', 'Member end', ['start', 'end']),
    enumField('mode', 'Trim / extend operation', ['trim', 'extend']),
    literalNumberField('distance', 'Trim / extend distance in millimetres', { minimum: 0.000001, maximum: 10_000 }),
    selectionField('targetMemberId', 'Corner target member', ['feature'], { minItems: 1, maxItems: 1 }),
    enumField('targetEnd', 'Corner target end', ['start', 'end']),
    selectionField('otherMemberId', 'Corner other member', ['feature'], { minItems: 1, maxItems: 1 }),
    enumField('otherEnd', 'Corner other end', ['start', 'end']),
    enumField('style', 'Corner style', ['miter', 'cope']),
    selectionField('leftMemberId', 'Gusset left member', ['feature'], { minItems: 1, maxItems: 1 }),
    enumField('leftEnd', 'Gusset left end', ['start', 'end']),
    selectionField('rightMemberId', 'Gusset right member', ['feature'], { minItems: 1, maxItems: 1 }),
    enumField('rightEnd', 'Gusset right end', ['start', 'end']),
    literalNumberField('leftLegLength', 'Gusset left-leg length in millimetres', { minimum: 0.000001, maximum: 10_000 }),
    literalNumberField('rightLegLength', 'Gusset right-leg length in millimetres', { minimum: 0.000001, maximum: 10_000 }),
    literalNumberField('thickness', 'Gusset or end-cap thickness in millimetres', { minimum: 0.000001, maximum: 10_000 }),
  ],
});

const directEditOperationKinds = Object.freeze(['directEdit.create', 'directEdit.update', 'directEdit.delete']);
const directEditCommonFields = Object.freeze([
  textField('name', 'Direct-edit feature name', { required: true }),
  selectionField('targetBody', 'Target body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
  selectionField('targetFace', 'Persistent planar target face', ['face'], { required: true, minItems: 1, maxItems: 1 }),
]);
const directEditControl = (id, label, elementId, fields) => control(id, label, 'modeling', [
  idBinding(elementId),
], {
  kind: 'action',
  workspaceId: 'solid',
  semanticAction: 'document.previewCommit',
  adapter: 'available',
  permission: 'project.edit',
  adapterTool: 'cad_preview',
  completionTool: 'cad_commit',
  operationKinds: directEditOperationKinds,
  fields,
});
const directEditControls = [
  directEditControl('model.direct-push-pull', 'Direct Push/Pull', 'bw-direct-push-pull-open', Object.freeze([
    ...directEditCommonFields,
    literalNumberField('distance', 'Signed face-normal distance in millimetres', {
      required: true,
      minimum: -1_000_000,
      maximum: 1_000_000,
    }),
  ])),
  directEditControl('model.replace-face', 'Replace Face', 'bw-replace-face-open', Object.freeze([
    ...directEditCommonFields,
    selectionField('replacementBody', 'Distinct replacement body', ['body'], { required: true, minItems: 1, maxItems: 1 }),
    selectionField('replacementFace', 'Persistent planar replacement face', ['face'], { required: true, minItems: 1, maxItems: 1 }),
  ])),
  directEditControl('model.delete-face', 'Delete Face', 'bw-delete-face-open', Object.freeze([
    ...directEditCommonFields,
    selectionField('patchFace', 'Distinct persistent planar patch face', ['face'], { required: true, minItems: 1, maxItems: 1 }),
  ])),
];

const weldBeadOperationKinds = Object.freeze(['weld.bead.create', 'weld.bead.update', 'weld.bead.delete']);
const weldBeadControl = control('model.weld-bead', 'Weld bead', 'modeling', [
  idBinding('bw-weld-bead-open'),
], {
  kind: 'command',
  workspaceId: 'solid',
  semanticAction: 'command.open',
  adapter: 'available',
  permission: 'ui.command-draft',
  operationKinds: weldBeadOperationKinds,
});

const drawingCutListControl = control('drawing.cut-list', 'Associative cut list', 'drawing-output', [
  idBinding('bw-drawing-cut-list-open'),
], {
  kind: 'action',
  workspaceId: 'output',
  semanticAction: 'document.previewCommit',
  adapter: 'available',
  permission: 'project.edit',
  adapterTool: 'cad_preview',
  completionTool: 'cad_commit',
  operationKinds: ['drawing.table.create', 'drawing.table.update', 'drawing.table.delete'],
  fields: [
    selectionField('tableId', 'Existing drawing table', ['drawing-table'], { maxItems: 1 }),
    enumField('kind', 'Drawing-table kind', ['cut-list'], { required: true }),
    selectionField('sheetId', 'Drawing sheet', ['drawing-sheet'], { required: true, minItems: 1, maxItems: 1 }),
    textField('name', 'Cut-list name', { required: true }),
    listField('positionMm', 'Sheet position X,Y in millimetres', 'number', { required: true, minItems: 2, maxItems: 2 }),
    literalNumberField('widthMm', 'Table width in millimetres', { required: true, minimum: 40, maximum: 250 }),
    enumField('sourceType', 'Cut-list source', ['structural-member', 'body-axis'], { required: true }),
    selectionField('sourceMemberIds', 'Structural-member features', ['feature'], { minItems: 1, maxItems: 50 }),
    enumField('axis', 'World-bounds axis', ['x', 'y', 'z']),
    selectionField('sourceBodyIds', 'Source bodies', ['body'], { minItems: 1, maxItems: 50 }),
  ],
});

const advancedFeatureControls = [
  ['split', 'Boolean split', ['boolean.split']],
  ['plane', 'Construction plane', ['datum.create', 'datum.update']],
  ['coordinate-system', 'Coordinate system', ['datum.create', 'datum.update']],
  ['curve-point', 'Point on curve', ['datum.create', 'datum.update']],
  ['reference-curve', 'Reference curve', ['sketch.reference.create', 'sketch.reference.update']],
  ['align', 'Align body', ['body.transform', 'transform.update']],
  ['profile', 'Profile sketch', ['sketch.profile.create', 'sketch.advanced.update']],
  ['path', 'Path sketch', ['sketch.path.create', 'sketch.advanced.update']],
  ['loft', 'Loft', ['feature.loft', 'feature.advanced.update']],
  ['sweep', 'Sweep', ['feature.sweep', 'feature.advanced.update']],
  ['revolve-advanced', 'Partial revolve', ['feature.revolveProfile', 'feature.advanced.update']],
  ['draft', 'Draft', ['feature.draft', 'feature.advanced.update']],
  ['thicken', 'Thicken', ['feature.thicken', 'feature.advanced.update']],
  ['variable-fillet', 'Variable fillet', ['feature.variableFillet', 'feature.advanced.update']],
  ['face-fillet', 'Face fillet', ['feature.faceFillet', 'feature.advanced.update']],
  ['pattern', 'Body pattern', ['pattern.create', 'pattern.update']],
  ['move', 'Move body', ['body.transform', 'transform.update']],
  ['copy', 'Copy body', ['body.transform', 'transform.update']],
  ['rotate', 'Rotate body', ['body.transform', 'transform.update']],
  ['mirror', 'Mirror body', ['body.transform', 'transform.update']],
  ['scale', 'Scale body', ['body.transform', 'transform.update']],
].map(([id, label, operationKinds]) =>
  control(`model.${id}`, label, 'modeling', [commandBinding(id)], {
    kind: 'command',
    workspaceId: 'solid',
    semanticAction: 'command.open',
    adapter: 'available',
    permission: 'ui.command-draft',
    operationKinds: [...new Set([...operationKinds, 'datum.create'])],
  }));

const sketchReuseOperationKinds = Object.freeze([
  'sketch.constrained.create',
  'sketch.constrained.delete',
  'sketch.constrained.promote',
  'sketch.blockDefinition.create',
  'sketch.blockDefinition.update',
  'sketch.blockDefinition.delete',
  'sketch.blockInstance.create',
  'sketch.blockInstance.update',
  'sketch.blockInstance.delete',
  'sketch.blockInstance.explode',
  'sketch.relation.create',
  'sketch.relation.update',
  'sketch.relation.delete',
  'sketch.derived.create',
  'sketch.derived.update',
  'sketch.derived.underive',
]);

const sketchReuseFieldControls = [
  ['sketch', 'Working constrained sketch', 'bw-sketch-reuse-sketch'],
  ['linked', 'Derived-sketch linked state', 'bw-sketch-reuse-linked', 'document.read'],
  ['feature', 'Inline constrained feature sketch', 'bw-sketch-reuse-feature'],
  ['promote-name', 'Promoted sketch name', 'bw-sketch-reuse-promote-name'],
  ['promote-plane', 'Promoted sketch support plane', 'bw-sketch-reuse-promote-plane'],
  ['definition', 'Sketch-block definition', 'bw-sketch-reuse-definition'],
  ['definition-name', 'Sketch-block definition name', 'bw-sketch-reuse-definition-name'],
  ['insertion-x', 'Sketch-block insertion X', 'bw-sketch-reuse-insertion-x'],
  ['insertion-y', 'Sketch-block insertion Y', 'bw-sketch-reuse-insertion-y'],
  ['members', 'Sketch-block member selection', 'bw-sketch-reuse-members'],
  ['instance', 'Sketch-block instance', 'bw-sketch-reuse-instance'],
  ['instance-definition', 'Sketch-block instance definition', 'bw-sketch-reuse-instance-definition'],
  ['translation-x', 'Sketch-block translation X', 'bw-sketch-reuse-translation-x'],
  ['translation-y', 'Sketch-block translation Y', 'bw-sketch-reuse-translation-y'],
  ['angle', 'Sketch-block angle', 'bw-sketch-reuse-angle'],
  ['scale', 'Sketch-block positive scale', 'bw-sketch-reuse-scale'],
  ['fixed', 'Fix sketch-block transform', 'bw-sketch-reuse-fixed'],
  ['relation', 'Sketch placement relation', 'bw-sketch-reuse-relation'],
  ['relation-json', 'Sketch placement relation JSON', 'bw-sketch-reuse-relation-json'],
  ['source', 'Derived-sketch source', 'bw-sketch-reuse-source'],
  ['derived-name', 'Derived-sketch name', 'bw-sketch-reuse-derived-name'],
  ['derived-plane', 'Derived-sketch support plane', 'bw-sketch-reuse-derived-plane'],
  ['derived-z', 'Derived-sketch plane offset', 'bw-sketch-reuse-derived-z'],
  ['derived-x', 'Derived-sketch translation X', 'bw-sketch-reuse-derived-x'],
  ['derived-y', 'Derived-sketch translation Y', 'bw-sketch-reuse-derived-y'],
  ['derived-angle', 'Derived-sketch angle', 'bw-sketch-reuse-derived-angle'],
].map(([id, label, elementId, permission = 'ui.command-draft']) =>
  control(`dialog.sketch-reuse.field.${id}`, label, 'dialog-field', [idBinding(elementId)], {
    kind: 'field',
    semanticAction: permission === 'document.read' ? 'document.inspect' : 'command.setInput',
    adapter: 'available',
    permission,
  }));

const sketchReuseActionControls = [
  ['create', 'Create constrained sketch', 'sketch.constrained.create'],
  ['promote', 'Promote inline constrained sketch', 'sketch.constrained.promote'],
  ['edit-members', 'Edit constrained-sketch members', 'sketch.constrained.update'],
  ['delete-sketch', 'Delete constrained sketch', 'sketch.constrained.delete'],
  ['make', 'Make sketch-block definition', 'sketch.blockDefinition.create'],
  ['edit-definition', 'Edit sketch-block definition', 'sketch.blockDefinition.update'],
  ['delete-definition', 'Delete sketch-block definition', 'sketch.blockDefinition.delete'],
  ['insert', 'Insert sketch-block instance', 'sketch.blockInstance.create'],
  ['edit-instance', 'Edit sketch-block instance', 'sketch.blockInstance.update'],
  ['delete-instance', 'Delete sketch-block instance', 'sketch.blockInstance.delete'],
  ['explode', 'Explode sketch-block instance', 'sketch.blockInstance.explode'],
  ['create-relation', 'Create sketch placement relation', 'sketch.relation.create'],
  ['edit-relation', 'Update sketch placement relation', 'sketch.relation.update'],
  ['delete-relation', 'Delete sketch placement relation', 'sketch.relation.delete'],
  ['derived', 'Create linked derived sketch', 'sketch.derived.create'],
  ['edit-derived', 'Edit linked derived sketch', 'sketch.derived.update'],
  ['underive', 'Underive linked sketch', 'sketch.derived.underive'],
].map(([id, label, operationKind]) =>
  control(`dialog.sketch-reuse.${id}`, label, 'dialog-action', [idBinding(`bw-sketch-reuse-${id}`)], {
    kind: 'dialog-action',
    semanticAction: 'command.commit',
    adapter: 'available',
    permission: 'project.edit',
    adapterTool: 'cad_ui',
    completionTool: 'cad_commit',
    operationKinds: [operationKind],
  }));

const sketchReuseControls = [
  control('model.sketch-reuse', 'Sketch reuse', 'modeling', [idBinding('bw-sketch-reuse-open')], {
    kind: 'action',
    workspaceId: 'solid',
    semanticAction: 'command.open',
    adapter: 'available',
    permission: 'ui.command-draft',
    operationKinds: sketchReuseOperationKinds,
  }),
  ...sketchReuseFieldControls,
  ...sketchReuseActionControls,
  control('dialog.sketch-reuse.close', 'Close sketch reuse', 'dialog-action', [idBinding('bw-sketch-reuse-close')], {
    kind: 'dialog-action', semanticAction: 'command.cancel', adapter: 'available', permission: 'ui.navigate',
  }),
];

const sketchControls = ['line', 'arc', 'rect', 'circle', 'poly', 'select', 'pan', 'mirror', 'offset', 'trim', 'spline'].map((id) =>
  control(`sketch.tool.${id}`, `${id} sketch tool`, 'sketch', [attributeBinding('data-sktool', id)], {
    kind: 'tool',
    workspaceId: 'sketch',
    semanticAction: 'sketch.setTool',
    adapter: 'available',
    permission: 'ui.command-draft',
  }));

const smartFastenerControl = control(
  'assembly.smart-fastener',
  'Smart Fastener',
  'assembly',
  [idBinding('bw-smart-fastener-open'), assemblyBinding('smart-fastener')],
  {
    kind: 'command',
    workspaceId: 'assembly',
    semanticAction: 'command.open',
    adapter: 'available',
    permission: 'ui.command-draft',
    operationKinds: ['smartFastener.apply', 'smartFastener.update', 'smartFastener.delete'],
    fields: COMMAND_FIELD_CONTRACTS['assembly.smart-fastener'],
  },
);

const assemblyFeatureControl = control(
  'assembly.feature',
  'Assembly Cut / Hole',
  'assembly',
  [idBinding('bw-assembly-feature-open'), assemblyBinding('feature')],
  {
    kind: 'command',
    workspaceId: 'assembly',
    semanticAction: 'command.open',
    adapter: 'available',
    permission: 'ui.command-draft',
    operationKinds: ['assemblyFeature.create', 'assemblyFeature.update', 'assemblyFeature.delete'],
    fields: COMMAND_FIELD_CONTRACTS['assembly.feature'],
  },
);

const assemblyControls = [
  smartFastenerControl,
  assemblyFeatureControl,
  ...[
  ['create', 'Create assembly', ['assembly.create']],
  ['insert', 'Insert component', ['component.insert']],
  ['linked', 'Linked duplicate', ['component.duplicate']],
  ['independent', 'Make component independent', ['component.makeIndependent']],
  ['replace', 'Replace component definition', ['component.replace']],
  ['variant', 'Component variant', ['component.update']],
  ['transform', 'Drag component with mates', ['assembly.drag'], 'available', TRANSFORM_FIELDS],
  ['edit-context', 'Edit component in context', ['assembly.context.enter']],
  ['exit-context', 'Return to assembly', ['assembly.context.exit']],
  ['pattern', 'Component pattern', ['component.pattern', 'component.pattern.update']],
].map(([id, label, operationKinds, adapter = 'available', fields = []]) =>
  control(`assembly.${id === 'transform' ? 'component-transform' : id}`, label, 'assembly', [assemblyBinding(id)], {
    kind: 'command',
    workspaceId: 'assembly',
    semanticAction: 'command.open',
    adapter,
    permission: 'ui.command-draft',
    operationKinds,
    fields,
  })),
];

const mateControls = [
  'fixed', 'coincident', 'concentric', 'distance', 'angle',
  'parallel', 'perpendicular', 'tangent', 'revolute', 'slider',
  'width', 'symmetry', 'path', 'linear-coupler', 'limit-distance', 'limit-angle',
  'gear', 'hinge',
].map((id) =>
  control(`assembly.mate.${id}`, `${id} mate`, 'assembly', [mateBinding(id)], {
    kind: 'command',
    workspaceId: 'assembly',
    semanticAction: 'command.open',
    adapter: 'available',
    permission: 'ui.command-draft',
    operationKinds: ['mate.create', 'mate.update'],
  }));

const inspectionControls = [
  ['section', 'Section view', ['section.create', 'section.update']],
  ['explode', 'Exploded view', ['exploded.create']],
  ['stage', 'Axial stage group', ['stage.create', 'stage.update']],
  ['material', 'Material assignment', ['material.ensureGeneric', 'material.assignBody', 'appearance.assignOccurrence']],
  ['properties', 'Mass and geometry health', []],
  ['measure', 'Saved measurement', ['measurement.create', 'measurement.update']],
  ['measurements', 'Evaluate measurements', []],
  ['clearance', 'Clearance', []],
  ['interference', 'Interference', []],
].map(([id, label, operationKinds]) =>
  control(`inspection.${id}`, label, 'inspection', [inspectionBinding(id)], {
    kind: operationKinds.length ? 'command' : 'query',
    workspaceId: 'assembly',
    semanticAction: operationKinds.length ? 'command.open' : 'inspection.run',
    permission: operationKinds.length ? 'ui.command-draft' : 'document.read',
    operationKinds,
    adapter: ['section', 'explode', 'stage', 'material', 'measure', 'properties', 'measurements', 'clearance', 'interference'].includes(id) ? 'available' : 'missing',
  }));

const displayControls = ['shaded-edges', 'wireframe', 'hidden-line', 'ghost'].map((id) =>
  control(`display.${id}`, `${id} display`, 'viewport', [displayBinding(id)], {
    kind: 'mode',
    workspaceId: 'assembly',
    semanticAction: 'display.setMode',
    adapter: 'available',
  }));

const viewControls = ['top', 'front', 'right', 'iso', 'fit'].map((id) =>
  control(`view.${id}`, `${id} view`, 'viewport', viewBindings(id), {
    kind: 'view',
    semanticAction: id === 'fit' ? 'camera.fitAll' : 'camera.setStandard',
    adapter: 'available',
  }));

const dialogControls = [
  ['dialog.command.apply', 'Apply command', 'bw-v5-command-apply', 'command.commit', 'available'],
  ['dialog.command.preview', 'Run exact command preview', 'bw-v5-command-preview', 'command.preview', 'available'],
  ['dialog.command.cancel', 'Cancel command', 'bw-v5-command-cancel', 'command.cancel', 'available'],
  ['dialog.direct-edit.name', 'Set direct-edit feature name', 'bw-direct-edit-name', 'control.set', 'available', directEditOperationKinds],
  ['dialog.direct-edit.target-body', 'Set direct-edit target body', 'bw-direct-edit-target-body', 'control.set', 'available', directEditOperationKinds],
  ['dialog.direct-edit.target-face', 'Rebind direct-edit target face', 'bw-direct-edit-target-face', 'control.set', 'available', directEditOperationKinds],
  ['dialog.direct-edit.distance', 'Set direct Push/Pull signed distance', 'bw-direct-edit-distance', 'control.set', 'available', directEditOperationKinds],
  ['dialog.direct-edit.replacement-body', 'Set Replace Face source body', 'bw-direct-edit-replacement-body', 'control.set', 'available', directEditOperationKinds],
  ['dialog.direct-edit.replacement-face', 'Rebind Replace Face source face', 'bw-direct-edit-replacement-face', 'control.set', 'available', directEditOperationKinds],
  ['dialog.direct-edit.patch-face', 'Rebind Delete Face patch face', 'bw-direct-edit-patch-face', 'control.set', 'available', directEditOperationKinds],
  ['dialog.direct-edit.apply', 'Create or update direct-edit feature', 'bw-direct-edit-apply', 'command.commit', 'available', directEditOperationKinds],
  ['dialog.direct-edit.delete', 'Delete direct-edit feature', 'bw-direct-edit-delete', 'command.commit', 'available', directEditOperationKinds],
  ['dialog.direct-edit.cancel', 'Cancel direct-edit command', 'bw-direct-edit-cancel', 'command.cancel', 'available', directEditOperationKinds],
  ['dialog.weld-bead.name', 'Set weld-bead name', 'bw-weld-bead-name', 'control.set', 'available', weldBeadOperationKinds],
  ['dialog.weld-bead.capture', 'Capture exact weld-bead supports', 'bw-weld-bead-capture', 'command.preview', 'available', weldBeadOperationKinds],
  ['dialog.weld-bead.size', 'Set weld-bead equal leg size', 'bw-weld-bead-size', 'control.set', 'available', weldBeadOperationKinds],
  ['dialog.weld-bead.process', 'Set weld-bead process', 'bw-weld-bead-process', 'control.set', 'available', weldBeadOperationKinds],
  ['dialog.weld-bead.apply', 'Create or update weld bead', 'bw-weld-bead-apply', 'command.commit', 'available', weldBeadOperationKinds],
  ['dialog.weld-bead.cancel', 'Cancel weld-bead command', 'bw-weld-bead-cancel', 'command.cancel', 'available', weldBeadOperationKinds],
  ['dialog.clear.confirm', 'Confirm clear', 'bw-clear-confirm', 'document.previewCommit', 'available'],
  ['dialog.clear.cancel', 'Cancel clear', 'bw-clear-cancel', 'control.invoke', 'available'],
  ['dialog.draft.keep', 'Keep editing draft', 'bw-draft-keep', 'control.invoke', 'available'],
  ['dialog.draft.discard', 'Discard draft', 'bw-draft-discard', 'control.invoke', 'available'],
  ['dialog.draft.apply', 'Apply draft and continue', 'bw-draft-apply', 'command.commit', 'available'],
  ['dialog.template.close', 'Close templates', 'bw-templates-close', 'control.invoke', 'available'],
  ['dialog.template.use', 'Use template', 'bw-template-use', 'template.use', 'available'],
  ['dialog.help.close', 'Close help', 'bw-help-close', 'control.invoke', 'available'],
  ['dialog.recovery.close', 'Close recovery', 'bw-recover-close', 'control.invoke', 'available'],
  ['dialog.addins.open', 'Open add-in manager', 'bw-addins-open', 'control.invoke', 'available'],
  ['dialog.addins.close', 'Close add-in manager', 'bw-addins-close', 'control.invoke', 'available'],
  ['dialog.addins.load', 'Load local add-in module', 'bw-addins-load', 'control.invoke', 'available'],
  ['dialog.drawing-pdf.close', 'Close drawing PDF output', 'bw-drawing-pdf-close', 'control.invoke', 'available'],
  ['dialog.drawing-view.select', 'Select named drawing view', 'bw-drawing-view-select', 'control.set', 'available'],
  ['dialog.drawing-view.name', 'Set named drawing view name', 'bw-drawing-view-name', 'control.set', 'available'],
  ['dialog.drawing-view.direction', 'Set named drawing view direction', 'bw-drawing-view-direction', 'control.set', 'available'],
  ['dialog.drawing-view.xaxis', 'Set named drawing view x-axis', 'bw-drawing-view-xaxis', 'control.set', 'available'],
  ['dialog.drawing-view.add', 'Add named drawing view', 'bw-drawing-view-add', 'command.commit', 'available'],
  ['dialog.drawing-view.update', 'Update named drawing view', 'bw-drawing-view-update', 'command.commit', 'available'],
  ['dialog.drawing-view.delete', 'Delete named drawing view', 'bw-drawing-view-delete', 'command.commit', 'available'],
  ['dialog.drawing-derived-view.select', 'Select derived drawing view', 'bw-drawing-derived-view-select', 'control.set', 'available'],
  ['dialog.drawing-derived-view.name', 'Set derived drawing view name', 'bw-drawing-derived-view-name', 'control.set', 'available'],
  ['dialog.drawing-derived-view.kind', 'Set derived drawing view kind', 'bw-drawing-derived-view-kind', 'control.set', 'available'],
  ['dialog.drawing-derived-view.source', 'Set derived drawing view source', 'bw-drawing-derived-view-source', 'control.set', 'available'],
  ['dialog.drawing-derived-view.planes', 'Set derived drawing view cutting planes', 'bw-drawing-derived-view-planes', 'control.set', 'available'],
  ['dialog.drawing-derived-view.hatch', 'Set section-view hatch angle', 'bw-drawing-derived-view-hatch', 'control.set', 'available'],
  ['dialog.drawing-derived-view.half-axis', 'Set half-section split axis', 'bw-drawing-derived-view-half-axis', 'control.set', 'available'],
  ['dialog.drawing-derived-view.half-side', 'Set half-section exterior side', 'bw-drawing-derived-view-half-side', 'control.set', 'available'],
  ['dialog.drawing-derived-view.half-at', 'Set half-section split position', 'bw-drawing-derived-view-half-at', 'control.set', 'available'],
  ['dialog.drawing-derived-view.boundary-kind', 'Set derived drawing view boundary kind', 'bw-drawing-derived-view-boundary-kind', 'control.set', 'available'],
  ['dialog.drawing-derived-view.boundary-x', 'Set derived drawing view boundary X', 'bw-drawing-derived-view-boundary-x', 'control.set', 'available'],
  ['dialog.drawing-derived-view.boundary-y', 'Set derived drawing view boundary Y', 'bw-drawing-derived-view-boundary-y', 'control.set', 'available'],
  ['dialog.drawing-derived-view.boundary-width', 'Set derived drawing view boundary width', 'bw-drawing-derived-view-boundary-width', 'control.set', 'available'],
  ['dialog.drawing-derived-view.boundary-height', 'Set derived drawing view boundary height', 'bw-drawing-derived-view-boundary-height', 'control.set', 'available'],
  ['dialog.drawing-derived-view.boundary-radius', 'Set derived drawing view boundary radius', 'bw-drawing-derived-view-boundary-radius', 'control.set', 'available'],
  ['dialog.drawing-derived-view.magnification', 'Set detail-view magnification', 'bw-drawing-derived-view-magnification', 'control.set', 'available'],
  ['dialog.drawing-derived-view.depth', 'Set broken-out section cut depth', 'bw-drawing-derived-view-depth', 'control.set', 'available'],
  ['dialog.drawing-derived-view.aux-body', 'Set auxiliary-view persistent body', 'bw-drawing-derived-view-aux-body', 'control.set', 'available'],
  ['dialog.drawing-derived-view.aux-face', 'Set auxiliary-view persistent planar face', 'bw-drawing-derived-view-aux-face', 'control.set', 'available'],
  ['dialog.drawing-derived-view.aux-xaxis', 'Set auxiliary-view sheet X-axis hint', 'bw-drawing-derived-view-aux-xaxis', 'control.set', 'available'],
  ['dialog.drawing-derived-view.break-axis', 'Set break-view axis', 'bw-drawing-derived-view-break-axis', 'control.set', 'available'],
  ['dialog.drawing-derived-view.break-start', 'Set break-view start', 'bw-drawing-derived-view-break-start', 'control.set', 'available'],
  ['dialog.drawing-derived-view.break-end', 'Set break-view end', 'bw-drawing-derived-view-break-end', 'control.set', 'available'],
  ['dialog.drawing-derived-view.break-gap', 'Set break-view display gap', 'bw-drawing-derived-view-break-gap', 'control.set', 'available'],
  ['dialog.drawing-derived-view.add', 'Add derived drawing view', 'bw-drawing-derived-view-add', 'command.commit', 'available'],
  ['dialog.drawing-derived-view.update', 'Update derived drawing view', 'bw-drawing-derived-view-update', 'command.commit', 'available'],
  ['dialog.drawing-derived-view.delete', 'Delete derived drawing view', 'bw-drawing-derived-view-delete', 'command.commit', 'available'],
  ['dialog.drawing-book.initialize', 'Initialize drawing set', 'bw-drawing-book-initialize', 'command.commit', 'available'],
  ['dialog.drawing-sheet.add', 'Add drawing sheet', 'bw-drawing-sheet-add', 'command.commit', 'available'],
  ['dialog.drawing-sheet.select', 'Select drawing sheet', 'bw-drawing-sheet', 'command.commit', 'available'],
  ['dialog.drawing-sheet.name', 'Set drawing sheet name', 'bw-drawing-sheet-name', 'control.set', 'available'],
  ['dialog.drawing-sheet.template', 'Set drawing sheet template', 'bw-drawing-sheet-template', 'control.set', 'available'],
  ['dialog.drawing-sheet.width', 'Set custom sheet width', 'bw-drawing-sheet-width', 'control.set', 'available'],
  ['dialog.drawing-sheet.height', 'Set custom sheet height', 'bw-drawing-sheet-height', 'control.set', 'available'],
  ['dialog.drawing-sheet.views', 'Set exact drawing views', 'bw-drawing-sheet-views', 'control.set', 'available'],
  ['dialog.drawing-sheet.tangent-edges', 'Set tangent-edge display', 'bw-drawing-tangent-edges', 'control.set', 'available'],
  ['dialog.drawing-standard.profile', 'Select drawing standard profile', 'bw-drawing-standard-profile', 'control.set', 'available'],
  ['dialog.drawing-standard.apply', 'Apply drawing standard profile', 'bw-drawing-standard-apply', 'command.commit', 'available'],
  ['dialog.drawing-layer.select', 'Select drawing layer', 'bw-drawing-layer', 'control.set', 'available'],
  ['dialog.drawing-layer.visible', 'Set drawing layer visibility', 'bw-drawing-layer-visible', 'control.set', 'available'],
  ['dialog.drawing-layer.printable', 'Set drawing layer print state', 'bw-drawing-layer-printable', 'control.set', 'available'],
  ['dialog.drawing-layer.line-font', 'Set drawing layer line font', 'bw-drawing-layer-line-font', 'control.set', 'available'],
  ['dialog.drawing-layer.apply', 'Apply drawing layer', 'bw-drawing-layer-apply', 'command.commit', 'available'],
  ['dialog.drawing-line-font.select', 'Select custom drawing line font', 'bw-drawing-line-font', 'control.set', 'available'],
  ['dialog.drawing-line-font.name', 'Set drawing line-font name', 'bw-drawing-line-font-name', 'control.set', 'available'],
  ['dialog.drawing-line-font.width', 'Set drawing line-font width', 'bw-drawing-line-font-width', 'control.set', 'available'],
  ['dialog.drawing-line-font.dash', 'Set drawing line-font dash pattern', 'bw-drawing-line-font-dash', 'control.set', 'available'],
  ['dialog.drawing-line-font.color', 'Set drawing line-font color', 'bw-drawing-line-font-color', 'control.set', 'available'],
  ['dialog.drawing-line-font.add', 'Add custom drawing line font', 'bw-drawing-line-font-add', 'command.commit', 'available'],
  ['dialog.drawing-line-font.update', 'Update custom drawing line font', 'bw-drawing-line-font-update', 'command.commit', 'available'],
  ['dialog.drawing-line-font.delete', 'Delete custom drawing line font', 'bw-drawing-line-font-delete', 'command.commit', 'available'],
  ['dialog.drawing-annotation.select', 'Select authored drawing annotation', 'bw-drawing-annotation', 'control.set', 'available'],
  ['dialog.drawing-annotation.kind', 'Set drawing annotation kind', 'bw-drawing-annotation-kind', 'control.set', 'available'],
  ['dialog.drawing-annotation.text', 'Set drawing annotation text', 'bw-drawing-annotation-text', 'control.set', 'available'],
  ['dialog.drawing-annotation.position', 'Set drawing annotation sheet position', 'bw-drawing-annotation-position', 'control.set', 'available'],
  ['dialog.drawing-annotation.view', 'Set manual balloon exact view', 'bw-drawing-annotation-view', 'control.set', 'available'],
  ['dialog.drawing-annotation.anchor', 'Set manual balloon projection anchor', 'bw-drawing-annotation-anchor', 'control.set', 'available'],
  ['dialog.drawing-annotation.extent', 'Set revision-cloud extent', 'bw-drawing-annotation-extent', 'control.set', 'available'],
  ['dialog.drawing-annotation.scale', 'Set annotation text size or block scale', 'bw-drawing-annotation-scale', 'control.set', 'available'],
  ['dialog.drawing-annotation.block', 'Set annotation reusable block', 'bw-drawing-annotation-block', 'control.set', 'available'],
  ['dialog.drawing-annotation.add', 'Add drawing annotation', 'bw-drawing-annotation-add', 'command.commit', 'available'],
  ['dialog.drawing-annotation.update', 'Update drawing annotation', 'bw-drawing-annotation-update', 'command.commit', 'available'],
  ['dialog.drawing-annotation.delete', 'Delete drawing annotation', 'bw-drawing-annotation-delete', 'command.commit', 'available'],
  ['dialog.drawing-associative-dimension.select', 'Select associative drawing dimension', 'bw-drawing-associative-dimension', 'control.set', 'available'],
  ['dialog.drawing-associative-dimension.type', 'Set associative drawing-dimension type', 'bw-drawing-associative-dimension-type', 'control.set', 'available'],
  ['dialog.drawing-associative-dimension.view', 'Set associative drawing-dimension exact view', 'bw-drawing-associative-dimension-view', 'control.set', 'available'],
  ['dialog.drawing-associative-dimension.capture', 'Capture selected persistent topology references', 'bw-drawing-associative-dimension-capture', 'command.preview', 'available'],
  ['dialog.drawing-associative-dimension.references', 'Set associative drawing-dimension references', 'bw-drawing-associative-dimension-references', 'control.set', 'available'],
  ['dialog.drawing-associative-dimension.label', 'Set associative drawing-dimension label position', 'bw-drawing-associative-dimension-label', 'control.set', 'available'],
  ['dialog.drawing-associative-dimension.add', 'Add associative drawing dimension', 'bw-drawing-associative-dimension-add', 'command.commit', 'available'],
  ['dialog.drawing-associative-dimension.update', 'Update associative drawing dimension', 'bw-drawing-associative-dimension-update', 'command.commit', 'available'],
  ['dialog.drawing-associative-dimension.delete', 'Delete associative drawing dimension', 'bw-drawing-associative-dimension-delete', 'command.commit', 'available'],
  ['dialog.drawing-gdt.select', 'Select GD&T drawing record', 'bw-drawing-gdt', 'control.set', 'available'],
  ['dialog.drawing-gdt.kind', 'Set GD&T drawing-record kind', 'bw-drawing-gdt-kind', 'control.set', 'available'],
  ['dialog.drawing-gdt.view', 'Set GD&T exact drawing view', 'bw-drawing-gdt-view', 'control.set', 'available'],
  ['dialog.drawing-gdt.capture', 'Capture selected persistent topology reference', 'bw-drawing-gdt-capture', 'command.preview', 'available'],
  ['dialog.drawing-gdt.reference', 'Set GD&T persistent topology reference', 'bw-drawing-gdt-reference', 'control.set', 'available'],
  ['dialog.drawing-gdt.name', 'Set datum identifier or tolerance-stack name', 'bw-drawing-gdt-name', 'control.set', 'available'],
  ['dialog.drawing-gdt.label', 'Set GD&T label or tolerance-stack position', 'bw-drawing-gdt-label', 'control.set', 'available'],
  ['dialog.drawing-gdt.characteristic', 'Set feature-control-frame characteristic', 'bw-drawing-gdt-characteristic', 'control.set', 'available'],
  ['dialog.drawing-gdt.tolerance', 'Set feature-control-frame tolerance', 'bw-drawing-gdt-tolerance', 'control.set', 'available'],
  ['dialog.drawing-gdt.diameter', 'Set feature-control-frame diameter zone', 'bw-drawing-gdt-diameter', 'control.set', 'available'],
  ['dialog.drawing-gdt.material', 'Set feature-control-frame material condition', 'bw-drawing-gdt-material', 'control.set', 'available'],
  ['dialog.drawing-gdt.datums', 'Set feature-control-frame datum sequence', 'bw-drawing-gdt-datums', 'control.set', 'available'],
  ['dialog.drawing-gdt.stack', 'Set tolerance-stack terms', 'bw-drawing-gdt-stack', 'control.set', 'available'],
  ['dialog.drawing-gdt.add', 'Add GD&T drawing record', 'bw-drawing-gdt-add', 'command.commit', 'available'],
  ['dialog.drawing-gdt.update', 'Update GD&T drawing record', 'bw-drawing-gdt-update', 'command.commit', 'available'],
  ['dialog.drawing-gdt.delete', 'Delete GD&T drawing record', 'bw-drawing-gdt-delete', 'command.commit', 'available'],
  ['dialog.drawing-model-dimension.select', 'Select imported model dimension', 'bw-drawing-model-dimension', 'control.set', 'available'],
  ['dialog.drawing-model-dimension.view', 'Set imported model-dimension exact view', 'bw-drawing-model-dimension-view', 'control.set', 'available'],
  ['dialog.drawing-model-dimension.feature', 'Set imported model-dimension feature', 'bw-drawing-model-dimension-feature', 'control.set', 'available'],
  ['dialog.drawing-model-dimension.field', 'Set imported model-dimension driving field', 'bw-drawing-model-dimension-field', 'control.set', 'available'],
  ['dialog.drawing-model-dimension.anchor-a', 'Set imported model-dimension first endpoint', 'bw-drawing-model-dimension-anchor-a', 'control.set', 'available'],
  ['dialog.drawing-model-dimension.anchor-b', 'Set imported model-dimension second endpoint', 'bw-drawing-model-dimension-anchor-b', 'control.set', 'available'],
  ['dialog.drawing-model-dimension.label', 'Set imported model-dimension label position', 'bw-drawing-model-dimension-label', 'control.set', 'available'],
  ['dialog.drawing-model-dimension.add', 'Import model dimension', 'bw-drawing-model-dimension-add', 'command.commit', 'available'],
  ['dialog.drawing-model-dimension.update', 'Update imported model dimension', 'bw-drawing-model-dimension-update', 'command.commit', 'available'],
  ['dialog.drawing-model-dimension.delete', 'Delete imported model dimension', 'bw-drawing-model-dimension-delete', 'command.commit', 'available'],
  ['dialog.drawing-symbol.select', 'Select manufacturing drawing symbol', 'bw-drawing-symbol', 'control.set', 'available'],
  ['dialog.drawing-symbol.kind', 'Set manufacturing drawing-symbol kind', 'bw-drawing-symbol-kind', 'control.set', 'available'],
  ['dialog.drawing-symbol.view', 'Set manufacturing drawing-symbol view', 'bw-drawing-symbol-view', 'control.set', 'available'],
  ['dialog.drawing-symbol.references', 'Set manufacturing drawing-symbol references', 'bw-drawing-symbol-references', 'control.set', 'available'],
  ['dialog.drawing-symbol.anchor', 'Set manufacturing drawing-symbol anchor', 'bw-drawing-symbol-anchor', 'control.set', 'available'],
  ['dialog.drawing-symbol.label', 'Set manufacturing drawing-symbol label position', 'bw-drawing-symbol-label', 'control.set', 'available'],
  ['dialog.drawing-symbol.value', 'Set manufacturing drawing-symbol value', 'bw-drawing-symbol-value', 'control.set', 'available'],
  ['dialog.drawing-symbol.weld-type', 'Set drawing weld type', 'bw-drawing-symbol-weld-type', 'control.set', 'available'],
  ['dialog.drawing-symbol.weld-side', 'Set drawing weld side', 'bw-drawing-symbol-weld-side', 'control.set', 'available'],
  ['dialog.drawing-symbol.surface-method', 'Set surface-finish method', 'bw-drawing-symbol-surface-method', 'control.set', 'available'],
  ['dialog.drawing-symbol.surface-lay', 'Set surface-finish lay', 'bw-drawing-symbol-surface-lay', 'control.set', 'available'],
  ['dialog.drawing-symbol.detail', 'Set manufacturing drawing-symbol detail', 'bw-drawing-symbol-detail', 'control.set', 'available'],
  ['dialog.drawing-symbol.add', 'Add manufacturing drawing symbol', 'bw-drawing-symbol-add', 'command.commit', 'available'],
  ['dialog.drawing-symbol.update', 'Update manufacturing drawing symbol', 'bw-drawing-symbol-update', 'command.commit', 'available'],
  ['dialog.drawing-symbol.delete', 'Delete manufacturing drawing symbol', 'bw-drawing-symbol-delete', 'command.commit', 'available'],
  ['dialog.drawing-block.select', 'Select reusable drawing block', 'bw-drawing-block', 'control.set', 'available'],
  ['dialog.drawing-block.name', 'Set reusable drawing-block name', 'bw-drawing-block-name', 'control.set', 'available'],
  ['dialog.drawing-block.text', 'Set reusable drawing-block text', 'bw-drawing-block-text', 'control.set', 'available'],
  ['dialog.drawing-block.size', 'Set reusable drawing-block size', 'bw-drawing-block-size', 'control.set', 'available'],
  ['dialog.drawing-block.add', 'Add reusable drawing block', 'bw-drawing-block-add', 'command.commit', 'available'],
  ['dialog.drawing-block.update', 'Update reusable drawing block', 'bw-drawing-block-update', 'command.commit', 'available'],
  ['dialog.drawing-block.delete', 'Delete reusable drawing block', 'bw-drawing-block-delete', 'command.commit', 'available'],
  ['dialog.drawing-table.select', 'Select authored drawing table', 'bw-drawing-table', 'control.setValue', 'missing'],
  ['dialog.drawing-table.kind', 'Set drawing-table kind', 'bw-drawing-table-kind', 'control.setValue', 'missing'],
  ['dialog.drawing-table.name', 'Set drawing-table name', 'bw-drawing-table-name', 'control.setValue', 'missing'],
  ['dialog.drawing-table.position', 'Set drawing-table position', 'bw-drawing-table-position', 'control.setValue', 'missing'],
  ['dialog.drawing-table.width', 'Set drawing-table width', 'bw-drawing-table-width', 'control.setValue', 'missing'],
  ['dialog.drawing-table.source-type', 'Set cut-list source mode', 'bw-drawing-table-source-type', 'control.setValue', 'missing'],
  ['dialog.drawing-table.members', 'Set structural-member cut-list sources', 'bw-drawing-table-members', 'control.setValue', 'missing'],
  ['dialog.drawing-table.axis', 'Set body-axis cut-list measurement axis', 'bw-drawing-table-axis', 'control.setValue', 'missing'],
  ['dialog.drawing-table.body-references', 'Set body-axis cut-list body references', 'bw-drawing-table-body-references', 'control.setValue', 'missing'],
  ['dialog.drawing-table.references', 'Set hole-table or weld-table feature references', 'bw-drawing-table-references', 'control.setValue', 'missing'],
  ['dialog.drawing-table.revisions', 'Set drawing revision rows', 'bw-drawing-table-revisions', 'control.setValue', 'missing'],
  ['dialog.drawing-table.add', 'Add drawing table through the human form', 'bw-drawing-table-add', 'document.previewCommit', 'missing'],
  ['dialog.drawing-table.update', 'Update drawing table through the human form', 'bw-drawing-table-update', 'document.previewCommit', 'missing'],
  ['dialog.drawing-table.delete', 'Delete drawing table through the human form', 'bw-drawing-table-delete', 'document.previewCommit', 'missing'],
  ['dialog.drawing-alignment.list', 'Select drawing-view alignment', 'bw-drawing-alignment-list', 'control.set', 'available'],
  ['dialog.drawing-alignment.parent', 'Set alignment parent view', 'bw-drawing-alignment-parent', 'control.set', 'available'],
  ['dialog.drawing-alignment.child', 'Set alignment child view', 'bw-drawing-alignment-child', 'control.set', 'available'],
  ['dialog.drawing-alignment.axis', 'Set drawing-view alignment axis', 'bw-drawing-alignment-axis', 'control.set', 'available'],
  ['dialog.drawing-alignment.gap', 'Set drawing-view alignment gap', 'bw-drawing-alignment-gap', 'control.set', 'available'],
  ['dialog.drawing-alignment.add', 'Add drawing-view alignment', 'bw-drawing-alignment-add', 'command.commit', 'available'],
  ['dialog.drawing-alignment.delete', 'Delete drawing-view alignment', 'bw-drawing-alignment-delete', 'command.commit', 'available'],
  ['dialog.drawing-pdf.scale', 'Select drawing PDF scale', 'bw-drawing-pdf-scale', 'control.set', 'available'],
  ['dialog.drawing-sheet.apply', 'Apply drawing sheet', 'bw-drawing-sheet-apply', 'command.commit', 'available'],
  ['dialog.drawing-sheet.up', 'Move drawing sheet up', 'bw-drawing-sheet-up', 'command.commit', 'available'],
  ['dialog.drawing-sheet.down', 'Move drawing sheet down', 'bw-drawing-sheet-down', 'command.commit', 'available'],
  ['dialog.drawing-sheet.delete', 'Delete drawing sheet', 'bw-drawing-sheet-delete', 'command.commit', 'available'],
  ['dialog.drawing-pdf.download', 'Download drawing PDF', 'bw-drawing-pdf-download', 'artifact.export-drawing-pdf', 'available'],
  ['dialog.drawing-pdf.print', 'Print drawing PDF', 'bw-drawing-pdf-print', 'artifact.print-drawing-pdf', 'available'],
  ['dialog.pdm.open', 'Open PDM manager', 'bw-pdm-open', 'control.invoke', 'available'],
  ['dialog.pdm.close', 'Close PDM manager', 'bw-pdm-close', 'control.invoke', 'available'],
  ['dialog.pdm.initialize', 'Initialize PDM', 'bw-pdm-initialize', 'command.commit', 'available'],
  ['dialog.pdm.branch', 'Create PDM branch', 'bw-pdm-new-branch', 'command.commit', 'available'],
  ['dialog.pdm.version', 'Create PDM version', 'bw-pdm-create-version', 'command.commit', 'available'],
  ['dialog.pdm.checkout', 'Check out PDM branch', 'bw-pdm-checkout', 'command.commit', 'available'],
  ['dialog.pdm.submit', 'Submit PDM review', 'bw-pdm-submit', 'command.commit', 'available'],
  ['dialog.pdm.approve', 'Approve PDM version', 'bw-pdm-approve', 'command.commit', 'available'],
  ['dialog.pdm.reject', 'Reject PDM version', 'bw-pdm-reject', 'command.commit', 'available'],
  ['dialog.pdm.return', 'Return PDM version', 'bw-pdm-return', 'command.commit', 'available'],
  ['dialog.pdm.release', 'Release PDM version', 'bw-pdm-release', 'command.commit', 'available'],
  ['dialog.pdm.obsolete', 'Obsolete PDM version', 'bw-pdm-obsolete', 'command.commit', 'available'],
  ['dialog.tour.back', 'Previous tour step', 'bw-tour-back', 'control.invoke', 'available'],
  ['dialog.tour.next', 'Next tour step', 'bw-tour-next', 'control.invoke', 'available'],
  ['dialog.tour.skip', 'Skip tour', 'bw-tour-skip', 'control.invoke', 'available'],
  ['dialog.transition.undo', 'Undo transition', 'bw-transition-undo', 'transition.undo', 'available'],
  ['dialog.transition.close', 'Dismiss transition', 'bw-transition-close', 'transition.dismiss', 'available'],
  ['dialog.commandbar.apply', 'Apply command-bar draft', 'bw-cmd-apply', 'command.commit', 'available'],
  ['dialog.commandbar.cancel', 'Cancel command-bar draft', 'bw-cmd-cancel', 'command.cancel', 'available'],
].map(([id, label, elementId, semanticAction, adapter = 'missing', operationKinds = []]) =>
  control(id, label, 'dialog', [idBinding(elementId)], {
    kind: 'dialog-action',
    semanticAction,
    adapter,
    operationKinds,
    ...(operationKinds.length
      ? {
          permission: 'project.edit',
          adapterTool: semanticAction === 'command.commit' ? 'cad_preview' : 'cad_ui',
          ...(semanticAction === 'command.commit' ? { completionTool: 'cad_commit' } : {}),
        }
      : {}),
    ...(id === 'dialog.clear.confirm'
      ? {
          permission: 'project.edit',
          adapterTool: 'cad_preview',
          completionTool: 'cad_commit',
          operationKinds: ['project.clear'],
        }
      : id === 'dialog.template.use' || id === 'dialog.transition.undo'
        ? { permission: 'project.edit', adapterTool: 'cad_ui' }
      : {}),
  }));

const modelingLifecycleControls = [
  ['model.face.next', 'Next planar face', 'bw-face-next', 'available'],
  ['model.face.use', 'Use selected face', 'bw-face-use', 'available'],
  ['model.face.base', 'Use base plane', 'bw-face-base', 'available'],
  ['model.face.cancel', 'Cancel face selection', 'bw-face-cancel', 'available', 'command.cancel'],
  ['model.shell.next', 'Next shell face', 'bw-shell-next', 'available'],
  ['model.shell.toggle', 'Toggle shell face', 'bw-shell-toggle', 'available'],
  ['model.shell.apply', 'Apply shell', 'bw-shell-apply', 'available'],
  ['model.shell.cancel', 'Cancel shell', 'bw-shell-cancel', 'available'],
  ['model.edge.apply', 'Apply edge operation', 'bw-pick-apply', 'available'],
  ['model.edge.cancel', 'Cancel edge operation', 'bw-pick-cancel', 'available'],
  ['sketch.apply', 'Apply sketch feature', 'bw-sk-apply', 'available'],
  ['sketch.cancel', 'Cancel sketch feature', 'bw-sk-cancel', 'available'],
  ['sketch.project', 'Project reference edges', 'bw-sk-project', 'available'],
  ['sketch.presspull.start', 'Start press pull', 'bw-sk-presspull', 'available'],
  ['sketch.presspull.apply', 'Finish press pull', 'bw-presspull-apply', 'available', 'command.commit'],
  ['sketch.presspull.back', 'Back to sketch', 'bw-presspull-back', 'available'],
].map(([id, label, elementId, adapter = 'missing', semanticAction = null]) =>
  control(id, label, 'modeling-lifecycle', [idBinding(elementId)], {
    kind: 'dialog-action',
    semanticAction: semanticAction || (id.endsWith('.cancel') ? 'command.cancel' : 'command.advance'),
    adapter,
    permission: 'project.edit',
  }));

const panelControls = [
  control('panel.model', 'Model panel', 'panel', [idBinding('bw-mtab-history')], { semanticAction: 'panel.open', adapter: 'available' }),
  control('panel.parameters', 'Parameters panel', 'panel', [idBinding('bw-mtab-params')], { semanticAction: 'panel.open', adapter: 'available' }),
  control('panel.project', 'Project panel', 'panel', [idBinding('bw-mtab-project')], { semanticAction: 'panel.open', adapter: 'available' }),
  control('parameter.add', 'Add parameter', 'parameter', [idBinding('bw-param-add')], {
    semanticAction: 'document.previewCommit',
    adapter: 'available',
    permission: 'project.edit',
    adapterTool: 'cad_preview',
    completionTool: 'cad_commit',
    operationKinds: ['parameter.create'],
  }),
  control('body.create', 'Create body', 'model-tree', [idBinding('bw-body-new')], {
    semanticAction: 'control.invoke',
    adapter: 'available',
    permission: 'ui.command-draft',
    operationKinds: ['feature.extrude'],
    commandId: 'model.extrude',
  }),
  control('tree.base-plane', 'Base plane', 'model-tree', [idBinding('bw-tree-base')], { semanticAction: 'selection.set', adapter: 'available' }),
  control('tree.entity', 'Model tree entity actions', 'model-tree', [dynamicBinding('model-tree.entity')], {
    semanticAction: 'tree.invoke',
    permission: 'ui.select',
    variants: [
      controlBoundVariant('datum.select', 'Select datum', {
        controlId: 'tree.entity.datum.select',
        adapter: 'available',
        permission: 'ui.select',
      }),
      controlBoundVariant('datum.edit', 'Edit datum', {
        controlId: 'tree.entity.datum.edit',
        semanticAction: 'command.open',
        adapter: 'available',
        permission: 'ui.command-draft',
        commandResolver: 'selected-datum-kind',
      }),
      controlBoundVariant('sketch.select', 'Select sketch', {
        controlId: 'tree.entity.sketch.select',
        adapter: 'available',
        permission: 'ui.select',
      }),
      controlBoundVariant('sketch.edit', 'Edit or manage sketch', {
        controlId: 'tree.entity.sketch.edit',
        semanticAction: 'command.open',
        adapter: 'available',
        permission: 'ui.command-draft',
        commandResolver: 'selected-sketch-role',
      }),
      familyVariant('tree.entity', 'pattern-instance.select', 'Select pattern occurrence', { adapter: 'available', permission: 'ui.select' }),
      familyDocumentEditVariant('tree.entity', 'pattern-instance.skip', 'Skip pattern occurrence', 'pattern.update'),
      familyVariant('tree.entity', 'pattern-instance.independent', 'Make pattern occurrence independent', {
        semanticAction: 'tree.invoke',
        adapter: 'available',
        permission: 'project.edit',
        adapterTool: 'cad_ui',
        completionTool: 'cad_commit',
        operationKinds: ['pattern.materialize'],
      }),
      familyVariant('tree.entity', 'pattern-instance.export', 'Select pattern occurrence for export', { adapter: 'available', permission: 'ui.select' }),
      familyEntityEditVariant('tree.entity', 'pattern.edit', 'Edit body pattern', 'model.pattern'),
      familyDocumentEditVariant('tree.entity', 'pattern.visibility', 'Toggle body-pattern visibility', 'pattern.update'),
      familyVariant('tree.entity', 'pattern.dissolve', 'Dissolve body pattern', {
        semanticAction: 'tree.invoke',
        adapter: 'available',
        permission: 'project.edit',
        adapterTool: 'cad_ui',
        completionTool: 'cad_commit',
        operationKinds: ['pattern.materialize'],
      }),
      familyDocumentEditVariant('tree.entity', 'pattern.delete', 'Delete body pattern', 'pattern.delete'),
    ],
  }),
  control('tree.feature', 'Feature history actions', 'model-tree', [dynamicBinding('history.feature')], {
    semanticAction: 'tree.invoke',
    permission: 'document.edit',
    variants: [
      familyVariant('tree.feature', 'select', 'Select feature', { adapter: 'available', permission: 'ui.select' }),
      familyDocumentEditVariant('tree.feature', 'move-earlier', 'Move feature earlier', 'feature.reorder'),
      familyDocumentEditVariant('tree.feature', 'move-later', 'Move feature later', 'feature.reorder'),
      familyDocumentEditVariant('tree.feature', 'rollback-toggle', 'Toggle rollback marker', 'feature.rollback'),
      familyFeatureEditVariant('tree.feature', 'edit', 'Edit feature'),
      familyDocumentEditVariant('tree.feature', 'delete', 'Delete feature', 'feature.delete'),
      familyDocumentEditVariant('tree.feature', 'drag-reorder', 'Drag feature to reorder', 'feature.reorder'),
    ],
  }),
  control('tree.body', 'Body actions', 'model-tree', [dynamicBinding('body.entity')], {
    semanticAction: 'tree.invoke',
    permission: 'document.edit',
    variants: [
      familyVariant('tree.body', 'select', 'Select body', { adapter: 'available', permission: 'ui.select' }),
      familyDocumentEditVariant('tree.body', 'activate', 'Activate body', 'body.activate'),
      familyDocumentEditVariant('tree.body', 'visibility', 'Toggle body visibility', 'body.setVisibility'),
      familyVariant('tree.body', 'isolate', 'Isolate or restore body', { adapter: 'available', permission: 'ui.select' }),
      familyDocumentEditVariant('tree.body', 'rename', 'Rename body', 'body.rename'),
      familyDocumentEditVariant('tree.body', 'suppress', 'Suppress or restore body', 'body.suppress'),
      familyVariant('tree.body', 'export', 'Select body for export', { adapter: 'available', permission: 'ui.select' }),
      familyDocumentEditVariant('tree.body', 'delete', 'Delete body', 'body.delete'),
    ],
  }),
  control('tree.assembly', 'Assembly occurrence, feature, and mate actions', 'model-tree', [dynamicBinding('assembly.entity')], {
    semanticAction: 'tree.invoke',
    permission: 'document.edit',
    variants: [
      familyVariant('tree.assembly', 'occurrence.expand', 'Expand or collapse component occurrence', { adapter: 'available', permission: 'ui.navigate' }),
      familyVariant('tree.assembly', 'occurrence.select', 'Select component occurrence', { adapter: 'available', permission: 'ui.select' }),
      familyDocumentEditVariant('tree.assembly', 'occurrence.visibility', 'Toggle component visibility', 'component.update'),
      familyDocumentEditVariant('tree.assembly', 'occurrence.suppress', 'Suppress or restore component', 'component.update'),
      familyVariant('tree.assembly', 'occurrence.export', 'Select component for export', { adapter: 'available', permission: 'ui.select' }),
      familyVariant('tree.assembly', 'runtime-occurrence.select', 'Select generated component occurrence', { adapter: 'available', permission: 'ui.select' }),
      familyVariant('tree.assembly', 'mate.select', 'Select mate', { adapter: 'available', permission: 'ui.select' }),
      familyDocumentEditVariant('tree.assembly', 'mate.suppress', 'Suppress or restore mate', 'mate.update'),
      familyDocumentEditVariant('tree.assembly', 'mate.delete', 'Delete mate', 'mate.delete'),
      familyVariant('tree.assembly', 'smart-fastener.edit', 'Edit Smart Fastener with a current exact plan', {
        semanticAction: 'tree.invoke', adapter: 'available', permission: 'ui.command-draft', operationKinds: ['smartFastener.update'],
      }),
      familyDocumentEditVariant('tree.assembly', 'smart-fastener.delete', 'Delete Smart Fastener group', 'smartFastener.delete'),
      familyVariant('tree.assembly', 'assembly-feature.select', 'Select assembly cut or hole', {
        adapter: 'available', permission: 'ui.select',
      }),
      familyVariant('tree.assembly', 'assembly-feature.edit', 'Edit assembly cut or hole', {
        semanticAction: 'tree.invoke', adapter: 'available', permission: 'ui.command-draft',
        operationKinds: ['assemblyFeature.update'], commandId: 'assembly.feature',
      }),
      familyDocumentEditVariant('tree.assembly', 'assembly-feature.delete', 'Delete assembly cut or hole', 'assemblyFeature.delete'),
    ],
  }),
  control('tree.inspection', 'Saved inspection actions', 'model-tree', [dynamicBinding('inspection.entity')], {
    semanticAction: 'tree.invoke',
    permission: 'document.edit',
    variants: [
      familyDocumentEditVariant('tree.inspection', 'section.toggle', 'Activate or deactivate saved section', 'section.activate'),
      familyDocumentEditVariant('tree.inspection', 'section.delete', 'Delete saved section', 'section.delete'),
      familyDocumentEditVariant('tree.inspection', 'explode.toggle', 'Activate or deactivate exploded view', 'exploded.activate'),
      familyDocumentEditVariant('tree.inspection', 'explode.delete', 'Delete exploded view', 'exploded.delete'),
      familyDocumentEditVariant('tree.inspection', 'stage.visibility', 'Toggle stage-group visibility', 'stage.update'),
      familyDocumentEditVariant('tree.inspection', 'stage.spacing-less', 'Decrease stage spacing', 'stage.update'),
      familyDocumentEditVariant('tree.inspection', 'stage.spacing-more', 'Increase stage spacing', 'stage.update'),
      familyVariant('tree.inspection', 'measurement.evaluate', 'Evaluate saved measurement', { adapter: 'available', permission: 'project.read' }),
      familyDocumentEditVariant('tree.inspection', 'measurement.delete', 'Delete saved measurement', 'measurement.delete'),
    ],
  }),
  control('parameter.row', 'Parameter row actions', 'parameter', [dynamicBinding('parameter.entity')], {
    semanticAction: 'parameter.invoke',
    permission: 'document.edit',
    variants: [
      familyDocumentEditVariant('parameter.row', 'rename', 'Rename parameter', 'parameter.update'),
      familyDocumentEditVariant('parameter.row', 'set-value', 'Set parameter value', 'parameter.update'),
      familyDocumentEditVariant('parameter.row', 'delete', 'Delete parameter', 'parameter.delete'),
    ],
  }),
  control('template.card', 'Template selection', 'template', [dynamicBinding('template.card')], {
    semanticAction: 'template.select',
    adapter: 'available',
    variants: [familyVariant('template.card', 'select', 'Select template')],
  }),
  control('recovery.entry', 'Recovery entry actions', 'recovery', [dynamicBinding('recovery.entry')], {
    semanticAction: 'recovery.restore',
    permission: 'project.recover',
    variants: [familyVariant('recovery.entry', 'restore', 'Restore recovery entry', {
      adapter: 'available',
      semanticAction: 'recovery.restore',
      permission: 'project.recover',
      adapterTool: 'cad_ui',
    })],
  }),
  control('inspector.context', 'Inspector context actions', 'inspector', [dynamicBinding('inspector.context')], {
    semanticAction: 'inspector.invoke',
    variants: [
      familyVariant('inspector.context', 'inspection.clear', 'Close inspection results', { adapter: 'available', permission: 'ui.select' }),
      familyVariant('inspector.context', 'mate.edit', 'Edit selected mate', {
        semanticAction: 'command.open',
        adapter: 'available',
        permission: 'ui.command-draft',
        commandResolver: 'selected-mate-kind',
      }),
      familyDocumentEditVariant('inspector.context', 'mate.suppress', 'Suppress or restore selected mate', 'mate.update'),
      familyDocumentEditVariant('inspector.context', 'mate.delete', 'Delete selected mate', 'mate.delete'),
      familyVariant('inspector.context', 'assembly-feature.edit', 'Edit selected assembly cut or hole', {
        semanticAction: 'command.open', adapter: 'available', permission: 'ui.command-draft', commandId: 'assembly.feature',
      }),
      familyDocumentEditVariant('inspector.context', 'assembly-feature.delete', 'Delete selected assembly cut or hole', 'assemblyFeature.delete'),
      familyDocumentEditVariant('inspector.context', 'occurrence.visibility', 'Toggle selected component visibility', 'component.update'),
      familyDocumentEditVariant('inspector.context', 'occurrence.suppress', 'Suppress or restore selected component', 'component.update'),
      familyVariant('inspector.context', 'occurrence.isolate', 'Isolate or restore selected component', { adapter: 'available', permission: 'ui.select' }),
      familyVariant('inspector.context', 'occurrence.edit-context', 'Edit selected component in context', {
        semanticAction: 'command.open', adapter: 'available', permission: 'ui.command-draft', commandId: 'assembly.edit-context',
      }),
      familyVariant('inspector.context', 'occurrence.variant', 'Edit selected component variant', {
        semanticAction: 'command.open', adapter: 'available', permission: 'ui.command-draft', commandId: 'assembly.variant',
      }),
      familyVariant('inspector.context', 'occurrence.independent', 'Make selected component independent', {
        semanticAction: 'command.open', adapter: 'available', permission: 'ui.command-draft', commandId: 'assembly.independent',
      }),
      familyVariant('inspector.context', 'occurrence.transform', 'Drag selected component with mates', {
        semanticAction: 'command.open', adapter: 'available', permission: 'ui.command-draft', commandId: 'assembly.component-transform',
      }),
      familyVariant('inspector.context', 'occurrence.linked', 'Create linked component duplicate', {
        semanticAction: 'command.open', adapter: 'available', permission: 'ui.command-draft', commandId: 'assembly.linked',
      }),
      familyDocumentEditVariant('inspector.context', 'occurrence.delete', 'Delete selected component', 'component.delete'),
      familyVariant('inspector.context', 'occurrence.export', 'Select component bodies for export', { adapter: 'available', permission: 'ui.select' }),
      familyEntityEditVariant('inspector.context', 'pattern.edit', 'Edit selected pattern', 'model.pattern'),
      familyDocumentEditVariant('inspector.context', 'pattern.skip', 'Skip selected pattern occurrence', 'pattern.update'),
      familyDocumentEditVariant('inspector.context', 'body.rename', 'Rename selected body', 'body.rename'),
      familyDocumentEditVariant('inspector.context', 'body.activate', 'Activate selected body', 'body.activate'),
      familyDocumentEditVariant('inspector.context', 'body.visibility', 'Toggle selected body visibility', 'body.setVisibility'),
      familyVariant('inspector.context', 'body.isolate', 'Isolate or restore selected body', { adapter: 'available', permission: 'ui.select' }),
      familyDocumentEditVariant('inspector.context', 'body.suppress', 'Suppress or restore selected body', 'body.suppress'),
      familyDocumentEditVariant('inspector.context', 'body.subtract', 'Subtract selected body from active body', 'boolean.subtract'),
      familyDocumentEditVariant('inspector.context', 'body.intersect', 'Intersect selected body with active body', 'boolean.intersect'),
      familyDocumentEditVariant('inspector.context', 'body.union', 'Union selected body with active body', 'boolean.union'),
      familyDocumentEditVariant('inspector.context', 'body.delete', 'Delete selected body', 'body.delete'),
      familyFeatureEditVariant('inspector.context', 'feature.dimension', 'Edit selected feature dimension'),
      familyFeatureEditVariant('inspector.context', 'feature.through', 'Toggle selected cut through-all'),
      familyDocumentEditVariant('inspector.context', 'feature.pattern-count', 'Edit selected feature pattern count', 'feature.update'),
      familyDocumentEditVariant('inspector.context', 'feature.pattern-a', 'Edit selected feature pattern first spacing', 'feature.update'),
      familyDocumentEditVariant('inspector.context', 'feature.pattern-b', 'Edit selected feature pattern second spacing', 'feature.update'),
      familyFeatureEditVariant('inspector.context', 'feature.edit', 'Edit selected feature'),
      familyDocumentEditVariant('inspector.context', 'feature.delete', 'Delete selected feature', 'feature.delete'),
    ],
  }),
];

const auxiliaryControls = [
  control('viewport.navigation.orbit', 'Orbit navigation mode', 'viewport', [attributeBinding('data-nav-mode', 'orbit')], { kind: 'mode', semanticAction: 'viewport.setNavigationMode', adapter: 'available' }),
  control('viewport.navigation.pan', 'Pan navigation mode', 'viewport', [attributeBinding('data-nav-mode', 'pan')], { kind: 'mode', semanticAction: 'viewport.setNavigationMode', adapter: 'available' }),
  control('viewport.selection-filter', 'Selection filter', 'viewport', [idBinding('bw-selection-filter')], { kind: 'field', semanticAction: 'control.setValue', adapter: 'available', permission: 'ui.select' }),
  control('viewport.select-other', 'Select other overlapping item', 'viewport', [idBinding('bw-select-other')], { semanticAction: 'control.invoke', adapter: 'available', permission: 'ui.select' }),
  control('viewport.box-select', 'Box or crossing selection', 'viewport', [idBinding('bw-box-select')], { kind: 'mode', semanticAction: 'control.invoke', adapter: 'available', permission: 'ui.select' }),
  control('viewport.context-toolbar', 'Selection context toolbar', 'viewport', [idBinding('bw-context-toolbar')], { kind: 'surface', semanticAction: 'control.invoke', adapter: 'available', permission: 'ui.select' }),
  control('viewport.mouse-gestures', 'Four-way mouse gesture menu', 'viewport', [idBinding('bw-mouse-gesture')], { kind: 'surface', semanticAction: 'control.invoke', adapter: 'available', permission: 'ui.select' }),
  control('viewport.orientation-manager', 'Saved view orientation manager', 'viewport', [idBinding('bw-orientation-list')], { kind: 'surface', semanticAction: 'control.invoke', adapter: 'available', permission: 'ui.navigate' }),
  control('viewport.display-state-manager', 'Saved display state manager', 'viewport', [idBinding('bw-display-state-list')], { kind: 'surface', semanticAction: 'control.invoke', adapter: 'available', permission: 'ui.navigate' }),
  control('viewport.scene-preset', 'Scene and lighting preset', 'viewport', [idBinding('bw-scene-preset')], { kind: 'field', semanticAction: 'control.setValue', adapter: 'available', permission: 'ui.navigate' }),
  control('viewport.scene-exposure', 'Scene exposure', 'viewport', [idBinding('bw-scene-exposure')], { kind: 'field', semanticAction: 'control.setValue', adapter: 'available', permission: 'ui.navigate' }),
  control('viewport.realview', 'RealView-style physical presentation', 'viewport', [idBinding('bw-scene-realview')], { kind: 'mode', semanticAction: 'control.setValue', adapter: 'available', permission: 'ui.navigate' }),
  control('viewport.contact-shadows', 'Contact shadows', 'viewport', [idBinding('bw-scene-shadows')], { kind: 'mode', semanticAction: 'control.setValue', adapter: 'available', permission: 'ui.navigate' }),
  control('help.shortcut-editor', 'Keyboard shortcut editor', 'help', [idBinding('bw-shortcut-editor')], { kind: 'field', semanticAction: 'control.setValue', adapter: 'available', permission: 'ui.navigate' }),
  control('viewport.canvas', '3D viewport interaction', 'viewport', [idBinding('bw-studio')], {
    kind: 'surface',
    semanticAction: 'viewport.interact',
    semanticActions: ['selection.set', 'selection.add', 'selection.remove', 'selection.clear', 'viewport.setCamera', 'viewport.fitAll', 'viewport.fitSelection', 'viewport.setNavigationMode'],
    adapter: 'available',
    permissions: ['ui.select', 'ui.navigate'],
    adapterTool: 'cad_ui',
  }),
  control('sketch.canvas', '2D sketch interaction', 'sketch', [idBinding('bw-sketch-canvas')], {
    kind: 'surface',
    semanticAction: 'sketch.shape.edit',
    semanticActions: [
      'sketch.setTool',
      'sketch.shape.select',
      'sketch.shape.update',
      'sketch.shape.delete',
      'command.setInput',
      'command.clearInput',
    ],
    adapter: 'available',
    permissions: ['ui.command-draft'],
    adapterTool: 'cad_ui',
    operationKinds: ['sketch.drag'],
  }),
  control('welcome.template.jet-engine-exploded-assembly', 'Exploded turbofan assembly template', 'welcome', [attributeBinding('data-welcome-template', 'jet-engine-exploded-assembly')], { semanticAction: 'template.use', adapter: 'available', permission: 'project.edit', adapterTool: 'cad_ui', templateId: 'jet-engine-exploded-assembly' }),
  control('welcome.template.starter-plate', 'Starter plate template', 'welcome', [attributeBinding('data-welcome-template', 'starter-plate')], { semanticAction: 'template.use', adapter: 'available', permission: 'project.edit', adapterTool: 'cad_ui', templateId: 'starter-plate' }),
  control('welcome.template.electronics-tray', 'Electronics tray template', 'welcome', [attributeBinding('data-welcome-template', 'electronics-tray')], { semanticAction: 'template.use', adapter: 'available', permission: 'project.edit', adapterTool: 'cad_ui', templateId: 'electronics-tray' }),
  control('welcome.template.four-hole-plate', 'Four-hole plate template', 'welcome', [attributeBinding('data-welcome-template', 'four-hole-plate')], { semanticAction: 'template.use', adapter: 'available', permission: 'project.edit', adapterTool: 'cad_ui', templateId: 'four-hole-plate' }),
  control('welcome.template.turned-knob', 'Turned knob template', 'welcome', [attributeBinding('data-welcome-template', 'turned-knob')], { semanticAction: 'template.use', adapter: 'available', permission: 'project.edit', adapterTool: 'cad_ui', templateId: 'turned-knob' }),
  control('welcome.templates', 'Browse templates from welcome', 'welcome', [idBinding('bw-welcome-templates')], { semanticAction: 'control.invoke', adapter: 'available' }),
  control('welcome.blank-sketch', 'Start blank sketch', 'welcome', [idBinding('bw-welcome-start')], { semanticAction: 'project.newBlank', adapter: 'available', permission: 'project.edit', adapterTool: 'cad_ui', operationKinds: ['feature.extrude'] }),
  control('welcome.open', 'Open project from welcome', 'welcome', [idBinding('bw-welcome-open')], {
    semanticAction: 'artifact.import',
    adapter: 'available',
    permission: 'project.replace',
    adapterTool: 'cad_artifact',
  }),
  control('welcome.help', 'Open help from welcome', 'welcome', [idBinding('bw-welcome-help')], { semanticAction: 'control.invoke', adapter: 'available' }),
  control('help.tour', 'Start guided tour', 'help', [idBinding('bw-help-tour')], { semanticAction: 'control.invoke', adapter: 'available' }),
  control('help.templates', 'Browse templates from help', 'help', [idBinding('bw-help-templates')], { semanticAction: 'control.invoke', adapter: 'available' }),
  control('help.full', 'Open full PartMode Help', 'help', [idBinding('bw-help-full')], {
    semanticAction: 'application.navigate',
    adapter: 'contextual',
    contextualReasonCode: 'DOCUMENTATION_NAVIGATION_OUTSIDE_CAD_SESSION',
  }),
  control('help.agent-setup', 'Open hosted MCP setup', 'help', [idBinding('bw-help-agent-setup')], {
    semanticAction: 'application.navigate',
    adapter: 'contextual',
    contextualReasonCode: 'DOCUMENTATION_NAVIGATION_OUTSIDE_CAD_SESSION',
  }),
  control('help.agent-guide', 'Open agent reference', 'help', [idBinding('bw-help-agent-guide')], {
    semanticAction: 'application.navigate',
    adapter: 'contextual',
    contextualReasonCode: 'DOCUMENTATION_NAVIGATION_OUTSIDE_CAD_SESSION',
  }),
  control('help.agent', 'Connect local agent from help', 'help', [idBinding('bw-help-agent')], {
    semanticAction: 'session.connect',
    adapter: 'contextual',
    permission: 'session.connect',
    contextualReasonCode: 'HUMAN_AUTHORITY_BOUNDARY',
  }),
  control('template.search', 'Search templates', 'template', [idBinding('bw-template-search')], { kind: 'field', semanticAction: 'control.setValue', adapter: 'available' }),
  control('model.shell.thickness', 'Shell wall thickness', 'modeling-field', [idBinding('bw-shell-t')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('model.edge.radius', 'Edge radius', 'modeling-field', [idBinding('bw-pick-r')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.operation.height', 'Sketch operation height', 'sketch-field', [idBinding('bw-sk-op-h')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.operation.through', 'Sketch through-all option', 'sketch-field', [idBinding('bw-sk-through')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.operation.pattern', 'Sketch pattern type', 'sketch-field', [idBinding('bw-sk-pat')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.operation.pattern-count', 'Sketch pattern count', 'sketch-field', [idBinding('bw-sk-pat-n')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.operation.pattern-a', 'Sketch pattern first spacing', 'sketch-field', [idBinding('bw-sk-pat-a')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.operation.pattern-b', 'Sketch pattern second spacing', 'sketch-field', [idBinding('bw-sk-pat-b')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.operation.result', 'Sketch result policy', 'sketch-field', [idBinding('bw-sk-result')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.operation.body-name', 'Sketch result body name', 'sketch-field', [idBinding('bw-sk-body-name')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.operation.target', 'Sketch target body', 'sketch-field', [idBinding('bw-sk-target')], { kind: 'field', semanticAction: 'command.bindSelection', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.presspull.distance', 'Press-pull distance', 'sketch-field', [idBinding('bw-presspull-h')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('sketch.shape.dimension', 'Selected sketch-shape dimensions', 'sketch-field', [dynamicBinding('sketch.shape.dimension')], {
    kind: 'field',
    semanticAction: 'sketch.shape.update',
    adapter: 'available',
    permission: 'ui.command-draft',
    adapterTool: 'cad_ui',
    fieldId: 'sketch',
    variants: [
      controlBoundVariant('w', 'Selected rectangle width', { controlId: 'sketch.shape.dimension.w', operation: 'w' }),
      controlBoundVariant('h', 'Selected rectangle height', { controlId: 'sketch.shape.dimension.h', operation: 'h' }),
      controlBoundVariant('x', 'Selected shape X position', { controlId: 'sketch.shape.dimension.x', operation: 'x' }),
      controlBoundVariant('y', 'Selected shape Y position', { controlId: 'sketch.shape.dimension.y', operation: 'y' }),
      controlBoundVariant('d', 'Selected circle diameter', { controlId: 'sketch.shape.dimension.d', operation: 'd' }),
    ],
  }),
  control('sketch.shape.delete', 'Delete selected sketch shape', 'sketch-field', [idBinding('bw-sk-delshape')], {
    semanticAction: 'sketch.shape.delete',
    adapter: 'available',
    permission: 'ui.command-draft',
    adapterTool: 'cad_ui',
    fieldId: 'sketch',
  }),
  control('sketch.constraint.dimension', 'Constrained-sketch driving dimensions', 'sketch-field', [controlIdBinding('sketch.constraint.dimension')], {
    kind: 'field',
    semanticAction: 'command.setInput',
    adapter: 'available',
    permission: 'ui.command-draft',
    fieldId: 'sketch',
  }),
  control('sketch.constraint.kind', 'Manual sketch constraint type', 'sketch-field', [controlIdBinding('sketch.constraint.kind')], { kind: 'field', permission: 'ui.command-draft' }),
  control('sketch.constraint.reference', 'Reference-only dimension toggle', 'sketch-field', [controlIdBinding('sketch.constraint.reference')], { kind: 'field', permission: 'ui.command-draft' }),
  control('sketch.constraint.pierce', 'Pierce reference curve selector', 'sketch-field', [controlIdBinding('sketch.constraint.pierce')], { kind: 'field', permission: 'ui.command-draft' }),
  control('sketch.constraint.add', 'Add manual sketch constraint', 'sketch-field', [controlIdBinding('sketch.constraint.add')], { permission: 'ui.command-draft' }),
  control('sketch.constraint.delete', 'Delete manual sketch constraint', 'sketch-field', [controlIdBinding('sketch.constraint.delete')], { permission: 'ui.command-draft' }),
  control('sketch.point.fixed', 'Fix or release sketch point', 'sketch-field', [controlIdBinding('sketch.point.fixed')], { permission: 'ui.command-draft' }),
  control('sketch.point.merge', 'Merge two sketch points', 'sketch-field', [controlIdBinding('sketch.point.merge')], { permission: 'ui.command-draft' }),
  control('dialog.command.field', 'Normal command dialog fields', 'dialog-field', [controlIdBinding('dialog.command.field')], { kind: 'field', semanticAction: 'command.setInput', adapter: 'available', permission: 'ui.command-draft' }),
  control('dialog.template.category', 'Template category', 'template', [controlIdBinding('dialog.template.category')], { semanticAction: 'template.filter', adapter: 'available' }),
  ...[
    ['origin', 'Origin'],
    ['datums', 'Datums'],
    ['sketches', 'Sketches'],
    ['patterns', 'Body patterns'],
    ['components', 'Components'],
    ['mates', 'Mates'],
    ['inspection', 'Views and stages'],
  ].map(([sectionId, label]) =>
    control(`tree.section.${sectionId}`, `${label} model-tree section`, 'model-tree', [
      controlIdBinding(`tree.section.${sectionId}`),
    ], {
      semanticAction: 'tree.setSectionExpanded',
      adapter: 'available',
      permission: 'ui.navigate',
      sectionId,
    })),
];

export const CAD_UI_CONTROL_REGISTRY = Object.freeze([
  ...projectControls,
  ...workspaceControls,
  ...basicFeatureControls,
  holeWizardControl,
  threadControl,
  structuralMemberControl,
  structuralTreatmentControl,
  sheetMetalFlangeControl,
  ...directEditControls,
  weldBeadControl,
  drawingCutListControl,
  ...advancedFeatureControls,
  ...sketchReuseControls,
  ...sketchControls,
  ...assemblyControls,
  ...mateControls,
  ...inspectionControls,
  ...displayControls,
  ...viewControls,
  ...dialogControls,
  ...modelingLifecycleControls,
  ...panelControls,
  ...auxiliaryControls,
].map((entry) => {
  if (entry.kind !== 'command') return entry;
  if (!Object.hasOwn(COMMAND_FIELD_CONTRACTS, entry.id)) {
    throw new Error(`CAD UI command "${entry.id}" has no declared field contract.`);
  }
  const fields = COMMAND_FIELD_CONTRACTS[entry.id];
  return Object.freeze({
    ...entry,
    fields,
    fieldContract: fields.length ? 'typed' : 'none',
  });
}));

export const CAD_UI_COMMAND_REGISTRY = Object.freeze(
  CAD_UI_CONTROL_REGISTRY.filter((entry) => entry.kind === 'command'),
);

export const CAD_UI_EXPANDED_CONTROL_REGISTRY = Object.freeze(
  CAD_UI_CONTROL_REGISTRY.flatMap((entry) => {
    if (!entry.variants.length) return [entry];
    return entry.variants.map((entryVariant) => Object.freeze({
      ...entry,
      id: `${entry.id}.${entryVariant.id}`,
      label: entryVariant.label,
      parentControlId: entry.id,
      semanticAction: entryVariant.semanticAction || entry.semanticAction,
      adapter: entryVariant.adapter || entry.adapter,
      permission: entryVariant.permission || entry.permission,
      contextualReasonCode: entryVariant.contextualReasonCode || entry.contextualReasonCode,
      adapterTool: entryVariant.adapterTool || entry.adapterTool,
      completionTool: entryVariant.completionTool || entry.completionTool,
      operationKinds: Object.freeze(entryVariant.operationKinds || entry.operationKinds),
      commandId: entryVariant.commandId || entry.commandId,
      commandResolver: entryVariant.commandResolver || entry.commandResolver,
      humanBindings: Object.freeze(entryVariant.humanBindings || entry.humanBindings),
      fieldId: entryVariant.fieldId || entry.fieldId,
      operation: entryVariant.operation || entryVariant.id,
      variants: Object.freeze([]),
    }));
  }),
);

export function cadUiControlRegistry() {
  return clone(CAD_UI_EXPANDED_CONTROL_REGISTRY);
}

export function cadUiCommandDefinition(commandId) {
  const command = CAD_UI_COMMAND_REGISTRY.find((entry) => entry.id === commandId);
  return command ? clone(command) : null;
}

export function cadUiFullParityReport({ observedControlIds = [] } = {}) {
  const observed = new Set(observedControlIds);
  const covered = CAD_UI_EXPANDED_CONTROL_REGISTRY.filter((entry) => entry.adapter === 'available');
  const contextual = CAD_UI_EXPANDED_CONTROL_REGISTRY.filter((entry) => entry.adapter === 'contextual');
  const missing = CAD_UI_EXPANDED_CONTROL_REGISTRY.filter((entry) => entry.adapter === 'missing');
  const missingFieldCoverage = CAD_UI_COMMAND_REGISTRY.filter((entry) => !['typed', 'none'].includes(entry.fieldContract));
  const registryIds = new Set([
    ...CAD_UI_CONTROL_REGISTRY.map((entry) => entry.id),
    ...CAD_UI_EXPANDED_CONTROL_REGISTRY.map((entry) => entry.id),
  ]);
  const observedOrphans = [...observed].filter((id) => !registryIds.has(id)).sort();
  const commandFieldDenominator = CAD_UI_COMMAND_REGISTRY
    .reduce((count, entry) => count + entry.fields.length, 0);
  const accounted = covered.length + contextual.length;
  return {
    denominator: CAD_UI_EXPANDED_CONTROL_REGISTRY.length,
    covered: covered.length,
    contextual: contextual.length,
    accounted,
    missing: missing.length,
    coveragePercent: Number(((accounted / CAD_UI_EXPANDED_CONTROL_REGISTRY.length) * 100).toFixed(2)),
    directCoveragePercent: Number(((covered.length / CAD_UI_EXPANDED_CONTROL_REGISTRY.length) * 100).toFixed(2)),
    commandDenominator: CAD_UI_COMMAND_REGISTRY.length,
    commandFieldDenominator,
    commandFieldCovered: CAD_UI_COMMAND_REGISTRY.length - missingFieldCoverage.length,
    missingAdapterIds: missing.map((entry) => entry.id),
    missingFieldCoverageIds: missingFieldCoverage.map((entry) => entry.id),
    observedOrphanIds: observedOrphans,
    complete: missing.length === 0 && missingFieldCoverage.length === 0 && observedOrphans.length === 0,
  };
}
