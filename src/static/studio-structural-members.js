export const STUDIO_STRUCTURAL_MEMBER_SCHEMA = 'partmode.structural-member/v1';
export const STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA = 'partmode.structural-profile-library/v1';

export const STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION = 1;
const EPSILON = 1e-9;
const ANTIPARALLEL_FRAME_EPSILON = 1e-8;
const clone = (value) => JSON.parse(JSON.stringify(value));
const owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);

export const STUDIO_STRUCTURAL_PROFILE_SOURCE = Object.freeze({
  id: 'partmode-generic-metric-structural-profiles',
  title: 'PartMode generic metric structural profiles',
  edition: '1',
  status: 'unstandardized nominal design aid',
});

const preset = (id, designation, dimensions) => Object.freeze({ id, designation, dimensions: Object.freeze({ ...dimensions }) });

const FAMILIES = Object.freeze([
  Object.freeze({
    id: 'rectangular-bar',
    name: 'Rectangular bar',
    dimensionKeys: Object.freeze(['width', 'height']),
    presets: Object.freeze([
      preset('rect-20x10', 'RECT 20 × 10', { width: 20, height: 10 }),
      preset('rect-40x20', 'RECT 40 × 20', { width: 40, height: 20 }),
      preset('rect-60x30', 'RECT 60 × 30', { width: 60, height: 30 }),
    ]),
  }),
  Object.freeze({
    id: 'equal-angle',
    name: 'Equal angle',
    dimensionKeys: Object.freeze(['width', 'height', 'thickness']),
    presets: Object.freeze([
      preset('angle-30x30x3', 'L 30 × 30 × 3', { width: 30, height: 30, thickness: 3 }),
      preset('angle-40x40x4', 'L 40 × 40 × 4', { width: 40, height: 40, thickness: 4 }),
      preset('angle-50x50x5', 'L 50 × 50 × 5', { width: 50, height: 50, thickness: 5 }),
    ]),
  }),
  Object.freeze({
    id: 'channel',
    name: 'Channel',
    dimensionKeys: Object.freeze(['width', 'height', 'thickness']),
    presets: Object.freeze([
      preset('channel-50x25x4', 'C 50 × 25 × 4', { height: 50, width: 25, thickness: 4 }),
      preset('channel-80x40x5', 'C 80 × 40 × 5', { height: 80, width: 40, thickness: 5 }),
      preset('channel-100x50x6', 'C 100 × 50 × 6', { height: 100, width: 50, thickness: 6 }),
    ]),
  }),
  Object.freeze({
    id: 'i-section',
    name: 'I section',
    dimensionKeys: Object.freeze(['width', 'height', 'webThickness', 'flangeThickness']),
    presets: Object.freeze([
      preset('i-80x40x5', 'I 80 × 40 × 5', { height: 80, width: 40, webThickness: 5, flangeThickness: 5 }),
      preset('i-100x50x6', 'I 100 × 50 × 6', { height: 100, width: 50, webThickness: 6, flangeThickness: 6 }),
      preset('i-120x60x6', 'I 120 × 60 × 6', { height: 120, width: 60, webThickness: 6, flangeThickness: 6 }),
    ]),
  }),
  Object.freeze({
    id: 'tee',
    name: 'T section',
    dimensionKeys: Object.freeze(['width', 'height', 'webThickness', 'flangeThickness']),
    presets: Object.freeze([
      preset('tee-50x40x5', 'T 50 × 40 × 5', { height: 50, width: 40, webThickness: 5, flangeThickness: 5 }),
      preset('tee-70x50x6', 'T 70 × 50 × 6', { height: 70, width: 50, webThickness: 6, flangeThickness: 6 }),
      preset('tee-90x60x6', 'T 90 × 60 × 6', { height: 90, width: 60, webThickness: 6, flangeThickness: 6 }),
    ]),
  }),
]);

export const STUDIO_STRUCTURAL_PROFILE_FAMILIES = FAMILIES;
export const STUDIO_STRUCTURAL_PROFILE_ANCHORS = Object.freeze([
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]);

const familyById = new Map(FAMILIES.map((family) => [family.id, family]));

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= EPSILON || number > 10_000) {
    throw new Error(label + ' must be greater than zero and at most 10,000 mm.');
  }
  return number;
}

function profileFamily(familyId) {
  const family = familyById.get(familyId);
  if (!family) throw new Error('Unknown structural profile family "' + String(familyId) + '".');
  return family;
}

function profilePreset(family, presetId) {
  const selected = family.presets.find((entry) => entry.id === presetId);
  if (!selected) throw new Error('Unknown structural profile preset "' + String(presetId) + '" for ' + family.name + '.');
  return selected;
}

function profileDimensions(family, dimensions) {
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) throw new Error('Structural profile dimensions must be an object.');
  const keys = Object.keys(dimensions).sort();
  const expected = [...family.dimensionKeys].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error(family.name + ' dimensions must contain exactly ' + expected.join(', ') + '.');
  const result = Object.fromEntries(family.dimensionKeys.map((key) => [key, finitePositive(dimensions[key], family.name + ' ' + key)]));
  const thicknesses = [result.thickness, result.webThickness, result.flangeThickness].filter((value) => value !== undefined);
  if (thicknesses.some((value) => value * 2 >= result.width || value * 2 >= result.height)) {
    throw new Error(family.name + ' thickness must remain below half of both overall dimensions.');
  }
  return result;
}

function rawProfilePoints(familyId, dimensions) {
  const { width: w, height: h } = dimensions;
  const x = w / 2;
  const y = h / 2;
  if (familyId === 'rectangular-bar') return [[-x, -y], [x, -y], [x, y], [-x, y]];
  if (familyId === 'equal-angle') {
    const t = dimensions.thickness;
    return [[-x, -y], [x, -y], [x, -y + t], [-x + t, -y + t], [-x + t, y], [-x, y]];
  }
  if (familyId === 'channel') {
    const t = dimensions.thickness;
    return [[-x, -y], [x, -y], [x, -y + t], [-x + t, -y + t], [-x + t, y - t], [x, y - t], [x, y], [-x, y]];
  }
  if (familyId === 'i-section') {
    const web = dimensions.webThickness / 2;
    const flange = dimensions.flangeThickness;
    return [
      [-x, -y], [x, -y], [x, -y + flange], [web, -y + flange], [web, y - flange], [x, y - flange],
      [x, y], [-x, y], [-x, y - flange], [-web, y - flange], [-web, -y + flange], [-x, -y + flange],
    ];
  }
  if (familyId === 'tee') {
    const web = dimensions.webThickness / 2;
    const flange = dimensions.flangeThickness;
    return [[-x, y], [x, y], [x, y - flange], [web, y - flange], [web, -y], [-web, -y], [-web, y - flange], [-x, y - flange]];
  }
  throw new Error('Structural profile polygon is unavailable.');
}

const signedArea = (points) => points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length];
  return sum + point[0] * next[1] - next[0] * point[1];
}, 0) / 2;

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  return ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON));
}

function validatePolygon(points, label) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 64) throw new Error(label + ' must contain 3 to 64 polygon points.');
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    if (!Array.isArray(point) || point.length !== 2 || point.some((value) => !Number.isFinite(value))) throw new Error(label + ' contains a non-finite point.');
    if (Math.hypot(next[0] - point[0], next[1] - point[1]) <= EPSILON) throw new Error(label + ' contains a zero-length edge.');
  }
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      if (right === left + 1 || (left === 0 && right === points.length - 1)) continue;
      if (segmentsIntersect(points[left], points[(left + 1) % points.length], points[right], points[(right + 1) % points.length])) {
        throw new Error(label + ' self-intersects.');
      }
    }
  }
  const area = signedArea(points);
  if (Math.abs(area) <= EPSILON) throw new Error(label + ' has zero area.');
  return area < 0 ? [...points].reverse() : points;
}

function placementRecord(input = {}) {
  const anchor = owns(input, 'anchor') ? input.anchor : 'center';
  if (!STUDIO_STRUCTURAL_PROFILE_ANCHORS.includes(anchor)) throw new Error('Structural profile anchor is unsupported.');
  const rotationDegrees = Number(owns(input, 'rotationDegrees') ? input.rotationDegrees : 0);
  if (!Number.isFinite(rotationDegrees) || Math.abs(rotationDegrees) > 360_000) throw new Error('Structural profile rotation must be a finite angle.');
  const offset = clone(owns(input, 'offset') ? input.offset : [0, 0]);
  if (!Array.isArray(offset) || offset.length !== 2 || offset.some((value) => !Number.isFinite(Number(value)))) {
    throw new Error('Structural profile offset must contain two finite millimetre values.');
  }
  return { anchor, rotationDegrees, offset: offset.map(Number) };
}

function anchorPoint(bounds, anchor) {
  const [minX, minY, maxX, maxY] = bounds;
  const x = anchor.endsWith('left') ? minX : anchor.endsWith('right') ? maxX : (minX + maxX) / 2;
  const y = anchor.startsWith('top') ? maxY : anchor.startsWith('bottom') ? minY : (minY + maxY) / 2;
  return [x, y];
}

function placedPoints(rawPoints, placement) {
  const xs = rawPoints.map((point) => point[0]);
  const ys = rawPoints.map((point) => point[1]);
  const anchor = anchorPoint([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], placement.anchor);
  const angle = placement.rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return rawPoints.map(([x, y]) => {
    const localX = x - anchor[0] + placement.offset[0];
    const localY = y - anchor[1] + placement.offset[1];
    return [localX * cosine - localY * sine, localX * sine + localY * cosine];
  });
}

export function studioStructuralProfile(familyId, presetId, placementInput = {}) {
  const family = profileFamily(familyId);
  const selected = profilePreset(family, presetId);
  const dimensions = profileDimensions(family, selected.dimensions);
  const placement = placementRecord(placementInput);
  const rawPoints = validatePolygon(rawProfilePoints(family.id, dimensions), selected.designation + ' profile');
  const points = validatePolygon(placedPoints(rawPoints, placement), selected.designation + ' placed profile');
  return {
    schema: STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA,
    catalogVersion: STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION,
    source: clone(STUDIO_STRUCTURAL_PROFILE_SOURCE),
    familyId: family.id,
    familyName: family.name,
    presetId: selected.id,
    designation: selected.designation,
    dimensions,
    placement,
    points,
    area: Math.abs(signedArea(points)),
  };
}

export function assertStudioStructuralMemberId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id) || id.length > 120) {
    throw new Error('Structural-member ID must contain 1 to 120 safe identifier characters.');
  }
  return id;
}

export function studioStructuralMemberOwnedIds(id) {
  assertStudioStructuralMemberId(id);
  return { profilePlaneId: id + '-profile-plane', profileSketchId: id + '-profile-sketch' };
}

export function studioStructuralMemberRecipe(featureId, pathSketchId, profile, ids, profileFrame) {
  assertStudioStructuralMemberId(featureId);
  return {
    schema: STUDIO_STRUCTURAL_MEMBER_SCHEMA,
    version: 1,
    catalog: {
      schema: STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA,
      version: STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION,
      source: clone(STUDIO_STRUCTURAL_PROFILE_SOURCE),
    },
    familyId: profile.familyId,
    presetId: profile.presetId,
    designation: profile.designation,
    dimensions: clone(profile.dimensions),
    profileArea: profile.area,
    pathSketchId,
    profilePlaneId: ids.profilePlaneId,
    profileSketchId: ids.profileSketchId,
    profileFrame: clone(profileFrame),
    placement: clone(profile.placement),
    pathPolicy: 'exact-two-point-single-segment',
    cornerPolicy: 'single-member-without-trim-or-corner-treatment',
    complianceStatus: 'generic-profile-design-aid-not-manufacturing-certification',
    featureId,
  };
}

function exactKeys(record, keys, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(label + ' must be an object.');
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ' contains unsupported fields.');
}

export function assertStudioStructuralMemberFeature(feature, path = 'feature') {
  if (!feature || feature.type !== 'sweep') throw new Error(path + ' must be an exact Sweep feature.');
  const recipe = feature.extensions?.structuralMember;
  exactKeys(recipe, [
    'schema', 'version', 'catalog', 'familyId', 'presetId', 'designation', 'dimensions', 'profileArea',
    'pathSketchId', 'profilePlaneId', 'profileSketchId', 'profileFrame', 'placement', 'pathPolicy', 'cornerPolicy',
    'complianceStatus', 'featureId',
  ], path + '.extensions.structuralMember');
  if (recipe.schema !== STUDIO_STRUCTURAL_MEMBER_SCHEMA || recipe.version !== 1) throw new Error(path + ' structural-member schema is unsupported.');
  exactKeys(recipe.catalog, ['schema', 'version', 'source'], path + '.extensions.structuralMember.catalog');
  exactKeys(recipe.catalog.source, ['id', 'title', 'edition', 'status'], path + '.extensions.structuralMember.catalog.source');
  if (recipe.catalog.schema !== STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA || recipe.catalog.version !== STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION
    || JSON.stringify(recipe.catalog.source) !== JSON.stringify(STUDIO_STRUCTURAL_PROFILE_SOURCE)) throw new Error(path + ' structural profile catalog provenance is invalid.');
  const profile = studioStructuralProfile(recipe.familyId, recipe.presetId, recipe.placement);
  exactKeys(recipe.placement, ['anchor', 'rotationDegrees', 'offset'], path + '.extensions.structuralMember.placement');
  if (recipe.designation !== profile.designation || JSON.stringify(recipe.dimensions) !== JSON.stringify(profile.dimensions)
    || typeof recipe.profileArea !== 'number' || !Number.isFinite(recipe.profileArea)
    || Math.abs(recipe.profileArea - profile.area) > 1e-8
    || JSON.stringify(recipe.placement) !== JSON.stringify(profile.placement)) {
    throw new Error(path + ' structural profile recipe does not match the catalog preset.');
  }
  if (recipe.featureId !== feature.id || recipe.pathSketchId !== feature.pathSketchId || recipe.profileSketchId !== feature.profileSketchId) {
    throw new Error(path + ' structural-member owned references do not match the Sweep feature.');
  }
  const ownedIds = studioStructuralMemberOwnedIds(feature.id);
  if (recipe.profilePlaneId !== ownedIds.profilePlaneId || recipe.profileSketchId !== ownedIds.profileSketchId) {
    throw new Error(path + ' structural-member owned IDs are not derived from the feature ID.');
  }
  exactKeys(recipe.profileFrame, ['normal', 'xDirection'], path + '.extensions.structuralMember.profileFrame');
  for (const [key, vector] of Object.entries(recipe.profileFrame)) {
    if (!Array.isArray(vector) || vector.length !== 3 || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(path + ' structural-member profileFrame.' + key + ' must contain three finite numbers.');
    }
    if (Math.abs(Math.hypot(...vector) - 1) > 1e-8) throw new Error(path + ' structural-member profileFrame.' + key + ' must be normalized.');
  }
  if (Math.abs(recipe.profileFrame.normal.reduce((sum, value, index) => sum + value * recipe.profileFrame.xDirection[index], 0)) > 1e-8) {
    throw new Error(path + ' structural-member profile frame must be orthogonal.');
  }
  if (feature.orientation !== 'minimum-twist' || JSON.stringify(feature.referenceDirection) !== JSON.stringify([0, 0, 1])
    || feature.transition !== 'right' || Number(feature.twistAngle) !== 0
    || Number(feature.scaleEnd) !== 1 || feature.resultPolicy?.kind !== 'new-body') {
    throw new Error(path + ' structural member must remain a unit-scale, untwisted, new-body exact Sweep.');
  }
  if (recipe.pathPolicy !== 'exact-two-point-single-segment'
    || recipe.cornerPolicy !== 'single-member-without-trim-or-corner-treatment'
    || recipe.complianceStatus !== 'generic-profile-design-aid-not-manufacturing-certification') {
    throw new Error(path + ' structural-member policy evidence is invalid.');
  }
  return clone(recipe);
}

export function assertStudioStructuralMemberPart(part, feature, path = 'part', evaluate = (value) => Number(value)) {
  const recipe = assertStudioStructuralMemberFeature(feature, path + '.feature');
  const plane = part.referenceGeometry?.find((entry) => entry.id === recipe.profilePlaneId);
  const profileSketch = part.sketches?.find((entry) => entry.id === recipe.profileSketchId);
  const pathSketch = part.sketches?.find((entry) => entry.id === recipe.pathSketchId);
  if (!pathSketch || pathSketch.extensions?.studioRole !== 'path' || pathSketch.extensions?.referenceCurve
    || pathSketch.entities?.length !== 1 || pathSketch.entities[0].kind !== 'polyline'
    || pathSketch.entities[0].closed !== false || pathSketch.entities[0].points?.length !== 2) {
    throw new Error(path + ' structural member requires one direct two-point polyline path.');
  }
  const evaluatedPath = pathSketch.entities[0].points.map((point, pointIndex) => {
    if (!Array.isArray(point) || point.length !== 3) throw new Error(path + ' structural path point must contain three coordinates.');
    return point.map((value, axis) => {
      const number = Number(evaluate(value, path + '.path[' + pointIndex + '][' + axis + ']'));
      if (!Number.isFinite(number)) throw new Error(path + ' structural path coordinate must evaluate to a finite number.');
      return number;
    });
  });
  const pathDelta = evaluatedPath[1].map((value, axis) => value - evaluatedPath[0][axis]);
  const pathLength = Math.hypot(...pathDelta);
  if (pathLength <= 1e-7) {
    throw new Error(path + ' structural-member path cannot be zero length.');
  }
  const currentTangent = pathDelta.map((value) => value / pathLength);
  const referenceNormal = recipe.profileFrame.normal;
  const frameAlignment = referenceNormal.reduce((sum, value, index) => sum + value * currentTangent[index], 0);
  if (frameAlignment <= -1 + ANTIPARALLEL_FRAME_EPSILON) {
    throw new Error(path + ' structural-member path reverses 180 degrees from its persisted reference frame.');
  }
  exactKeys(plane?.definition, [
    'mode', 'curveSketchId', 'parameter', 'referenceNormal', 'referenceXDirection',
  ], path + '.profilePlane.definition');
  if (!plane || plane.kind !== 'plane' || plane.suppressed === true || plane.extensions?.structuralMemberOwnerId !== feature.id
    || plane.definition?.mode !== 'curve-normal' || plane.definition?.curveSketchId !== recipe.pathSketchId
    || Number(evaluate(plane.definition.parameter, path + '.profilePlane.parameter')) !== 0
    || JSON.stringify(plane.definition?.referenceNormal) !== JSON.stringify(recipe.profileFrame.normal)
    || JSON.stringify(plane.definition?.referenceXDirection) !== JSON.stringify(recipe.profileFrame.xDirection)) {
    throw new Error(path + ' structural-member profile plane is missing or detached from its path and reference frame.');
  }
  if (!profileSketch || profileSketch.extensions?.studioRole !== 'profile'
    || profileSketch.extensions?.structuralMemberOwnerId !== feature.id
    || profileSketch.support?.ownerKind !== 'datum' || profileSketch.support?.ownerId !== recipe.profilePlaneId
    || profileSketch.support?.semanticPath?.role !== 'support' || profileSketch.support?.signature?.kind !== 'plane') {
    throw new Error(path + ' structural-member profile sketch is missing or detached.');
  }
  const expected = studioStructuralProfile(recipe.familyId, recipe.presetId, recipe.placement);
  if (profileSketch.entities?.length !== 1 || profileSketch.entities[0].id !== 'entity-' + recipe.profileSketchId
    || profileSketch.entities[0].kind !== 'polyline'
    || profileSketch.entities[0].closed !== true
    || JSON.stringify(profileSketch.entities[0].points) !== JSON.stringify(expected.points)) {
    throw new Error(path + ' structural-member profile sketch no longer matches its catalog recipe.');
  }
  const structuralInputs = [
    [recipe.profileSketchId, 'profile'],
    [recipe.pathSketchId, 'path'],
  ];
  if (!Array.isArray(feature.inputRefs) || feature.inputRefs.length !== structuralInputs.length
    || structuralInputs.some(([ownerId, role]) => {
      const matches = feature.inputRefs.filter((reference) => reference?.ownerKind === 'sketch' && reference.ownerId === ownerId);
      return matches.length !== 1 || matches[0].semanticPath?.role !== role || matches[0].signature?.role !== role;
    })) {
    throw new Error(path + ' structural-member Sweep inputs are detached from the owned profile or authored path.');
  }
  const library = part.extensions?.structuralProfileLibrary;
  exactKeys(library, ['schema', 'version', 'source'], path + '.extensions.structuralProfileLibrary');
  exactKeys(library?.source, ['id', 'title', 'edition', 'status'], path + '.extensions.structuralProfileLibrary.source');
  if (library?.schema !== STUDIO_STRUCTURAL_PROFILE_LIBRARY_SCHEMA
    || library.version !== STUDIO_STRUCTURAL_PROFILE_CATALOG_VERSION
    || JSON.stringify(library.source) !== JSON.stringify(STUDIO_STRUCTURAL_PROFILE_SOURCE)) {
    throw new Error(path + ' structural profile library provenance is missing from the part.');
  }
  return { recipe, profile: expected, evaluatedPath, currentTangent };
}
