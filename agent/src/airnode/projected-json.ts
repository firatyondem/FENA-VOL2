// Reads fields of a projected response, such as {"price":2244.695,"updatedAt":1793381072608}, the way the vault's
// ProjectedJson library reads them: numbers as written, cut to a fixed number of decimals, never through a float.

export class ProjectedJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectedJsonError';
  }
}

const isWhitespace = (char: string | undefined) => char === ' ' || char === '\n' || char === '\r' || char === '\t';

// Returns the index just past the string that starts at `start`, which is a double quote.
const skipString = (json: string, start: number) => {
  let index = start + 1;
  while (index < json.length) {
    const char = json[index];
    if (char === '\\') index += 2;
    else if (char === '"') return index + 1;
    else index += 1;
  }
  throw new ProjectedJsonError('Unterminated string');
};

// Returns the index just past the value that starts at `start`, nested objects and arrays included.
const skipValue = (json: string, start: number) => {
  if (json[start] === '"') return skipString(json, start);
  let depth = 0;
  let index = start;
  while (index < json.length) {
    const char = json[index];
    if (char === '"') {
      index = skipString(json, index);
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      if (depth === 0) return index;
      depth -= 1;
      if (depth === 0) return index + 1;
    } else if (char === ',' && depth === 0) return index;
    index += 1;
  }
  if (depth !== 0) throw new ProjectedJsonError('Unterminated object or array');
  return index;
};

// Every top-level field with its value exactly as written.
export const readRawFields = (json: string): Map<string, string> => {
  const fields = new Map<string, string>();
  let index = 0;
  const skipWhitespace = () => {
    while (isWhitespace(json[index])) index += 1;
  };
  skipWhitespace();
  if (json[index] !== '{') throw new ProjectedJsonError('The data is not a JSON object');
  index += 1;
  skipWhitespace();
  if (json[index] === '}') return fields;
  while (index < json.length) {
    skipWhitespace();
    if (json[index] !== '"') throw new ProjectedJsonError(`Expected a key at ${index}`);
    const keyEnd = skipString(json, index);
    const key = JSON.parse(json.slice(index, keyEnd)) as string;
    index = keyEnd;
    skipWhitespace();
    if (json[index] !== ':') throw new ProjectedJsonError(`Expected ':' after "${key}"`);
    index += 1;
    skipWhitespace();
    const valueEnd = skipValue(json, index);
    fields.set(key, json.slice(index, valueEnd).trim());
    index = valueEnd;
    skipWhitespace();
    if (json[index] === ',') {
      index += 1;
      continue;
    }
    if (json[index] === '}') return fields;
    throw new ProjectedJsonError(`Expected ',' or '}' after "${key}"`);
  }
  throw new ProjectedJsonError('Unterminated object');
};

const readField = (json: string, key: string) => {
  const raw = readRawFields(json).get(key);
  if (raw === undefined) throw new ProjectedJsonError(`The field "${key}" is missing`);
  return raw;
};

const NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

// Parses a JSON number into an integer with `decimals` decimal places, cutting off further digits toward zero, so
// "2443.959" with 2 decimals is 244395n. Accepts the exponent form that some serializers write for small numbers.
export const parseFixedPoint = (text: string, decimals: number): bigint => {
  const match = NUMBER.exec(text);
  if (!match) throw new ProjectedJsonError(`"${text}" is not a number`);
  const [, sign = '', whole = '', fraction = '', exponentText = '0'] = match;
  const digits = whole + fraction;
  // Position of the decimal point in `digits` once the exponent is applied.
  const point = whole.length + Number(exponentText);
  const shift = point + decimals;
  let magnitude: bigint;
  if (shift <= 0) magnitude = 0n;
  else if (shift >= digits.length) magnitude = BigInt(digits) * 10n ** BigInt(shift - digits.length);
  else magnitude = BigInt(digits.slice(0, shift));
  return sign === '-' ? -magnitude : magnitude;
};

// Formats an integer with `decimals` decimal places back into a decimal string, trimming trailing zeros.
export const formatFixedPoint = (value: bigint, decimals: number): string => {
  const negative = value < 0n;
  const magnitude = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = magnitude.slice(0, magnitude.length - decimals);
  const fraction = magnitude.slice(magnitude.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
};

// Like ProjectedJson.readUint: a number, or a string that holds one, that is not negative.
export const readUint = (json: string, key: string, decimals: number): bigint => {
  let raw = readField(json, key);
  if (raw.startsWith('"')) raw = JSON.parse(raw) as string;
  const value = parseFixedPoint(raw, decimals);
  if (value < 0n || raw.startsWith('-')) throw new ProjectedJsonError(`The field "${key}" is negative`);
  return value;
};

export const readString = (json: string, key: string): string => {
  const raw = readField(json, key);
  if (!raw.startsWith('"')) throw new ProjectedJsonError(`The field "${key}" is not a string`);
  return JSON.parse(raw) as string;
};

export const isNull = (json: string, key: string) => readField(json, key) === 'null';
