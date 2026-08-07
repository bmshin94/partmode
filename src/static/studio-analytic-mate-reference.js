// Exact and deterministic mate-frame signatures for analytic B-rep faces.
// Planes, cylinders, and spheres use OCCT analytic parameters directly. The
// bundled OCCT build does not bind gp_Cone, so conical axes are recovered from
// two exact parametric circles on the Geom_ConicalSurface.

const safeDelete = (value) => {
  try { value?.delete?.(); } catch {}
};

const add = (left, right) => left.map((value, index) => value + right[index]);
const subtract = (left, right) => left.map((value, index) => value - right[index]);
const multiply = (vector, scalar) => vector.map((value) => value * scalar);
const dot = (left, right) => left.reduce((total, value, index) => total + value * right[index], 0);
const cross = (left, right) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];
const magnitude = (vector) => Math.hypot(...vector);
const normalize = (vector, label) => {
  const size = magnitude(vector);
  if (!(size > 1e-10)) throw new Error(label + ' has zero length.');
  return multiply(vector, 1 / size);
};
const pointArray = (point) => [point.x ?? point.X?.() ?? point[0], point.y ?? point.Y?.() ?? point[1], point.z ?? point.Z?.() ?? point[2]].map(Number);

function solveThreeByThree(rows, values) {
  const matrix = rows.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    if (Math.abs(matrix[pivot][column]) <= 1e-12) throw new Error('Analytic surface circle is degenerate.');
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const scale = matrix[column][column];
    for (let index = column; index < 4; index++) matrix[column][index] /= scale;
    for (let row = 0; row < 3; row++) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let index = column; index < 4; index++) matrix[row][index] -= factor * matrix[column][index];
    }
  }
  return matrix.map((row) => row[3]);
}

function parametricPoint(face, u, v) {
  let point = null;
  try {
    point = face.pointOnSurface(u, v);
    const result = pointArray(point);
    if (result.length !== 3 || result.some((value) => !Number.isFinite(value))) throw new Error('Analytic surface returned a non-finite point.');
    return result;
  } finally {
    safeDelete(point);
  }
}

function circleAt(face, v) {
  const bounds = face.UVBounds;
  const span = bounds.uMax - bounds.uMin;
  if (!(span > 1e-8)) throw new Error('Analytic surface has no angular parameter span.');
  // Replicad's pointOnSurface takes normalized UV coordinates and maps them
  // through UVBounds internally.
  const points = [0, 1 / 3, 2 / 3].map((fraction) => parametricPoint(face, fraction, v));
  const ab = subtract(points[1], points[0]);
  const ac = subtract(points[2], points[0]);
  const normal = normalize(cross(ab, ac), 'analytic surface ring normal');
  const center = solveThreeByThree([
    multiply(ab, 2),
    multiply(ac, 2),
    normal,
  ], [
    dot(points[1], points[1]) - dot(points[0], points[0]),
    dot(points[2], points[2]) - dot(points[0], points[0]),
    dot(normal, points[0]),
  ]);
  return { center, radius: magnitude(subtract(points[0], center)), normal };
}

function coneGeometry(face) {
  const bounds = face.UVBounds;
  const vSpan = bounds.vMax - bounds.vMin;
  if (!(vSpan > 1e-8)) throw new Error('Conical face has no axial parameter span.');
  const first = circleAt(face, 0.25);
  const second = circleAt(face, 0.75);
  let direction = normalize(subtract(second.center, first.center), 'conical face axis');
  if (dot(direction, first.normal) < 0) direction = multiply(direction, -1);
  const axialSpan = dot(subtract(second.center, first.center), direction);
  const radiusDelta = second.radius - first.radius;
  const semiAngle = Math.atan2(Math.abs(radiusDelta), Math.abs(axialSpan));
  if (!(semiAngle > 1e-9 && semiAngle < Math.PI / 2 - 1e-9)) throw new Error('Conical face semi-angle is invalid.');
  const signedSlope = radiusDelta / axialSpan;
  const apex = add(first.center, multiply(direction, -first.radius / signedSlope));
  return { axisPoint: apex, axisDirection: direction, semiAngle, referenceRadius: first.radius };
}

function axisGeometry(surface) {
  let axis = null; let location = null; let direction = null;
  try {
    axis = surface.Axis();
    location = axis.Location();
    direction = axis.Direction();
    return {
      axisPoint: [location.X(), location.Y(), location.Z()],
      axisDirection: normalize([direction.X(), direction.Y(), direction.Z()], 'analytic face axis'),
    };
  } finally {
    safeDelete(direction); safeDelete(location); safeDelete(axis);
  }
}

export function createStudioAnalyticMateSignature(oc, face, quantize = (value) => value) {
  let center = null; let normal = null; let adaptor = null; let surface = null; let location = null;
  try {
    center = face.center;
    normal = face.normalAt();
    const signature = {
      p: pointArray(center).map(quantize),
      n: pointArray(normal).map(quantize),
    };
    if (face.geomType === 'PLANE') return { ...signature, topologyKind: 'planar-face' };
    adaptor = new oc.BRepAdaptor_Surface_2(face.wrapped, true);
    if (face.geomType === 'CYLINDRE' || face.geomType === 'CYLINDER') {
      surface = adaptor.Cylinder();
      const axis = axisGeometry(surface);
      return {
        ...signature,
        topologyKind: 'cylindrical-face',
        a: axis.axisPoint.map(quantize),
        d: axis.axisDirection.map(quantize),
        r: quantize(surface.Radius()),
      };
    }
    if (face.geomType === 'CONE') {
      const cone = coneGeometry(face);
      return {
        ...signature,
        topologyKind: 'conical-face',
        a: cone.axisPoint.map(quantize),
        d: cone.axisDirection.map(quantize),
        semiAngle: quantize(cone.semiAngle),
        r: quantize(cone.referenceRadius),
      };
    }
    if (face.geomType === 'SPHERE') {
      surface = adaptor.Sphere();
      location = surface.Location();
      return {
        ...signature,
        topologyKind: 'spherical-face',
        c: [location.X(), location.Y(), location.Z()].map(quantize),
        r: quantize(surface.Radius()),
      };
    }
    return { ...signature, topologyKind: 'face' };
  } finally {
    safeDelete(location); safeDelete(surface); safeDelete(adaptor); safeDelete(normal); safeDelete(center);
  }
}
