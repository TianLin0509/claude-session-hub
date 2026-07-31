'use strict';

const assert = require('assert');
const path = require('path');
const {
  normalizeCardFontSize,
  normalizeCardFontFamily,
  normalizeCardDisplayConfig,
} = require(path.join(__dirname, '..', 'core', 'card-display-config.js'));
const {
  CARD_FONT_STACKS,
  applyCardDisplaySettings,
} = require(path.join(__dirname, '..', 'renderer', 'card-display-settings.js'));
const {
  buildConfigJsonUpdate,
  toEditableConfig,
} = require(path.join(__dirname, '..', 'main', 'ipc', 'config-handlers.js'));

assert.strictEqual(normalizeCardFontSize(undefined), 15, 'default should be two px above the old 13px card body');
assert.strictEqual(normalizeCardFontSize(9), 13, 'font size must clamp to the readable lower bound');
assert.strictEqual(normalizeCardFontSize(99), 22, 'font size must clamp to the UI upper bound');
assert.strictEqual(normalizeCardFontFamily('serif'), 'serif');
assert.strictEqual(normalizeCardFontFamily('url(javascript:bad)'), 'system', 'font family is an enum, never raw CSS');
assert.deepStrictEqual(normalizeCardDisplayConfig({ cardFontSize: '18', cardFontFamily: 'mono' }), {
  cardFontSize: 18,
  cardFontFamily: 'mono',
});

const properties = new Map();
const document = {
  documentElement: {
    style: { setProperty(name, value) { properties.set(name, value); } },
  },
};
const applied = applyCardDisplaySettings(document, { cardFontSize: 19, cardFontFamily: 'yahei' });
assert.deepStrictEqual(applied, { cardFontSize: 19, cardFontFamily: 'yahei' });
assert.strictEqual(properties.get('--card-content-font-size'), '19px');
assert.strictEqual(properties.get('--card-content-font-family'), CARD_FONT_STACKS.yahei);

const editable = toEditableConfig({ cardFontSize: 18, cardFontFamily: 'serif' });
assert.strictEqual(editable.cardFontSize, 18);
assert.strictEqual(editable.cardFontFamily, 'serif');

const existing = { ui: { tool_fold_threshold: 11, card_font_size: 17, card_font_family: 'mono' } };
const preserved = buildConfigJsonUpdate(existing, {});
assert.strictEqual(preserved.ui.tool_fold_threshold, 11, 'unrelated UI settings must survive a partial save');
assert.strictEqual(preserved.ui.card_font_size, 17);
assert.strictEqual(preserved.ui.card_font_family, 'mono');
const updated = buildConfigJsonUpdate(existing, { cardFontSize: 200, cardFontFamily: 'serif' });
assert.strictEqual(updated.ui.card_font_size, 22);
assert.strictEqual(updated.ui.card_font_family, 'serif');

console.log('unit-card-display-settings.test.js OK');
