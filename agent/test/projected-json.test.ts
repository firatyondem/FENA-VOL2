import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatFixedPoint,
  isNull,
  parseFixedPoint,
  ProjectedJsonError,
  readRawFields,
  readString,
  readUint,
} from '../src/airnode/projected-json.ts';
import { readFixture } from './helpers.ts';

test('reads a signed Nodary price with 18 decimals, without a float', () => {
  const { data } = readFixture('nodary-eth-usd-p0.json');
  assert.equal(readUint(data, 'price', 18), 2244695000000000000000n);
  assert.equal(readUint(data, 'updatedAt', 0), 1793381072608n);
});

test('reads a small DOGE price exactly', () => {
  const { data } = readFixture('nodary-doge-usd.json');
  assert.equal(readUint(data, 'price', 18), 75845000000000000n);
});

test('cuts off digits beyond the decimals toward zero', () => {
  assert.equal(parseFixedPoint('2443.959', 2), 244395n);
  assert.equal(parseFixedPoint('-1.239', 2), -123n);
  assert.equal(parseFixedPoint('0.0000001', 6), 0n);
});

test('keeps every digit of a large integer', () => {
  assert.equal(parseFixedPoint('123456789012345678901234567890', 0), 123456789012345678901234567890n);
});

test('reads the exponent form', () => {
  assert.equal(parseFixedPoint('7.5e-8', 18), 75000000000n);
  assert.equal(parseFixedPoint('1E3', 2), 100000n);
  assert.equal(parseFixedPoint('12e-1', 0), 1n);
});

test('reads a number written as a string', () => {
  assert.equal(readUint('{"price":"0.0005"}', 'price', 6), 500n);
});

test('rejects malformed numbers and negative unsigned values', () => {
  assert.throws(() => parseFixedPoint('1.', 2), ProjectedJsonError);
  assert.throws(() => parseFixedPoint('', 2), ProjectedJsonError);
  assert.throws(() => readUint('{"price":-1}', 'price', 0), ProjectedJsonError);
  assert.throws(() => readUint('{"price":"-0"}', 'price', 0), ProjectedJsonError);
});

test('reads strings with escapes and nested values as written', () => {
  const json = '{ "text" : "say \\"hi\\" to {all}, ok", "author":{"name":"a,b"}, "n" : null , "list":[1,[2,3]] }';
  const fields = readRawFields(json);
  assert.equal(readString(json, 'text'), 'say "hi" to {all}, ok');
  assert.equal(fields.get('author'), '{"name":"a,b"}');
  assert.equal(fields.get('list'), '[1,[2,3]]');
  assert.ok(isNull(json, 'n'));
});

test('names a missing field', () => {
  assert.throws(() => readUint('{"price":1}', 'updatedAt', 0), /"updatedAt" is missing/);
});

test('rejects data that is not an object', () => {
  assert.throws(() => readRawFields('[1,2]'), ProjectedJsonError);
  assert.throws(() => readRawFields('{"a":1'), ProjectedJsonError);
});

test('formats fixed-point values back to decimals', () => {
  assert.equal(formatFixedPoint(2244695000000000000000n, 18), '2244.695');
  assert.equal(formatFixedPoint(75845000000000000n, 18), '0.075845');
  assert.equal(formatFixedPoint(-150n, 2), '-1.5');
  assert.equal(formatFixedPoint(0n, 6), '0');
});
