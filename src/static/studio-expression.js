// Safe, shared expression grammar for every PartMode document boundary.
// Geometry is canonical millimetres/degrees, so unit literals are normalized
// before callers receive a number. Trigonometric arguments and inverse results
// use degrees to match the application's existing angle fields.

export const STUDIO_EXPRESSION_UNITS = Object.freeze({
  mm: 1, cm: 10, m: 1000, um: 0.001,
  in: 25.4, inch: 25.4, ft: 304.8, mil: 0.0254,
  deg: 1, d: 1, rad: 180 / Math.PI,
});

const FUNCTION_ARITY = Object.freeze({
  sin: [1, 1], cos: [1, 1], tan: [1, 1], sec: [1, 1], cosec: [1, 1], cotan: [1, 1],
  asin: [1, 1], arcsin: [1, 1], acos: [1, 1], arccos: [1, 1], atan: [1, 1], atn: [1, 1],
  atan2: [2, 2], sqrt: [1, 1], sqr: [1, 1], abs: [1, 1], exp: [1, 1], log: [1, 1], ln: [1, 1],
  floor: [1, 1], ceil: [1, 1], round: [1, 1], int: [1, 1], trunc: [1, 1], sgn: [1, 1],
  min: [1, Number.POSITIVE_INFINITY], max: [1, Number.POSITIVE_INFINITY], pow: [2, 2],
  if: [3, 3], iif: [3, 3], clamp: [3, 3],
});

const degreesToRadians = (value) => value * Math.PI / 180;
const radiansToDegrees = (value) => value * 180 / Math.PI;

function evaluateFunction(name, args) {
  switch (name) {
    case 'sin': return Math.sin(degreesToRadians(args[0]));
    case 'cos': return Math.cos(degreesToRadians(args[0]));
    case 'tan': return Math.tan(degreesToRadians(args[0]));
    case 'sec': return 1 / Math.cos(degreesToRadians(args[0]));
    case 'cosec': return 1 / Math.sin(degreesToRadians(args[0]));
    case 'cotan': return 1 / Math.tan(degreesToRadians(args[0]));
    case 'asin': case 'arcsin': return radiansToDegrees(Math.asin(args[0]));
    case 'acos': case 'arccos': return radiansToDegrees(Math.acos(args[0]));
    case 'atan': case 'atn': return radiansToDegrees(Math.atan(args[0]));
    case 'atan2': return radiansToDegrees(Math.atan2(args[0], args[1]));
    case 'sqrt': case 'sqr': return Math.sqrt(args[0]);
    case 'abs': return Math.abs(args[0]);
    case 'exp': return Math.exp(args[0]);
    case 'log': case 'ln': return Math.log(args[0]);
    case 'floor': return Math.floor(args[0]);
    case 'ceil': return Math.ceil(args[0]);
    case 'round': return Math.round(args[0]);
    case 'int': case 'trunc': return Math.trunc(args[0]);
    case 'sgn': return Math.sign(args[0]);
    case 'min': return Math.min(...args);
    case 'max': return Math.max(...args);
    case 'pow': return Math.pow(args[0], args[1]);
    case 'if': case 'iif': return args[0] ? args[1] : args[2];
    case 'clamp': return Math.min(Math.max(args[0], args[1]), args[2]);
    default: throw new Error('unknown function "' + name + '"');
  }
}

export function parseStudioExpression(input, options = {}) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error((options.path || 'Expression') + ' must be finite.');
    return { dependencies: new Set(), evaluate: () => input };
  }
  const source = String(input);
  const path = options.path || 'Expression';
  const allowedNames = options.allowedNames || null;
  const dependencies = new Set();
  let index = 0;
  const fail = (message) => { throw new Error(path + ' ' + message); };
  const skip = () => { while (/\s/.test(source[index] || '')) index++; };
  const identifier = () => {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
    if (!match) return null;
    index += match[0].length;
    return match[0];
  };

  function primary() {
    skip();
    if (source[index] === '(') {
      index++;
      const inner = comparison();
      skip();
      if (source[index] !== ')') fail('has an unmatched parenthesis.');
      index++;
      return inner;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (number) {
      index += number[0].length;
      const numeric = Number(number[0]);
      return () => numeric;
    }
    const name = identifier();
    if (!name) fail('contains unsupported syntax at character ' + (index + 1) + '.');
    const normalized = name.toLowerCase();
    skip();
    if (source[index] === '(') {
      if (!Object.prototype.hasOwnProperty.call(FUNCTION_ARITY, normalized)) fail('uses unknown function "' + name + '".');
      index++;
      const args = [];
      skip();
      if (source[index] !== ')') {
        for (;;) {
          args.push(comparison());
          skip();
          if (source[index] !== ',') break;
          index++;
        }
      }
      if (source[index] !== ')') fail('has an unmatched function parenthesis.');
      index++;
      const [minimum, maximum] = FUNCTION_ARITY[normalized];
      if (args.length < minimum || args.length > maximum) {
        fail('uses ' + name + ' with ' + args.length + ' argument(s); expected '
          + (minimum === maximum ? minimum : minimum + ' or more') + '.');
      }
      return (resolve) => evaluateFunction(normalized, args.map((argument) => argument(resolve)));
    }
    if (!allowedNames?.has(name)) {
      if (normalized === 'pi') return () => Math.PI;
      if (normalized === 'e') return () => Math.E;
      if (allowedNames) fail('references unknown parameter "' + name + '".');
    }
    dependencies.add(name);
    return (resolve) => {
      const value = resolve(name);
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(path + ' parameter "' + name + '" is not finite.');
      return value;
    };
  }

  function postfix() {
    let evaluate = primary();
    const beforeUnit = index;
    skip();
    const unitName = identifier();
    if (unitName && Object.prototype.hasOwnProperty.call(STUDIO_EXPRESSION_UNITS, unitName.toLowerCase())) {
      const factor = STUDIO_EXPRESSION_UNITS[unitName.toLowerCase()];
      const operand = evaluate;
      evaluate = (resolve) => operand(resolve) * factor;
    } else {
      index = beforeUnit;
    }
    return evaluate;
  }

  function power() {
    let evaluate = postfix();
    skip();
    if (source[index] === '^') {
      index++;
      const left = evaluate;
      const right = unary();
      evaluate = (resolve) => Math.pow(left(resolve), right(resolve));
    }
    return evaluate;
  }

  function unary() {
    skip();
    if (source[index] === '+' || source[index] === '-') {
      const sign = source[index++] === '-' ? -1 : 1;
      const operand = unary();
      return (resolve) => sign * operand(resolve);
    }
    return power();
  }

  function term() {
    let evaluate = unary();
    for (;;) {
      skip();
      const operator = source[index];
      if (operator !== '*' && operator !== '/') return evaluate;
      index++;
      const left = evaluate;
      const right = unary();
      evaluate = operator === '*'
        ? (resolve) => left(resolve) * right(resolve)
        : (resolve) => left(resolve) / right(resolve);
    }
  }

  function expression() {
    let evaluate = term();
    for (;;) {
      skip();
      const operator = source[index];
      if (operator !== '+' && operator !== '-') return evaluate;
      index++;
      const left = evaluate;
      const right = term();
      evaluate = operator === '+'
        ? (resolve) => left(resolve) + right(resolve)
        : (resolve) => left(resolve) - right(resolve);
    }
  }

  function comparison() {
    let evaluate = expression();
    skip();
    const operator = /^(?:<=|>=|==|!=|<|>)/.exec(source.slice(index))?.[0];
    if (!operator) return evaluate;
    index += operator.length;
    const left = evaluate;
    const right = expression();
    evaluate = (resolve) => {
      const a = left(resolve); const b = right(resolve);
      if (operator === '<') return a < b ? 1 : 0;
      if (operator === '<=') return a <= b ? 1 : 0;
      if (operator === '>') return a > b ? 1 : 0;
      if (operator === '>=') return a >= b ? 1 : 0;
      if (operator === '==') return a === b ? 1 : 0;
      return a !== b ? 1 : 0;
    };
    return evaluate;
  }

  const evaluateNode = comparison();
  skip();
  if (index !== source.length) fail('contains unsupported syntax at character ' + (index + 1) + '.');
  return {
    dependencies,
    evaluate(resolve = () => undefined) {
      const result = evaluateNode(resolve);
      if (!Number.isFinite(result)) throw new Error(path + ' must evaluate to a finite number.');
      return result;
    },
  };
}

export function evaluateStudioExpression(input, params = {}, options = {}) {
  const parseOptions = typeof params === 'function' || options.allowedNames
    ? options
    : { ...options, allowedNames: new Set(Object.keys(params)) };
  const resolve = typeof params === 'function'
    ? params
    : (name) => {
        if (!Object.prototype.hasOwnProperty.call(params, name)) throw new Error((options.path || 'Expression') + ' references unknown parameter "' + name + '".');
        return params[name];
      };
  return parseStudioExpression(input, parseOptions).evaluate(resolve);
}
