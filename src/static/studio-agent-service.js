import {
  STUDIO_V5_PROJECT_LIMITS,
  STUDIO_V5_SCHEMA_VERSION,
  createEmptyStudioV5PartProject,
} from './studio-project-v5.js';
import {
  canonicalStudioV5Project,
  configureStudioV5Feature,
  createStudioV5BooleanFeature,
  createStudioV5BooleanSplit,
  createStudioV5Datum,
  updateStudioV5Datum,
  deleteStudioV5Datum,
  createStudioV5ProfileSketch,
  createStudioV5PathSketch,
  createStudioV5ReferenceCurve,
  updateStudioV5AdvancedSketch,
  updateStudioV5ReferenceCurve,
  deleteStudioV5AdvancedSketch,
  createStudioV5ConstrainedSketch,
  promoteStudioV5InlineConstrainedSketch,
  updateStudioV5ConstrainedSketch,
  deleteStudioV5ConstrainedSketch,
  createStudioV5SketchBlockDefinition,
  updateStudioV5SketchBlockDefinition,
  deleteStudioV5SketchBlockDefinition,
  createStudioV5SketchBlockInstance,
  updateStudioV5SketchBlockInstance,
  deleteStudioV5SketchBlockInstance,
  explodeStudioV5SketchBlockInstance,
  createStudioV5SketchRelation,
  updateStudioV5SketchRelation,
  deleteStudioV5SketchRelation,
  createStudioV5DerivedSketch,
  updateStudioV5DerivedSketch,
  underiveStudioV5DerivedSketch,
  refreshStudioV5SketchInstances,
  createStudioV5LoftFeature,
  createStudioV5SweepFeature,
  createStudioStructuralMember,
  updateStudioStructuralMember,
  deleteStudioStructuralMember,
  createStudioWeldmentTreatment,
  updateStudioWeldmentTreatment,
  deleteStudioWeldmentTreatment,
  createStudioSheetMetalFeature,
  updateStudioSheetMetalFeature,
  deleteStudioSheetMetalFeature,
  setStudioSheetMetalBendTable,
  deleteStudioSheetMetalBendTable,
  createStudioWeldBead,
  updateStudioWeldBead,
  deleteStudioWeldBead,
  createStudioV5RevolveFeature,
  createStudioV5DraftFeature,
  createStudioV5ThickenFeature,
  createStudioV5FaceFilletFeature,
  createStudioV5VariableFilletFeature,
  updateStudioV5AdvancedFeature,
  createStudioV5BodyPattern,
  updateStudioV5BodyPattern,
  deleteStudioV5BodyPattern,
  materializeStudioV5PatternOccurrences,
  createStudioV5AssemblyFromPart,
  createStudioV5ComponentOccurrence,
  updateStudioV5ComponentOccurrence,
  duplicateStudioV5LinkedOccurrence,
  makeStudioV5OccurrenceIndependent,
  replaceStudioV5ComponentOccurrence,
  deleteStudioV5ComponentOccurrence,
  createStudioV5AssemblyMate,
  updateStudioV5AssemblyMate,
  deleteStudioV5AssemblyMate,
  createStudioV5OccurrencePattern,
  updateStudioV5OccurrencePattern,
  deleteStudioV5OccurrencePattern,
  enterStudioV5AssemblyContext,
  exitStudioV5AssemblyContext,
  createStudioV5TransformFeature,
  applyStudioV5SmartFastenerPlan,
  deleteStudioV5SmartFastenerGroup,
  updateStudioV5SmartFastenerGroup,
  createStudioV5AssemblyFeature,
  updateStudioV5AssemblyFeature,
  deleteStudioV5AssemblyFeature,
  createStudioV5DirectEditFeature,
  updateStudioV5DirectEditFeature,
  deleteStudioV5DirectEditFeature,
  updateStudioV5TransformFeature,
  reorderStudioV5Feature,
  setStudioV5RollbackMarker,
  deleteStudioV5Body,
  isStudioV5Project,
  prepareStudioV5RuntimeProject,
  refreshStudioV5ReferenceCurves,
  studioV5CanonicalHash,
  studioV5ActiveBody,
  studioV5RootAssembly,
  studioV5RootPart,
  switchStudioV5PartConfiguration,
  updateStudioV5Body,
} from './studio-v5-runtime-document.js';
import {
  assignStudioV5BodyMaterial,
  assignStudioV5OccurrenceAppearance,
  ensureStudioV5GenericMaterials,
  createStudioV5SectionView,
  updateStudioV5SectionView,
  activateStudioV5SectionView,
  deleteStudioV5SectionView,
  createStudioV5ExplodedView,
  activateStudioV5ExplodedView,
  deleteStudioV5ExplodedView,
  createStudioV5Measurement,
  updateStudioV5Measurement,
  deleteStudioV5Measurement,
  setStudioV5DisplayMode,
  createStudioV5AxialStageGroup,
  updateStudioV5AxialStageGroup,
  deleteStudioV5AxialStageGroup,
} from './studio-v5-inspection.js';
import { evaluateStudioV5Expression, studioV5ParameterValues } from './studio-v5-modeling.js';
import { STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM } from './studio-direct-edit.js';
import { previewStudioAssemblyDrag } from './studio-assembly-drag.js';
import { beginStudioSketchDrag, settleStudioSketchDrag } from './studio-sketch-drag.js';
import { createStudioV5PierceResolver } from './studio-sketch-pierce.js';
import {
  hasStudioExactTangentFilletPolicy,
  setStudioExactTangentFilletPolicy,
} from './studio-kernel-robustness.js';
import {
  STUDIO_THREAD_SCHEMA_V2,
  assertStudioThreadFeature,
} from './studio-thread.js';
import {
  checkoutStudioPdmBranch,
  createStudioPdmBranch,
  createStudioPdmVersion,
  initializeStudioPdm,
  inspectStudioPdm,
  obsoleteStudioPdmVersion,
  recordStudioPdmApproval,
  releaseStudioPdmVersion,
  returnStudioPdmForChanges,
  submitStudioPdmReview,
} from './studio-pdm.js';
import {
  activateStudioDrawingSheet,
  createStudioDrawingSheet,
  deleteStudioDrawingSheet,
  initializeStudioDrawingBook,
  inspectStudioDrawingBook,
  reorderStudioDrawingSheets,
  updateStudioDrawingSheet,
} from './studio-drawing-book.js';
import {
  createStudioDerivedDrawingView,
  createStudioNamedDrawingView,
  deleteStudioDerivedDrawingView,
  deleteStudioNamedDrawingView,
  inspectStudioDrawingViews,
  updateStudioDerivedDrawingView,
  updateStudioNamedDrawingView,
} from './studio-drawing-views.js';
import {
  applyStudioDrawingStandardProfile,
  createStudioDrawingLineFont,
  deleteStudioDrawingLineFont,
  inspectStudioDrawingStandards,
  updateStudioDrawingLayer,
  updateStudioDrawingLineFont,
} from './studio-drawing-standards.js';
import {
  createStudioDrawingAnnotation,
  createStudioDrawingBlock,
  deleteStudioDrawingAnnotation,
  deleteStudioDrawingBlock,
  inspectStudioDrawingAnnotations,
  updateStudioDrawingAnnotation,
  updateStudioDrawingBlock,
} from './studio-drawing-annotations.js';
import {
  createStudioDrawingTable,
  deleteStudioDrawingTable,
  inspectStudioDrawingTables,
  updateStudioDrawingTable,
} from './studio-drawing-tables.js';
import {
  constraintSketchToLoops,
  measureSketchDimension,
  sampleSplineThrough,
  solveSketch,
  validateConstraintSketch,
} from './studio-sketch-solver.js';
import {
  STUDIO_DXF_IMPORT_MAX_BYTES,
  importStudioSketchDxf,
} from './studio-drawing-dxf.js';

export const CAD_AGENT_PROTOCOL = 'partmode.cad.agent/v1';
export const CAD_AGENT_STUDIO_VERSION = '7.1.0';
export const CAD_AGENT_KERNEL_VERSION = 'replicad-open-cascade/runtime-5A';

const MAX_TRANSACTION_OPERATIONS = 250;
const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_REQUEST_CACHE_ENTRIES = 1000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const ALL_PERMISSIONS = Object.freeze([
  'project.read',
  'project.create',
  'project.edit',
  'project.replace',
  'project.save-new',
  'project.save-in-place',
  'project.recover',
  'artifact.render',
  'artifact.export-project',
  'artifact.export-step',
  'artifact.export-stl',
  'artifact.export-amf',
  'artifact.export-3mf',
  'artifact.export-drawing',
  'artifact.export-narration',
  'ui.read',
  'ui.select',
  'ui.navigate',
  'ui.command-draft',
  'ui.present-preview',
  'ui.present-demo',
  'ui.present-narration',
  'ui.wait-events',
  'session.launch-visible',
]);

const READ_PERMISSIONS = new Set(['project.read']);
const EDIT_PERMISSIONS = new Set(['project.edit']);
const clone = (value) => structuredClone(value);

const JSON_SCHEMAS = Object.freeze({
  transaction: {
    type: 'object',
    required: ['transactionId', 'label', 'expectedRevision', 'operations', 'atomic'],
    properties: {
      transactionId: { type: 'string', minLength: 1, maxLength: 200 },
      label: { type: 'string', minLength: 1, maxLength: 200 },
      expectedRevision: { type: 'integer', minimum: 0 },
      operations: { type: 'array', minItems: 1, maxItems: MAX_TRANSACTION_OPERATIONS },
      atomic: { const: true },
    },
  },
  result: {
    type: 'object',
    required: ['changeSet'],
    properties: { changeSet: { type: 'object' } },
  },
});

const ID_SCHEMA = Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' });
const STRUCTURAL_MEMBER_ID_SCHEMA = Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' });
const WELDMENT_TREATMENT_ID_SCHEMA = Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' });
const WELDMENT_TREATMENT_DIMENSION_SCHEMA = Object.freeze({ type: 'number', exclusiveMinimum: 1e-7, maximum: 10000 });
const WELD_BEAD_ID_SCHEMA = Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,114}$' });
const SHEET_METAL_ID_SCHEMA = Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' });
const SHEET_METAL_THICKNESS_SCHEMA = Object.freeze({ type: 'number', minimum: 0.05, maximum: 100 });
const SHEET_METAL_RADIUS_SCHEMA = Object.freeze({ type: 'number', minimum: 0.05, maximum: 1000 });
const SHEET_METAL_K_FACTOR_SCHEMA = Object.freeze({ type: 'number', minimum: 0.01, maximum: 1 });
const SHEET_METAL_FLANGE_LENGTH_SCHEMA = Object.freeze({ type: 'number', minimum: 0.05, maximum: 10000 });
const WELD_BEAD_SIZE_SCHEMA = Object.freeze({ type: 'number', exclusiveMinimum: 1e-7, maximum: 10000 });
const REUSABLE_SKETCH_ID_SCHEMA = Object.freeze({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$' });
const SKETCH_MEMBER_ID_SCHEMA = Object.freeze({
  anyOf: [
    REUSABLE_SKETCH_ID_SCHEMA,
    { type: 'string', pattern: '^(?:bi|ds):[A-Za-z0-9._:-]{1,196}$' },
  ],
});
const DRAWING_STANDARD_VIEW_SCHEMA = Object.freeze({ enum: ['front', 'top', 'right', 'left', 'bottom', 'back', 'iso'] });
const DRAWING_NAMED_VIEW_ID_SCHEMA = Object.freeze({ type: 'string', pattern: '^drawing-view-[0-9]{6}$' });
const DRAWING_DERIVED_VIEW_ID_SCHEMA = Object.freeze({ type: 'string', pattern: '^drawing-derived-view-[0-9]{6}$' });
const DRAWING_ORDINARY_VIEW_KEY_SCHEMA = Object.freeze({ oneOf: [DRAWING_STANDARD_VIEW_SCHEMA, DRAWING_NAMED_VIEW_ID_SCHEMA] });
const DRAWING_VIEW_KEY_SCHEMA = Object.freeze({ oneOf: [DRAWING_STANDARD_VIEW_SCHEMA, DRAWING_NAMED_VIEW_ID_SCHEMA, DRAWING_DERIVED_VIEW_ID_SCHEMA] });
const DRAWING_VECTOR_SCHEMA = Object.freeze({ type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } });
const DRAWING_ALIGNMENT_SCHEMA = Object.freeze({ type: 'object', required: ['parentView', 'childView', 'axis'], properties: { parentView: DRAWING_VIEW_KEY_SCHEMA, childView: DRAWING_VIEW_KEY_SCHEMA, axis: { enum: ['horizontal', 'vertical'] }, gapMm: { type: 'number', minimum: 2, maximum: 100 } }, additionalProperties: false });
const DIMENSION_SCHEMA = Object.freeze({ oneOf: [{ type: 'number' }, { type: 'string', minLength: 1, maxLength: 500 }] });
const ENTITY_OR_ALIAS_SCHEMA = Object.freeze({ oneOf: [ID_SCHEMA, { type: 'object', required: ['alias'], properties: { alias: { type: 'string', minLength: 1, maxLength: 200 } }, additionalProperties: false }] });
const REUSABLE_ENTITY_OR_ALIAS_SCHEMA = Object.freeze({ oneOf: [REUSABLE_SKETCH_ID_SCHEMA, { type: 'object', required: ['alias'], properties: { alias: { type: 'string', minLength: 1, maxLength: 200 } }, additionalProperties: false }] });
const RESULT_POLICY_SCHEMA = Object.freeze({
  oneOf: [
    { type: 'object', required: ['kind'], properties: { kind: { const: 'new-body' }, bodyName: { type: 'string', minLength: 1, maxLength: 200 } }, additionalProperties: false },
    ...['add', 'subtract', 'intersect'].map((kind) => ({
      type: 'object', required: ['kind', 'targetBodyIds'],
      properties: { kind: { const: kind }, targetBodyIds: { type: 'array', minItems: 1, items: ENTITY_OR_ALIAS_SCHEMA }, keepTools: { type: 'boolean' } },
      additionalProperties: false,
    })),
  ],
});
const SHAPE_SCHEMA = Object.freeze({
  oneOf: [
    { type: 'object', required: ['kind', 'x', 'y', 'w', 'h'], properties: { kind: { const: 'rect' }, x: DIMENSION_SCHEMA, y: DIMENSION_SCHEMA, w: DIMENSION_SCHEMA, h: DIMENSION_SCHEMA }, additionalProperties: false },
    { type: 'object', required: ['kind', 'x', 'y', 'r'], properties: { kind: { const: 'circle' }, x: DIMENSION_SCHEMA, y: DIMENSION_SCHEMA, r: DIMENSION_SCHEMA }, additionalProperties: false },
    { type: 'object', required: ['kind', 'pts'], properties: { kind: { const: 'poly' }, pts: { type: 'array', minItems: 3, items: { type: 'array', minItems: 2, maxItems: 2, items: DIMENSION_SCHEMA } } }, additionalProperties: false },
  ],
});
const constrainedEntitySchema = (memberIdSchema) => Object.freeze({
  oneOf: [
    { type: 'object', required: ['id', 'kind', 'at'], properties: { id: memberIdSchema, kind: { const: 'point' }, at: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, fixed: { type: 'boolean' } }, additionalProperties: false },
    { type: 'object', required: ['id', 'kind', 'a', 'b'], properties: { id: memberIdSchema, kind: { const: 'line' }, a: memberIdSchema, b: memberIdSchema, construction: { type: 'boolean' } }, additionalProperties: false },
    { type: 'object', required: ['id', 'kind', 'center', 'r'], properties: { id: memberIdSchema, kind: { const: 'circle' }, center: memberIdSchema, r: DIMENSION_SCHEMA, construction: { type: 'boolean' } }, additionalProperties: false },
    { type: 'object', required: ['id', 'kind', 'center', 'a', 'b'], properties: { id: memberIdSchema, kind: { const: 'arc' }, center: memberIdSchema, a: memberIdSchema, b: memberIdSchema, ccw: { type: 'boolean' }, construction: { type: 'boolean' } }, additionalProperties: false },
    { type: 'object', required: ['id', 'kind', 'through'], properties: { id: memberIdSchema, kind: { const: 'spline' }, through: { type: 'array', minItems: 2, items: memberIdSchema }, construction: { type: 'boolean' } }, additionalProperties: false },
  ],
});
const INLINE_CONSTRAINED_CONSTRAINT_KINDS = Object.freeze([
  'coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'equal',
  'concentric', 'midpoint', 'pointOnLine', 'pointOnCircle', 'pierce', 'symmetric', 'distance',
  'horizontalDistance', 'verticalDistance', 'length', 'radius', 'angle',
]);
const constrainedConstraintSchema = (memberIdSchema, kinds) => Object.freeze({
  type: 'object', required: ['kind'],
  properties: {
    id: ID_SCHEMA,
    kind: { enum: kinds },
    a: memberIdSchema, b: memberIdSchema, line: memberIdSchema, circle: memberIdSchema, point: memberIdSchema, axis: memberIdSchema,
    curveSketchId: ID_SCHEMA, planeDatumId: ID_SCHEMA,
    value: DIMENSION_SCHEMA,
    driving: { type: 'boolean' },
  },
  additionalProperties: false,
});
const INLINE_CONSTRAINED_ENTITY_SCHEMA = constrainedEntitySchema(ID_SCHEMA);
const FIRST_CLASS_CONSTRAINED_ENTITY_SCHEMA = constrainedEntitySchema(SKETCH_MEMBER_ID_SCHEMA);
const INLINE_CONSTRAINED_CONSTRAINT_SCHEMA = constrainedConstraintSchema(ID_SCHEMA, INLINE_CONSTRAINED_CONSTRAINT_KINDS);
const FIRST_CLASS_CONSTRAINED_CONSTRAINT_SCHEMA = constrainedConstraintSchema(
  SKETCH_MEMBER_ID_SCHEMA,
  INLINE_CONSTRAINED_CONSTRAINT_KINDS.filter((kind) => kind !== 'pierce'),
);
const SKETCH_INSTANCE_TRANSFORM_SCHEMA = Object.freeze({
  type: 'object', required: ['translation', 'angleDeg', 'scale'],
  properties: {
    translation: { type: 'array', minItems: 2, maxItems: 2, items: DIMENSION_SCHEMA },
    angleDeg: DIMENSION_SCHEMA,
    scale: DIMENSION_SCHEMA,
  },
  additionalProperties: false,
});
const DERIVED_SKETCH_TRANSFORM_SCHEMA = Object.freeze({
  type: 'object', required: ['translation', 'angleDeg'],
  properties: {
    translation: { type: 'array', minItems: 2, maxItems: 2, items: DIMENSION_SCHEMA },
    angleDeg: DIMENSION_SCHEMA,
  },
  additionalProperties: false,
});
const SKETCH_BLOCK_INSTANCE_SCHEMA = Object.freeze({
  type: 'object', required: ['id', 'definitionId', 'transform'],
  properties: {
    id: REUSABLE_SKETCH_ID_SCHEMA,
    definitionId: ID_SCHEMA,
    transform: SKETCH_INSTANCE_TRANSFORM_SCHEMA,
    fixed: { type: 'boolean' },
  },
  additionalProperties: false,
});
const SKETCH_RELATION_REFERENCE_SCHEMA = Object.freeze({
  oneOf: [
    SKETCH_MEMBER_ID_SCHEMA,
    {
      type: 'object', required: ['entityId'],
      properties: { entityId: SKETCH_MEMBER_ID_SCHEMA }, additionalProperties: false,
    },
    {
      type: 'object', required: ['instanceId', 'memberId'],
      properties: { instanceId: REUSABLE_SKETCH_ID_SCHEMA, memberId: REUSABLE_SKETCH_ID_SCHEMA }, additionalProperties: false,
    },
    {
      type: 'object', required: ['derivedMemberId'],
      properties: { derivedMemberId: SKETCH_MEMBER_ID_SCHEMA }, additionalProperties: false,
    },
  ],
});
const sketchRelationVariants = (kind, operands, dimensional = false) => {
  const baseProperties = Object.fromEntries([
    ['id', ID_SCHEMA],
    ['kind', { const: kind }],
    ...operands.map((field) => [field, SKETCH_RELATION_REFERENCE_SCHEMA]),
  ]);
  if (!dimensional) {
    return [{
      type: 'object', required: ['id', 'kind', ...operands],
      properties: { ...baseProperties, driving: { const: true } },
      additionalProperties: false,
    }];
  }
  return [
    {
      type: 'object', required: ['id', 'kind', ...operands, 'value'],
      properties: { ...baseProperties, value: DIMENSION_SCHEMA, driving: { const: true } },
      additionalProperties: false,
    },
    {
      type: 'object', required: ['id', 'kind', ...operands, 'driving'],
      properties: { ...baseProperties, driving: { const: false } },
      additionalProperties: false,
    },
  ];
};
const SKETCH_RELATION_SCHEMA = Object.freeze({
  oneOf: [
    ...sketchRelationVariants('coincident', ['a', 'b']),
    ...sketchRelationVariants('horizontal', ['line']),
    ...sketchRelationVariants('horizontal', ['a', 'b']),
    ...sketchRelationVariants('vertical', ['line']),
    ...sketchRelationVariants('vertical', ['a', 'b']),
    ...sketchRelationVariants('parallel', ['a', 'b']),
    ...sketchRelationVariants('perpendicular', ['a', 'b']),
    ...sketchRelationVariants('tangent', ['a', 'b']),
    ...sketchRelationVariants('equal', ['a', 'b']),
    ...sketchRelationVariants('concentric', ['a', 'b']),
    ...sketchRelationVariants('midpoint', ['point', 'line']),
    ...sketchRelationVariants('pointOnLine', ['point', 'line']),
    ...sketchRelationVariants('pointOnCircle', ['point', 'circle']),
    ...sketchRelationVariants('symmetric', ['a', 'b', 'axis']),
    ...sketchRelationVariants('distance', ['a', 'b'], true),
    ...sketchRelationVariants('horizontalDistance', ['a', 'b'], true),
    ...sketchRelationVariants('verticalDistance', ['a', 'b'], true),
    ...sketchRelationVariants('length', ['line'], true),
    ...sketchRelationVariants('radius', ['circle'], true),
    ...sketchRelationVariants('angle', ['a', 'b'], true),
  ],
});
const firstClassConstrainedSketchSchema = Object.freeze({
  type: 'object', required: ['entities'],
  properties: {
    entities: { type: 'array', items: FIRST_CLASS_CONSTRAINED_ENTITY_SCHEMA },
    constraints: { type: 'array', items: FIRST_CLASS_CONSTRAINED_CONSTRAINT_SCHEMA },
    blockInstances: { type: 'array', items: SKETCH_BLOCK_INSTANCE_SCHEMA },
    relations: { type: 'array', items: SKETCH_RELATION_SCHEMA },
    derivedFrom: {
      type: 'object', required: ['sourceSketchId', 'transform'],
      properties: { sourceSketchId: REUSABLE_SKETCH_ID_SCHEMA, transform: DERIVED_SKETCH_TRANSFORM_SCHEMA },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
});
const INLINE_CONSTRAINED_SKETCH_SCHEMA = Object.freeze({
  type: 'object', required: ['entities'],
  properties: {
    entities: { type: 'array', items: INLINE_CONSTRAINED_ENTITY_SCHEMA },
    constraints: { type: 'array', items: INLINE_CONSTRAINED_CONSTRAINT_SCHEMA },
  },
  additionalProperties: false,
});
const FIRST_CLASS_CONSTRAINED_SKETCH_SCHEMA = firstClassConstrainedSketchSchema;
const ORDINARY_FIRST_CLASS_CONSTRAINED_SKETCH_SCHEMA = Object.freeze({
  ...FIRST_CLASS_CONSTRAINED_SKETCH_SCHEMA,
  properties: Object.fromEntries(Object.entries(FIRST_CLASS_CONSTRAINED_SKETCH_SCHEMA.properties)
    .filter(([field]) => field !== 'derivedFrom')),
});
const CONSTRAINED_SKETCH_PATCH_SCHEMA = Object.freeze({
  type: 'object', minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    plane: { enum: ['XY', 'YZ', 'ZX'] },
    z: DIMENSION_SCHEMA,
    constrained: ORDINARY_FIRST_CLASS_CONSTRAINED_SKETCH_SCHEMA,
  },
  additionalProperties: false,
});
const SKETCH_BLOCK_DEFINITION_PATCH_SCHEMA = Object.freeze({
  type: 'object', minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    insertionPoint: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
    constrained: ORDINARY_FIRST_CLASS_CONSTRAINED_SKETCH_SCHEMA,
  },
  additionalProperties: false,
});
const SKETCH_BLOCK_INSTANCE_PATCH_SCHEMA = Object.freeze({
  type: 'object', minProperties: 1,
  properties: {
    transform: SKETCH_INSTANCE_TRANSFORM_SCHEMA,
    fixed: { type: 'boolean' },
  },
  additionalProperties: false,
});
const DERIVED_SKETCH_PATCH_SCHEMA = Object.freeze({
  type: 'object', minProperties: 1,
  properties: {
    transform: DERIVED_SKETCH_TRANSFORM_SCHEMA,
    relations: { type: 'array', items: SKETCH_RELATION_SCHEMA },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    plane: { enum: ['XY', 'YZ', 'ZX'] },
    z: DIMENSION_SCHEMA,
  },
  additionalProperties: false,
});
const SKETCH_SCHEMA = Object.freeze({
  type: 'object',
  anyOf: [{ required: ['shapes'] }, { required: ['constrained'] }],
  properties: {
    shapes: { type: 'array', minItems: 1, items: SHAPE_SCHEMA },
    constrained: INLINE_CONSTRAINED_SKETCH_SCHEMA,
    z: DIMENSION_SCHEMA,
  },
  additionalProperties: true,
});
const FEATURE_PATTERN_SCHEMA = Object.freeze({
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'n', 'dx', 'dy'],
      properties: {
        kind: { const: 'linear' },
        n: DIMENSION_SCHEMA,
        dx: DIMENSION_SCHEMA,
        dy: DIMENSION_SCHEMA,
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['kind', 'n', 'cx', 'cy'],
      properties: {
        kind: { const: 'circular' },
        n: DIMENSION_SCHEMA,
        cx: DIMENSION_SCHEMA,
        cy: DIMENSION_SCHEMA,
      },
      additionalProperties: false,
    },
  ],
});
const FEATURE_COMMON_PROPERTIES = Object.freeze({
  id: ID_SCHEMA,
  name: { type: 'string', minLength: 1, maxLength: 200 },
  resultPolicy: RESULT_POLICY_SCHEMA,
  inputRefs: { type: 'array', items: { type: 'object' } },
  onFace: { type: 'object' },
  bodyName: { type: 'string', minLength: 1, maxLength: 200 },
  pattern: FEATURE_PATTERN_SCHEMA,
  extensions: { type: 'object' },
});
const objectSchema = (required, properties) => ({ type: 'object', required, properties, additionalProperties: false });
const DRAWING_BOUNDED_NUMBER_SCHEMA = Object.freeze({ type: 'number', minimum: -1_000_000, maximum: 1_000_000 });
const DRAWING_CUTTING_PLANE_SCHEMA = Object.freeze(objectSchema(['origin', 'normal'], {
  origin: { type: 'array', minItems: 3, maxItems: 3, items: DRAWING_BOUNDED_NUMBER_SCHEMA },
  normal: { type: 'array', minItems: 3, maxItems: 3, items: DRAWING_BOUNDED_NUMBER_SCHEMA },
  xAxis: { type: 'array', minItems: 3, maxItems: 3, items: DRAWING_BOUNDED_NUMBER_SCHEMA },
  keepSide: { enum: ['positive', 'negative'] },
}));
const DRAWING_BOUNDARY_SCHEMA = Object.freeze({
  oneOf: [
    objectSchema(['kind', 'x', 'y', 'width', 'height'], {
      kind: { const: 'rect' }, x: DRAWING_BOUNDED_NUMBER_SCHEMA, y: DRAWING_BOUNDED_NUMBER_SCHEMA,
      width: { type: 'number', minimum: 0.001, maximum: 1_000_000 },
      height: { type: 'number', minimum: 0.001, maximum: 1_000_000 },
    }),
    objectSchema(['kind', 'x', 'y', 'radius'], {
      kind: { const: 'circle' }, x: DRAWING_BOUNDED_NUMBER_SCHEMA, y: DRAWING_BOUNDED_NUMBER_SCHEMA,
      radius: { type: 'number', minimum: 0.001, maximum: 1_000_000 },
    }),
  ],
});
const DRAWING_HATCH_ANGLE_SCHEMA = Object.freeze({ type: 'number', minimum: -89, maximum: 89 });
const drawingPlanesSchema = (minimum, maximum = minimum) => ({
  type: 'array', minItems: minimum, maxItems: maximum, items: DRAWING_CUTTING_PLANE_SCHEMA,
});
const DRAWING_DERIVED_DEFINITION_SCHEMAS = Object.freeze({
  'full-section': objectSchema(['planes'], { planes: drawingPlanesSchema(1), hatchAngleDeg: DRAWING_HATCH_ANGLE_SCHEMA }),
  'half-section': objectSchema(['planes', 'half'], {
    planes: drawingPlanesSchema(2),
    half: objectSchema(['axis', 'side', 'at'], {
      axis: { enum: ['x', 'y'] }, side: { enum: ['positive', 'negative'] }, at: DRAWING_BOUNDED_NUMBER_SCHEMA,
    }),
    hatchAngleDeg: DRAWING_HATCH_ANGLE_SCHEMA,
  }),
  'aligned-section': objectSchema(['planes'], { planes: drawingPlanesSchema(2, 6), hatchAngleDeg: DRAWING_HATCH_ANGLE_SCHEMA }),
  'broken-out-section': objectSchema(['boundary', 'depthMm'], {
    boundary: DRAWING_BOUNDARY_SCHEMA,
    depthMm: { type: 'number', minimum: 0.001, maximum: 1_000_000 },
    hatchAngleDeg: DRAWING_HATCH_ANGLE_SCHEMA,
  }),
  detail: objectSchema(['boundary'], {
    boundary: DRAWING_BOUNDARY_SCHEMA, magnification: { type: 'number', minimum: 1.1, maximum: 10 },
  }),
  auxiliary: objectSchema(['reference', 'xAxis'], {
    reference: objectSchema(['bodyId', 'faceName'], {
      bodyId: ID_SCHEMA, faceName: { type: 'string', minLength: 1, maxLength: 120 },
    }),
    xAxis: DRAWING_VECTOR_SCHEMA,
  }),
  crop: objectSchema(['boundary'], { boundary: DRAWING_BOUNDARY_SCHEMA }),
  break: objectSchema(['axis', 'start', 'end', 'gapMm'], {
    axis: { enum: ['x', 'y'] }, start: DRAWING_BOUNDED_NUMBER_SCHEMA, end: DRAWING_BOUNDED_NUMBER_SCHEMA,
    gapMm: { type: 'number', minimum: 1, maximum: 25 },
  }),
});
const drawingDerivedInputVariant = (kind, { patch = false } = {}) => objectSchema(
  patch ? ['kind', 'definition'] : ['name', 'kind', 'sourceViewId', 'definition'],
  {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    kind: { const: kind },
    sourceViewId: DRAWING_ORDINARY_VIEW_KEY_SCHEMA,
    definition: DRAWING_DERIVED_DEFINITION_SCHEMAS[kind],
  },
);
const DRAWING_DERIVED_CREATE_SCHEMA = Object.freeze({
  oneOf: Object.keys(DRAWING_DERIVED_DEFINITION_SCHEMAS).map((kind) => drawingDerivedInputVariant(kind)),
});
const DRAWING_DERIVED_UPDATE_PATCH_SCHEMA = Object.freeze({
  oneOf: [
    objectSchema([], {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      sourceViewId: DRAWING_ORDINARY_VIEW_KEY_SCHEMA,
    }),
    ...Object.keys(DRAWING_DERIVED_DEFINITION_SCHEMAS).map((kind) => drawingDerivedInputVariant(kind, { patch: true })),
  ],
});
const LOFT_SECTION_SCHEMA = Object.freeze({
  oneOf: [
    ENTITY_OR_ALIAS_SCHEMA,
    {
      type: 'object',
      required: ['sketchId'],
      properties: {
        sketchId: ENTITY_OR_ALIAS_SCHEMA,
        startIndex: { type: 'integer', minimum: 0 },
        reversed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  ],
});
const LOFT_CONTINUITY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    start: { enum: ['free', 'tangent', 'curvature'] },
    end: { enum: ['free', 'tangent', 'curvature'] },
  },
  additionalProperties: false,
});
const VARIABLE_FILLET_RADIUS_SCHEMA = Object.freeze({
  type: 'object',
  required: ['startRadius', 'endRadius'],
  properties: { startRadius: DIMENSION_SCHEMA, endRadius: DIMENSION_SCHEMA },
  additionalProperties: false,
});
const VARIABLE_PATTERN_INSTANCE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['position', 'parameterOverrides'],
  properties: {
    position: DIMENSION_SCHEMA,
    parameterOverrides: {
      type: 'object',
      minProperties: 1,
      maxProperties: 16,
      additionalProperties: { type: 'number' },
    },
  },
  additionalProperties: false,
});
const BODY_PATTERN_DEFINITION_PROPERTIES = Object.freeze({
  count: DIMENSION_SCHEMA,
  distribution: { enum: ['spacing', 'extent', 'table', 'full', 'equal', 'mirror', 'points', 'fill'] },
  orientation: { enum: ['preserve', 'alternating', 'rotate', 'tangent', 'fixed', 'mirror'] },
  symmetric: { type: 'boolean' },
  spacing: DIMENSION_SCHEMA,
  extent: DIMENSION_SCHEMA,
  positions: { type: 'array', items: DIMENSION_SCHEMA },
  alternating: { type: 'boolean' },
  count2: DIMENSION_SCHEMA,
  distribution2: { enum: ['spacing', 'extent', 'table'] },
  symmetric2: { type: 'boolean' },
  spacing2: DIMENSION_SCHEMA,
  extent2: DIMENSION_SCHEMA,
  positions2: { type: 'array', items: DIMENSION_SCHEMA },
  alternating2: { type: 'boolean' },
  totalAngle: DIMENSION_SCHEMA,
  spacingAngle: DIMENSION_SCHEMA,
  angles: { type: 'array', items: DIMENSION_SCHEMA },
  radialOffset: DIMENSION_SCHEMA,
  axialOffset: DIMENSION_SCHEMA,
  parameters: { type: 'array', items: DIMENSION_SCHEMA },
  pointIds: { type: 'array', minItems: 2, maxItems: 5_000, uniqueItems: true, items: ID_SCHEMA },
  layout: { enum: ['square', 'triangular'] },
  rotation: DIMENSION_SCHEMA,
  boundaryMargin: DIMENSION_SCHEMA,
  seed: { type: 'array', minItems: 2, maxItems: 2, items: DIMENSION_SCHEMA },
  maximumCount: { type: 'integer', minimum: 2, maximum: 5_000 },
  instances: { type: 'array', minItems: 1, maxItems: 100, items: VARIABLE_PATTERN_INSTANCE_SCHEMA },
});
const CLASSIC_PROFILE_LINK_PROPERTIES = Object.freeze({
  sketch: SKETCH_SCHEMA,
  sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA,
  plane: { enum: ['XY', 'YZ', 'ZX'] },
});
const classicProfileOperationSchema = (properties) => ({
  type: 'object',
  oneOf: [
    { required: ['sketch'], not: { required: ['sketchId'] } },
    {
      required: ['sketchId'],
      not: { anyOf: [{ required: ['sketch'] }, { required: ['onFace'] }] },
    },
  ],
  properties: { ...FEATURE_COMMON_PROPERTIES, ...CLASSIC_PROFILE_LINK_PROPERTIES, ...properties },
  additionalProperties: false,
});
const STRUCTURAL_MEMBER_PLACEMENT_SCHEMA = {
  type: 'object',
  properties: {
    anchor: { enum: ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'] },
    rotationDegrees: { type: 'number' },
    offset: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
  },
  additionalProperties: false,
};
const WELD_BEAD_TOPOLOGY_REFERENCE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['name', 'sig'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 500 },
    sig: { type: 'object', minProperties: 1 },
  },
  additionalProperties: false,
});
const DIRECT_EDIT_TOPOLOGY_REFERENCE_SCHEMA = Object.freeze({
  type: 'object',
  required: ['name', 'sig'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 4096 },
    sig: { type: 'object', minProperties: 1 },
  },
  additionalProperties: false,
});
const DIRECT_EDIT_DISTANCE_SCHEMA = Object.freeze({
  oneOf: [
    { type: 'number', minimum: -STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM, exclusiveMaximum: -1e-9 },
    { type: 'number', exclusiveMinimum: 1e-9, maximum: STUDIO_DIRECT_EDIT_MAX_DISTANCE_MM },
    { type: 'string', minLength: 1, maxLength: 500 },
  ],
});
const DIRECT_EDIT_PATCH_SCHEMA = Object.freeze({
  type: 'object',
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    targetFace: DIRECT_EDIT_TOPOLOGY_REFERENCE_SCHEMA,
    distance: DIRECT_EDIT_DISTANCE_SCHEMA,
    replacementBodyId: ENTITY_OR_ALIAS_SCHEMA,
    replacementFace: DIRECT_EDIT_TOPOLOGY_REFERENCE_SCHEMA,
    patchFace: DIRECT_EDIT_TOPOLOGY_REFERENCE_SCHEMA,
    suppressed: { type: 'boolean' },
  },
  additionalProperties: false,
});
const WELD_BEAD_SUPPORT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['role', 'memberId', 'face', 'edge'],
  properties: {
    role: { enum: ['support-a', 'support-b'] },
    memberId: ENTITY_OR_ALIAS_SCHEMA,
    face: WELD_BEAD_TOPOLOGY_REFERENCE_SCHEMA,
    edge: WELD_BEAD_TOPOLOGY_REFERENCE_SCHEMA,
  },
  additionalProperties: false,
});
const SMART_FASTENER_PLAN_SCHEMA = Object.freeze({
  type: 'object',
  required: ['schema', 'policyId', 'documentHash', 'target', 'selections', 'occurrences', 'mates', 'fingerprint'],
  properties: {
    schema: { const: 'partmode.smart-fastener-plan/v1' },
    policyId: { const: 'aligned-clearance-hole-full-stack/v1' },
    documentHash: { type: 'string', minLength: 64, maxLength: 64 },
    target: { type: 'object' },
    selections: { type: 'object' },
    occurrences: { type: 'object' },
    mates: { type: 'array', minItems: 6, maxItems: 6 },
    fingerprint: { type: 'string', minLength: 64, maxLength: 64 },
  },
  additionalProperties: false,
});
const ASSEMBLY_FEATURE_TARGET_SCHEMA = Object.freeze({
  type: 'object',
  required: ['occurrenceId', 'partId', 'bodyId'],
  properties: {
    occurrenceId: ENTITY_OR_ALIAS_SCHEMA,
    partId: ENTITY_OR_ALIAS_SCHEMA,
    bodyId: ENTITY_OR_ALIAS_SCHEMA,
  },
  additionalProperties: false,
});
const ASSEMBLY_FEATURE_TARGETS_SCHEMA = Object.freeze({
  type: 'array',
  minItems: 1,
  maxItems: 64,
  items: ASSEMBLY_FEATURE_TARGET_SCHEMA,
});
const ASSEMBLY_FEATURE_VECTOR_SCHEMA = Object.freeze({
  type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' },
});
const ASSEMBLY_FEATURE_DIMENSION_SCHEMA = Object.freeze({
  type: 'number', minimum: 0.001, maximum: 100_000,
});
const ASSEMBLY_FEATURE_PATCH_SCHEMA = Object.freeze({
  type: 'object',
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    targets: ASSEMBLY_FEATURE_TARGETS_SCHEMA,
    origin: ASSEMBLY_FEATURE_VECTOR_SCHEMA,
    direction: ASSEMBLY_FEATURE_VECTOR_SCHEMA,
    xDirection: ASSEMBLY_FEATURE_VECTOR_SCHEMA,
    width: ASSEMBLY_FEATURE_DIMENSION_SCHEMA,
    height: ASSEMBLY_FEATURE_DIMENSION_SCHEMA,
    diameter: ASSEMBLY_FEATURE_DIMENSION_SCHEMA,
    suppressed: { type: 'boolean' },
  },
  additionalProperties: false,
});
const OPERATION_INPUT_SCHEMAS = Object.freeze({
  'project.rename': objectSchema(['name'], { name: { type: 'string', minLength: 1, maxLength: 200 } }),
  'project.setUnits': objectSchema(['units'], { units: { enum: ['mm', 'in'] } }),
  'project.clear': objectSchema([], {}),
  'parameter.create': objectSchema(['name', 'value'], { id: ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 }, value: DIMENSION_SCHEMA, description: { type: 'string', maxLength: 2000 } }),
  'parameter.update': objectSchema([], { parameterId: ENTITY_OR_ALIAS_SCHEMA, parameterName: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 200 }, value: DIMENSION_SCHEMA, description: { type: 'string', maxLength: 2000 } }),
  'parameter.delete': objectSchema([], { parameterId: ENTITY_OR_ALIAS_SCHEMA, parameterName: { type: 'string' } }),
  'configuration.activate': objectSchema(['configurationId'], { partId: ENTITY_OR_ALIAS_SCHEMA, configurationId: ID_SCHEMA }),
  'feature.extrude': classicProfileOperationSchema({ height: DIMENSION_SCHEMA, h: DIMENSION_SCHEMA }),
  'feature.cut': classicProfileOperationSchema({ height: DIMENSION_SCHEMA, h: DIMENSION_SCHEMA, through: { type: 'boolean' } }),
  'feature.revolve': objectSchema(['sketch'], { ...FEATURE_COMMON_PROPERTIES, sketch: SKETCH_SCHEMA }),
  'feature.fillet': objectSchema(['radius'], { ...FEATURE_COMMON_PROPERTIES, radius: DIMENSION_SCHEMA, r: DIMENSION_SCHEMA, edges: { type: 'array', items: { type: 'object' } }, tangentPropagation: { type: 'boolean' } }),
  'feature.chamfer': objectSchema(['radius'], { ...FEATURE_COMMON_PROPERTIES, radius: DIMENSION_SCHEMA, r: DIMENSION_SCHEMA, edges: { type: 'array', items: { type: 'object' } } }),
  'feature.shell': objectSchema(['thickness'], { ...FEATURE_COMMON_PROPERTIES, thickness: DIMENSION_SCHEMA, t: DIMENSION_SCHEMA, faces: { type: 'array', items: { type: 'object' } } }),
  'feature.thread': objectSchema(['extensions'], { ...FEATURE_COMMON_PROPERTIES }),
  'feature.update': objectSchema(['featureId', 'patch'], { featureId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'feature.suppress': objectSchema(['featureId', 'suppressed'], { featureId: ENTITY_OR_ALIAS_SCHEMA, suppressed: { type: 'boolean' } }),
  'feature.delete': objectSchema(['featureId'], { featureId: ENTITY_OR_ALIAS_SCHEMA }),
  'body.activate': objectSchema(['bodyId'], { bodyId: ENTITY_OR_ALIAS_SCHEMA }),
  'body.rename': objectSchema(['bodyId', 'name'], { bodyId: ENTITY_OR_ALIAS_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 } }),
  'body.setVisibility': objectSchema(['bodyId', 'visible'], { bodyId: ENTITY_OR_ALIAS_SCHEMA, visible: { type: 'boolean' } }),
  'body.suppress': objectSchema(['bodyId', 'suppressed'], { bodyId: ENTITY_OR_ALIAS_SCHEMA, suppressed: { type: 'boolean' } }),
  'body.delete': objectSchema(['bodyId'], { bodyId: ENTITY_OR_ALIAS_SCHEMA }),
  'boolean.union': objectSchema(['targetBodyId', 'toolBodyId'], { id: ID_SCHEMA, name: { type: 'string' }, targetBodyId: ENTITY_OR_ALIAS_SCHEMA, toolBodyId: ENTITY_OR_ALIAS_SCHEMA, keepTools: { type: 'boolean' } }),
  'boolean.subtract': objectSchema(['targetBodyId', 'toolBodyId'], { id: ID_SCHEMA, name: { type: 'string' }, targetBodyId: ENTITY_OR_ALIAS_SCHEMA, toolBodyId: ENTITY_OR_ALIAS_SCHEMA, keepTools: { type: 'boolean' } }),
  'boolean.intersect': objectSchema(['targetBodyId', 'toolBodyId'], { id: ID_SCHEMA, name: { type: 'string' }, targetBodyId: ENTITY_OR_ALIAS_SCHEMA, toolBodyId: ENTITY_OR_ALIAS_SCHEMA, keepTools: { type: 'boolean' } }),
  'boolean.split': objectSchema(['targetBodyId', 'toolBodyIds'], { id: ID_SCHEMA, name: { type: 'string' }, targetBodyId: ENTITY_OR_ALIAS_SCHEMA, toolBodyIds: { type: 'array', minItems: 1, items: ENTITY_OR_ALIAS_SCHEMA }, keepOriginal: { type: 'boolean' }, keepTools: { const: true }, bodyNames: { type: 'array', items: { type: 'string' } } }),
  'datum.create': objectSchema(['id', 'name', 'datumKind', 'definition'], { id: ID_SCHEMA, name: { type: 'string' }, datumKind: { enum: ['plane', 'axis', 'point', 'coordinate-system'] }, definition: { type: 'object' } }),
  'datum.update': objectSchema(['datumId', 'patch'], { datumId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'datum.delete': objectSchema(['datumId'], { datumId: ENTITY_OR_ALIAS_SCHEMA }),
  'sketch.profile.create': objectSchema(['id', 'name', 'planeDatumId', 'points'], { id: ID_SCHEMA, name: { type: 'string' }, planeDatumId: ENTITY_OR_ALIAS_SCHEMA, points: { type: 'array' }, curveKind: { enum: ['spline', 'polyline'] } }),
  'sketch.path.create': objectSchema(['id', 'name', 'points'], { id: ID_SCHEMA, name: { type: 'string' }, points: { type: 'array' }, curveKind: { enum: ['spline', 'polyline'] } }),
  'sketch.reference.create': objectSchema(['id', 'name', 'definition'], { id: ID_SCHEMA, name: { type: 'string' }, definition: { type: 'object' } }),
  'sketch.reference.update': objectSchema(['sketchId', 'patch'], { sketchId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'sketch.advanced.update': objectSchema(['sketchId', 'patch'], { sketchId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'sketch.advanced.delete': objectSchema(['sketchId'], { sketchId: ENTITY_OR_ALIAS_SCHEMA }),
  'sketch.constrained.create': objectSchema(['id', 'name', 'constrained'], { id: REUSABLE_SKETCH_ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 }, plane: { enum: ['XY', 'YZ', 'ZX'] }, z: DIMENSION_SCHEMA, constrained: ORDINARY_FIRST_CLASS_CONSTRAINED_SKETCH_SCHEMA }),
  'sketch.importDxf': objectSchema(['id', 'name', 'dxfText'], { id: REUSABLE_SKETCH_ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 }, plane: { enum: ['XY', 'YZ', 'ZX'] }, z: DIMENSION_SCHEMA, dxfText: { type: 'string', minLength: 1, maxLength: STUDIO_DXF_IMPORT_MAX_BYTES } }),
  'sketch.constrained.promote': objectSchema(['featureId', 'id', 'name'], { featureId: ENTITY_OR_ALIAS_SCHEMA, id: REUSABLE_SKETCH_ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 }, plane: { enum: ['XY', 'YZ', 'ZX'] } }),
  'sketch.constrained.update': objectSchema(['sketchId', 'patch'], { sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA, patch: CONSTRAINED_SKETCH_PATCH_SCHEMA }),
  'sketch.constrained.delete': objectSchema(['sketchId'], { sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA }),
  'sketch.blockDefinition.create': {
    type: 'object', required: ['id', 'name', 'insertionPoint'],
    oneOf: [{ required: ['sourceSketchId'] }, { required: ['constrained'] }],
    properties: {
      id: ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 },
      insertionPoint: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
      sourceSketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA,
      memberEntityIds: { type: 'array', minItems: 1, items: REUSABLE_SKETCH_ID_SCHEMA },
      constrained: ORDINARY_FIRST_CLASS_CONSTRAINED_SKETCH_SCHEMA,
    },
    additionalProperties: false,
  },
  'sketch.blockDefinition.update': objectSchema(['definitionId', 'patch'], { definitionId: ENTITY_OR_ALIAS_SCHEMA, patch: SKETCH_BLOCK_DEFINITION_PATCH_SCHEMA }),
  'sketch.blockDefinition.delete': objectSchema(['definitionId'], { definitionId: ENTITY_OR_ALIAS_SCHEMA }),
  'sketch.blockInstance.create': objectSchema(['sketchId', 'id', 'definitionId', 'transform'], {
    sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA, id: REUSABLE_SKETCH_ID_SCHEMA, definitionId: ENTITY_OR_ALIAS_SCHEMA,
    transform: SKETCH_INSTANCE_TRANSFORM_SCHEMA, fixed: { type: 'boolean' }, relations: { type: 'array', items: SKETCH_RELATION_SCHEMA },
  }),
  'sketch.blockInstance.update': objectSchema(['sketchId', 'instanceId', 'patch'], { sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA, instanceId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA, patch: SKETCH_BLOCK_INSTANCE_PATCH_SCHEMA }),
  'sketch.blockInstance.delete': objectSchema(['sketchId', 'instanceId'], { sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA, instanceId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA }),
  'sketch.blockInstance.explode': objectSchema(['sketchId', 'instanceId'], { sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA, instanceId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA }),
  'sketch.relation.create': objectSchema(['sketchId', 'relation'], { sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA, relation: SKETCH_RELATION_SCHEMA }),
  'sketch.relation.update': objectSchema(['sketchId', 'relationId', 'relation'], { sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA, relationId: ENTITY_OR_ALIAS_SCHEMA, relation: SKETCH_RELATION_SCHEMA }),
  'sketch.relation.delete': objectSchema(['sketchId', 'relationId'], { sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA, relationId: ENTITY_OR_ALIAS_SCHEMA }),
  'sketch.derived.create': objectSchema(['id', 'name', 'sourceSketchId', 'transform'], {
    id: REUSABLE_SKETCH_ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 }, sourceSketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA,
    plane: { enum: ['XY', 'YZ', 'ZX'] }, z: DIMENSION_SCHEMA, transform: DERIVED_SKETCH_TRANSFORM_SCHEMA,
    relations: { type: 'array', items: SKETCH_RELATION_SCHEMA },
  }),
  'sketch.derived.update': objectSchema(['sketchId', 'patch'], { sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA, patch: DERIVED_SKETCH_PATCH_SCHEMA }),
  'sketch.derived.underive': objectSchema(['sketchId'], { sketchId: REUSABLE_ENTITY_OR_ALIAS_SCHEMA }),
  'sketch.drag': {
    oneOf: [
      objectSchema(['featureId', 'handleKind', 'entityId', 'target'], {
        featureId: ENTITY_OR_ALIAS_SCHEMA,
        handleKind: { const: 'point' },
        entityId: ID_SCHEMA,
        target: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
      }),
      objectSchema(['featureId', 'handleKind', 'entityId', 'target'], {
        featureId: ENTITY_OR_ALIAS_SCHEMA,
        handleKind: { const: 'radius' },
        entityId: ID_SCHEMA,
        target: { type: 'number', exclusiveMinimum: 0 },
      }),
    ],
  },
  'body.transform': objectSchema(['id', 'bodyId', 'transform'], { id: ID_SCHEMA, name: { type: 'string' }, bodyId: ENTITY_OR_ALIAS_SCHEMA, transform: { type: 'object' }, copy: { type: 'boolean' }, moveOriginal: { type: 'boolean' }, bodyName: { type: 'string' }, createdBodyId: ID_SCHEMA }),
  'transform.update': objectSchema(['featureId', 'patch'], { featureId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'feature.reorder': objectSchema(['featureId'], { featureId: ENTITY_OR_ALIAS_SCHEMA, beforeFeatureId: ENTITY_OR_ALIAS_SCHEMA }),
  'feature.rollback': objectSchema([], { featureId: ENTITY_OR_ALIAS_SCHEMA }),
  'feature.loft': objectSchema(['id', 'sections'], { id: ID_SCHEMA, name: { type: 'string' }, sections: { type: 'array', minItems: 2, items: LOFT_SECTION_SCHEMA }, guideSketchIds: { type: 'array', items: ENTITY_OR_ALIAS_SCHEMA }, centerlineSketchId: ENTITY_OR_ALIAS_SCHEMA, mapping: { const: 'explicit' }, continuity: LOFT_CONTINUITY_SCHEMA, ruled: { type: 'boolean' }, closed: { const: false }, targetBodyId: ENTITY_OR_ALIAS_SCHEMA, operation: { enum: ['add', 'subtract', 'intersect'] }, bodyName: { type: 'string' } }),
  'feature.sweep': objectSchema(['id', 'profileSketchId', 'pathSketchId'], { id: ID_SCHEMA, name: { type: 'string' }, profileSketchId: ENTITY_OR_ALIAS_SCHEMA, pathSketchId: ENTITY_OR_ALIAS_SCHEMA, guideSketchId: ENTITY_OR_ALIAS_SCHEMA, orientation: { enum: ['path-normal', 'minimum-twist', 'fixed', 'reference', 'guide'] }, referenceDirection: { type: 'array', minItems: 3, maxItems: 3, items: DIMENSION_SCHEMA }, twistAngle: DIMENSION_SCHEMA, scaleEnd: DIMENSION_SCHEMA, transition: { enum: ['transformed', 'round', 'right'] }, targetBodyId: ENTITY_OR_ALIAS_SCHEMA, operation: { enum: ['add', 'subtract', 'intersect'] }, bodyName: { type: 'string' } }),
  'structural.member.create': objectSchema(['id', 'pathSketchId', 'familyId', 'presetId'], { id: STRUCTURAL_MEMBER_ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 }, bodyName: { type: 'string', minLength: 1, maxLength: 200 }, pathSketchId: ENTITY_OR_ALIAS_SCHEMA, familyId: { enum: ['rectangular-bar', 'equal-angle', 'channel', 'i-section', 'tee'] }, presetId: ID_SCHEMA, placement: STRUCTURAL_MEMBER_PLACEMENT_SCHEMA }),
  'structural.member.update': objectSchema(['featureId', 'patch'], { featureId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, pathSketchId: ENTITY_OR_ALIAS_SCHEMA, familyId: { enum: ['rectangular-bar', 'equal-angle', 'channel', 'i-section', 'tee'] }, presetId: ID_SCHEMA, placement: STRUCTURAL_MEMBER_PLACEMENT_SCHEMA }, additionalProperties: false } }),
  'structural.treatment.create': {
    oneOf: [
      objectSchema(['id', 'kind', 'memberId', 'end', 'mode', 'distance'], {
        id: WELDMENT_TREATMENT_ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 }, kind: { const: 'trim-extend' },
        memberId: ENTITY_OR_ALIAS_SCHEMA, end: { enum: ['start', 'end'] }, mode: { enum: ['trim', 'extend'] },
        distance: WELDMENT_TREATMENT_DIMENSION_SCHEMA,
      }),
      objectSchema(['id', 'kind', 'targetMemberId', 'targetEnd', 'otherMemberId', 'otherEnd', 'style'], {
        id: WELDMENT_TREATMENT_ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 }, kind: { const: 'corner' },
        targetMemberId: ENTITY_OR_ALIAS_SCHEMA, targetEnd: { enum: ['start', 'end'] },
        otherMemberId: ENTITY_OR_ALIAS_SCHEMA, otherEnd: { enum: ['start', 'end'] }, style: { enum: ['miter', 'cope'] },
      }),
      objectSchema(['id', 'kind', 'leftMemberId', 'leftEnd', 'rightMemberId', 'rightEnd', 'leftLegLength', 'rightLegLength', 'thickness'], {
        id: WELDMENT_TREATMENT_ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 }, bodyName: { type: 'string', minLength: 1, maxLength: 200 }, kind: { const: 'gusset' },
        leftMemberId: ENTITY_OR_ALIAS_SCHEMA, leftEnd: { enum: ['start', 'end'] },
        rightMemberId: ENTITY_OR_ALIAS_SCHEMA, rightEnd: { enum: ['start', 'end'] },
        leftLegLength: WELDMENT_TREATMENT_DIMENSION_SCHEMA,
        rightLegLength: WELDMENT_TREATMENT_DIMENSION_SCHEMA,
        thickness: WELDMENT_TREATMENT_DIMENSION_SCHEMA,
      }),
      objectSchema(['id', 'kind', 'memberId', 'end', 'thickness'], {
        id: WELDMENT_TREATMENT_ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 }, bodyName: { type: 'string', minLength: 1, maxLength: 200 }, kind: { const: 'end-cap' },
        memberId: ENTITY_OR_ALIAS_SCHEMA, end: { enum: ['start', 'end'] },
        thickness: WELDMENT_TREATMENT_DIMENSION_SCHEMA,
      }),
    ],
  },
  'structural.treatment.update': objectSchema(['featureId', 'patch'], {
    featureId: ENTITY_OR_ALIAS_SCHEMA,
    patch: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        mode: { enum: ['trim', 'extend'] },
        distance: WELDMENT_TREATMENT_DIMENSION_SCHEMA,
        style: { enum: ['miter', 'cope'] },
        leftLegLength: WELDMENT_TREATMENT_DIMENSION_SCHEMA,
        rightLegLength: WELDMENT_TREATMENT_DIMENSION_SCHEMA,
        thickness: WELDMENT_TREATMENT_DIMENSION_SCHEMA,
      },
      additionalProperties: false,
    },
  }),
  'structural.treatment.delete': objectSchema(['featureId'], { featureId: ENTITY_OR_ALIAS_SCHEMA }),
  'weld.bead.create': objectSchema(['id', 'kind', 'sizeMm', 'supports'], {
    id: WELD_BEAD_ID_SCHEMA,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    bodyName: { type: 'string', minLength: 1, maxLength: 200 },
    kind: { const: 'fillet' },
    sizeMm: WELD_BEAD_SIZE_SCHEMA,
    process: { type: 'string', maxLength: 80 },
    supports: { type: 'array', minItems: 2, maxItems: 2, items: WELD_BEAD_SUPPORT_SCHEMA },
  }),
  'weld.bead.update': objectSchema(['featureId', 'patch'], {
    featureId: ENTITY_OR_ALIAS_SCHEMA,
    patch: {
      type: 'object',
      minProperties: 1,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        sizeMm: WELD_BEAD_SIZE_SCHEMA,
        process: { type: 'string', maxLength: 80 },
      },
      additionalProperties: false,
    },
  }),
  'weld.bead.delete': objectSchema(['featureId'], { featureId: ENTITY_OR_ALIAS_SCHEMA }),
  'sheetMetal.flange.create': {
    oneOf: [
      objectSchema(['id', 'kind', 'profileSketchId', 'thickness', 'bendRadius'], {
        id: SHEET_METAL_ID_SCHEMA,
        name: { type: 'string', minLength: 1, maxLength: 200 },
        bodyName: { type: 'string', minLength: 1, maxLength: 200 },
        kind: { const: 'base-flange' },
        profileSketchId: ENTITY_OR_ALIAS_SCHEMA,
        thickness: SHEET_METAL_THICKNESS_SCHEMA,
        kFactor: SHEET_METAL_K_FACTOR_SCHEMA,
        bendRadius: SHEET_METAL_RADIUS_SCHEMA,
      }),
      objectSchema(['id', 'kind', 'baseFeatureId', 'segmentIndex', 'side', 'flangeLength'], {
        id: SHEET_METAL_ID_SCHEMA,
        name: { type: 'string', minLength: 1, maxLength: 200 },
        kind: { const: 'edge-flange' },
        baseFeatureId: ENTITY_OR_ALIAS_SCHEMA,
        segmentIndex: { type: 'integer', minimum: 0, maximum: 63 },
        side: { enum: ['up', 'down'] },
        bendRadius: SHEET_METAL_RADIUS_SCHEMA,
        kFactor: SHEET_METAL_K_FACTOR_SCHEMA,
        flangeLength: SHEET_METAL_FLANGE_LENGTH_SCHEMA,
      }),
    ],
  },
  'sheetMetal.cornerRelief.create': objectSchema(['id', 'baseFeatureId', 'cornerIndex', 'style'], {
    id: SHEET_METAL_ID_SCHEMA,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    baseFeatureId: ENTITY_OR_ALIAS_SCHEMA,
    cornerIndex: { type: 'integer', minimum: 0, maximum: 63 },
    style: { enum: ['rectangular', 'circular'] },
  }),
  'sheetMetal.flatPattern.create': objectSchema(['id', 'baseFeatureId'], {
    id: SHEET_METAL_ID_SCHEMA,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    bodyName: { type: 'string', minLength: 1, maxLength: 200 },
    baseFeatureId: ENTITY_OR_ALIAS_SCHEMA,
  }),
  'sheetMetal.bendTable.set': objectSchema(['rows'], {
    rows: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: objectSchema(['thickness', 'bendRadius', 'kFactor'], {
        thickness: SHEET_METAL_THICKNESS_SCHEMA,
        bendRadius: SHEET_METAL_RADIUS_SCHEMA,
        kFactor: SHEET_METAL_K_FACTOR_SCHEMA,
      }),
    },
  }),
  'sheetMetal.bendTable.delete': objectSchema([], {}),
  'sheetMetal.flange.update': objectSchema(['featureId', 'patch'], {
    featureId: ENTITY_OR_ALIAS_SCHEMA,
    patch: {
      type: 'object',
      minProperties: 1,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        thickness: SHEET_METAL_THICKNESS_SCHEMA,
        kFactor: SHEET_METAL_K_FACTOR_SCHEMA,
        bendRadius: SHEET_METAL_RADIUS_SCHEMA,
        flangeLength: SHEET_METAL_FLANGE_LENGTH_SCHEMA,
      },
      additionalProperties: false,
    },
  }),
  'sheetMetal.flange.delete': objectSchema(['featureId'], { featureId: ENTITY_OR_ALIAS_SCHEMA }),
  'directEdit.create': {
    oneOf: [
      objectSchema(['id', 'operation', 'targetBodyId', 'targetFace', 'distance'], {
        id: ID_SCHEMA,
        name: { type: 'string', minLength: 1, maxLength: 200 },
        operation: { const: 'push-pull' },
        targetBodyId: ENTITY_OR_ALIAS_SCHEMA,
        targetFace: DIRECT_EDIT_TOPOLOGY_REFERENCE_SCHEMA,
        distance: DIRECT_EDIT_DISTANCE_SCHEMA,
        suppressed: { type: 'boolean' },
      }),
      objectSchema(['id', 'operation', 'targetBodyId', 'targetFace', 'replacementBodyId', 'replacementFace'], {
        id: ID_SCHEMA,
        name: { type: 'string', minLength: 1, maxLength: 200 },
        operation: { const: 'replace-face' },
        targetBodyId: ENTITY_OR_ALIAS_SCHEMA,
        targetFace: DIRECT_EDIT_TOPOLOGY_REFERENCE_SCHEMA,
        replacementBodyId: ENTITY_OR_ALIAS_SCHEMA,
        replacementFace: DIRECT_EDIT_TOPOLOGY_REFERENCE_SCHEMA,
        suppressed: { type: 'boolean' },
      }),
      objectSchema(['id', 'operation', 'targetBodyId', 'targetFace', 'patchFace'], {
        id: ID_SCHEMA,
        name: { type: 'string', minLength: 1, maxLength: 200 },
        operation: { const: 'delete-face' },
        targetBodyId: ENTITY_OR_ALIAS_SCHEMA,
        targetFace: DIRECT_EDIT_TOPOLOGY_REFERENCE_SCHEMA,
        patchFace: DIRECT_EDIT_TOPOLOGY_REFERENCE_SCHEMA,
        suppressed: { type: 'boolean' },
      }),
    ],
  },
  'directEdit.update': objectSchema(['featureId', 'patch'], {
    featureId: ENTITY_OR_ALIAS_SCHEMA,
    patch: DIRECT_EDIT_PATCH_SCHEMA,
  }),
  'directEdit.delete': objectSchema(['featureId'], { featureId: ENTITY_OR_ALIAS_SCHEMA }),
  'feature.revolveProfile': objectSchema(['id', 'profileSketchId', 'axisDatumId', 'angle'], { id: ID_SCHEMA, name: { type: 'string' }, profileSketchId: ENTITY_OR_ALIAS_SCHEMA, axisDatumId: ENTITY_OR_ALIAS_SCHEMA, angle: DIMENSION_SCHEMA, startAngle: DIMENSION_SCHEMA, symmetric: { type: 'boolean' }, targetBodyId: ENTITY_OR_ALIAS_SCHEMA, operation: { enum: ['add', 'subtract', 'intersect'] }, bodyName: { type: 'string' } }),
  'feature.draft': objectSchema(['id', 'bodyId', 'neutralPlaneDatumId', 'angle', 'faceRefs'], { id: ID_SCHEMA, name: { type: 'string' }, bodyId: ENTITY_OR_ALIAS_SCHEMA, neutralPlaneDatumId: ENTITY_OR_ALIAS_SCHEMA, angle: DIMENSION_SCHEMA, faceRefs: { type: 'array', minItems: 1 }, flip: { type: 'boolean' }, tangentPropagation: { const: false } }),
  'feature.thicken': objectSchema(['id', 'bodyId', 'faceRefs', 'thickness'], { id: ID_SCHEMA, name: { type: 'string' }, bodyId: ENTITY_OR_ALIAS_SCHEMA, faceRefs: { type: 'array', minItems: 1 }, thickness: DIMENSION_SCHEMA, direction: { enum: ['inside', 'outside', 'symmetric'] }, bodyName: { type: 'string' } }),
  'feature.faceFillet': objectSchema(['id', 'bodyId', 'faceRefs', 'radius'], { id: ID_SCHEMA, name: { type: 'string' }, bodyId: ENTITY_OR_ALIAS_SCHEMA, faceRefs: { type: 'array', minItems: 2, maxItems: 2 }, radius: DIMENSION_SCHEMA }),
  'feature.variableFillet': objectSchema(['id', 'bodyId', 'edgeRefs', 'variableRadii'], { id: ID_SCHEMA, name: { type: 'string' }, bodyId: ENTITY_OR_ALIAS_SCHEMA, edgeRefs: { type: 'array', minItems: 1 }, variableRadii: { type: 'array', minItems: 1, items: VARIABLE_FILLET_RADIUS_SCHEMA }, tangentPropagation: { const: false } }),
  'feature.advanced.update': objectSchema(['featureId', 'patch'], { featureId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'pattern.create': objectSchema(['id', 'kind', 'sourceBodyId'], { id: ID_SCHEMA, name: { type: 'string' }, kind: { enum: ['linear', 'circular', 'curve', 'mirror', 'sketch', 'fill', 'variable'] }, sourceBodyId: ENTITY_OR_ALIAS_SCHEMA, directionDatumId: ENTITY_OR_ALIAS_SCHEMA, directionDatumIds: { type: 'array', minItems: 1, maxItems: 2, items: ENTITY_OR_ALIAS_SCHEMA }, axisDatumId: ENTITY_OR_ALIAS_SCHEMA, pathSketchId: ENTITY_OR_ALIAS_SCHEMA, pointSketchId: ENTITY_OR_ALIAS_SCHEMA, boundarySketchId: ENTITY_OR_ALIAS_SCHEMA, planeDatumId: ENTITY_OR_ALIAS_SCHEMA, outputMode: { enum: ['linked', 'union'] }, skippedIndices: { type: 'array', items: { type: 'integer', minimum: 1 } }, suppressed: { type: 'boolean' }, visible: { type: 'boolean' }, ...BODY_PATTERN_DEFINITION_PROPERTIES, definition: { type: 'object', properties: BODY_PATTERN_DEFINITION_PROPERTIES, additionalProperties: false } }),
  'pattern.update': objectSchema(['patternId', 'patch'], { patternId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'pattern.delete': objectSchema(['patternId'], { patternId: ENTITY_OR_ALIAS_SCHEMA }),
  'pattern.materialize': objectSchema(['patternId', 'records'], { patternId: ENTITY_OR_ALIAS_SCHEMA, records: { type: 'array', minItems: 1 }, dissolve: { type: 'boolean' } }),
  'assembly.create': objectSchema(['id', 'occurrenceId'], { id: ID_SCHEMA, name: { type: 'string' }, occurrenceId: ID_SCHEMA, occurrenceName: { type: 'string' }, fixed: { type: 'boolean' } }),
  'document.activate': objectSchema(['definition'], { definition: { type: 'object' } }),
  'assembly.context.enter': objectSchema(['occurrenceId'], { occurrenceId: ENTITY_OR_ALIAS_SCHEMA }),
  'assembly.context.exit': objectSchema([], {}),
  'assembly.drag': objectSchema(['occurrenceId', 'targetTransform'], { occurrenceId: ENTITY_OR_ALIAS_SCHEMA, targetTransform: { type: 'array', minItems: 16, maxItems: 16 } }),
  'smartFastener.apply': objectSchema(['id', 'plan'], {
    id: ID_SCHEMA,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    plan: SMART_FASTENER_PLAN_SCHEMA,
  }),
  'smartFastener.update': objectSchema(['smartFastenerId', 'plan'], {
    smartFastenerId: ENTITY_OR_ALIAS_SCHEMA,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    plan: SMART_FASTENER_PLAN_SCHEMA,
  }),
  'smartFastener.delete': objectSchema(['smartFastenerId'], {
    smartFastenerId: ENTITY_OR_ALIAS_SCHEMA,
  }),
  'assemblyFeature.create': {
    oneOf: [
      objectSchema(['id', 'name', 'kind', 'targets', 'origin', 'direction', 'xDirection', 'width', 'height'], {
        id: ID_SCHEMA,
        name: { type: 'string', minLength: 1, maxLength: 200 },
        kind: { const: 'cut' },
        targets: ASSEMBLY_FEATURE_TARGETS_SCHEMA,
        origin: ASSEMBLY_FEATURE_VECTOR_SCHEMA,
        direction: ASSEMBLY_FEATURE_VECTOR_SCHEMA,
        xDirection: ASSEMBLY_FEATURE_VECTOR_SCHEMA,
        width: ASSEMBLY_FEATURE_DIMENSION_SCHEMA,
        height: ASSEMBLY_FEATURE_DIMENSION_SCHEMA,
        suppressed: { type: 'boolean' },
      }),
      objectSchema(['id', 'name', 'kind', 'targets', 'origin', 'direction', 'xDirection', 'diameter'], {
        id: ID_SCHEMA,
        name: { type: 'string', minLength: 1, maxLength: 200 },
        kind: { const: 'hole' },
        targets: ASSEMBLY_FEATURE_TARGETS_SCHEMA,
        origin: ASSEMBLY_FEATURE_VECTOR_SCHEMA,
        direction: ASSEMBLY_FEATURE_VECTOR_SCHEMA,
        xDirection: ASSEMBLY_FEATURE_VECTOR_SCHEMA,
        diameter: ASSEMBLY_FEATURE_DIMENSION_SCHEMA,
        suppressed: { type: 'boolean' },
      }),
    ],
  },
  'assemblyFeature.update': objectSchema(['assemblyFeatureId', 'patch'], {
    assemblyFeatureId: ENTITY_OR_ALIAS_SCHEMA,
    patch: ASSEMBLY_FEATURE_PATCH_SCHEMA,
  }),
  'assemblyFeature.delete': objectSchema(['assemblyFeatureId'], {
    assemblyFeatureId: ENTITY_OR_ALIAS_SCHEMA,
  }),
  'component.createPart': objectSchema(['partId', 'name', 'occurrenceId'], { partId: ID_SCHEMA, name: { type: 'string' }, occurrenceId: ID_SCHEMA, occurrenceName: { type: 'string' }, baseTransform: { type: 'array', minItems: 16, maxItems: 16 }, fixed: { type: 'boolean' }, enterContext: { type: 'boolean' } }),
  'component.insert': objectSchema(['id', 'definition'], { id: ID_SCHEMA, name: { type: 'string' }, definition: { type: 'object' }, baseTransform: { type: 'array', minItems: 16, maxItems: 16 }, fixed: { type: 'boolean' }, visible: { type: 'boolean' }, parameterOverrides: { type: 'object' } }),
  'component.update': objectSchema(['occurrenceId', 'patch'], { occurrenceId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'component.duplicate': objectSchema(['occurrenceId', 'id'], { occurrenceId: ENTITY_OR_ALIAS_SCHEMA, id: ID_SCHEMA, name: { type: 'string' }, baseTransform: { type: 'array', minItems: 16, maxItems: 16 } }),
  'component.makeIndependent': objectSchema(['occurrenceId', 'partId'], { occurrenceId: ENTITY_OR_ALIAS_SCHEMA, partId: ID_SCHEMA, name: { type: 'string' }, occurrenceName: { type: 'string' } }),
  'component.replace': objectSchema(['occurrenceId', 'definition'], { occurrenceId: ENTITY_OR_ALIAS_SCHEMA, definition: { type: 'object' } }),
  'component.delete': objectSchema(['occurrenceId'], { occurrenceId: ENTITY_OR_ALIAS_SCHEMA }),
  'component.pattern': objectSchema(['id', 'sourceOccurrenceIds', 'generatedCount'], { id: ID_SCHEMA, name: { type: 'string' }, kind: { type: 'string' }, sourceOccurrenceIds: { type: 'array', minItems: 1, items: ENTITY_OR_ALIAS_SCHEMA }, generatedCount: { type: 'integer' }, definition: { type: 'object' } }),
  'component.pattern.update': objectSchema(['patternId', 'patch'], { patternId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'component.pattern.delete': objectSchema(['patternId'], { patternId: ENTITY_OR_ALIAS_SCHEMA }),
  'mate.create': objectSchema(['id', 'mateKind', 'occurrenceIds'], {
    id: ID_SCHEMA,
    name: { type: 'string' },
    mateKind: { enum: [
      'fixed',
      'coincident',
      'concentric',
      'distance',
      'angle',
      'parallel',
      'perpendicular',
      'tangent',
      'revolute',
      'slider',
      'width',
      'symmetry',
      'path',
      'linear-coupler',
      'limit-distance',
      'limit-angle',
      'gear',
      'hinge',
    ] },
    occurrenceIds: { type: 'array', minItems: 1, items: ENTITY_OR_ALIAS_SCHEMA },
    references: { type: 'array' },
    value: DIMENSION_SCHEMA,
    suppressed: { type: 'boolean' },
    extensions: { type: 'object' },
  }),
  'mate.update': objectSchema(['mateId', 'patch'], { mateId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'mate.delete': objectSchema(['mateId'], { mateId: ENTITY_OR_ALIAS_SCHEMA }),
  'section.create': objectSchema(['id', 'name', 'kind', 'planes'], { id: ID_SCHEMA, name: { type: 'string' }, kind: { enum: ['plane', 'quarter', 'box'] }, planes: { type: 'array', minItems: 1 }, scopeOccurrenceIds: { type: 'array', items: ENTITY_OR_ALIAS_SCHEMA }, cap: { type: 'boolean' }, reverse: { type: 'boolean' }, hatch: { type: 'object' } }),
  'section.update': objectSchema(['sectionId', 'patch'], { sectionId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'section.activate': objectSchema([], { sectionId: ENTITY_OR_ALIAS_SCHEMA }),
  'section.delete': objectSchema(['sectionId'], { sectionId: ENTITY_OR_ALIAS_SCHEMA }),
  'exploded.create': objectSchema(['id', 'name', 'steps'], { id: ID_SCHEMA, name: { type: 'string' }, steps: { type: 'array', minItems: 1 } }),
  'exploded.activate': objectSchema([], { explodedViewId: ENTITY_OR_ALIAS_SCHEMA }),
  'exploded.delete': objectSchema(['explodedViewId'], { explodedViewId: ENTITY_OR_ALIAS_SCHEMA }),
  'measurement.create': objectSchema(['id', 'name', 'measurementKind', 'definition'], { id: ID_SCHEMA, name: { type: 'string' }, measurementKind: { type: 'string' }, definition: { type: 'object' } }),
  'measurement.update': objectSchema(['measurementId', 'patch'], { measurementId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'measurement.delete': objectSchema(['measurementId'], { measurementId: ENTITY_OR_ALIAS_SCHEMA }),
  'display.setMode': objectSchema(['mode'], { mode: { enum: ['shaded', 'shaded-edges', 'wireframe', 'hidden-line', 'ghost'] } }),
  'material.ensureGeneric': objectSchema([], {}),
  'material.assignBody': objectSchema(['partId', 'bodyId', 'materialId'], { partId: ENTITY_OR_ALIAS_SCHEMA, bodyId: ENTITY_OR_ALIAS_SCHEMA, materialId: ENTITY_OR_ALIAS_SCHEMA }),
  'appearance.assignOccurrence': objectSchema(['occurrenceId', 'appearanceId'], { occurrenceId: ENTITY_OR_ALIAS_SCHEMA, appearanceId: ID_SCHEMA }),
  'stage.create': objectSchema(['id', 'name', 'occurrenceIds', 'distanceMateIds'], { id: ID_SCHEMA, name: { type: 'string' }, occurrenceIds: { type: 'array', minItems: 1, items: ENTITY_OR_ALIAS_SCHEMA }, distanceMateIds: { type: 'array', minItems: 1, items: ENTITY_OR_ALIAS_SCHEMA }, axis: { type: 'array' }, start: { type: 'number' }, spacing: { type: 'number' }, visible: { type: 'boolean' } }),
  'stage.update': objectSchema(['groupId', 'patch'], { groupId: ENTITY_OR_ALIAS_SCHEMA, patch: { type: 'object' } }),
  'stage.delete': objectSchema(['groupId'], { groupId: ENTITY_OR_ALIAS_SCHEMA }),
  'pdm.initialize': objectSchema(['actor', 'at'], { actor: { type: 'string', minLength: 1, maxLength: 200 }, at: { type: 'string' }, branchName: { type: 'string', minLength: 1, maxLength: 100 }, message: { type: 'string', minLength: 1, maxLength: 500 } }),
  'pdm.version.create': objectSchema(['actor', 'at', 'message', 'expectedHeadVersionId'], { actor: { type: 'string', minLength: 1, maxLength: 200 }, at: { type: 'string' }, message: { type: 'string', minLength: 1, maxLength: 500 }, branchId: ID_SCHEMA, expectedHeadVersionId: ID_SCHEMA }),
  'pdm.branch.create': objectSchema(['name', 'actor', 'at'], { name: { type: 'string', minLength: 1, maxLength: 100 }, actor: { type: 'string', minLength: 1, maxLength: 200 }, at: { type: 'string' }, fromVersionId: ID_SCHEMA, checkout: { type: 'boolean' } }),
  'pdm.branch.checkout': objectSchema(['branchId'], { branchId: ID_SCHEMA }),
  'pdm.review.submit': objectSchema(['versionId', 'actor', 'at'], { versionId: ID_SCHEMA, actor: { type: 'string', minLength: 1, maxLength: 200 }, at: { type: 'string' }, comment: { type: 'string', maxLength: 1000 } }),
  'pdm.approval.record': objectSchema(['versionId', 'reviewer', 'decision', 'at'], { versionId: ID_SCHEMA, reviewer: { type: 'string', minLength: 1, maxLength: 200 }, decision: { enum: ['approved', 'rejected'] }, at: { type: 'string' }, comment: { type: 'string', maxLength: 1000 } }),
  'pdm.review.return': objectSchema(['versionId', 'actor', 'at'], { versionId: ID_SCHEMA, actor: { type: 'string', minLength: 1, maxLength: 200 }, at: { type: 'string' }, comment: { type: 'string', maxLength: 1000 } }),
  'pdm.version.release': objectSchema(['versionId', 'actor', 'at'], { versionId: ID_SCHEMA, actor: { type: 'string', minLength: 1, maxLength: 200 }, at: { type: 'string' }, comment: { type: 'string', maxLength: 1000 }, requiredApprovals: { type: 'integer', minimum: 1, maximum: 20 } }),
  'pdm.version.obsolete': objectSchema(['versionId', 'actor', 'at'], { versionId: ID_SCHEMA, actor: { type: 'string', minLength: 1, maxLength: 200 }, at: { type: 'string' }, comment: { type: 'string', maxLength: 1000 } }),
  'drawing.view.create': objectSchema(['name', 'direction', 'xAxis'], { name: { type: 'string', minLength: 1, maxLength: 120 }, direction: DRAWING_VECTOR_SCHEMA, xAxis: DRAWING_VECTOR_SCHEMA }),
  'drawing.view.update': objectSchema(['viewId', 'patch'], { viewId: ID_SCHEMA, patch: { type: 'object' } }),
  'drawing.view.delete': objectSchema(['viewId'], { viewId: ID_SCHEMA }),
  'drawing.derivedView.create': DRAWING_DERIVED_CREATE_SCHEMA,
  'drawing.derivedView.update': objectSchema(['viewId', 'patch'], { viewId: DRAWING_DERIVED_VIEW_ID_SCHEMA, patch: DRAWING_DERIVED_UPDATE_PATCH_SCHEMA }),
  'drawing.derivedView.delete': objectSchema(['viewId'], { viewId: DRAWING_DERIVED_VIEW_ID_SCHEMA }),
  'drawing.book.initialize': objectSchema([], { title: { type: 'string', minLength: 1, maxLength: 120 }, templateId: ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 120 }, scale: { oneOf: [{ const: 'fit' }, { enum: [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01] }] }, views: { type: 'array', minItems: 1, maxItems: 16, items: DRAWING_VIEW_KEY_SCHEMA }, tangentEdges: { enum: ['visible', 'removed', 'phantom'] }, alignments: { type: 'array', maxItems: 15, items: DRAWING_ALIGNMENT_SCHEMA } }),
  'drawing.sheet.create': objectSchema(['name'], { name: { type: 'string', minLength: 1, maxLength: 120 }, templateId: ID_SCHEMA, widthMm: { type: 'number' }, heightMm: { type: 'number' }, formatName: { type: 'string' }, standard: { type: 'string' }, size: { type: 'string' }, projection: { enum: ['first-angle', 'third-angle'] }, titleBlock: { type: 'string' }, scale: { oneOf: [{ const: 'fit' }, { enum: [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01] }] }, views: { type: 'array', minItems: 1, maxItems: 16, items: DRAWING_VIEW_KEY_SCHEMA }, tangentEdges: { enum: ['visible', 'removed', 'phantom'] }, alignments: { type: 'array', maxItems: 15, items: DRAWING_ALIGNMENT_SCHEMA }, description: { type: 'string', maxLength: 500 }, activate: { type: 'boolean' } }),
  'drawing.sheet.update': objectSchema(['sheetId', 'patch'], { sheetId: ID_SCHEMA, patch: { type: 'object' } }),
  'drawing.sheet.delete': objectSchema(['sheetId'], { sheetId: ID_SCHEMA }),
  'drawing.sheet.activate': objectSchema(['sheetId'], { sheetId: ID_SCHEMA }),
  'drawing.sheet.reorder': objectSchema(['orderedSheetIds'], { orderedSheetIds: { type: 'array', minItems: 1, maxItems: 20, items: ID_SCHEMA } }),
  'drawing.standard.apply': objectSchema(['sheetId', 'profileId'], { sheetId: ID_SCHEMA, profileId: { enum: ['iso', 'ansi', 'din'] } }),
  'drawing.lineFont.create': objectSchema(['name', 'widthMm', 'dashMm', 'color'], { name: { type: 'string', minLength: 1, maxLength: 120 }, widthMm: { type: 'number', minimum: 0.05, maximum: 2 }, dashMm: { type: 'array', maxItems: 8, items: { type: 'number', exclusiveMinimum: 0, maximum: 100 } }, color: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', minimum: 0, maximum: 1 } } }),
  'drawing.lineFont.update': objectSchema(['lineFontId', 'patch'], { lineFontId: ID_SCHEMA, patch: { type: 'object' } }),
  'drawing.lineFont.delete': objectSchema(['lineFontId'], { lineFontId: ID_SCHEMA }),
  'drawing.layer.update': objectSchema(['sheetId', 'layerId', 'patch'], { sheetId: ID_SCHEMA, layerId: { enum: ['border', 'visible', 'hidden', 'tangent', 'dimensions', 'annotations', 'tables'] }, patch: { type: 'object' } }),
  'drawing.block.create': objectSchema(['name', 'text', 'widthMm', 'heightMm'], { name: { type: 'string', minLength: 1, maxLength: 120 }, text: { type: 'string', minLength: 1, maxLength: 200 }, widthMm: { type: 'number', minimum: 5, maximum: 200 }, heightMm: { type: 'number', minimum: 5, maximum: 100 } }),
  'drawing.block.update': objectSchema(['blockId', 'patch'], { blockId: ID_SCHEMA, patch: { type: 'object' } }),
  'drawing.block.delete': objectSchema(['blockId'], { blockId: ID_SCHEMA }),
  'drawing.annotation.create': objectSchema(['kind', 'sheetId'], { kind: { enum: ['note', 'balloon', 'revision-cloud', 'block', 'model-dimension', 'associative-dimension', 'datum-symbol', 'feature-control-frame', 'tolerance-stack', 'hole-callout', 'center-mark', 'centerline', 'weld-symbol', 'surface-finish'] }, sheetId: ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 120 }, text: { type: 'string', minLength: 1, maxLength: 500 }, positionMm: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, sizePt: { type: 'number', minimum: 5, maximum: 24 }, viewId: DRAWING_ORDINARY_VIEW_KEY_SCHEMA, anchor: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, anchorA: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, anchorB: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, labelMm: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, revision: { type: 'string', minLength: 1, maxLength: 20 }, boundsMm: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } }, blockId: ID_SCHEMA, scale: { type: 'number', minimum: 0.1, maximum: 10 }, featureId: ID_SCHEMA, featureIds: { type: 'array', minItems: 2, maxItems: 2, items: ID_SCHEMA }, sourceField: { enum: ['h', 'r', 't'] }, dimensionType: { enum: ['distance', 'horizontal', 'vertical'] }, references: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'object', required: ['bodyId', 'topologyKind', 'name'], properties: { bodyId: ID_SCHEMA, topologyKind: { enum: ['face', 'edge', 'vertex'] }, name: { type: 'string', minLength: 1, maxLength: 4096 } }, additionalProperties: false } }, reference: { type: 'object', required: ['bodyId', 'topologyKind', 'name'], properties: { bodyId: ID_SCHEMA, topologyKind: { enum: ['face', 'edge', 'vertex'] }, name: { type: 'string', minLength: 1, maxLength: 4096 } }, additionalProperties: false }, identifier: { type: 'string', minLength: 1, maxLength: 3 }, characteristic: { enum: ['straightness', 'flatness', 'circularity', 'cylindricity', 'profile-line', 'profile-surface', 'parallelism', 'perpendicularity', 'angularity', 'position', 'circular-runout', 'total-runout'] }, toleranceMm: { type: 'number', exclusiveMinimum: 0, maximum: 100000 }, diameterZone: { type: 'boolean' }, materialCondition: { enum: ['none', 'maximum', 'least'] }, datumIds: { type: 'array', maxItems: 3, items: ID_SCHEMA }, entries: { type: 'array', minItems: 2, maxItems: 50, items: { type: 'object', required: ['label', 'nominalMm'], properties: { label: { type: 'string', minLength: 1, maxLength: 80 }, nominalMm: { type: 'number' }, plusMm: { type: 'number', minimum: 0 }, minusMm: { type: 'number', minimum: 0 }, direction: { enum: [1, -1] } }, additionalProperties: false } }, sizeMm: { type: 'number', exclusiveMinimum: 0, maximum: 1000 }, extensionMm: { type: 'number', minimum: 0, maximum: 20 }, weldType: { enum: ['fillet', 'square-groove', 'v-groove', 'plug-slot'] }, side: { enum: ['arrow', 'other', 'both'] }, tail: { type: 'string', maxLength: 120 }, roughnessRa: { type: 'number', minimum: 0.01, maximum: 500 }, method: { enum: ['unspecified', 'material-removal-required', 'material-removal-prohibited'] }, lay: { enum: ['none', 'parallel', 'perpendicular', 'crossed', 'multidirectional', 'circular', 'radial'] }, process: { type: 'string', maxLength: 120 } }),
  'drawing.annotation.update': objectSchema(['annotationId', 'patch'], { annotationId: ID_SCHEMA, patch: { type: 'object' } }),
  'drawing.annotation.delete': objectSchema(['annotationId'], { annotationId: ID_SCHEMA }),
  'drawing.table.create': objectSchema(['kind', 'sheetId', 'name', 'positionMm', 'widthMm'], { kind: { enum: ['cut-list', 'hole', 'revision', 'weld'] }, sheetId: ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 120 }, positionMm: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, widthMm: { type: 'number', minimum: 40, maximum: 250 }, sourceType: { enum: ['body-axis', 'structural-member'] }, axis: { enum: ['x', 'y', 'z'] }, sourceBodyIds: { type: 'array', minItems: 1, maxItems: 50, items: ID_SCHEMA }, sourceMemberIds: { type: 'array', minItems: 1, maxItems: 50, items: ID_SCHEMA }, sourceFeatureIds: { type: 'array', minItems: 1, maxItems: 100, items: ID_SCHEMA }, entries: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } } }),
  'drawing.table.update': objectSchema(['tableId', 'patch'], { tableId: ID_SCHEMA, patch: { type: 'object' } }),
  'drawing.table.delete': objectSchema(['tableId'], { tableId: ID_SCHEMA }),
});

const AVAILABLE_OPERATION_KINDS = Object.freeze([
  'project.rename',
  'project.setUnits',
  'project.clear',
  'parameter.create',
  'parameter.update',
  'parameter.delete',
  'configuration.activate',
  'feature.extrude',
  'feature.cut',
  'feature.revolve',
  'feature.fillet',
  'feature.chamfer',
  'feature.shell',
  'feature.thread',
  'feature.update',
  'feature.suppress',
  'feature.delete',
  'body.activate',
  'body.rename',
  'body.setVisibility',
  'body.suppress',
  'body.delete',
  'boolean.union',
  'boolean.subtract',
  'boolean.intersect',
  'boolean.split',
  'datum.create', 'datum.update', 'datum.delete',
  'sketch.profile.create', 'sketch.path.create', 'sketch.reference.create', 'sketch.reference.update', 'sketch.advanced.update', 'sketch.advanced.delete',
  'sketch.constrained.create', 'sketch.constrained.promote', 'sketch.constrained.update', 'sketch.constrained.delete', 'sketch.importDxf',
  'sketch.blockDefinition.create', 'sketch.blockDefinition.update', 'sketch.blockDefinition.delete',
  'sketch.blockInstance.create', 'sketch.blockInstance.update', 'sketch.blockInstance.delete', 'sketch.blockInstance.explode',
  'sketch.relation.create', 'sketch.relation.update', 'sketch.relation.delete',
  'sketch.derived.create', 'sketch.derived.update', 'sketch.derived.underive', 'sketch.drag',
  'body.transform', 'transform.update', 'feature.reorder', 'feature.rollback',
  'feature.loft', 'feature.sweep', 'structural.member.create', 'structural.member.update',
  'structural.treatment.create', 'structural.treatment.update', 'structural.treatment.delete',
  'weld.bead.create', 'weld.bead.update', 'weld.bead.delete',
  'sheetMetal.flange.create', 'sheetMetal.flange.update', 'sheetMetal.flange.delete',
  'sheetMetal.cornerRelief.create', 'sheetMetal.flatPattern.create',
  'sheetMetal.bendTable.set', 'sheetMetal.bendTable.delete',
  'directEdit.create', 'directEdit.update', 'directEdit.delete',
  'feature.revolveProfile', 'feature.draft', 'feature.thicken', 'feature.faceFillet', 'feature.variableFillet', 'feature.advanced.update',
  'pattern.create', 'pattern.update', 'pattern.delete', 'pattern.materialize',
  'assembly.create', 'document.activate', 'assembly.context.enter', 'assembly.context.exit', 'assembly.drag',
  'smartFastener.apply', 'smartFastener.update', 'smartFastener.delete',
  'assemblyFeature.create', 'assemblyFeature.update', 'assemblyFeature.delete',
  'component.createPart', 'component.insert', 'component.update', 'component.duplicate', 'component.makeIndependent', 'component.replace', 'component.delete', 'component.pattern', 'component.pattern.update', 'component.pattern.delete',
  'mate.create', 'mate.update', 'mate.delete',
  'section.create', 'section.update', 'section.activate', 'section.delete',
  'exploded.create', 'exploded.activate', 'exploded.delete',
  'measurement.create', 'measurement.update', 'measurement.delete',
  'display.setMode', 'material.ensureGeneric', 'material.assignBody', 'appearance.assignOccurrence',
  'stage.create', 'stage.update', 'stage.delete',
  'pdm.initialize', 'pdm.version.create', 'pdm.branch.create', 'pdm.branch.checkout',
  'pdm.review.submit', 'pdm.approval.record', 'pdm.review.return', 'pdm.version.release', 'pdm.version.obsolete',
  'drawing.view.create', 'drawing.view.update', 'drawing.view.delete',
  'drawing.derivedView.create', 'drawing.derivedView.update', 'drawing.derivedView.delete',
  'drawing.book.initialize', 'drawing.sheet.create', 'drawing.sheet.update',
  'drawing.sheet.delete', 'drawing.sheet.activate', 'drawing.sheet.reorder',
  'drawing.standard.apply', 'drawing.lineFont.create', 'drawing.lineFont.update', 'drawing.lineFont.delete', 'drawing.layer.update',
  'drawing.block.create', 'drawing.block.update', 'drawing.block.delete',
  'drawing.annotation.create', 'drawing.annotation.update', 'drawing.annotation.delete',
  'drawing.table.create', 'drawing.table.update', 'drawing.table.delete',
]);

const DISABLED_OPERATION_REASONS = Object.freeze({});

const SKETCH_REUSE_OPERATION_INPUT_FIELDS = Object.freeze({
  'sketch.constrained.create': ['id', 'name', 'plane', 'z', 'constrained'],
  'sketch.importDxf': ['id', 'name', 'plane', 'z', 'dxfText'],
  'sketch.constrained.promote': ['featureId', 'id', 'name', 'plane'],
  'sketch.constrained.update': ['sketchId', 'patch'],
  'sketch.constrained.delete': ['sketchId'],
  'sketch.blockDefinition.create': ['id', 'name', 'insertionPoint', 'sourceSketchId', 'memberEntityIds', 'constrained'],
  'sketch.blockDefinition.update': ['definitionId', 'patch'],
  'sketch.blockDefinition.delete': ['definitionId'],
  'sketch.blockInstance.create': ['sketchId', 'id', 'definitionId', 'transform', 'fixed', 'relations'],
  'sketch.blockInstance.update': ['sketchId', 'instanceId', 'patch'],
  'sketch.blockInstance.delete': ['sketchId', 'instanceId'],
  'sketch.blockInstance.explode': ['sketchId', 'instanceId'],
  'sketch.relation.create': ['sketchId', 'relation'],
  'sketch.relation.update': ['sketchId', 'relationId', 'relation'],
  'sketch.relation.delete': ['sketchId', 'relationId'],
  'sketch.derived.create': ['id', 'name', 'sourceSketchId', 'plane', 'z', 'transform', 'relations'],
  'sketch.derived.update': ['sketchId', 'patch'],
  'sketch.derived.underive': ['sketchId'],
});

const QUERY_CAPABILITIES = Object.freeze([
  'project.summary',
  'project.tree',
  'entity.detail',
  'entity.dependencies',
  'entity.search',
  'geometry.validity',
  'geometry.bodies',
  'sketch.solve',
  'geometry.topology',
  'geometry.health',
  'assembly.clearance',
  'assembly.interference',
  'history.list',
  'history.changesSince',
]);

function operationCapability(kind, state = 'available', disabledReasonCode) {
  return {
    kind,
    version: 1,
    state,
    ...(disabledReasonCode ? { disabledReasonCode } : {}),
    inputSchema: state === 'available'
      ? { type: 'object', required: ['kind', 'input'], properties: { kind: { const: kind }, alias: { type: 'string' }, input: clone(OPERATION_INPUT_SCHEMAS[kind] || { type: 'object' }) }, additionalProperties: false }
      : { type: 'object' },
    resultSchema: JSON_SCHEMAS.result,
    supportsPreview: state === 'available',
    supportsAtomicBatch: state === 'available',
  };
}

export function cadCapabilityManifest(options = {}) {
  const available = AVAILABLE_OPERATION_KINDS.map((kind) => operationCapability(kind));
  const disabled = Object.entries(DISABLED_OPERATION_REASONS).map(([kind, reason]) => operationCapability(kind, 'disabled', reason));
  return {
    protocolVersion: CAD_AGENT_PROTOCOL,
    studioVersion: options.studioVersion || CAD_AGENT_STUDIO_VERSION,
    schemaVersions: [STUDIO_V5_SCHEMA_VERSION],
    kernelVersion: CAD_AGENT_KERNEL_VERSION,
    documentKinds: ['part', 'assembly'],
    operations: [...available, ...disabled],
    queries: QUERY_CAPABILITIES.map((kind) => ({
      kind,
      version: 1,
      state: ['geometry.topology', 'geometry.health', 'assembly.clearance', 'assembly.interference'].includes(kind) && options.exactKernel === false
        ? 'disabled'
        : 'available',
      ...(['geometry.topology', 'geometry.health', 'assembly.clearance', 'assembly.interference'].includes(kind) && options.exactKernel === false
        ? { disabledReasonCode: 'EXACT_KERNEL_ADAPTER_REQUIRED' }
        : {}),
      supportsPreviewScope: ['geometry.health', 'assembly.clearance', 'assembly.interference'].includes(kind),
      inputSchema: { type: 'object' },
      resultSchema: { type: 'object' },
    })),
    exports: [
      { format: 'project', state: 'available', permission: 'artifact.export-project' },
      { format: 'step', state: options.exactKernel === false ? 'disabled' : 'available', permission: 'artifact.export-step', disabledReasonCode: options.exactKernel === false ? 'EXACT_KERNEL_ADAPTER_REQUIRED' : undefined },
      { format: 'stl', state: options.exactKernel === false ? 'disabled' : 'available', permission: 'artifact.export-stl', disabledReasonCode: options.exactKernel === false ? 'EXACT_KERNEL_ADAPTER_REQUIRED' : undefined },
      { format: 'amf', state: options.exactKernel === false ? 'disabled' : 'available', permission: 'artifact.export-amf', disabledReasonCode: options.exactKernel === false ? 'EXACT_KERNEL_ADAPTER_REQUIRED' : undefined },
      { format: '3mf', state: options.exactKernel === false ? 'disabled' : 'available', permission: 'artifact.export-3mf', disabledReasonCode: options.exactKernel === false ? 'EXACT_KERNEL_ADAPTER_REQUIRED' : undefined },
      { format: 'png', state: options.visibleStudio === true ? 'available' : 'disabled', permission: 'artifact.render', disabledReasonCode: options.visibleStudio === true ? undefined : 'VISIBLE_STUDIO_REQUIRED' },
      { format: 'drawing-svg', state: options.visibleStudio === true && options.exactKernel !== false ? 'available' : 'disabled', permission: 'artifact.export-drawing', disabledReasonCode: options.visibleStudio !== true ? 'VISIBLE_STUDIO_REQUIRED' : options.exactKernel === false ? 'EXACT_KERNEL_ADAPTER_REQUIRED' : undefined },
      { format: 'drawing-dxf', state: options.visibleStudio === true && options.exactKernel !== false ? 'available' : 'disabled', permission: 'artifact.export-drawing', disabledReasonCode: options.visibleStudio !== true ? 'VISIBLE_STUDIO_REQUIRED' : options.exactKernel === false ? 'EXACT_KERNEL_ADAPTER_REQUIRED' : undefined },
      { format: 'sketch-dxf', state: options.visibleStudio === true ? 'available' : 'disabled', permission: 'artifact.export-drawing', disabledReasonCode: options.visibleStudio === true ? undefined : 'VISIBLE_STUDIO_REQUIRED' },
      { format: 'flat-dxf', state: options.visibleStudio === true ? 'available' : 'disabled', permission: 'artifact.export-drawing', disabledReasonCode: options.visibleStudio === true ? undefined : 'VISIBLE_STUDIO_REQUIRED' },
      { format: 'webvtt', state: options.visibleStudio === true ? 'available' : 'disabled', permission: 'artifact.export-narration', disabledReasonCode: options.visibleStudio === true ? undefined : 'VISIBLE_STUDIO_REQUIRED' },
      { format: 'srt', state: options.visibleStudio === true ? 'available' : 'disabled', permission: 'artifact.export-narration', disabledReasonCode: options.visibleStudio === true ? undefined : 'VISIBLE_STUDIO_REQUIRED' },
    ],
    imports: [
      { format: 'project', state: options.visibleStudio === true ? 'available' : 'disabled', permission: 'project.replace', disabledReasonCode: options.visibleStudio === true ? undefined : 'VISIBLE_STUDIO_REQUIRED' },
      { format: 'step', state: options.visibleStudio === true && options.exactKernel !== false ? 'available' : 'disabled', permission: 'project.replace', disabledReasonCode: options.visibleStudio !== true ? 'VISIBLE_STUDIO_REQUIRED' : options.exactKernel === false ? 'EXACT_KERNEL_ADAPTER_REQUIRED' : undefined },
    ],
    limits: {
      ...STUDIO_V5_PROJECT_LIMITS,
      transactionOperations: MAX_TRANSACTION_OPERATIONS,
      requestBytes: MAX_REQUEST_BYTES,
      queryPageSize: MAX_PAGE_SIZE,
    },
    permissions: ALL_PERMISSIONS.map((permission) => ({ permission, default: 'denied' })),
    transports: ['headless', 'mcp-stdio', 'studio-loopback'],
  };
}

function invalidCapabilityQuery(message) {
  const error = new Error(message);
  error.code = 'INVALID_CAPABILITY_QUERY';
  throw error;
}

function boundedCapabilityIds(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20 || value.some((entry) => typeof entry !== 'string' || !entry || entry.length > 200)) {
    invalidCapabilityQuery(`${name} must be a bounded list of at most 20 stable capability IDs.`);
  }
  return [...new Set(value)];
}

function compactCapability(entry) {
  const { inputSchema: _inputSchema, resultSchema: _resultSchema, ...summary } = entry;
  return summary;
}

export function selectCadCapabilities(manifest, query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    invalidCapabilityQuery('Capability discovery requires an object.');
  }
  const allowed = new Set(['detail', 'operationKinds', 'queryKinds']);
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length) invalidCapabilityQuery(`Unknown capability discovery fields: ${unknown.join(', ')}.`);
  const detail = query.detail || 'summary';
  if (!['summary', 'schemas', 'full'].includes(detail)) {
    invalidCapabilityQuery('Capability detail must be summary, schemas, or full.');
  }
  const operationKinds = boundedCapabilityIds(query.operationKinds, 'operationKinds');
  const queryKinds = boundedCapabilityIds(query.queryKinds, 'queryKinds');
  const operationByKind = new Map(manifest.operations.map((entry) => [entry.kind, entry]));
  const queryByKind = new Map(manifest.queries.map((entry) => [entry.kind, entry]));
  const missingOperationKinds = operationKinds.filter((kind) => !operationByKind.has(kind));
  const missingQueryKinds = queryKinds.filter((kind) => !queryByKind.has(kind));
  if (missingOperationKinds.length || missingQueryKinds.length) {
    invalidCapabilityQuery(`Unknown capability IDs: ${[...missingOperationKinds, ...missingQueryKinds].join(', ')}.`);
  }
  if (detail === 'schemas' && !operationKinds.length && !queryKinds.length) {
    invalidCapabilityQuery('Schema discovery requires at least one operationKinds or queryKinds entry.');
  }
  const operations = detail === 'full'
    ? manifest.operations
    : detail === 'schemas'
      ? operationKinds.map((kind) => operationByKind.get(kind))
      : manifest.operations.map(compactCapability);
  const queries = detail === 'full'
    ? manifest.queries
    : detail === 'schemas'
      ? queryKinds.map((kind) => queryByKind.get(kind))
      : manifest.queries.map(compactCapability);
  return clone({
    ...manifest,
    operations,
    queries,
    capabilityDiscovery: {
      detail,
      operationCount: manifest.operations.length,
      queryCount: manifest.queries.length,
      schemaBatchLimit: 20,
      supportedDetails: ['summary', 'schemas', 'full'],
      instructions: detail === 'summary'
        ? 'Request detail "schemas" with only the operationKinds or queryKinds needed for the current task. Full discovery is available for audits.'
        : 'The manifest identity and capability states are unchanged across discovery detail levels.',
    },
  });
}

export class CadAgentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CadAgentError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new CadAgentError(code, message, details);
}

function diagnostic(error, operationIndex) {
  const code = error?.code || 'CAD_OPERATION_FAILED';
  return {
    code,
    severity: 'error',
    message: String(error?.message || error),
    ...(Number.isInteger(operationIndex) ? { operationIndex } : {}),
    ...(error?.details?.entity ? { entity: error.details.entity } : {}),
    ...(error?.details?.repairOptions ? { repairOptions: clone(error.details.repairOptions) } : {}),
    ...(error?.details?.commitApplied === true ? {
      commitApplied: true,
      revision: error.details.revision,
      ...(Number.isInteger(error.details.remainingCommits)
        ? { remainingCommits: error.details.remainingCommits }
        : {}),
      commitReceipt: clone(error.details.commitReceipt || null),
      settlementError: clone(error.details.settlementError || null),
    } : {}),
    ...(error?.details?.operationApplied === true ? {
      operationApplied: true,
      ...(error.details.historyAction ? { historyAction: error.details.historyAction } : {}),
      ...(error.details.projectId ? { projectId: error.details.projectId } : {}),
      ...(Number.isInteger(error.details.revision) ? { revision: error.details.revision } : {}),
      ...(error.details.documentHash ? { documentHash: error.details.documentHash } : {}),
      settlementError: clone(error.details.settlementError || null),
    } : {}),
  };
}

function assertRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REQUEST', path + ' must be an object.');
  return value;
}

function assertText(value, path, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail('INVALID_REQUEST', path + ' must contain 1 to ' + maximum + ' characters.');
  return value.trim();
}

function assertId(value, path) {
  const id = assertText(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) fail('INVALID_REQUEST', path + ' is not a valid stable ID.');
  return id;
}

function assertInteger(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail('INVALID_REQUEST', path + ' must be an integer from ' + minimum + ' to ' + maximum + '.');
  return value;
}

function assertFiniteOrExpression(value, path) {
  if ((typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim() && value.length <= 500)) return value;
  fail('INVALID_EXPRESSION', path + ' must be a finite number or bounded parameter expression.');
}

function assertPermission(context, required, projectId, operationKinds = []) {
  const permission = assertRecord(context, 'permissionContext');
  const granted = new Set(Array.isArray(permission.granted) ? permission.granted : []);
  for (const item of required) if (!granted.has(item)) fail('PERMISSION_DENIED', 'Permission "' + item + '" is required.');
  if (permission.expiresAt != null) {
    const expiresAt = typeof permission.expiresAt === 'string' ? Date.parse(permission.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAt)) fail('INVALID_PERMISSION_SCOPE', 'permissionContext.expiresAt must be a valid timestamp.');
    if (expiresAt <= Date.now()) fail('PERMISSION_EXPIRED', 'The CAD permission scope has expired.');
  }
  if (permission.maxCommits != null && (!Number.isInteger(permission.maxCommits) || permission.maxCommits < 0)) {
    fail('INVALID_PERMISSION_SCOPE', 'permissionContext.maxCommits must be a non-negative integer.');
  }
  if (Array.isArray(permission.projectIds) && projectId && !permission.projectIds.includes(projectId)) fail('PERMISSION_DENIED', 'The session is not allowed to access this project.');
  if (Array.isArray(permission.operationKinds)) {
    for (const kind of operationKinds) if (!permission.operationKinds.includes(kind)) fail('PERMISSION_DENIED', 'Operation "' + kind + '" is outside the session scope.');
  }
  return permission;
}

function canonicalEntityMap(project) {
  const entries = [];
  entries.push(['project', project.projectId, project]);
  for (const parameter of project.parameters || []) entries.push(['parameter', parameter.id, parameter]);
  for (const material of project.materials || []) entries.push(['material', material.id, material]);
  for (const branch of project.extensions?.pdm?.branches || []) entries.push(['pdm-branch', branch.id, branch]);
  for (const version of project.extensions?.pdm?.versions || []) entries.push(['pdm-version', version.id, version]);
  for (const sheet of project.extensions?.drawingBook?.sheets || []) entries.push(['drawing-sheet', sheet.id, sheet]);
  for (const view of project.extensions?.drawingViews?.views || []) entries.push(['drawing-view', view.id, view]);
  for (const view of project.extensions?.drawingViews?.derivedViews || []) entries.push(['drawing-derived-view', view.id, view]);
  for (const font of project.extensions?.drawingStandards?.lineFonts || []) entries.push(['drawing-line-font', font.id, font]);
  for (const style of project.extensions?.drawingStandards?.sheets || []) {
    for (const layer of style.layers || []) entries.push(['drawing-layer', `${style.sheetId}:${layer.id}`, { ...layer, sheetId: style.sheetId, profileId: style.profileId }]);
  }
  for (const block of project.extensions?.drawingAnnotations?.blocks || []) entries.push(['drawing-block', block.id, block]);
  for (const annotation of project.extensions?.drawingAnnotations?.annotations || []) entries.push(['drawing-annotation', annotation.id, annotation]);
  for (const table of project.extensions?.drawingTables?.tables || []) entries.push(['drawing-table', table.id, table]);
  for (const part of project.partDefinitions || []) {
    entries.push(['part', part.id, part]);
    for (const parameter of part.parameters || []) entries.push(['parameter', parameter.id, parameter]);
    for (const datum of part.referenceGeometry || []) entries.push(['datum', datum.id, datum]);
    for (const sketch of part.sketches || []) entries.push(['sketch', sketch.id, sketch]);
    for (const definition of part.sketchBlockDefinitions || []) entries.push(['sketch-block-definition', definition.id, definition]);
    for (const sketch of part.sketches || []) {
      for (const instance of sketch.constrained?.blockInstances || []) {
        entries.push(['sketch-block-instance', instance.id, { ...instance, sketchId: sketch.id }]);
      }
      for (const relation of sketch.constrained?.relations || []) {
        entries.push(['sketch-relation', relation.id, { ...relation, sketchId: sketch.id }]);
      }
    }
    for (const feature of part.features || []) entries.push(['feature', feature.id, feature]);
    for (const body of part.bodies || []) entries.push(['body', body.id, body]);
    for (const pattern of part.bodyPatterns || []) entries.push(['body-pattern', pattern.id, pattern]);
  }
  for (const assembly of project.assemblyDefinitions || []) {
    entries.push(['assembly', assembly.id, assembly]);
    for (const parameter of assembly.parameters || []) entries.push(['parameter', parameter.id, parameter]);
    for (const occurrence of assembly.occurrences || []) entries.push(['occurrence', occurrence.id, occurrence]);
    for (const mate of assembly.mates || []) entries.push(['mate', mate.id, mate]);
    for (const smartFastener of assembly.extensions?.smartFasteners?.groups || []) {
      entries.push(['smart-fastener', smartFastener.id, smartFastener]);
    }
    for (const assemblyFeature of assembly.extensions?.assemblyFeatures?.features || []) {
      entries.push(['assembly-feature', assemblyFeature.id, assemblyFeature]);
    }
    for (const pattern of assembly.occurrencePatterns || []) entries.push(['occurrence-pattern', pattern.id, pattern]);
    for (const section of assembly.sectionViews || []) entries.push(['section', section.id, section]);
    for (const exploded of assembly.explodedViews || []) entries.push(['exploded-view', exploded.id, exploded]);
    for (const measurement of assembly.metadata?.measurements || []) entries.push(['measurement', measurement.id, measurement]);
    for (const stage of assembly.metadata?.axialStageGroups || []) entries.push(['stage-group', stage.id, stage]);
  }
  return new Map(entries.map(([kind, id, value]) => [kind + ':' + id, { kind, id, value }]));
}

function changedEntity(entry) {
  return { kind: entry.kind, id: entry.id, name: entry.value?.name || entry.value?.title || entry.id };
}

function semanticChangeSet(before, after, aliases = {}, effects = {}) {
  const previous = canonicalEntityMap(before);
  const next = canonicalEntityMap(after);
  const created = [];
  const updated = [];
  const deleted = [];
  for (const [key, entry] of next) {
    if (!previous.has(key)) created.push(changedEntity(entry));
    else if (JSON.stringify(previous.get(key).value) !== JSON.stringify(entry.value)) updated.push(changedEntity(entry));
  }
  for (const [key, entry] of previous) if (!next.has(key)) deleted.push(changedEntity(entry));
  const previousParameters = new Map((before.parameters || []).map((entry) => [entry.id, entry]));
  const parameterDiffs = (after.parameters || []).flatMap((entry) => {
    const old = previousParameters.get(entry.id);
    return !old || old.name !== entry.name || old.value !== entry.value
      ? [{ parameter: { kind: 'parameter', id: entry.id }, before: old?.value, after: entry.value, nameBefore: old?.name, nameAfter: entry.name }]
      : [];
  });
  const beforeBodies = (before.partDefinitions || []).flatMap((part) => part.bodies || []);
  const afterBodies = (after.partDefinitions || []).flatMap((part) => part.bodies || []);
  const previousBodies = new Map(beforeBodies.map((body) => [body.id, body]));
  const visibilityDiffs = afterBodies.flatMap((body) => {
    const old = previousBodies.get(body.id);
    return old && (old.visible !== body.visible || old.suppressed !== body.suppressed)
      ? [{ body: { kind: 'body', id: body.id }, visibleBefore: old.visible, visibleAfter: body.visible, suppressedBefore: old.suppressed, suppressedAfter: body.suppressed }]
      : [];
  });
  const previousOccurrences = new Map((before.assemblyDefinitions || []).flatMap((assembly) => assembly.occurrences || []).map((entry) => [entry.id, entry]));
  const transformDiffs = (after.assemblyDefinitions || []).flatMap((assembly) => assembly.occurrences || []).flatMap((entry) => {
    const old = previousOccurrences.get(entry.id);
    return old && JSON.stringify(old.baseTransform) !== JSON.stringify(entry.baseTransform)
      ? [{ occurrence: { kind: 'occurrence', id: entry.id }, before: clone(old.baseTransform), after: clone(entry.baseTransform) }]
      : [];
  });
  return {
    created,
    updated,
    deleted,
    remapped: clone(effects.remapped || []),
    invalidated: updated.filter((entry) => entry.kind === 'feature' || entry.kind === 'body'),
    rebuilt: updated.filter((entry) => entry.kind === 'feature' || entry.kind === 'body').map((entry) => ({ entity: entry })),
    unchangedAssertions: [],
    parameterDiffs,
    transformDiffs,
    visibilityDiffs,
    aliases: clone(aliases),
    documentHashBefore: studioV5CanonicalHash(before),
    documentHashAfter: studioV5CanonicalHash(after),
  };
}

function boundedHash(value) {
  const source = JSON.stringify(value ?? null);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return 'fnv1a32:' + (hash >>> 0).toString(16).padStart(8, '0');
}

function evidenceFromKernel(response, exactGeometry) {
  return {
    exactGeometry: Boolean(exactGeometry),
    bodyResults: (response?.bodies || []).map((body) => ({
      body: { kind: 'body', id: body.bodyId, name: body.bodyName },
      sourceBodyId: body.sourceBodyId || body.bodyId,
      occurrenceInstance: clone(body.occurrenceInstance || null),
      visible: body.visible !== false,
      suppressed: body.suppressed === true,
      valid: body.geometry?.valid === true && !body.error,
      solids: body.geometry?.solidCount || 0,
      shells: body.geometry?.shellCount || 0,
      faces: body.geometry?.faceCount || 0,
      edges: body.geometry?.edgeCount || 0,
      ...(Number.isFinite(body.geometry?.volume) ? { volume: body.geometry.volume } : {}),
      ...(body.geometry?.bounds ? { boundingBox: body.geometry.bounds } : {}),
      geometryHash: body.geometry?.hash || body.geometry?.geometryHash || boundedHash({
        valid: body.geometry?.valid,
        solidCount: body.geometry?.solidCount,
        shellCount: body.geometry?.shellCount,
        faceCount: body.geometry?.faceCount,
        edgeCount: body.geometry?.edgeCount,
        volume: body.geometry?.volume,
        bounds: body.geometry?.bounds,
      }),
    })),
    warnings: [
      ...(response?.warnings || []).map((entry) => entry.message),
      ...(response?.errors || []).filter((entry) => entry.severity === 'warning').map((entry) => entry.message),
    ],
  };
}

function findFeature(project, featureId) {
  const feature = studioV5RootPart(project).features.find((entry) => entry.id === featureId);
  if (!feature) fail('MISSING_REFERENCE', 'Feature "' + featureId + '" does not exist.', { entity: { kind: 'feature', id: featureId } });
  return feature;
}

function findBody(project, bodyId) {
  const body = studioV5RootPart(project).bodies.find((entry) => entry.id === bodyId);
  if (!body) fail('MISSING_REFERENCE', 'Body "' + bodyId + '" does not exist.', { entity: { kind: 'body', id: bodyId } });
  return body;
}

function findParameter(project, parameterId) {
  const parameter = project.parameters.find((entry) => entry.id === parameterId);
  if (!parameter) fail('MISSING_REFERENCE', 'Parameter "' + parameterId + '" does not exist.', { entity: { kind: 'parameter', id: parameterId } });
  return parameter;
}

function replaceFeature(project, nextFeature) {
  return configureStudioV5Feature(project, nextFeature, {
    resultPolicy: nextFeature.resultPolicy,
    bodyName: nextFeature.resultPolicy?.bodyName,
  });
}

function deleteFeature(project, featureId) {
  const candidate = canonicalStudioV5Project(project);
  const part = studioV5RootPart(candidate);
  const feature = part.features.find((entry) => entry.id === featureId);
  if (feature?.extensions?.structuralMember) return deleteStudioStructuralMember(candidate, featureId);
  if (feature?.extensions?.weldmentTreatment) return deleteStudioWeldmentTreatment(candidate, featureId);
  if (feature?.extensions?.weldBead) return deleteStudioWeldBead(candidate, featureId);
  if (feature?.extensions?.sheetMetal) return deleteStudioSheetMetalFeature(candidate, featureId);
  if (feature?.type === 'direct-edit') {
    fail('INVALID_OPERATION', 'Direct edits must be deleted through directEdit.delete.');
  }
  const createdBody = part.bodies.find((body) => body.createdByFeatureId === featureId);
  if (createdBody) return deleteStudioV5Body(candidate, createdBody.id);
  if (!feature) fail('MISSING_REFERENCE', 'Feature "' + featureId + '" does not exist.');
  part.features = part.features.filter((entry) => entry.id !== featureId);
  return prepareStudioV5RuntimeProject(candidate);
}

function resolveReference(value, aliases, path) {
  if (value && typeof value === 'object' && typeof value.alias === 'string') {
    const resolved = aliases[value.alias];
    if (!resolved) fail('MISSING_ALIAS', path + ' references unknown transaction alias "' + value.alias + '".');
    return resolved.id;
  }
  return assertId(value, path);
}

function resolveOptionalReference(value, aliases, path) {
  return value == null ? value : resolveReference(value, aliases, path);
}

function resolveReferenceArray(values, aliases, path) {
  if (!Array.isArray(values)) fail('INVALID_REQUEST', path + ' must be an array.');
  return values.map((value, index) => resolveReference(value, aliases, path + '[' + index + ']'));
}

function resolveDefinition(definition, aliases, path) {
  const value = assertRecord(definition, path);
  if (value.kind === 'part') return { kind: 'part', partId: resolveReference(value.partId, aliases, path + '.partId') };
  if (value.kind === 'assembly') return { kind: 'assembly', assemblyId: resolveReference(value.assemblyId, aliases, path + '.assemblyId') };
  fail('INVALID_REQUEST', path + '.kind must be "part" or "assembly".');
}

function validatedFeaturePattern(value, path) {
  const pattern = assertRecord(value, path);
  const linear = pattern.kind === 'linear';
  const circular = pattern.kind === 'circular';
  if (!linear && !circular) {
    fail('INVALID_REQUEST', path + '.kind must be "linear" or "circular".');
  }
  const allowed = new Set(linear
    ? ['kind', 'n', 'dx', 'dy']
    : ['kind', 'n', 'cx', 'cy']);
  const unexpected = Object.keys(pattern).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    fail('INVALID_REQUEST', path + ' contains unsupported fields: ' + unexpected.join(', ') + '.');
  }
  const normalized = {
    kind: pattern.kind,
    n: assertFiniteOrExpression(pattern.n, path + '.n'),
  };
  if (linear) {
    return {
      ...normalized,
      dx: assertFiniteOrExpression(pattern.dx, path + '.dx'),
      dy: assertFiniteOrExpression(pattern.dy, path + '.dy'),
    };
  }
  return {
    ...normalized,
    cx: assertFiniteOrExpression(pattern.cx, path + '.cx'),
    cy: assertFiniteOrExpression(pattern.cy, path + '.cy'),
  };
}

function nextStableId(project, prefix) {
  const used = new Set(canonicalEntityMap(project).values());
  const usedIds = new Set([...used].map((entry) => entry.id));
  let index = 1;
  while (usedIds.has(prefix + '-' + index)) index++;
  return prefix + '-' + index;
}

function featureFromOperation(project, kind, input, aliases) {
  const type = kind.slice('feature.'.length);
  if (type === 'revolve' && input.sketchId !== undefined) {
    fail(
      'UNSUPPORTED_FIRST_CLASS_SKETCH_CONSUMER',
      'First-class constrained sketches currently support linked Extrude and Cut only; linked Revolve is unsupported.',
    );
  }
  const id = input.id ? assertId(input.id, 'operation.input.id') : nextStableId(project, 'feature-' + type);
  const activeBody = studioV5ActiveBody(project);
  const defaultPolicy = activeBody
    ? type === 'cut'
      ? { kind: 'subtract', targetBodyIds: [activeBody.id], keepTools: false }
      : { kind: 'add', targetBodyIds: [activeBody.id] }
    : { kind: 'new-body', bodyName: input.bodyName || 'Body ' + (studioV5RootPart(project).bodies.length + 1) };
  const resultPolicy = clone(Object.prototype.hasOwnProperty.call(input, 'resultPolicy') ? input.resultPolicy : defaultPolicy);
  if (!resultPolicy || typeof resultPolicy !== 'object' || Array.isArray(resultPolicy)) fail('INVALID_REQUEST', 'operation.input.resultPolicy must be an object.');
  if (Array.isArray(resultPolicy.targetBodyIds)) {
    resultPolicy.targetBodyIds = resultPolicy.targetBodyIds.map((bodyId, index) => resolveReference(bodyId, aliases, 'operation.input.resultPolicy.targetBodyIds[' + index + ']'));
  }
  if (
    type === 'cut'
    && (
      resultPolicy.kind !== 'subtract'
      || resultPolicy.targetBodyIds?.length !== 1
    )
  ) {
    fail('INVALID_REQUEST', 'A Cut must subtract from exactly one existing target body.');
  }
  const inputRefsSource = Object.prototype.hasOwnProperty.call(input, 'inputRefs') ? input.inputRefs : [];
  if (!Array.isArray(inputRefsSource)) fail('INVALID_REQUEST', 'operation.input.inputRefs must be an array.');
  const inputRefs = clone(inputRefsSource).map((reference, index) => {
    if (reference?.ownerId && typeof reference.ownerId === 'object') {
      return { ...reference, ownerId: resolveReference(reference.ownerId, aliases, 'operation.input.inputRefs[' + index + '].ownerId') };
    }
    return reference;
  });
  const base = {
    id,
    name: input.name || type[0].toUpperCase() + type.slice(1),
    type,
    suppressed: false,
    inputRefs,
    resultPolicy,
    ...(Object.prototype.hasOwnProperty.call(input, 'onFace') ? { onFace: clone(input.onFace) } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'pattern') ? { pattern: validatedFeaturePattern(input.pattern, 'operation.input.pattern') } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'extensions') ? { extensions: clone(input.extensions) } : {}),
  };
  if (type === 'extrude' || type === 'cut' || type === 'revolve') {
    if (input.sketch !== undefined && input.sketchId !== undefined) {
      fail('INVALID_REQUEST', 'Choose either an inline sketch or sketchId, not both.');
    }
    if (input.sketchId !== undefined) {
      if (input.onFace !== undefined) {
        fail('INVALID_REQUEST', 'A first-class constrained sketch uses its authored base-plane support and cannot also use onFace.');
      }
      const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
      const sketch = studioV5RootPart(project).sketches.find((entry) => entry.id === sketchId);
      if (!sketch || sketch.extensions?.studioRole !== 'constrained-2d') {
        fail('MISSING_REFERENCE', 'operation.input.sketchId must resolve to a first-class constrained sketch.');
      }
      const plane = input.plane || sketch.plane;
      if (plane !== sketch.plane) fail('INVALID_REQUEST', 'operation.input.plane must match the linked sketch support.');
      base.sketchId = sketch.id;
      base.plane = { kind: 'base', plane };
      base.inputRefs = [
        ...base.inputRefs.filter((reference) => reference.ownerKind !== 'sketch' || reference.ownerId !== sketch.id),
        { ownerKind: 'sketch', ownerId: sketch.id, semanticPath: { role: 'profile' }, signature: { role: 'profile' } },
      ];
      base.extensions = { ...(base.extensions || {}), exactSketchEntities: true };
    } else {
      assertRecord(input.sketch, 'operation.input.sketch');
      base.sketch = clone(input.sketch);
    }
  }
  if (type === 'extrude' || type === 'cut') {
    const depthSource = Object.prototype.hasOwnProperty.call(input, 'height')
      ? input.height
      : Object.prototype.hasOwnProperty.call(input, 'h')
        ? input.h
        : 20;
    base.h = assertFiniteOrExpression(depthSource, 'operation.input.height');
    if (Object.prototype.hasOwnProperty.call(input, 'through') && typeof input.through !== 'boolean') fail('INVALID_REQUEST', 'operation.input.through must be true or false.');
    base.through = type === 'cut' ? (input.through ?? false) : false;
  } else if (type === 'fillet' || type === 'chamfer') {
    base.r = assertFiniteOrExpression(
      Object.prototype.hasOwnProperty.call(input, 'radius') ? input.radius : input.r,
      'operation.input.radius',
    );
    if (input.edges !== undefined && !Array.isArray(input.edges)) fail('INVALID_REQUEST', 'operation.input.edges must be an array.');
    base.edges = clone(input.edges ?? []);
    if (type === 'fillet' && Object.prototype.hasOwnProperty.call(input, 'tangentPropagation')) {
      if (typeof input.tangentPropagation !== 'boolean') fail('INVALID_REQUEST', 'operation.input.tangentPropagation must be a boolean.');
      base.tangentPropagation = input.tangentPropagation;
      setStudioExactTangentFilletPolicy(base, input.tangentPropagation);
    }
  } else if (type === 'shell') {
    base.t = assertFiniteOrExpression(
      Object.prototype.hasOwnProperty.call(input, 'thickness') ? input.thickness : input.t,
      'operation.input.thickness',
    );
    if (input.faces !== undefined && !Array.isArray(input.faces)) fail('INVALID_REQUEST', 'operation.input.faces must be an array.');
    base.faces = clone(input.faces ?? []);
  }
  return base;
}

// --- constrained sketches --------------------------------------------------
// A feature sketch may carry `constrained: { entities, constraints }` as its
// source of truth. After every operation the constrained form is re-solved
// against the current parameters and the solved geometry is written back as
// exact line/arc/circle entities (the kernel's exactSketchEntities path) plus
// an approximate polygon form for inline-profile rendering. Parameter edits therefore
// re-solve dependent sketches automatically.

function exactEntitiesFromConstrainedLoops(loops) {
  const entities = [];
  let sequence = 0;
  for (const loop of loops) {
    if (loop.kind === 'circle') {
      entities.push({ id: 'cs-circle-' + (++sequence), kind: 'circle', center: [loop.center[0], loop.center[1]], radius: loop.r });
      continue;
    }
    for (const segment of loop.segments) {
      if (segment.kind === 'line') {
        entities.push({ id: 'cs-line-' + (++sequence), kind: 'line', a: [segment.a[0], segment.a[1]], b: [segment.b[0], segment.b[1]] });
      } else if (segment.kind === 'spline') {
        entities.push({ id: 'cs-spline-' + (++sequence), kind: 'spline', through: segment.through.map((p) => [p[0], p[1]]) });
      } else {
        entities.push({
          id: 'cs-arc-' + (++sequence), kind: 'arc',
          start: [segment.a[0], segment.a[1]], end: [segment.b[0], segment.b[1]],
          center: [segment.center[0], segment.center[1]],
          clockwise: segment.ccw === false,
        });
      }
    }
  }
  return entities;
}

function approximateShapesFromConstrainedLoops(loops) {
  const shapes = [];
  for (const loop of loops) {
    if (loop.kind === 'circle') {
      shapes.push({ kind: 'circle', x: loop.center[0], y: loop.center[1], r: loop.r });
      continue;
    }
    const pts = [];
    for (const segment of loop.segments) {
      if (!pts.length) pts.push([segment.a[0], segment.a[1]]);
      if (segment.kind === 'line') { pts.push([segment.b[0], segment.b[1]]); continue; }
      if (segment.kind === 'spline') {
        for (const p of sampleSplineThrough(segment.through, 12).slice(1)) pts.push(p);
        continue;
      }
      const [cx, cy] = segment.center;
      const start = Math.atan2(segment.a[1] - cy, segment.a[0] - cx);
      const end = Math.atan2(segment.b[1] - cy, segment.b[0] - cx);
      let delta = end - start;
      if (segment.ccw === false) { while (delta >= 0) delta -= Math.PI * 2; }
      else { while (delta <= 0) delta += Math.PI * 2; }
      const radius = Math.hypot(segment.a[0] - cx, segment.a[1] - cy);
      const steps = 32;
      for (let index = 1; index <= steps; index++) {
        const angle = start + (delta * index) / steps;
        pts.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
      }
    }
    if (pts.length > 1) {
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (Math.abs(first[0] - last[0]) <= 1e-9 && Math.abs(first[1] - last[1]) <= 1e-9) pts.pop();
    }
    shapes.push({ kind: 'poly', pts, closed: true });
  }
  return shapes;
}

function refreshConstrainedSketches(project) {
  for (const part of project.partDefinitions || []) {
    let parameters = null;
    for (const feature of part.features || []) {
      const constrained = feature.sketch?.constrained;
      if (!constrained) continue;
      if (!constrained || typeof constrained !== 'object' || Array.isArray(constrained)) {
        fail('SKETCH_CONSTRAINTS_INVALID', 'Feature "' + feature.id + '" constrained sketch must be an object.', { featureId: feature.id });
      }
      for (const field of Object.keys(constrained)) {
        if (!['entities', 'constraints'].includes(field)) {
          fail(
            'SKETCH_CONSTRAINTS_INVALID',
            'Feature "' + feature.id + '" inline constrained sketch contains unsupported field "' + field + '".',
            { featureId: feature.id, field },
          );
        }
      }
      if (!parameters) {
        try {
          parameters = studioV5ParameterValues(project, part);
        } catch (error) {
          fail('SKETCH_PARAMETERS_INVALID', String(error?.message || error), { featureId: feature.id });
        }
      }
      const resolveDimension = (value) => evaluateStudioV5Expression(value, parameters);
      const resolvePierce = createStudioV5PierceResolver(project, part.id);
      const structural = validateConstraintSketch(constrained);
      if (structural.length) {
        fail('SKETCH_CONSTRAINTS_INVALID', 'Feature "' + feature.id + '" has an invalid constrained sketch: ' + structural[0].message, { featureId: feature.id, diagnostics: structural });
      }
      const solved = solveSketch(constrained, { resolveDimension, resolvePierce });
      if (solved.status !== 'ok') {
        fail('SKETCH_CONSTRAINTS_UNSOLVED', 'Feature "' + feature.id + '" sketch did not solve: ' + (solved.diagnostics[0]?.message || solved.status), { featureId: feature.id, diagnostics: solved.diagnostics });
      }
      const loopResult = constraintSketchToLoops(constrained, { presolved: solved });
      if (loopResult.status !== 'ok') {
        fail('SKETCH_PROFILE_OPEN', 'Feature "' + feature.id + '" constrained sketch does not form closed profiles: ' + (loopResult.diagnostics[0]?.message || ''), { featureId: feature.id, diagnostics: loopResult.diagnostics });
      }
      feature.sketch.entities = exactEntitiesFromConstrainedLoops(loopResult.loops);
      feature.sketch.shapes = approximateShapesFromConstrainedLoops(loopResult.loops);
      feature.sketch.solver = {
        dof: solved.dof,
        fullyDefined: solved.dof === 0,
        ...(solved.diagnostics.length ? { diagnostics: solved.diagnostics } : {}),
      };
      feature.extensions = { ...(feature.extensions || {}), exactSketchEntities: true };
    }
  }
  return project;
}

function assertNoDerivedDrawingViewsForAssemblyRoot(project) {
  const viewIds = (project.extensions?.drawingViews?.derivedViews || []).map((entry) => entry.id);
  if (viewIds.length) {
    fail('DRAWING_DERIVED_VIEW_PART_REQUIRED', 'Delete part-only derived drawing views before activating or creating an assembly root.', {
      derivedViewIds: viewIds,
    });
  }
}

function applyOperation(project, operation, aliases, effects) {
  const op = assertRecord(operation, 'operation');
  const kind = assertText(op.kind, 'operation.kind');
  if (!AVAILABLE_OPERATION_KINDS.includes(kind)) {
    const reason = DISABLED_OPERATION_REASONS[kind];
    if (reason) fail('CAPABILITY_DISABLED', 'Operation "' + kind + '" is not available in this runtime.', { repairOptions: [{ kind: 'inspect-capabilities', capability: kind, reasonCode: reason }] });
    fail('UNKNOWN_OPERATION', 'Unknown CAD operation "' + kind + '".');
  }
  const input = assertRecord(op.input || {}, 'operation.input');
  const sketchReuseFields = SKETCH_REUSE_OPERATION_INPUT_FIELDS[kind];
  if (sketchReuseFields) {
    for (const key of Object.keys(input)) {
      if (!sketchReuseFields.includes(key)) {
        fail('INVALID_REQUEST', 'operation.input contains unsupported field "' + key + '".');
      }
    }
  }
  let candidate = canonicalStudioV5Project(project);
  let resultRef = null;

  if (kind === 'drawing.block.create') {
    candidate = createStudioDrawingBlock(candidate, clone(input));
    const block = inspectStudioDrawingAnnotations(candidate).blocks.find((entry) => entry.name === input.name.trim());
    resultRef = { kind: 'drawing-block', id: block.id, name: block.name };
  } else if (kind === 'drawing.block.update') {
    candidate = updateStudioDrawingBlock(candidate, clone(input));
    const block = inspectStudioDrawingAnnotations(candidate).blocks.find((entry) => entry.id === input.blockId);
    resultRef = { kind: 'drawing-block', id: block.id, name: block.name };
  } else if (kind === 'drawing.block.delete') {
    candidate = deleteStudioDrawingBlock(candidate, input.blockId);
  } else if (kind === 'drawing.annotation.create') {
    candidate = createStudioDrawingAnnotation(candidate, clone(input));
    const graph = inspectStudioDrawingAnnotations(candidate);
    const annotation = graph.annotations.at(-1);
    resultRef = { kind: 'drawing-annotation', id: annotation.id, name: annotation.kind };
  } else if (kind === 'drawing.annotation.update') {
    candidate = updateStudioDrawingAnnotation(candidate, clone(input));
    const annotation = inspectStudioDrawingAnnotations(candidate).annotations.find((entry) => entry.id === input.annotationId);
    resultRef = { kind: 'drawing-annotation', id: annotation.id, name: annotation.kind };
  } else if (kind === 'drawing.annotation.delete') {
    candidate = deleteStudioDrawingAnnotation(candidate, input.annotationId);
  } else if (kind === 'drawing.table.create') {
    candidate = createStudioDrawingTable(candidate, clone(input));
    const graph = inspectStudioDrawingTables(candidate);
    const table = graph.tables.at(-1);
    resultRef = { kind: 'drawing-table', id: table.id, name: table.name };
  } else if (kind === 'drawing.table.update') {
    candidate = updateStudioDrawingTable(candidate, clone(input));
    const table = inspectStudioDrawingTables(candidate).tables.find((entry) => entry.id === input.tableId);
    resultRef = { kind: 'drawing-table', id: table.id, name: table.name };
  } else if (kind === 'drawing.table.delete') {
    candidate = deleteStudioDrawingTable(candidate, input.tableId);
  } else if (kind === 'drawing.standard.apply') {
    candidate = applyStudioDrawingStandardProfile(candidate, clone(input));
    resultRef = { kind: 'drawing-standard', id: input.sheetId, name: input.profileId };
  } else if (kind === 'drawing.lineFont.create') {
    candidate = createStudioDrawingLineFont(candidate, clone(input));
    const font = inspectStudioDrawingStandards(candidate).lineFonts.find((entry) => entry.name === input.name.trim());
    resultRef = { kind: 'drawing-line-font', id: font.id, name: font.name };
  } else if (kind === 'drawing.lineFont.update') {
    candidate = updateStudioDrawingLineFont(candidate, clone(input));
    const font = inspectStudioDrawingStandards(candidate).lineFonts.find((entry) => entry.id === input.lineFontId);
    resultRef = { kind: 'drawing-line-font', id: font.id, name: font.name };
  } else if (kind === 'drawing.lineFont.delete') {
    candidate = deleteStudioDrawingLineFont(candidate, input.lineFontId);
  } else if (kind === 'drawing.layer.update') {
    candidate = updateStudioDrawingLayer(candidate, clone(input));
    resultRef = { kind: 'drawing-layer', id: `${input.sheetId}:${input.layerId}`, name: input.layerId };
  } else if (kind === 'drawing.view.create') {
    candidate = createStudioNamedDrawingView(candidate, clone(input));
    const view = inspectStudioDrawingViews(candidate).views.find((entry) => entry.name === input.name.trim());
    resultRef = { kind: 'drawing-view', id: view.id, name: view.name };
  } else if (kind === 'drawing.view.update') {
    candidate = updateStudioNamedDrawingView(candidate, clone(input));
    const view = inspectStudioDrawingViews(candidate).views.find((entry) => entry.id === input.viewId);
    resultRef = { kind: 'drawing-view', id: view.id, name: view.name };
  } else if (kind === 'drawing.view.delete') {
    candidate = deleteStudioNamedDrawingView(candidate, input.viewId);
  } else if (kind === 'drawing.derivedView.create') {
    candidate = createStudioDerivedDrawingView(candidate, clone(input));
    const view = inspectStudioDrawingViews(candidate).derivedViews.find((entry) => entry.name === input.name.trim());
    resultRef = { kind: 'drawing-derived-view', id: view.id, name: view.name };
  } else if (kind === 'drawing.derivedView.update') {
    candidate = updateStudioDerivedDrawingView(candidate, clone(input));
    const view = inspectStudioDrawingViews(candidate).derivedViews.find((entry) => entry.id === input.viewId);
    resultRef = { kind: 'drawing-derived-view', id: view.id, name: view.name };
  } else if (kind === 'drawing.derivedView.delete') {
    candidate = deleteStudioDerivedDrawingView(candidate, input.viewId);
  } else if (kind === 'drawing.book.initialize') {
    candidate = initializeStudioDrawingBook(candidate, clone(input));
    const book = inspectStudioDrawingBook(candidate);
    const sheet = book.sheets.find((entry) => entry.id === book.activeSheetId);
    resultRef = { kind: 'drawing-sheet', id: sheet.id, name: sheet.name };
  } else if (kind === 'drawing.sheet.create') {
    candidate = createStudioDrawingSheet(candidate, clone(input));
    const book = inspectStudioDrawingBook(candidate);
    const sheet = book.sheets.find((entry) => entry.name === input.name.trim());
    resultRef = { kind: 'drawing-sheet', id: sheet.id, name: sheet.name };
  } else if (kind === 'drawing.sheet.update') {
    candidate = updateStudioDrawingSheet(candidate, clone(input));
    const sheet = inspectStudioDrawingBook(candidate).sheets.find((entry) => entry.id === input.sheetId);
    resultRef = { kind: 'drawing-sheet', id: sheet.id, name: sheet.name };
  } else if (kind === 'drawing.sheet.delete') {
    candidate = deleteStudioDrawingSheet(candidate, input.sheetId);
  } else if (kind === 'drawing.sheet.activate') {
    candidate = activateStudioDrawingSheet(candidate, input.sheetId);
    const sheet = inspectStudioDrawingBook(candidate).sheets.find((entry) => entry.id === input.sheetId);
    resultRef = { kind: 'drawing-sheet', id: sheet.id, name: sheet.name };
  } else if (kind === 'drawing.sheet.reorder') {
    candidate = reorderStudioDrawingSheets(candidate, clone(input.orderedSheetIds));
  } else if (kind === 'pdm.initialize') {
    candidate = initializeStudioPdm(candidate, clone(input));
    const graph = inspectStudioPdm(candidate);
    const branch = graph.branches.find((entry) => entry.id === graph.activeBranchId);
    resultRef = { kind: 'pdm-version', id: branch.headVersionId, name: branch.headVersionId };
  } else if (kind === 'pdm.version.create') {
    candidate = createStudioPdmVersion(candidate, clone(input));
    const graph = inspectStudioPdm(candidate);
    const branch = graph.branches.find((entry) => entry.id === graph.activeBranchId);
    resultRef = { kind: 'pdm-version', id: branch.headVersionId, name: branch.headVersionId };
  } else if (kind === 'pdm.branch.create') {
    candidate = createStudioPdmBranch(candidate, clone(input));
    const branch = inspectStudioPdm(candidate).branches.find((entry) => entry.name === input.name.trim());
    resultRef = { kind: 'pdm-branch', id: branch.id, name: branch.name };
  } else if (kind === 'pdm.branch.checkout') {
    candidate = checkoutStudioPdmBranch(candidate, input.branchId);
    const branch = inspectStudioPdm(candidate).branches.find((entry) => entry.id === input.branchId);
    resultRef = { kind: 'pdm-branch', id: branch.id, name: branch.name };
  } else if (kind === 'pdm.review.submit') {
    candidate = submitStudioPdmReview(candidate, clone(input));
    resultRef = { kind: 'pdm-version', id: input.versionId, name: input.versionId };
  } else if (kind === 'pdm.approval.record') {
    candidate = recordStudioPdmApproval(candidate, clone(input));
    resultRef = { kind: 'pdm-version', id: input.versionId, name: input.versionId };
  } else if (kind === 'pdm.review.return') {
    candidate = returnStudioPdmForChanges(candidate, clone(input));
    resultRef = { kind: 'pdm-version', id: input.versionId, name: input.versionId };
  } else if (kind === 'pdm.version.release') {
    candidate = releaseStudioPdmVersion(candidate, clone(input));
    resultRef = { kind: 'pdm-version', id: input.versionId, name: input.versionId };
  } else if (kind === 'pdm.version.obsolete') {
    candidate = obsoleteStudioPdmVersion(candidate, clone(input));
    resultRef = { kind: 'pdm-version', id: input.versionId, name: input.versionId };
  } else if (kind === 'project.rename') {
    const name = assertText(input.name, 'operation.input.name');
    candidate.name = name;
    if (candidate.rootDocument.kind === 'part') studioV5RootPart(candidate).name = name;
    else studioV5RootAssembly(candidate).name = name;
  } else if (kind === 'project.setUnits') {
    if (input.units !== 'mm' && input.units !== 'in') fail('INVALID_UNITS', 'Project units must be "mm" or "in".');
    candidate.units = input.units;
  } else if (kind === 'project.clear') {
    const cleared = createEmptyStudioV5PartProject({
      projectId: candidate.projectId,
      name: candidate.name,
      units: candidate.units,
    });
    cleared.materials = clone(candidate.materials || []);
    cleared.resources = clone(candidate.resources || []);
    if (candidate.extensions) cleared.extensions = clone(candidate.extensions);
    candidate = cleared;
  } else if (kind === 'parameter.create') {
    const parameter = {
      id: input.id ? assertId(input.id, 'operation.input.id') : nextStableId(candidate, 'parameter'),
      name: assertText(input.name, 'operation.input.name'),
      value: assertFiniteOrExpression(input.value, 'operation.input.value'),
      ...(input.description ? { description: String(input.description).slice(0, 2000) } : {}),
    };
    candidate.parameters.push(parameter);
    resultRef = { kind: 'parameter', id: parameter.id, name: parameter.name };
  } else if (kind === 'parameter.update') {
    const parameterId = input.parameterId
      ? resolveReference(input.parameterId, aliases, 'operation.input.parameterId')
      : candidate.parameters.find((entry) => entry.name === input.parameterName)?.id;
    if (!parameterId) fail('MISSING_REFERENCE', 'The requested parameter does not exist.');
    const parameter = findParameter(candidate, parameterId);
    if (input.name != null) parameter.name = assertText(input.name, 'operation.input.name');
    if (input.value != null) parameter.value = assertFiniteOrExpression(input.value, 'operation.input.value');
    if (input.description != null) parameter.description = String(input.description).slice(0, 2000);
    resultRef = { kind: 'parameter', id: parameter.id, name: parameter.name };
  } else if (kind === 'parameter.delete') {
    const parameterId = input.parameterId
      ? resolveReference(input.parameterId, aliases, 'operation.input.parameterId')
      : candidate.parameters.find((entry) => entry.name === input.parameterName)?.id;
    if (!parameterId) fail('MISSING_REFERENCE', 'The requested parameter does not exist.');
    findParameter(candidate, parameterId);
    candidate.parameters = candidate.parameters.filter((entry) => entry.id !== parameterId);
  } else if (kind === 'configuration.activate') {
    const partId = input.partId
      ? resolveReference(input.partId, aliases, 'operation.input.partId')
      : studioV5RootPart(candidate).id;
    const configurationId = assertId(input.configurationId, 'operation.input.configurationId');
    const switched = switchStudioV5PartConfiguration(candidate, partId, configurationId);
    candidate = switched.project;
    const configurationSet = candidate.partConfigurationSets.find((entry) => entry.partId === partId);
    const configuration = configurationSet?.configurations.find((entry) => entry.id === configurationId);
    resultRef = { kind: 'configuration', id: configurationId, name: configuration?.name || configurationId };
  } else if (kind === 'datum.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5Datum(candidate, { id, name: input.name, kind: input.datumKind, definition: clone(input.definition) });
    resultRef = { kind: 'datum', id, name: input.name };
  } else if (kind === 'datum.update') {
    const datumId = resolveReference(input.datumId, aliases, 'operation.input.datumId');
    candidate = updateStudioV5Datum(candidate, datumId, clone(input.patch));
    resultRef = { kind: 'datum', id: datumId };
  } else if (kind === 'datum.delete') {
    candidate = deleteStudioV5Datum(candidate, resolveReference(input.datumId, aliases, 'operation.input.datumId'));
  } else if (kind === 'sketch.profile.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5ProfileSketch(candidate, {
      id, name: input.name, planeDatumId: resolveReference(input.planeDatumId, aliases, 'operation.input.planeDatumId'),
      points: clone(input.points), kind: input.curveKind,
    });
    resultRef = { kind: 'sketch', id, name: input.name };
  } else if (kind === 'sketch.path.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5PathSketch(candidate, { id, name: input.name, points: clone(input.points), kind: input.curveKind });
    resultRef = { kind: 'sketch', id, name: input.name };
  } else if (kind === 'sketch.reference.create') {
    const id = assertId(input.id, 'operation.input.id');
    const definition = clone(input.definition);
    for (const key of ['sourceSketchId', 'planeDatumId', 'axisDatumId']) {
      if (definition[key] != null) definition[key] = resolveReference(definition[key], aliases, 'operation.input.definition.' + key);
    }
    if (definition.sourceSketchIds != null) {
      definition.sourceSketchIds = resolveReferenceArray(definition.sourceSketchIds, aliases, 'operation.input.definition.sourceSketchIds');
    }
    candidate = createStudioV5ReferenceCurve(candidate, { id, name: input.name, definition });
    resultRef = { kind: 'sketch', id, name: input.name };
  } else if (kind === 'sketch.reference.update') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    const patch = clone(input.patch);
    if (patch.definition) {
      for (const key of ['sourceSketchId', 'planeDatumId', 'axisDatumId']) {
        if (patch.definition[key] != null) patch.definition[key] = resolveReference(patch.definition[key], aliases, 'operation.input.patch.definition.' + key);
      }
      if (patch.definition.sourceSketchIds != null) {
        patch.definition.sourceSketchIds = resolveReferenceArray(patch.definition.sourceSketchIds, aliases, 'operation.input.patch.definition.sourceSketchIds');
      }
    }
    candidate = updateStudioV5ReferenceCurve(candidate, sketchId, patch);
    resultRef = { kind: 'sketch', id: sketchId };
  } else if (kind === 'sketch.advanced.update') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    candidate = updateStudioV5AdvancedSketch(candidate, sketchId, clone(input.patch));
    resultRef = { kind: 'sketch', id: sketchId };
  } else if (kind === 'sketch.advanced.delete') {
    candidate = deleteStudioV5AdvancedSketch(candidate, resolveReference(input.sketchId, aliases, 'operation.input.sketchId'));
  } else if (kind === 'sketch.constrained.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5ConstrainedSketch(candidate, {
      id, name: input.name, plane: input.plane || 'XY', z: input.z ?? 0, constrained: clone(input.constrained),
    });
    resultRef = { kind: 'sketch', id, name: input.name };
  } else if (kind === 'sketch.importDxf') {
    const id = assertId(input.id, 'operation.input.id');
    if (typeof input.dxfText !== 'string' || !input.dxfText.length || input.dxfText.length > STUDIO_DXF_IMPORT_MAX_BYTES) {
      fail('INVALID_REQUEST', 'operation.input.dxfText must be DXF R12 ASCII text within ' + STUDIO_DXF_IMPORT_MAX_BYTES + ' bytes.');
    }
    let imported;
    try {
      imported = importStudioSketchDxf(input.dxfText);
    } catch (error) {
      fail(error?.code || 'DXF_IMPORT_INVALID', 'DXF sketch import failed: ' + String(error?.message || error));
    }
    candidate = createStudioV5ConstrainedSketch(candidate, {
      id, name: input.name, plane: input.plane || 'XY', z: input.z ?? 0, constrained: imported.constrained,
    });
    resultRef = { kind: 'sketch', id, name: input.name };
  } else if (kind === 'sketch.constrained.promote') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    const id = assertId(input.id, 'operation.input.id');
    candidate = promoteStudioV5InlineConstrainedSketch(candidate, featureId, {
      id, name: input.name, plane: input.plane,
    });
    resultRef = { kind: 'sketch', id, name: input.name };
  } else if (kind === 'sketch.constrained.update') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    candidate = updateStudioV5ConstrainedSketch(candidate, sketchId, clone(input.patch));
    resultRef = { kind: 'sketch', id: sketchId };
  } else if (kind === 'sketch.constrained.delete') {
    candidate = deleteStudioV5ConstrainedSketch(candidate, resolveReference(input.sketchId, aliases, 'operation.input.sketchId'));
  } else if (kind === 'sketch.blockDefinition.create') {
    const id = assertId(input.id, 'operation.input.id');
    const sourceSketchId = input.sourceSketchId === undefined
      ? undefined
      : resolveReference(input.sourceSketchId, aliases, 'operation.input.sourceSketchId');
    candidate = createStudioV5SketchBlockDefinition(candidate, {
      id, name: input.name, insertionPoint: clone(input.insertionPoint), sourceSketchId,
      memberEntityIds: clone(input.memberEntityIds), constrained: clone(input.constrained),
    });
    resultRef = { kind: 'sketch-block-definition', id, name: input.name };
  } else if (kind === 'sketch.blockDefinition.update') {
    const definitionId = resolveReference(input.definitionId, aliases, 'operation.input.definitionId');
    candidate = updateStudioV5SketchBlockDefinition(candidate, definitionId, clone(input.patch));
    resultRef = { kind: 'sketch-block-definition', id: definitionId };
  } else if (kind === 'sketch.blockDefinition.delete') {
    candidate = deleteStudioV5SketchBlockDefinition(candidate, resolveReference(input.definitionId, aliases, 'operation.input.definitionId'));
  } else if (kind === 'sketch.blockInstance.create') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    const definitionId = resolveReference(input.definitionId, aliases, 'operation.input.definitionId');
    const instanceId = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5SketchBlockInstance(candidate, sketchId, {
      id: instanceId, definitionId, transform: clone(input.transform),
      fixed: input.fixed === true, relations: clone(input.relations || []),
    });
    resultRef = { kind: 'sketch-block-instance', id: instanceId, name: instanceId };
  } else if (kind === 'sketch.blockInstance.update') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    const instanceId = resolveReference(input.instanceId, aliases, 'operation.input.instanceId');
    const patch = clone(input.patch);
    candidate = updateStudioV5SketchBlockInstance(candidate, sketchId, instanceId, patch);
    resultRef = { kind: 'sketch-block-instance', id: instanceId };
  } else if (kind === 'sketch.blockInstance.delete') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    const instanceId = resolveReference(input.instanceId, aliases, 'operation.input.instanceId');
    candidate = deleteStudioV5SketchBlockInstance(candidate, sketchId, instanceId);
  } else if (kind === 'sketch.blockInstance.explode') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    const instanceId = resolveReference(input.instanceId, aliases, 'operation.input.instanceId');
    candidate = explodeStudioV5SketchBlockInstance(candidate, sketchId, instanceId, effects);
  } else if (kind === 'sketch.relation.create') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    const relation = clone(input.relation);
    const relationId = assertId(relation?.id, 'operation.input.relation.id');
    relation.id = relationId;
    candidate = createStudioV5SketchRelation(candidate, sketchId, relation);
    resultRef = { kind: 'sketch-relation', id: relationId, name: relationId };
  } else if (kind === 'sketch.relation.update') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    const relationId = resolveReference(input.relationId, aliases, 'operation.input.relationId');
    const relation = clone(input.relation);
    if (relation?.id !== undefined) relation.id = assertId(relation.id, 'operation.input.relation.id');
    candidate = updateStudioV5SketchRelation(candidate, sketchId, relationId, relation);
    resultRef = { kind: 'sketch-relation', id: relationId, name: relationId };
  } else if (kind === 'sketch.relation.delete') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    const relationId = resolveReference(input.relationId, aliases, 'operation.input.relationId');
    candidate = deleteStudioV5SketchRelation(candidate, sketchId, relationId);
  } else if (kind === 'sketch.derived.create') {
    const id = assertId(input.id, 'operation.input.id');
    const sourceSketchId = resolveReference(input.sourceSketchId, aliases, 'operation.input.sourceSketchId');
    candidate = createStudioV5DerivedSketch(candidate, {
      id, name: input.name, sourceSketchId,
      ...(input.plane !== undefined ? { plane: input.plane } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'z') ? { z: input.z } : {}),
      transform: clone(input.transform), relations: clone(input.relations || []),
    });
    resultRef = { kind: 'sketch', id, name: input.name };
  } else if (kind === 'sketch.derived.update') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    const patch = clone(input.patch);
    candidate = updateStudioV5DerivedSketch(candidate, sketchId, patch);
    resultRef = { kind: 'sketch', id: sketchId };
  } else if (kind === 'sketch.derived.underive') {
    const sketchId = resolveReference(input.sketchId, aliases, 'operation.input.sketchId');
    candidate = underiveStudioV5DerivedSketch(candidate, sketchId, effects);
    resultRef = { kind: 'sketch', id: sketchId };
  } else if (kind === 'sketch.drag') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    const feature = clone(findFeature(candidate, featureId));
    const constrained = feature.sketch?.constrained;
    if (!constrained) {
      fail('SKETCH_DRAG_CONSTRAINED_REQUIRED', 'Sketch drag requires a constrained inline feature sketch.', {
        entity: { kind: 'feature', id: featureId },
      });
    }
    if (input.handleKind !== 'point' && input.handleKind !== 'radius') {
      fail('INVALID_REQUEST', 'operation.input.handleKind must be "point" or "radius".');
    }
    const entityId = assertId(input.entityId, 'operation.input.entityId');
    let target;
    if (input.handleKind === 'point') {
      if (!Array.isArray(input.target) || input.target.length !== 2 || !input.target.every(Number.isFinite)) {
        fail('INVALID_REQUEST', 'operation.input.target must be one finite [x, y] point for a point drag.');
      }
      target = [input.target[0], input.target[1]];
    } else {
      if (!Number.isFinite(input.target) || input.target <= 0) {
        fail('INVALID_REQUEST', 'operation.input.target must be one positive finite radius for a radius drag.');
      }
      target = input.target;
    }
    const part = studioV5RootPart(candidate);
    let parameters;
    try {
      parameters = studioV5ParameterValues(candidate, part);
    } catch (error) {
      fail('SKETCH_PARAMETERS_INVALID', String(error?.message || error), { entity: { kind: 'feature', id: featureId } });
    }
    const solveOptions = {
      resolveDimension: (value) => evaluateStudioV5Expression(value, parameters),
      resolvePierce: createStudioV5PierceResolver(candidate, part.id),
    };
    const session = beginStudioSketchDrag(
      clone(constrained),
      { kind: input.handleKind, entityId },
      solveOptions,
    );
    const settled = settleStudioSketchDrag(session, target, solveOptions);
    if (!settled?.sketch || !Array.isArray(settled.sketch.entities)) {
      fail('SKETCH_DRAG_RESULT_INVALID', 'Sketch drag did not return a constrained sketch result.');
    }
    feature.sketch = { ...feature.sketch, constrained: clone(settled.sketch) };
    candidate = replaceFeature(candidate, feature);
    resultRef = { kind: 'feature', id: feature.id, name: feature.name };
  } else if (kind === 'body.transform') {
    const id = assertId(input.id, 'operation.input.id');
    const transform = clone(input.transform);
    for (const key of ['axisDatumId', 'planeDatumId', 'fromDatumId', 'toDatumId']) {
      if (transform[key] != null) transform[key] = resolveReference(transform[key], aliases, 'operation.input.transform.' + key);
    }
    candidate = createStudioV5TransformFeature(candidate, {
      ...clone(input), id, bodyId: resolveReference(input.bodyId, aliases, 'operation.input.bodyId'), transform,
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Transform' };
  } else if (kind === 'transform.update') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    candidate = updateStudioV5TransformFeature(candidate, featureId, clone(input.patch));
    resultRef = { kind: 'feature', id: featureId };
  } else if (kind === 'feature.reorder') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    candidate = reorderStudioV5Feature(candidate, featureId, resolveOptionalReference(input.beforeFeatureId, aliases, 'operation.input.beforeFeatureId'));
    resultRef = { kind: 'feature', id: featureId };
  } else if (kind === 'feature.rollback') {
    candidate = setStudioV5RollbackMarker(candidate, resolveOptionalReference(input.featureId, aliases, 'operation.input.featureId'));
  } else if (kind === 'feature.loft') {
    const id = assertId(input.id, 'operation.input.id');
    const sections = input.sections.map((section, index) => typeof section === 'string' || section?.alias
      ? resolveReference(section, aliases, 'operation.input.sections[' + index + ']')
      : { ...clone(section), sketchId: resolveReference(section.sketchId, aliases, 'operation.input.sections[' + index + '].sketchId') });
    candidate = createStudioV5LoftFeature(candidate, {
      ...clone(input), id, sections,
      guideSketchIds: Object.prototype.hasOwnProperty.call(input, 'guideSketchIds')
        ? resolveReferenceArray(input.guideSketchIds, aliases, 'operation.input.guideSketchIds')
        : [],
      ...(Object.prototype.hasOwnProperty.call(input, 'centerlineSketchId')
        ? { centerlineSketchId: resolveReference(input.centerlineSketchId, aliases, 'operation.input.centerlineSketchId') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(input, 'targetBodyId')
        ? { targetBodyId: resolveReference(input.targetBodyId, aliases, 'operation.input.targetBodyId') }
        : {}),
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Loft' };
  } else if (kind === 'feature.sweep') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5SweepFeature(candidate, {
      ...clone(input), id,
      profileSketchId: resolveReference(input.profileSketchId, aliases, 'operation.input.profileSketchId'),
      pathSketchId: resolveReference(input.pathSketchId, aliases, 'operation.input.pathSketchId'),
      guideSketchId: resolveOptionalReference(input.guideSketchId, aliases, 'operation.input.guideSketchId'),
      targetBodyId: resolveOptionalReference(input.targetBodyId, aliases, 'operation.input.targetBodyId'),
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Sweep' };
  } else if (kind === 'structural.member.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioStructuralMember(candidate, {
      ...clone(input),
      id,
      pathSketchId: resolveReference(input.pathSketchId, aliases, 'operation.input.pathSketchId'),
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Structural member' };
  } else if (kind === 'structural.member.update') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    const patch = clone(input.patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'pathSketchId')) {
      patch.pathSketchId = resolveReference(patch.pathSketchId, aliases, 'operation.input.patch.pathSketchId');
    }
    candidate = updateStudioStructuralMember(candidate, featureId, patch);
    resultRef = { kind: 'feature', id: featureId };
  } else if (kind === 'structural.treatment.create') {
    const id = assertId(input.id, 'operation.input.id');
    const resolved = { ...clone(input), id };
    const referenceFields = input.kind === 'corner'
      ? ['targetMemberId', 'otherMemberId']
      : input.kind === 'gusset'
        ? ['leftMemberId', 'rightMemberId']
        : ['memberId'];
    for (const field of referenceFields) {
      resolved[field] = resolveReference(input[field], aliases, 'operation.input.' + field);
    }
    candidate = createStudioWeldmentTreatment(candidate, resolved);
    resultRef = { kind: 'feature', id, name: input.name || 'Structural treatment' };
  } else if (kind === 'structural.treatment.update') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    candidate = updateStudioWeldmentTreatment(candidate, featureId, clone(input.patch));
    resultRef = { kind: 'feature', id: featureId };
  } else if (kind === 'structural.treatment.delete') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    candidate = deleteStudioWeldmentTreatment(candidate, featureId);
  } else if (kind === 'weld.bead.create') {
    const id = assertId(input.id, 'operation.input.id');
    const supports = input.supports.map((support, index) => ({
      ...clone(support),
      memberId: resolveReference(
        support.memberId,
        aliases,
        'operation.input.supports[' + index + '].memberId',
      ),
    }));
    candidate = createStudioWeldBead(candidate, { ...clone(input), id, supports });
    resultRef = { kind: 'feature', id, name: input.name || 'Fillet weld bead' };
  } else if (kind === 'weld.bead.update') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    candidate = updateStudioWeldBead(candidate, featureId, clone(input.patch));
    resultRef = { kind: 'feature', id: featureId };
  } else if (kind === 'weld.bead.delete') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    candidate = deleteStudioWeldBead(candidate, featureId);
  } else if (kind === 'sheetMetal.flange.create') {
    const id = assertId(input.id, 'operation.input.id');
    const resolved = { ...clone(input), id };
    if (input.kind === 'base-flange') {
      resolved.profileSketchId = resolveReference(input.profileSketchId, aliases, 'operation.input.profileSketchId');
    } else {
      resolved.baseFeatureId = resolveReference(input.baseFeatureId, aliases, 'operation.input.baseFeatureId');
    }
    candidate = createStudioSheetMetalFeature(candidate, resolved);
    resultRef = { kind: 'feature', id, name: input.name || (input.kind === 'edge-flange' ? 'Edge flange' : 'Base flange') };
  } else if (kind === 'sheetMetal.flange.update') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    candidate = updateStudioSheetMetalFeature(candidate, featureId, clone(input.patch));
    resultRef = { kind: 'feature', id: featureId };
  } else if (kind === 'sheetMetal.flange.delete') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    candidate = deleteStudioSheetMetalFeature(candidate, featureId);
  } else if (kind === 'sheetMetal.cornerRelief.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioSheetMetalFeature(candidate, {
      ...clone(input),
      id,
      kind: 'corner-relief',
      baseFeatureId: resolveReference(input.baseFeatureId, aliases, 'operation.input.baseFeatureId'),
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Corner relief' };
  } else if (kind === 'sheetMetal.flatPattern.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioSheetMetalFeature(candidate, {
      ...clone(input),
      id,
      kind: 'flat-pattern',
      baseFeatureId: resolveReference(input.baseFeatureId, aliases, 'operation.input.baseFeatureId'),
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Flat pattern' };
  } else if (kind === 'sheetMetal.bendTable.set') {
    candidate = setStudioSheetMetalBendTable(candidate, clone(input));
  } else if (kind === 'sheetMetal.bendTable.delete') {
    candidate = deleteStudioSheetMetalBendTable(candidate);
  } else if (kind === 'directEdit.create') {
    const id = assertId(input.id, 'operation.input.id');
    const resolved = {
      ...clone(input),
      id,
      targetBodyId: resolveReference(input.targetBodyId, aliases, 'operation.input.targetBodyId'),
    };
    if (input.operation === 'replace-face') {
      resolved.replacementBodyId = resolveReference(
        input.replacementBodyId,
        aliases,
        'operation.input.replacementBodyId',
      );
    }
    candidate = createStudioV5DirectEditFeature(candidate, resolved);
    resultRef = { kind: 'feature', id, name: input.name || 'Direct edit' };
  } else if (kind === 'directEdit.update') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    const patch = clone(input.patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'replacementBodyId')) {
      patch.replacementBodyId = resolveReference(
        patch.replacementBodyId,
        aliases,
        'operation.input.patch.replacementBodyId',
      );
    }
    candidate = updateStudioV5DirectEditFeature(candidate, featureId, patch);
    resultRef = { kind: 'feature', id: featureId };
  } else if (kind === 'directEdit.delete') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    candidate = deleteStudioV5DirectEditFeature(candidate, featureId);
  } else if (kind === 'feature.revolveProfile') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5RevolveFeature(candidate, {
      ...clone(input), id,
      profileSketchId: resolveReference(input.profileSketchId, aliases, 'operation.input.profileSketchId'),
      axisDatumId: resolveReference(input.axisDatumId, aliases, 'operation.input.axisDatumId'),
      targetBodyId: resolveOptionalReference(input.targetBodyId, aliases, 'operation.input.targetBodyId'),
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Revolve' };
  } else if (kind === 'feature.draft') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5DraftFeature(candidate, {
      ...clone(input), id, bodyId: resolveReference(input.bodyId, aliases, 'operation.input.bodyId'),
      neutralPlaneDatumId: resolveReference(input.neutralPlaneDatumId, aliases, 'operation.input.neutralPlaneDatumId'),
      faces: clone(input.faceRefs),
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Draft' };
  } else if (kind === 'feature.thicken') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5ThickenFeature(candidate, {
      ...clone(input), id, bodyId: resolveReference(input.bodyId, aliases, 'operation.input.bodyId'),
      faces: clone(input.faceRefs || input.faces || []), symmetric: input.direction === 'symmetric', flip: input.direction === 'inside',
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Thicken' };
  } else if (kind === 'feature.faceFillet') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5FaceFilletFeature(candidate, {
      ...clone(input), id, bodyId: resolveReference(input.bodyId, aliases, 'operation.input.bodyId'),
      faces: clone(input.faceRefs),
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Face Fillet' };
  } else if (kind === 'feature.variableFillet') {
    const id = assertId(input.id, 'operation.input.id');
    const radii = clone(input.variableRadii);
    candidate = createStudioV5VariableFilletFeature(candidate, {
      ...clone(input), id, bodyId: resolveReference(input.bodyId, aliases, 'operation.input.bodyId'),
      edges: clone(input.edgeRefs), radii,
      startRadius: radii[0]?.startRadius, endRadius: radii[0]?.endRadius,
    });
    resultRef = { kind: 'feature', id, name: input.name || 'Variable Fillet' };
  } else if (kind === 'feature.advanced.update') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    candidate = updateStudioV5AdvancedFeature(candidate, featureId, clone(input.patch));
    resultRef = { kind: 'feature', id: featureId };
  } else if (kind.startsWith('feature.') && ['feature.extrude', 'feature.cut', 'feature.revolve', 'feature.fillet', 'feature.chamfer', 'feature.shell', 'feature.thread'].includes(kind)) {
    const feature = featureFromOperation(candidate, kind, input, aliases);
    candidate = configureStudioV5Feature(candidate, feature, { resultPolicy: feature.resultPolicy, bodyName: feature.resultPolicy?.bodyName || input.bodyName });
    resultRef = { kind: 'feature', id: feature.id, name: feature.name };
  } else if (kind === 'feature.update') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    const feature = clone(findFeature(candidate, featureId));
    let immutableThreadSupport = null;
    if (feature.extensions?.thread?.schema === STUDIO_THREAD_SCHEMA_V2) {
      try {
        immutableThreadSupport = JSON.stringify(assertStudioThreadFeature(feature).support);
      } catch (error) {
        fail('INVALID_PATCH', 'Stored Thread v2 feature is invalid: ' + String(error?.message || error));
      }
    }
    if (feature.extensions?.structuralMember) {
      fail('INVALID_PATCH', 'Structural members must be edited through structural.member.update.');
    }
    if (feature.extensions?.weldmentTreatment) {
      fail('INVALID_PATCH', 'Weldment treatments must be edited through structural.treatment.update.');
    }
    if (feature.extensions?.weldBead) {
      fail('INVALID_PATCH', 'Weld beads must be edited through weld.bead.update.');
    }
    if (feature.extensions?.sheetMetal) {
      fail('INVALID_PATCH', 'Sheet-metal flanges must be edited through sheetMetal.flange.update.');
    }
    if (feature.type === 'direct-edit') {
      fail('INVALID_PATCH', 'Direct edits must be edited through directEdit.update.');
    }
    const patch = assertRecord(input.patch, 'operation.input.patch');
    const allowed = new Set(['name', 'h', 'through', 'r', 't', 'edges', 'faces', 'sketch', 'pattern', 'resultPolicy', 'inputRefs', 'onFace', 'extensions', 'tangentPropagation']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) fail('INVALID_PATCH', 'Feature field "' + key + '" is not editable through protocol v1.');
    if (Object.prototype.hasOwnProperty.call(patch, 'tangentPropagation')) {
      if (feature.type !== 'fillet' || typeof patch.tangentPropagation !== 'boolean') {
        fail('INVALID_PATCH', 'tangentPropagation is a boolean Fillet field.');
      }
    }
    Object.assign(feature, clone(patch));
    if (Object.prototype.hasOwnProperty.call(patch, 'tangentPropagation')) {
      if (patch.tangentPropagation === false) {
        setStudioExactTangentFilletPolicy(feature, false);
      } else {
        setStudioExactTangentFilletPolicy(feature, true);
      }
    }
    if (immutableThreadSupport !== null) {
      let nextThread;
      try {
        nextThread = assertStudioThreadFeature(feature);
      } catch (error) {
        fail('INVALID_PATCH', 'Thread v2 update is invalid: ' + String(error?.message || error));
      }
      if (JSON.stringify(nextThread.support) !== immutableThreadSupport) {
        fail(
          'INVALID_PATCH',
          'Thread v2 support body and cylindrical face are immutable during update; delete and recreate the feature to retarget it.',
        );
      }
    }
    if (patch.pattern === null) delete feature.pattern;
    if (patch.onFace === null) delete feature.onFace;
    candidate = replaceFeature(candidate, feature);
    resultRef = { kind: 'feature', id: feature.id, name: feature.name };
  } else if (kind === 'feature.suppress') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    const feature = clone(findFeature(candidate, featureId));
    if (feature.extensions?.weldmentTreatment) {
      fail('INVALID_PATCH', 'Weldment treatments use their typed structural.treatment lifecycle and cannot be generically suppressed.');
    }
    if (feature.extensions?.weldBead) {
      fail('INVALID_PATCH', 'Weld beads use their typed weld.bead lifecycle and cannot be generically suppressed.');
    }
    if (feature.type === 'direct-edit') {
      fail('INVALID_PATCH', 'Direct edits use their typed directEdit.update lifecycle and cannot be generically suppressed.');
    }
    if (typeof input.suppressed !== 'boolean') fail('INVALID_REQUEST', 'operation.input.suppressed must be a boolean.');
    feature.suppressed = input.suppressed;
    candidate = replaceFeature(candidate, feature);
    resultRef = { kind: 'feature', id: feature.id, name: feature.name };
  } else if (kind === 'feature.delete') {
    candidate = deleteFeature(candidate, resolveReference(input.featureId, aliases, 'operation.input.featureId'));
  } else if (kind === 'body.activate') {
    const bodyId = resolveReference(input.bodyId, aliases, 'operation.input.bodyId');
    findBody(candidate, bodyId);
    candidate = updateStudioV5Body(candidate, bodyId, { active: true });
    resultRef = { kind: 'body', id: bodyId };
  } else if (kind === 'body.rename') {
    const bodyId = resolveReference(input.bodyId, aliases, 'operation.input.bodyId');
    findBody(candidate, bodyId);
    const name = assertText(input.name, 'operation.input.name');
    candidate = updateStudioV5Body(candidate, bodyId, { name });
    resultRef = { kind: 'body', id: bodyId, name };
  } else if (kind === 'body.setVisibility') {
    const bodyId = resolveReference(input.bodyId, aliases, 'operation.input.bodyId');
    findBody(candidate, bodyId);
    if (typeof input.visible !== 'boolean') fail('INVALID_REQUEST', 'operation.input.visible must be a boolean.');
    candidate = updateStudioV5Body(candidate, bodyId, { visible: input.visible });
    resultRef = { kind: 'body', id: bodyId };
  } else if (kind === 'body.suppress') {
    const bodyId = resolveReference(input.bodyId, aliases, 'operation.input.bodyId');
    findBody(candidate, bodyId);
    if (typeof input.suppressed !== 'boolean') fail('INVALID_REQUEST', 'operation.input.suppressed must be a boolean.');
    candidate = updateStudioV5Body(candidate, bodyId, { suppressed: input.suppressed });
    resultRef = { kind: 'body', id: bodyId };
  } else if (kind === 'body.delete') {
    const bodyId = resolveReference(input.bodyId, aliases, 'operation.input.bodyId');
    const body = findBody(candidate, bodyId);
    const drawingViewUsers = (candidate.extensions?.drawingViews?.derivedViews || [])
      .filter((view) => view.kind === 'auxiliary' && view.definition?.reference?.bodyId === bodyId)
      .map((view) => view.id);
    if (drawingViewUsers.length) {
      fail('DRAWING_VIEW_IN_USE', 'Body is the persistent planar-face source of one or more auxiliary drawing views.', {
        entity: { kind: 'body', id: bodyId }, derivedViewIds: drawingViewUsers,
      });
    }
    const structuralFeature = studioV5RootPart(candidate).features.find((entry) =>
      entry.id === body.createdByFeatureId && entry.extensions?.structuralMember);
    const treatmentFeature = studioV5RootPart(candidate).features.find((entry) =>
      entry.id === body.createdByFeatureId && entry.extensions?.weldmentTreatment);
    const beadFeature = studioV5RootPart(candidate).features.find((entry) =>
      entry.id === body.createdByFeatureId && entry.extensions?.weldBead);
    candidate = structuralFeature
      ? deleteStudioStructuralMember(candidate, structuralFeature.id)
      : treatmentFeature
        ? deleteStudioWeldmentTreatment(candidate, treatmentFeature.id)
        : beadFeature
          ? deleteStudioWeldBead(candidate, beadFeature.id)
          : deleteStudioV5Body(candidate, bodyId);
  } else if (kind === 'pattern.create') {
    const id = assertId(input.id, 'operation.input.id');
    const definition = Object.prototype.hasOwnProperty.call(input, 'definition')
      ? assertRecord(input.definition, 'operation.input.definition')
      : {};
    const duplicates = Object.keys(definition).filter((key) =>
      Object.prototype.hasOwnProperty.call(input, key)
      && JSON.stringify(input[key]) !== JSON.stringify(definition[key]));
    if (duplicates.length) fail('INVALID_REQUEST', 'Pattern fields conflict with operation.input.definition: ' + duplicates.join(', ') + '.');
    const mergedPatternInput = { ...clone(input), ...clone(definition), id };
    delete mergedPatternInput.definition;
    candidate = createStudioV5BodyPattern(candidate, {
      ...mergedPatternInput,
      sourceBodyId: resolveReference(input.sourceBodyId, aliases, 'operation.input.sourceBodyId'),
      ...(Object.prototype.hasOwnProperty.call(mergedPatternInput, 'directionDatumId')
        ? { directionDatumId: resolveReference(mergedPatternInput.directionDatumId, aliases, 'operation.input.directionDatumId') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(mergedPatternInput, 'directionDatumIds')
        ? { directionDatumIds: resolveReferenceArray(mergedPatternInput.directionDatumIds, aliases, 'operation.input.directionDatumIds') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(mergedPatternInput, 'axisDatumId')
        ? { axisDatumId: resolveReference(mergedPatternInput.axisDatumId, aliases, 'operation.input.axisDatumId') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(mergedPatternInput, 'pathSketchId')
        ? { pathSketchId: resolveReference(mergedPatternInput.pathSketchId, aliases, 'operation.input.pathSketchId') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(mergedPatternInput, 'pointSketchId')
        ? { pointSketchId: resolveReference(mergedPatternInput.pointSketchId, aliases, 'operation.input.pointSketchId') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(mergedPatternInput, 'boundarySketchId')
        ? { boundarySketchId: resolveReference(mergedPatternInput.boundarySketchId, aliases, 'operation.input.boundarySketchId') }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(mergedPatternInput, 'planeDatumId')
        ? { planeDatumId: resolveReference(mergedPatternInput.planeDatumId, aliases, 'operation.input.planeDatumId') }
        : {}),
    });
    resultRef = { kind: 'body-pattern', id, name: input.name || input.kind + ' pattern' };
  } else if (kind === 'pattern.update') {
    const patternId = resolveReference(input.patternId, aliases, 'operation.input.patternId');
    candidate = updateStudioV5BodyPattern(candidate, patternId, clone(input.patch));
    resultRef = { kind: 'body-pattern', id: patternId };
  } else if (kind === 'pattern.delete') {
    candidate = deleteStudioV5BodyPattern(candidate, resolveReference(input.patternId, aliases, 'operation.input.patternId'));
  } else if (kind === 'pattern.materialize') {
    const patternId = resolveReference(input.patternId, aliases, 'operation.input.patternId');
    candidate = materializeStudioV5PatternOccurrences(candidate, patternId, clone(input.records), { dissolve: input.dissolve === true });
  } else if (kind === 'assembly.create') {
    assertNoDerivedDrawingViewsForAssemblyRoot(candidate);
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5AssemblyFromPart(candidate, { ...clone(input), id, occurrenceId: assertId(input.occurrenceId, 'operation.input.occurrenceId') });
    resultRef = { kind: 'assembly', id, name: input.name || 'Assembly' };
  } else if (kind === 'document.activate') {
    const definition = resolveDefinition(input.definition, aliases, 'operation.input.definition');
    const exists = definition.kind === 'part'
      ? candidate.partDefinitions.some((entry) => entry.id === definition.partId)
      : candidate.assemblyDefinitions.some((entry) => entry.id === definition.assemblyId);
    if (!exists) fail('MISSING_REFERENCE', 'The requested active document definition does not exist.');
    if (definition.kind === 'assembly') assertNoDerivedDrawingViewsForAssemblyRoot(candidate);
    candidate.rootDocument = definition;
    delete candidate.metadata.editContext;
  } else if (kind === 'assembly.context.enter') {
    candidate = enterStudioV5AssemblyContext(candidate, resolveReference(input.occurrenceId, aliases, 'operation.input.occurrenceId'));
  } else if (kind === 'assembly.context.exit') {
    assertNoDerivedDrawingViewsForAssemblyRoot(candidate);
    candidate = exitStudioV5AssemblyContext(candidate);
  } else if (kind === 'assembly.drag') {
    const occurrenceId = resolveReference(input.occurrenceId, aliases, 'operation.input.occurrenceId');
    candidate = previewStudioAssemblyDrag(candidate, occurrenceId, clone(input.targetTransform)).project;
    resultRef = { kind: 'occurrence', id: occurrenceId };
  } else if (kind === 'smartFastener.apply') {
    const id = assertId(input.id, 'operation.input.id');
    const applied = applyStudioV5SmartFastenerPlan(candidate, clone(input.plan), {
      id,
      ...(input.name == null ? {} : { name: input.name }),
    });
    candidate = applied.project;
    resultRef = { kind: 'smart-fastener', id, name: input.name || 'Smart Fastener' };
  } else if (kind === 'smartFastener.update') {
    const smartFastenerId = resolveReference(
      input.smartFastenerId,
      aliases,
      'operation.input.smartFastenerId',
    );
    const updated = updateStudioV5SmartFastenerGroup(candidate, smartFastenerId, clone(input.plan), {
      ...(input.name == null ? {} : { name: input.name }),
    });
    candidate = updated.project;
    resultRef = { kind: 'smart-fastener', id: smartFastenerId, name: input.name || 'Smart Fastener' };
  } else if (kind === 'smartFastener.delete') {
    const deleted = deleteStudioV5SmartFastenerGroup(
      candidate,
      resolveReference(input.smartFastenerId, aliases, 'operation.input.smartFastenerId'),
    );
    candidate = deleted.project;
  } else if (kind === 'assemblyFeature.create') {
    const id = assertId(input.id, 'operation.input.id');
    const targets = input.targets.map((target, index) => ({
      occurrenceId: resolveReference(target.occurrenceId, aliases, 'operation.input.targets[' + index + '].occurrenceId'),
      partId: resolveReference(target.partId, aliases, 'operation.input.targets[' + index + '].partId'),
      bodyId: resolveReference(target.bodyId, aliases, 'operation.input.targets[' + index + '].bodyId'),
    }));
    const created = createStudioV5AssemblyFeature(candidate, { ...clone(input), id, targets });
    candidate = created.project;
    resultRef = { kind: 'assembly-feature', id, name: input.name };
  } else if (kind === 'assemblyFeature.update') {
    const assemblyFeatureId = resolveReference(
      input.assemblyFeatureId,
      aliases,
      'operation.input.assemblyFeatureId',
    );
    const patch = clone(input.patch);
    if (patch.targets) patch.targets = patch.targets.map((target, index) => ({
      occurrenceId: resolveReference(target.occurrenceId, aliases, 'operation.input.patch.targets[' + index + '].occurrenceId'),
      partId: resolveReference(target.partId, aliases, 'operation.input.patch.targets[' + index + '].partId'),
      bodyId: resolveReference(target.bodyId, aliases, 'operation.input.patch.targets[' + index + '].bodyId'),
    }));
    const updated = updateStudioV5AssemblyFeature(candidate, assemblyFeatureId, patch);
    candidate = updated.project;
    resultRef = { kind: 'assembly-feature', id: assemblyFeatureId, name: updated.feature.name };
  } else if (kind === 'assemblyFeature.delete') {
    const deleted = deleteStudioV5AssemblyFeature(
      candidate,
      resolveReference(input.assemblyFeatureId, aliases, 'operation.input.assemblyFeatureId'),
    );
    candidate = deleted.project;
  } else if (kind === 'component.createPart') {
    const partId = assertId(input.partId, 'operation.input.partId');
    const occurrenceId = assertId(input.occurrenceId, 'operation.input.occurrenceId');
    if (candidate.partDefinitions.some((entry) => entry.id === partId)) fail('DUPLICATE_ID', 'Part ID "' + partId + '" is already in use.');
    candidate.partDefinitions.push({
      id: partId, name: assertText(input.name, 'operation.input.name'), parameters: [], referenceGeometry: [], sketches: [],
      bodies: [], bodyPatterns: [], features: [], featureOrder: [], metadata: {},
    });
    candidate = createStudioV5ComponentOccurrence(candidate, {
      id: occurrenceId, name: input.occurrenceName || input.name, definition: { kind: 'part', partId },
      baseTransform: input.baseTransform, fixed: input.fixed === true, visible: true,
    });
    if (input.enterContext === true) candidate = enterStudioV5AssemblyContext(candidate, occurrenceId);
    resultRef = { kind: 'part', id: partId, name: input.name };
  } else if (kind === 'component.insert') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5ComponentOccurrence(candidate, { ...clone(input), id, definition: resolveDefinition(input.definition, aliases, 'operation.input.definition') });
    resultRef = { kind: 'occurrence', id, name: input.name || 'Component' };
  } else if (kind === 'component.update') {
    const occurrenceId = resolveReference(input.occurrenceId, aliases, 'operation.input.occurrenceId');
    candidate = updateStudioV5ComponentOccurrence(candidate, occurrenceId, clone(input.patch));
    resultRef = { kind: 'occurrence', id: occurrenceId };
  } else if (kind === 'component.duplicate') {
    const occurrenceId = resolveReference(input.occurrenceId, aliases, 'operation.input.occurrenceId');
    const id = assertId(input.id, 'operation.input.id');
    candidate = duplicateStudioV5LinkedOccurrence(candidate, occurrenceId, { ...clone(input), id });
    resultRef = { kind: 'occurrence', id, name: input.name || 'Linked component' };
  } else if (kind === 'component.makeIndependent') {
    const occurrenceId = resolveReference(input.occurrenceId, aliases, 'operation.input.occurrenceId');
    const partId = assertId(input.partId, 'operation.input.partId');
    candidate = makeStudioV5OccurrenceIndependent(candidate, occurrenceId, { ...clone(input), partId });
    resultRef = { kind: 'part', id: partId, name: input.name || 'Independent part' };
  } else if (kind === 'component.replace') {
    const occurrenceId = resolveReference(input.occurrenceId, aliases, 'operation.input.occurrenceId');
    candidate = replaceStudioV5ComponentOccurrence(candidate, occurrenceId, resolveDefinition(input.definition, aliases, 'operation.input.definition'));
    resultRef = { kind: 'occurrence', id: occurrenceId };
  } else if (kind === 'component.delete') {
    candidate = deleteStudioV5ComponentOccurrence(candidate, resolveReference(input.occurrenceId, aliases, 'operation.input.occurrenceId'));
  } else if (kind === 'component.pattern') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5OccurrencePattern(candidate, {
      ...clone(input), id, sourceOccurrenceIds: resolveReferenceArray(input.sourceOccurrenceIds, aliases, 'operation.input.sourceOccurrenceIds'),
    });
    resultRef = { kind: 'occurrence-pattern', id, name: input.name || 'Component pattern' };
  } else if (kind === 'component.pattern.update') {
    const patternId = resolveReference(input.patternId, aliases, 'operation.input.patternId');
    const patch = clone(input.patch);
    if (patch.sourceOccurrenceIds) patch.sourceOccurrenceIds = resolveReferenceArray(patch.sourceOccurrenceIds, aliases, 'operation.input.patch.sourceOccurrenceIds');
    candidate = updateStudioV5OccurrencePattern(candidate, patternId, patch);
    resultRef = { kind: 'occurrence-pattern', id: patternId };
  } else if (kind === 'component.pattern.delete') {
    candidate = deleteStudioV5OccurrencePattern(candidate, resolveReference(input.patternId, aliases, 'operation.input.patternId'));
  } else if (kind === 'mate.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5AssemblyMate(candidate, {
      ...clone(input), id, kind: input.mateKind,
      occurrenceIds: resolveReferenceArray(input.occurrenceIds, aliases, 'operation.input.occurrenceIds'),
    });
    resultRef = { kind: 'mate', id, name: input.name || input.mateKind + ' mate' };
  } else if (kind === 'mate.update') {
    const mateId = resolveReference(input.mateId, aliases, 'operation.input.mateId');
    candidate = updateStudioV5AssemblyMate(candidate, mateId, clone(input.patch));
    resultRef = { kind: 'mate', id: mateId };
  } else if (kind === 'mate.delete') {
    candidate = deleteStudioV5AssemblyMate(candidate, resolveReference(input.mateId, aliases, 'operation.input.mateId'));
  } else if (kind === 'section.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5SectionView(candidate, {
      ...clone(input), id,
      scopeOccurrenceIds: input.scopeOccurrenceIds ? resolveReferenceArray(input.scopeOccurrenceIds, aliases, 'operation.input.scopeOccurrenceIds') : [],
    });
    resultRef = { kind: 'section', id, name: input.name };
  } else if (kind === 'section.update') {
    const sectionId = resolveReference(input.sectionId, aliases, 'operation.input.sectionId');
    candidate = updateStudioV5SectionView(candidate, sectionId, clone(input.patch));
    resultRef = { kind: 'section', id: sectionId };
  } else if (kind === 'section.activate') {
    candidate = activateStudioV5SectionView(candidate, resolveOptionalReference(input.sectionId, aliases, 'operation.input.sectionId'));
  } else if (kind === 'section.delete') {
    candidate = deleteStudioV5SectionView(candidate, resolveReference(input.sectionId, aliases, 'operation.input.sectionId'));
  } else if (kind === 'exploded.create') {
    const id = assertId(input.id, 'operation.input.id');
    const steps = clone(input.steps).map((step, index) => ({
      ...step, occurrenceIds: resolveReferenceArray(step.occurrenceIds, aliases, 'operation.input.steps[' + index + '].occurrenceIds'),
    }));
    candidate = createStudioV5ExplodedView(candidate, { ...clone(input), id, steps });
    resultRef = { kind: 'exploded-view', id, name: input.name };
  } else if (kind === 'exploded.activate') {
    candidate = activateStudioV5ExplodedView(candidate, resolveOptionalReference(input.explodedViewId, aliases, 'operation.input.explodedViewId'));
  } else if (kind === 'exploded.delete') {
    candidate = deleteStudioV5ExplodedView(candidate, resolveReference(input.explodedViewId, aliases, 'operation.input.explodedViewId'));
  } else if (kind === 'measurement.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5Measurement(candidate, { ...clone(input), id, kind: input.measurementKind });
    resultRef = { kind: 'measurement', id, name: input.name };
  } else if (kind === 'measurement.update') {
    const measurementId = resolveReference(input.measurementId, aliases, 'operation.input.measurementId');
    candidate = updateStudioV5Measurement(candidate, measurementId, clone(input.patch));
    resultRef = { kind: 'measurement', id: measurementId };
  } else if (kind === 'measurement.delete') {
    candidate = deleteStudioV5Measurement(candidate, resolveReference(input.measurementId, aliases, 'operation.input.measurementId'));
  } else if (kind === 'display.setMode') {
    candidate = setStudioV5DisplayMode(candidate, input.mode);
  } else if (kind === 'material.ensureGeneric') {
    candidate = ensureStudioV5GenericMaterials(candidate);
  } else if (kind === 'material.assignBody') {
    candidate = assignStudioV5BodyMaterial(candidate,
      resolveReference(input.partId, aliases, 'operation.input.partId'),
      resolveReference(input.bodyId, aliases, 'operation.input.bodyId'),
      resolveReference(input.materialId, aliases, 'operation.input.materialId'));
  } else if (kind === 'appearance.assignOccurrence') {
    candidate = assignStudioV5OccurrenceAppearance(candidate,
      resolveReference(input.occurrenceId, aliases, 'operation.input.occurrenceId'),
      assertId(input.appearanceId, 'operation.input.appearanceId'));
  } else if (kind === 'stage.create') {
    const id = assertId(input.id, 'operation.input.id');
    candidate = createStudioV5AxialStageGroup(candidate, {
      ...clone(input), id,
      occurrenceIds: resolveReferenceArray(input.occurrenceIds, aliases, 'operation.input.occurrenceIds'),
      distanceMateIds: resolveReferenceArray(input.distanceMateIds, aliases, 'operation.input.distanceMateIds'),
    });
    resultRef = { kind: 'stage-group', id, name: input.name };
  } else if (kind === 'stage.update') {
    const groupId = resolveReference(input.groupId, aliases, 'operation.input.groupId');
    candidate = updateStudioV5AxialStageGroup(candidate, groupId, clone(input.patch));
    resultRef = { kind: 'stage-group', id: groupId };
  } else if (kind === 'stage.delete') {
    candidate = deleteStudioV5AxialStageGroup(candidate, resolveReference(input.groupId, aliases, 'operation.input.groupId'));
  } else if (kind === 'pattern.linear' || kind === 'pattern.circular' || kind === 'pattern.dissolve') {
    const featureId = resolveReference(input.featureId, aliases, 'operation.input.featureId');
    const feature = clone(findFeature(candidate, featureId));
    if (kind === 'pattern.dissolve') delete feature.pattern;
    else if (kind === 'pattern.linear') {
      feature.pattern = {
        kind: 'linear',
        n: assertInteger(input.count, 'operation.input.count', 1, 100),
        dx: assertFiniteOrExpression(input.dx ?? 0, 'operation.input.dx'),
        dy: assertFiniteOrExpression(input.dy ?? 0, 'operation.input.dy'),
      };
    } else {
      feature.pattern = {
        kind: 'circular',
        n: assertInteger(input.count, 'operation.input.count', 1, 100),
        cx: assertFiniteOrExpression(input.cx ?? 0, 'operation.input.cx'),
        cy: assertFiniteOrExpression(input.cy ?? 0, 'operation.input.cy'),
      };
    }
    candidate = replaceFeature(candidate, feature);
    resultRef = { kind: 'feature', id: feature.id, name: feature.name };
  } else if (kind === 'boolean.split') {
    const targetBodyId = resolveReference(input.targetBodyId, aliases, 'operation.input.targetBodyId');
    const toolSource = input.toolBodyId ?? input.toolBodyIds?.[0];
    const toolBodyId = resolveReference(toolSource, aliases, 'operation.input.toolBodyId');
    const id = input.id ? assertId(input.id, 'operation.input.id') : nextStableId(candidate, 'feature-boolean-split');
    candidate = createStudioV5BooleanSplit(candidate, {
      id, name: input.name, targetBodyId, toolBodyId,
      keepTools: Object.prototype.hasOwnProperty.call(input, 'keepTools') ? input.keepTools : true,
      keepOriginal: Object.prototype.hasOwnProperty.call(input, 'keepOriginal') ? input.keepOriginal : false,
      outsideName: input.bodyNames?.[0], insideName: input.bodyNames?.[1],
    });
    resultRef = { kind: 'feature', id: id + '-outside', name: input.name || 'Boolean Split' };
  } else if (kind.startsWith('boolean.')) {
    const operationName = kind.slice('boolean.'.length);
    const targetBodyId = resolveReference(input.targetBodyId, aliases, 'operation.input.targetBodyId');
    const toolBodyId = resolveReference(input.toolBodyId, aliases, 'operation.input.toolBodyId');
    findBody(candidate, targetBodyId);
    findBody(candidate, toolBodyId);
    const id = input.id ? assertId(input.id, 'operation.input.id') : nextStableId(candidate, 'feature-boolean-' + operationName);
    if (input.keepTools != null && typeof input.keepTools !== 'boolean') fail('INVALID_REQUEST', 'operation.input.keepTools must be a boolean.');
    candidate = createStudioV5BooleanFeature(candidate, {
      id,
      name: input.name,
      operation: operationName === 'union' ? 'add' : operationName,
      targetBodyId,
      toolBodyId,
      keepTools: input.keepTools !== false,
    });
    resultRef = { kind: 'feature', id, name: input.name || operationName };
  }

  refreshConstrainedSketches(candidate);
  candidate = refreshStudioV5ReferenceCurves(candidate);
  candidate = refreshStudioV5SketchInstances(candidate);
  if (op.alias) {
    const alias = assertText(op.alias, 'operation.alias');
    if (aliases[alias]) fail('DUPLICATE_ALIAS', 'Transaction alias "' + alias + '" is already defined.');
    if (!resultRef) fail('INVALID_ALIAS', 'Operation "' + kind + '" does not create or select an addressable result.');
    aliases[alias] = resultRef;
  }
  return candidate;
}

export function applyCadTransaction(project, transaction) {
  if (!isStudioV5Project(project)) fail('UNSUPPORTED_DOCUMENT', 'Agent protocol v1 requires a schema-5 CAD project.');
  const tx = assertRecord(transaction, 'transaction');
  assertText(tx.transactionId, 'transaction.transactionId');
  assertText(tx.label, 'transaction.label');
  if (tx.atomic !== true) fail('ATOMIC_REQUIRED', 'Protocol v1 transactions must set atomic to true.');
  if (!Array.isArray(tx.operations) || tx.operations.length < 1 || tx.operations.length > MAX_TRANSACTION_OPERATIONS) {
    fail('LIMIT_OPERATIONS', 'A transaction must contain 1 to ' + MAX_TRANSACTION_OPERATIONS + ' operations.');
  }
  const aliases = {};
  const effects = { remapped: [] };
  let candidate = canonicalStudioV5Project(project);
  for (let index = 0; index < tx.operations.length; index++) {
    try {
      candidate = applyOperation(candidate, tx.operations[index], aliases, effects);
    } catch (error) {
      if (error instanceof CadAgentError) {
        error.details = { ...(error.details || {}), operationIndex: index };
        throw error;
      }
      throw new CadAgentError(error?.code || 'DOCUMENT_VALIDATION_FAILED', String(error?.message || error), { operationIndex: index });
    }
  }
  candidate = prepareStudioV5RuntimeProject(candidate);
  return { project: candidate, aliases, changeSet: semanticChangeSet(project, candidate, aliases, effects) };
}

function paginate(items, request = {}) {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(request.pageSize) || DEFAULT_PAGE_SIZE));
  const offset = request.cursor == null ? 0 : assertInteger(Number(request.cursor), 'cursor', 0);
  return {
    items: items.slice(offset, offset + pageSize),
    total: items.length,
    nextCursor: offset + pageSize < items.length ? String(offset + pageSize) : null,
  };
}

function dependencyGraph(project) {
  const edges = [];
  const seen = new Set();
  const add = (from, to, relation) => {
    if (!from?.kind || !from?.id || !to?.kind || !to?.id) return;
    const edge = { from, to, relation };
    const key = JSON.stringify(edge);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };
  const persistentViewIds = new Set([
    ...(project.extensions?.drawingViews?.views || []).map((entry) => entry.id),
    ...(project.extensions?.drawingViews?.derivedViews || []).map((entry) => entry.id),
  ]);
  for (const view of project.extensions?.drawingViews?.derivedViews || []) {
    if (persistentViewIds.has(view.sourceViewId)) {
      add({ kind: view.sourceViewId.startsWith('drawing-derived-view-') ? 'drawing-derived-view' : 'drawing-view', id: view.sourceViewId },
        { kind: 'drawing-derived-view', id: view.id }, 'derives');
    }
    if (view.kind === 'auxiliary' && view.definition?.reference?.bodyId) {
      add({ kind: 'body', id: view.definition.reference.bodyId }, { kind: 'drawing-derived-view', id: view.id }, 'references');
    }
  }
  for (const sheet of project.extensions?.drawingBook?.sheets || []) {
    for (const viewId of sheet.views || []) if (persistentViewIds.has(viewId)) {
      add({ kind: viewId.startsWith('drawing-derived-view-') ? 'drawing-derived-view' : 'drawing-view', id: viewId },
        { kind: 'drawing-sheet', id: sheet.id }, 'places');
    }
  }
  for (const part of project.partDefinitions || []) {
    for (const datum of part.referenceGeometry || []) {
      for (const [field, value] of Object.entries(datum.definition || {})) {
        if (field.endsWith('DatumId') && typeof value === 'string') {
          add({ kind: 'datum', id: value }, { kind: 'datum', id: datum.id }, 'defines');
        } else if (field.endsWith('DatumIds') && Array.isArray(value)) {
          for (const id of value) if (typeof id === 'string') add({ kind: 'datum', id }, { kind: 'datum', id: datum.id }, 'defines');
        } else if (field.endsWith('SketchId') && typeof value === 'string') {
          add({ kind: 'sketch', id: value }, { kind: 'datum', id: datum.id }, 'defines');
        }
      }
    }
    for (const sketch of part.sketches || []) {
      if (sketch.support?.ownerKind && sketch.support?.ownerId) {
        add({ kind: sketch.support.ownerKind, id: sketch.support.ownerId }, { kind: 'sketch', id: sketch.id }, 'supports');
      }
      for (const [field, value] of Object.entries(sketch.extensions?.referenceCurve || {})) {
        if (field.endsWith('DatumId') && typeof value === 'string') {
          add({ kind: 'datum', id: value }, { kind: 'sketch', id: sketch.id }, 'defines');
        } else if (field.endsWith('SketchId') && typeof value === 'string') {
          add({ kind: 'sketch', id: value }, { kind: 'sketch', id: sketch.id }, 'defines');
        } else if (field.endsWith('SketchIds') && Array.isArray(value)) {
          for (const id of value) if (typeof id === 'string') add({ kind: 'sketch', id }, { kind: 'sketch', id: sketch.id }, 'defines');
        }
      }
      for (const instance of sketch.constrained?.blockInstances || []) {
        add(
          { kind: 'sketch-block-definition', id: instance.definitionId },
          { kind: 'sketch-block-instance', id: instance.id },
          'instantiates',
        );
        add(
          { kind: 'sketch-block-instance', id: instance.id },
          { kind: 'sketch', id: sketch.id },
          'belongs-to',
        );
      }
      for (const relation of sketch.constrained?.relations || []) {
        add(
          { kind: 'sketch-relation', id: relation.id },
          { kind: 'sketch', id: sketch.id },
          'belongs-to',
        );
        for (const field of ['a', 'b', 'line', 'circle', 'point', 'axis']) {
          const reference = relation[field];
          if (reference?.instanceId) add(
            { kind: 'sketch-block-instance', id: reference.instanceId },
            { kind: 'sketch-relation', id: relation.id },
            'constrains',
          );
        }
      }
      if (sketch.constrained?.derivedFrom?.sourceSketchId) {
        add(
          { kind: 'sketch', id: sketch.constrained.derivedFrom.sourceSketchId },
          { kind: 'sketch', id: sketch.id },
          'derives',
        );
      }
    }
    for (const feature of part.features) {
      for (const constraint of feature.sketch?.constrained?.constraints || []) {
        if (constraint.kind !== 'pierce') continue;
        add({ kind: 'sketch', id: constraint.curveSketchId }, { kind: 'feature', id: feature.id }, 'pierces');
        add({ kind: 'datum', id: constraint.planeDatumId }, { kind: 'feature', id: feature.id }, 'pierces');
      }
      for (const ref of feature.inputRefs || []) add({ kind: ref.ownerKind, id: ref.ownerId }, { kind: 'feature', id: feature.id }, 'input');
      for (const bodyId of feature.resultPolicy?.targetBodyIds || []) add({ kind: 'feature', id: feature.id }, { kind: 'body', id: bodyId }, 'modifies');
      if (feature.createdBodyId) add({ kind: 'feature', id: feature.id }, { kind: 'body', id: feature.createdBodyId }, 'creates');
      for (const bodyId of feature.toolBodyIds || []) add({ kind: 'body', id: bodyId }, { kind: 'feature', id: feature.id }, 'tool');
    }
    for (const body of part.bodies || []) {
      if (body.materialId) add({ kind: 'material', id: body.materialId }, { kind: 'body', id: body.id }, 'material');
    }
    for (const pattern of part.bodyPatterns || []) {
      add({ kind: 'body', id: pattern.sourceBodyId }, { kind: 'body-pattern', id: pattern.id }, 'patterns');
      for (const reference of pattern.references || []) {
        add({ kind: reference.ownerKind, id: reference.ownerId }, { kind: 'body-pattern', id: pattern.id }, 'input');
      }
    }
  }
  for (const assembly of project.assemblyDefinitions || []) {
    for (const occurrence of assembly.occurrences || []) {
      add(occurrence.definition.kind === 'part'
        ? { kind: 'part', id: occurrence.definition.partId }
        : { kind: 'assembly', id: occurrence.definition.assemblyId },
      { kind: 'occurrence', id: occurrence.id }, 'instantiates');
      if (occurrence.parentOccurrenceId) {
        add({ kind: 'occurrence', id: occurrence.parentOccurrenceId }, { kind: 'occurrence', id: occurrence.id }, 'contains');
      }
    }
    for (const mate of assembly.mates || []) for (const occurrenceId of mate.occurrenceIds || []) {
      add({ kind: 'occurrence', id: occurrenceId }, { kind: 'mate', id: mate.id }, 'constrains');
    }
    for (const smartFastener of assembly.extensions?.smartFasteners?.groups || []) {
      add(
        { kind: 'occurrence', id: smartFastener.targetOccurrenceId },
        { kind: 'smart-fastener', id: smartFastener.id },
        'recognizes-hole-on',
      );
      for (const occurrenceId of Object.values(smartFastener.occurrenceIds || {})) {
        add(
          { kind: 'smart-fastener', id: smartFastener.id },
          { kind: 'occurrence', id: occurrenceId },
          'owns',
        );
      }
      for (const mateId of Object.values(smartFastener.mateIds || {})) {
        add(
          { kind: 'smart-fastener', id: smartFastener.id },
          { kind: 'mate', id: mateId },
          'owns',
        );
      }
    }
    for (const assemblyFeature of assembly.extensions?.assemblyFeatures?.features || []) {
      for (const target of assemblyFeature.targets || []) {
        add(
          { kind: 'occurrence', id: target.occurrenceId },
          { kind: 'assembly-feature', id: assemblyFeature.id },
          'assembly-modifies',
        );
        add(
          { kind: 'body', id: target.bodyId },
          { kind: 'assembly-feature', id: assemblyFeature.id },
          'assembly-modifies',
        );
      }
    }
    for (const pattern of assembly.occurrencePatterns || []) {
      for (const occurrenceId of pattern.sourceOccurrenceIds || []) {
        add({ kind: 'occurrence', id: occurrenceId }, { kind: 'occurrence-pattern', id: pattern.id }, 'patterns');
      }
    }
    for (const section of assembly.sectionViews || []) {
      for (const occurrenceId of section.definition?.scopeOccurrenceIds || []) {
        add({ kind: 'occurrence', id: occurrenceId }, { kind: 'section', id: section.id }, 'scopes');
      }
    }
    for (const exploded of assembly.explodedViews || []) {
      for (const step of exploded.definition?.steps || []) {
        if (step.occurrenceId) add({ kind: 'occurrence', id: step.occurrenceId }, { kind: 'exploded-view', id: exploded.id }, 'explodes');
      }
    }
  }
  return edges;
}

function dependencyQuery(project, request) {
  const edges = dependencyGraph(project);
  if (!request.entity) return paginate(edges, request);
  const entityKind = assertText(request.entity.kind, 'entity.kind');
  const entityId = assertId(request.entity.id, 'entity.id');
  if (!canonicalEntityMap(project).has(entityKind + ':' + entityId)) {
    fail('MISSING_REFERENCE', entityKind + ' "' + entityId + '" does not exist.');
  }
  const direction = request.direction == null ? 'both' : assertText(request.direction, 'direction');
  if (!['upstream', 'downstream', 'both'].includes(direction)) {
    fail('INVALID_REQUEST', 'direction must be upstream, downstream, or both.');
  }
  if (request.transitive != null && typeof request.transitive !== 'boolean') {
    fail('INVALID_REQUEST', 'transitive must be a boolean.');
  }
  const relation = request.relation == null ? null : assertText(request.relation, 'relation');
  const filtered = relation ? edges.filter((edge) => edge.relation === relation) : edges;
  if (request.transitive !== true) {
    return paginate(filtered.filter((edge) =>
      (direction !== 'upstream' && edge.from.kind === entityKind && edge.from.id === entityId)
      || (direction !== 'downstream' && edge.to.kind === entityKind && edge.to.id === entityId)), request);
  }
  const maxDepth = request.maxDepth == null ? 64 : assertInteger(request.maxDepth, 'maxDepth', 1, 256);
  const queue = [{ key: entityKind + ':' + entityId, depth: 0 }];
  const visitedNodes = new Set(queue.map((entry) => entry.key));
  const found = new Map();
  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;
    for (const edge of filtered) {
      const fromKey = edge.from.kind + ':' + edge.from.id;
      const toKey = edge.to.kind + ':' + edge.to.id;
      let nextKey = null;
      if (direction !== 'upstream' && fromKey === current.key) nextKey = toKey;
      if (direction !== 'downstream' && toKey === current.key) nextKey = fromKey;
      if (!nextKey) continue;
      const edgeKey = JSON.stringify(edge);
      if (!found.has(edgeKey)) found.set(edgeKey, { ...edge, depth: current.depth + 1 });
      if (!visitedNodes.has(nextKey)) {
        visitedNodes.add(nextKey);
        queue.push({ key: nextKey, depth: current.depth + 1 });
      }
    }
  }
  return paginate([...found.values()], request);
}

function cacheResponse(cache, key, response) {
  if (!cache.has(key) && cache.size >= MAX_REQUEST_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, clone(response));
}

export class CadCommandService {
  constructor(options = {}) {
    const project = options.project || createEmptyStudioV5PartProject({ projectId: options.projectId || 'project-agent-1', name: options.name || 'Agent part', units: options.units || 'mm' });
    this.project = prepareStudioV5RuntimeProject(project);
    this.revision = Number.isInteger(options.revision) ? options.revision : 0;
    this.kernel = options.kernel || null;
    this.commitAdapter = options.commitAdapter || null;
    this.visibleStudio = options.visibleStudio === true;
    this.studioVersion = options.studioVersion || CAD_AGENT_STUDIO_VERSION;
    this.previewTtlMs = options.previewTtlMs || DEFAULT_PREVIEW_TTL_MS;
    this.now = options.now || (() => Date.now());
    this.previews = new Map();
    this.requestCache = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.journal = [];
    this.previewSequence = 0;
    this.lastEvidence = evidenceFromKernel(null, false);
  }

  snapshot() {
    return canonicalStudioV5Project(this.project);
  }

  previewSnapshot(previewId, expectedRevision) {
    this.prunePreviews();
    const requestedRevision = assertInteger(expectedRevision, 'expectedRevision', 0);
    if (requestedRevision !== this.revision) {
      fail('REVISION_CONFLICT', 'The requested preview targets an older project revision.', {
        expectedRevision: requestedRevision,
        actualRevision: this.revision,
      });
    }
    const preview = this.previews.get(assertText(previewId, 'previewId'));
    if (!preview) fail('PREVIEW_EXPIRED', 'The requested preview does not exist or has expired.');
    if (preview.baseRevision !== this.revision) {
      this.previews.delete(previewId);
      fail('REVISION_CONFLICT', 'The project changed after this preview was created.', {
        expectedRevision: preview.baseRevision,
        actualRevision: this.revision,
      });
    }
    return {
      previewId: preview.previewId,
      baseRevision: preview.baseRevision,
      project: canonicalStudioV5Project(preview.project),
      evidence: clone(preview.evidence),
      documentHash: preview.changeSet.documentHashAfter,
      expiresAt: new Date(preview.expiresAtMs).toISOString(),
    };
  }

  synchronize(project, revision, entry = null) {
    this.project = prepareStudioV5RuntimeProject(project);
    this.revision = assertInteger(revision, 'revision', 0);
    this.previews.clear();
    if (entry) this.journal.push({ revision: this.revision, ...clone(entry), documentHash: studioV5CanonicalHash(this.project) });
    return this.snapshot();
  }

  capabilities(query = { detail: 'full' }) {
    return selectCadCapabilities(
      cadCapabilityManifest({
        exactKernel: Boolean(this.kernel),
        visibleStudio: this.visibleStudio,
        studioVersion: this.studioVersion,
      }),
      query,
    );
  }

  inspect(request = {}) {
    const kind = request.kind || 'project.summary';
    const project = this.project;
    const activePart = project.rootDocument.kind === 'part' ? studioV5RootPart(project) : null;
    const activeAssembly = project.rootDocument.kind === 'assembly' ? studioV5RootAssembly(project) : null;
    const allFeatures = project.partDefinitions.flatMap((part) => part.features || []);
    const allBodies = project.partDefinitions.flatMap((part) => part.bodies || []);
    const allOccurrences = project.assemblyDefinitions.flatMap((assembly) => assembly.occurrences || []);
    const allMates = project.assemblyDefinitions.flatMap((assembly) => assembly.mates || []);
    const allSmartFasteners = project.assemblyDefinitions.flatMap(
      (assembly) => assembly.extensions?.smartFasteners?.groups || [],
    );
    if (kind === 'project.summary') {
      return {
        projectId: project.projectId,
        revision: this.revision,
        name: project.name,
        units: project.units,
        schemaVersion: project.schemaVersion,
        documentKind: project.rootDocument.kind,
        counts: {
          parameters: project.parameters.length,
          parts: project.partDefinitions.length,
          assemblies: project.assemblyDefinitions.length,
          features: allFeatures.length,
          bodies: allBodies.length,
          sketches: project.partDefinitions.reduce((total, part) => total + (part.sketches?.length || 0), 0),
          sketchBlockDefinitions: project.partDefinitions.reduce((total, part) => total + (part.sketchBlockDefinitions?.length || 0), 0),
          sketchRelations: project.partDefinitions.reduce((total, part) => total + (part.sketches || []).reduce(
            (partTotal, sketch) => partTotal + (sketch.constrained?.relations?.length || 0), 0), 0),
          occurrences: allOccurrences.length,
          mates: allMates.length,
          smartFasteners: allSmartFasteners.length,
        },
        activeBodyId: activePart?.metadata?.activeBodyId || null,
        activeAssemblyId: activeAssembly?.id || null,
        documentHash: studioV5CanonicalHash(project),
      };
    }
    if (kind === 'project.tree') {
      const nodes = [
        { kind: 'project', id: project.projectId, name: project.name, parent: null },
        ...project.parameters.map((entry) => ({ kind: 'parameter', id: entry.id, name: entry.name, parent: { kind: 'project', id: project.projectId } })),
        ...project.partDefinitions.flatMap((part) => [
          { kind: 'part', id: part.id, name: part.name, parent: { kind: 'project', id: project.projectId } },
          ...part.referenceGeometry.map((entry) => ({ kind: 'datum', id: entry.id, name: entry.name, datumKind: entry.kind, parent: { kind: 'part', id: part.id } })),
          ...part.sketches.map((entry) => ({ kind: 'sketch', id: entry.id, name: entry.name, role: entry.extensions?.studioRole, parent: { kind: 'part', id: part.id } })),
          ...(part.sketchBlockDefinitions || []).map((entry) => ({ kind: 'sketch-block-definition', id: entry.id, name: entry.name, parent: { kind: 'part', id: part.id } })),
          ...part.sketches.flatMap((sketch) => (sketch.constrained?.blockInstances || []).map((entry) => ({
            kind: 'sketch-block-instance', id: entry.id, name: entry.id,
            definitionId: entry.definitionId, parent: { kind: 'sketch', id: sketch.id },
          }))),
          ...part.sketches.flatMap((sketch) => (sketch.constrained?.relations || []).map((entry) => ({
            kind: 'sketch-relation', id: entry.id, name: entry.id,
            relationKind: entry.kind, parent: { kind: 'sketch', id: sketch.id },
          }))),
          ...part.bodies.map((entry) => ({ kind: 'body', id: entry.id, name: entry.name, visible: entry.visible, suppressed: entry.suppressed, parent: { kind: 'part', id: part.id } })),
          ...part.features.map((entry) => ({ kind: 'feature', id: entry.id, name: entry.name, featureType: entry.type, suppressed: entry.suppressed, parent: { kind: 'part', id: part.id } })),
          ...(part.bodyPatterns || []).map((entry) => ({ kind: 'body-pattern', id: entry.id, name: entry.name, patternKind: entry.kind, parent: { kind: 'part', id: part.id } })),
        ]),
        ...project.assemblyDefinitions.flatMap((assembly) => [
          { kind: 'assembly', id: assembly.id, name: assembly.name, parent: { kind: 'project', id: project.projectId } },
          ...assembly.occurrences.map((entry) => ({ kind: 'occurrence', id: entry.id, name: entry.name, definition: clone(entry.definition), visible: entry.visible, suppressed: entry.suppressed, parent: { kind: 'assembly', id: assembly.id } })),
          ...assembly.mates.map((entry) => ({ kind: 'mate', id: entry.id, name: entry.name, mateKind: entry.kind, suppressed: entry.suppressed, parent: { kind: 'assembly', id: assembly.id } })),
          ...(assembly.extensions?.smartFasteners?.groups || []).map((entry) => ({
            kind: 'smart-fastener',
            id: entry.id,
            name: entry.name,
            designation: entry.target?.designation,
            targetOccurrenceId: entry.targetOccurrenceId,
            parent: { kind: 'assembly', id: assembly.id },
          })),
          ...(assembly.extensions?.assemblyFeatures?.features || []).map((entry) => ({
            kind: 'assembly-feature',
            id: entry.id,
            name: entry.name,
            featureKind: entry.kind,
            targetCount: entry.targets.length,
            suppressed: entry.suppressed,
            parent: { kind: 'assembly', id: assembly.id },
          })),
          ...(assembly.occurrencePatterns || []).map((entry) => ({ kind: 'occurrence-pattern', id: entry.id, name: entry.name, patternKind: entry.kind, parent: { kind: 'assembly', id: assembly.id } })),
          ...(assembly.sectionViews || []).map((entry) => ({ kind: 'section', id: entry.id, name: entry.name, sectionKind: entry.kind, parent: { kind: 'assembly', id: assembly.id } })),
          ...(assembly.explodedViews || []).map((entry) => ({ kind: 'exploded-view', id: entry.id, name: entry.name, parent: { kind: 'assembly', id: assembly.id } })),
          ...(assembly.metadata?.measurements || []).map((entry) => ({ kind: 'measurement', id: entry.id, name: entry.name, measurementKind: entry.kind, parent: { kind: 'assembly', id: assembly.id } })),
          ...(assembly.metadata?.axialStageGroups || []).map((entry) => ({ kind: 'stage-group', id: entry.id, name: entry.name, parent: { kind: 'assembly', id: assembly.id } })),
        ]),
      ];
      return paginate(nodes, request);
    }
    if (kind === 'entity.detail') {
      const entityKind = assertText(request.entity?.kind, 'entity.kind');
      const entityId = assertId(request.entity?.id, 'entity.id');
      const entry = canonicalEntityMap(project).get(entityKind + ':' + entityId);
      if (!entry) fail('MISSING_REFERENCE', entityKind + ' "' + entityId + '" does not exist.');
      return { entity: changedEntity(entry), value: clone(entry.value) };
    }
    if (kind === 'entity.dependencies') {
      return dependencyQuery(project, request);
    }
    if (kind === 'entity.search') {
      const query = String(request.query || '').trim().toLowerCase();
      const matches = [...canonicalEntityMap(project).values()]
        .filter((entry) => !query || entry.id.toLowerCase().includes(query) || String(entry.value?.name || '').toLowerCase().includes(query))
        .map(changedEntity);
      return paginate(matches, request);
    }
    if (kind === 'history.list') return paginate(this.journal.slice().reverse(), request);
    if (kind === 'history.changesSince') {
      const revision = assertInteger(request.revision, 'revision', 0);
      return paginate(this.journal.filter((entry) => entry.revision > revision), request);
    }
    fail('UNKNOWN_QUERY', 'Unknown inspection query "' + kind + '".');
  }

  async query(request = {}) {
    const kind = request.kind || 'geometry.validity';
    if (kind === 'sketch.solve') {
      // Stateless constraint solve: lets an agent iterate on a constrained
      // sketch (and read dof / diagnostics / closed loops) without touching
      // the document. Dimensions may reference project/part parameters.
      const constrained = assertRecord(request.sketch, 'query.sketch');
      const part = this.project.rootDocument?.kind === 'part' ? studioV5RootPart(this.project) : null;
      let parameters = new Map();
      try {
        parameters = part ? studioV5ParameterValues(this.project, part) : new Map();
      } catch {
        // Parameter problems surface per-dimension below instead.
      }
      const resolveDimension = (value) => evaluateStudioV5Expression(value, parameters);
      const resolvePierce = part ? createStudioV5PierceResolver(this.project, part.id) : undefined;
      const structural = validateConstraintSketch(constrained);
      if (structural.length) return { status: 'invalid', diagnostics: structural };
      const solved = solveSketch(constrained, { resolveDimension, resolvePierce });
      if (solved.status === 'invalid') return { status: 'invalid', diagnostics: solved.diagnostics };
      const loopResult = constraintSketchToLoops(constrained, { presolved: solved });
      const referenceDimensions = solved.status === 'ok'
        ? (constrained.constraints || [])
            .filter((constraint) => constraint.driving === false)
            .map((constraint, index) => ({
              id: constraint.id || constraint.kind + '#' + index,
              kind: constraint.kind,
              value: measureSketchDimension(constrained, constraint, { presolved: solved }),
            }))
        : [];
      return {
        status: solved.status,
        entities: solved.entities,
        dof: solved.dof,
        rank: solved.rank,
        equations: solved.equations,
        fullyDefined: solved.status === 'ok' && solved.dof === 0,
        iterations: solved.iterations,
        residual: solved.residual,
        diagnostics: [...solved.diagnostics, ...loopResult.diagnostics],
        loops: loopResult.loops,
        profilesClosed: loopResult.status === 'ok',
        referenceDimensions,
      };
    }
    if (kind === 'geometry.bodies' || kind === 'geometry.validity') {
      let evidence = this.lastEvidence;
      if (request.exact === true) {
        if (!this.kernel) fail('EXACT_KERNEL_REQUIRED', 'This session has no exact-kernel adapter.');
        const response = await this.kernel.validate(this.snapshot(), this.revision);
        if (response?.errors?.length) fail('KERNEL_VALIDATION_FAILED', response.errors[0].message, { kernelErrors: response.errors });
        evidence = evidenceFromKernel(response, true);
        this.lastEvidence = evidence;
      }
      return kind === 'geometry.bodies'
        ? paginate(evidence.bodyResults, request)
        : { exactGeometry: evidence.exactGeometry, valid: evidence.bodyResults.every((entry) => entry.valid), bodies: evidence.bodyResults };
    }
    return this.inspect(request);
  }

  prunePreviews() {
    const now = this.now();
    for (const [id, preview] of this.previews) if (preview.expiresAtMs <= now) this.previews.delete(id);
  }

  async preview(transaction, permissionContext, options = {}) {
    assertPermission(permissionContext, EDIT_PERMISSIONS, this.project.projectId, transaction?.operations?.map((entry) => entry.kind) || []);
    const expectedRevision = assertInteger(transaction?.expectedRevision, 'transaction.expectedRevision', 0);
    if (expectedRevision !== this.revision) fail('REVISION_CONFLICT', 'Expected project revision ' + expectedRevision + ' but current revision is ' + this.revision + '.', {
      expectedRevision,
      actualRevision: this.revision,
      changesSince: this.journal.filter((entry) => entry.revision > expectedRevision).slice(-20),
    });
    const baseRevision = this.revision;
    const baseProjectId = this.project.projectId;
    const baseDocumentHash = studioV5CanonicalHash(this.project);
    const bytes = new TextEncoder().encode(JSON.stringify(transaction)).byteLength;
    if (bytes > MAX_REQUEST_BYTES && options.trustedGenerated !== true) {
      fail('LIMIT_REQUEST_BYTES', 'Transaction exceeds the 1 MiB protocol request limit.');
    }
    let applied;
    try {
      applied = applyCadTransaction(this.project, transaction);
    } catch (error) {
      if (error instanceof CadAgentError) throw error;
      throw new CadAgentError(error?.code || 'DOCUMENT_VALIDATION_FAILED', String(error?.message || error));
    }
    let kernelResponse = null;
    if (this.kernel) {
      kernelResponse = await this.kernel.validate(applied.project, baseRevision);
      if (kernelResponse?.errors?.length) fail('KERNEL_VALIDATION_FAILED', kernelResponse.errors[0].message, { kernelErrors: kernelResponse.errors });
    }
    const actualDocumentHash = studioV5CanonicalHash(this.project);
    if (
      this.revision !== baseRevision ||
      this.project.projectId !== baseProjectId ||
      actualDocumentHash !== baseDocumentHash
    ) {
      fail('REVISION_CONFLICT', 'The project changed while the exact preview was being validated.', {
        expectedRevision: baseRevision,
        actualRevision: this.revision,
        expectedProjectId: baseProjectId,
        actualProjectId: this.project.projectId,
        expectedDocumentHash: baseDocumentHash,
        actualDocumentHash,
        changesSince: this.journal.filter((entry) => entry.revision > baseRevision).slice(-20),
      });
    }
    this.prunePreviews();
    const previewId = 'preview-' + (++this.previewSequence) + '-' + applied.changeSet.documentHashAfter;
    const expiresAtMs = this.now() + this.previewTtlMs;
    const preview = {
      previewId,
      transaction: clone(transaction),
      project: applied.project,
      aliases: applied.aliases,
      baseRevision,
      expiresAtMs,
      changeSet: applied.changeSet,
      evidence: evidenceFromKernel(kernelResponse, Boolean(this.kernel)),
    };
    this.previews.set(previewId, preview);
    return {
      previewId,
      baseRevision,
      expiresAt: new Date(expiresAtMs).toISOString(),
      changeSet: clone(preview.changeSet),
      validation: { valid: true, exactGeometry: Boolean(this.kernel), diagnostics: [] },
      evidence: clone(preview.evidence),
      confirmation: { required: preview.changeSet.deleted.length > 0, reasons: preview.changeSet.deleted.length ? ['DESTRUCTIVE_DELETE'] : [] },
    };
  }

  async commit(previewId, expectedRevision, permissionContext, options = {}) {
    const permission = assertPermission(permissionContext, EDIT_PERMISSIONS, this.project.projectId);
    this.prunePreviews();
    const requestedRevision = assertInteger(expectedRevision, 'expectedRevision', 0);
    if (requestedRevision !== this.revision) {
      fail('REVISION_CONFLICT', 'The project changed after this preview was created.', { expectedRevision: requestedRevision, actualRevision: this.revision });
    }
    const preview = this.previews.get(assertText(previewId, 'previewId'));
    if (!preview) fail('PREVIEW_EXPIRED', 'The requested preview does not exist or has expired.');
    if (preview.baseRevision !== this.revision) {
      this.previews.delete(previewId);
      fail('REVISION_CONFLICT', 'The project changed after this preview was created.', { expectedRevision: preview.baseRevision, actualRevision: this.revision });
    }
    if (Number.isInteger(permission.maxCommits) && permission.maxCommits === 0) fail('PERMISSION_BUDGET_EXCEEDED', 'The session commit budget has been exhausted.');
    const before = this.snapshot();
    const entry = {
      label: preview.transaction.label,
      actor: preview.transaction.metadata?.actor || options.actor || 'agent',
      transactionId: preview.transaction.transactionId,
      changeSet: clone(preview.changeSet),
    };
    let committedRevision = this.revision + 1;
    let adapterResult = null;
    if (this.commitAdapter) {
      adapterResult = await this.commitAdapter({
        project: clone(preview.project),
        baseRevision: this.revision,
        previewId,
        previewDocumentHash: preview.changeSet.documentHashAfter,
        requestId: options.requestId || null,
        ...entry,
      });
      if (adapterResult?.project) this.project = prepareStudioV5RuntimeProject(adapterResult.project);
      else this.project = prepareStudioV5RuntimeProject(preview.project);
      if (Number.isInteger(adapterResult?.revision)) committedRevision = adapterResult.revision;
    } else {
      this.project = prepareStudioV5RuntimeProject(preview.project);
      this.undoStack.push({ project: before, entry });
      this.redoStack.length = 0;
    }
    this.revision = committedRevision;
    if (Number.isInteger(permission.maxCommits)) permission.maxCommits--;
    this.lastEvidence = clone(preview.evidence);
    this.journal.push({ revision: this.revision, ...entry, documentHash: studioV5CanonicalHash(this.project) });
    this.previews.clear();
    const result = {
      revision: this.revision,
      projectId: this.project.projectId,
      changeSet: clone(preview.changeSet),
      evidence: clone(preview.evidence),
      aliases: clone(preview.aliases),
      historyEntry: { revision: this.revision, label: entry.label, actor: entry.actor, transactionId: entry.transactionId },
      ...(Number.isInteger(permission.maxCommits)
        ? { remainingCommits: permission.maxCommits }
        : {}),
      ...(adapterResult?.commitReceipt ? { commitReceipt: clone(adapterResult.commitReceipt) } : {}),
      ...(adapterResult?.settlement ? { settlement: clone(adapterResult.settlement) } : {}),
    };
    // A persistence/render barrier can fail after the authoritative document
    // mutation has already landed. Preserve that committed state and journal
    // entry, then return a typed, idempotently cached outcome that explicitly
    // says the mutation applied instead of pretending it rolled back.
    if (adapterResult?.settlementError) {
      fail('COMMIT_SETTLEMENT_FAILED', 'The CAD change committed, but one or more required settlement barriers failed.', {
        commitApplied: true,
        revision: this.revision,
        commitReceipt: result.commitReceipt || {
          previewId,
          transactionId: entry.transactionId,
          documentHash: studioV5CanonicalHash(this.project),
        },
        settlementError: clone(adapterResult.settlementError),
        ...(Number.isInteger(permission.maxCommits)
          ? { remainingCommits: permission.maxCommits }
          : {}),
        repairOptions: [{ kind: 'inspect-current-revision' }, { kind: 'retry-settlement' }],
      });
    }
    return result;
  }

  cancelPreview(previewId) {
    const existed = this.previews.delete(previewId);
    return { cancelled: existed };
  }

  async historyAction(request, permissionContext, options = {}) {
    const action = request.action || 'list';
    if (action === 'list' || action === 'changesSince') {
      assertPermission(permissionContext, READ_PERMISSIONS, this.project.projectId);
      return this.inspect(action === 'list'
        ? { ...request, kind: 'history.list' }
        : { ...request, kind: 'history.changesSince', revision: request.revision });
    }
    assertPermission(permissionContext, EDIT_PERMISSIONS, this.project.projectId);
    if (this.commitAdapter) {
      return this.commitAdapter({
        historyAction: action,
        expectedRevision: request.expectedRevision,
        requestId: options.requestId || null,
      });
    }
    if (assertInteger(request.expectedRevision, 'expectedRevision', 0) !== this.revision) fail('REVISION_CONFLICT', 'History command targets a stale project revision.');
    if (action === 'undo') {
      const command = this.undoStack.pop();
      if (!command) fail('NOTHING_TO_UNDO', 'There is no command to undo.');
      this.redoStack.push({ project: this.snapshot(), entry: command.entry });
      this.project = prepareStudioV5RuntimeProject(command.project);
    } else if (action === 'redo') {
      const command = this.redoStack.pop();
      if (!command) fail('NOTHING_TO_REDO', 'There is no command to redo.');
      this.undoStack.push({ project: this.snapshot(), entry: command.entry });
      this.project = prepareStudioV5RuntimeProject(command.project);
    } else fail('UNKNOWN_HISTORY_ACTION', 'Unknown history action "' + action + '".');
    this.revision++;
    this.previews.clear();
    this.journal.push({ revision: this.revision, label: action === 'undo' ? 'Undo' : 'Redo', actor: 'agent', documentHash: studioV5CanonicalHash(this.project) });
    return { revision: this.revision, project: this.snapshot(), documentHash: studioV5CanonicalHash(this.project) };
  }

  async request(envelope) {
    const startedAt = this.now();
    let requestId = envelope?.requestId;
    let sessionId = envelope?.sessionId;
    try {
      assertRecord(envelope, 'request');
      if (envelope.protocol !== CAD_AGENT_PROTOCOL) fail('UNSUPPORTED_PROTOCOL', 'This build supports only ' + CAD_AGENT_PROTOCOL + '.');
      requestId = assertText(envelope.requestId, 'request.requestId');
      sessionId = assertText(envelope.sessionId, 'request.sessionId');
      const cacheKey = sessionId + ':' + requestId;
      if (this.requestCache.has(cacheKey)) return clone(this.requestCache.get(cacheKey));
      const payload = assertRecord(envelope.payload, 'request.payload');
      let result;
      if (payload.kind === 'capabilities') result = this.capabilities(payload.capabilityQuery || { detail: 'full' });
      else if (payload.kind === 'inspect') {
        assertPermission(envelope.permissionContext, READ_PERMISSIONS, this.project.projectId);
        result = this.inspect(payload.query || {});
      } else if (payload.kind === 'query') {
        assertPermission(envelope.permissionContext, READ_PERMISSIONS, this.project.projectId);
        result = await this.query(payload.query || {});
      } else if (payload.kind === 'preview') result = await this.preview(payload.transaction, envelope.permissionContext);
      else if (payload.kind === 'commit') result = await this.commit(
        payload.previewId,
        envelope.expectedRevision,
        envelope.permissionContext,
        { ...payload, requestId, sessionId },
      );
      else if (payload.kind === 'cancelPreview') result = this.cancelPreview(payload.previewId);
      else if (payload.kind === 'history') {
        result = await this.historyAction(payload, envelope.permissionContext, { requestId });
      }
      else fail('UNKNOWN_REQUEST_KIND', 'Unknown CAD request kind "' + payload.kind + '".');
      const response = {
        protocol: CAD_AGENT_PROTOCOL,
        requestId,
        sessionId,
        projectId: this.project.projectId,
        revision: this.revision,
        status: 'ok',
        result,
        diagnostics: [],
        timing: { totalMs: Math.max(0, this.now() - startedAt) },
      };
      cacheResponse(this.requestCache, cacheKey, response);
      return response;
    } catch (error) {
      const status = error?.code === 'REVISION_CONFLICT' ? 'conflict' : 'error';
      const response = {
        protocol: CAD_AGENT_PROTOCOL,
        requestId: requestId || 'invalid-request',
        sessionId: sessionId || 'invalid-session',
        projectId: this.project.projectId,
        revision: this.revision,
        status,
        diagnostics: [diagnostic(error, error?.details?.operationIndex)],
        timing: { totalMs: Math.max(0, this.now() - startedAt) },
      };
      if (requestId && sessionId) cacheResponse(this.requestCache, sessionId + ':' + requestId, response);
      return response;
    }
  }
}

export function createCadAgentRequest(options) {
  return {
    protocol: CAD_AGENT_PROTOCOL,
    requestId: options.requestId,
    sessionId: options.sessionId,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(Number.isInteger(options.expectedRevision) ? { expectedRevision: options.expectedRevision } : {}),
    permissionContext: clone(options.permissionContext || { granted: [] }),
    payload: clone(options.payload),
  };
}
