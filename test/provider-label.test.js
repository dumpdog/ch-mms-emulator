'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { providerLabel } = require('../emulator');

test('provider label: default, custom text, and none -> invisible default', () => {
  assert.deepStrictEqual([undefined, 'Library', 'none', 'NONE', '  '].map(providerLabel), ['­', 'Library', '­', '­', '­']);
});
