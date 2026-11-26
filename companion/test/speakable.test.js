const { test } = require('node:test');
const assert = require('node:assert/strict');
const { speakable } = require('../renderer/speakable.js');

test('homework maths is read as words, not symbols', () => {
  assert.equal(speakable('The answer is $\\frac{1}{2}$.'), 'The answer is 1 over 2.');
  assert.equal(speakable('So $x^2 + 3x - 4 = 0$ factors.'), 'So x squared plus 3x minus 4 equals 0 factors.');
  assert.equal(speakable('Use $\\sqrt{b^2 - 4ac}$ here'), 'Use the square root of b squared minus 4ac here');
  assert.equal(speakable('$$E = mc^2$$'), 'E equals mc squared');
  assert.equal(speakable('Then \\(a \\leq b\\) holds'), 'Then a is at most b holds');
  assert.equal(speakable('It is 2^{10} bytes'), 'It is 2 to the 10th bytes');
  assert.equal(speakable('$x_1 \\times \\pi$'), 'x sub 1 times pi');
  assert.equal(speakable('45° and x ≥ 3'), '45 degrees and x is at least 3');
});

test('markdown and links are read the way a person would say them', () => {
  assert.equal(speakable('## Steps\n- Open **Word**\n- Click `Insert`'), 'Steps Open Word. Click Insert.');
  assert.equal(speakable('See [the docs](https://example.com/a/b) or https://www.github.com/potlakai.'), 'See the docs or github.com.');
  assert.equal(speakable('Run this:\n```js\nconsole.log(1)\n```\nDone.'), 'Run this: The code is in the bubble. Done.');
  assert.equal(speakable('Click Save -> Export, e.g. as PDF 🎉'), 'Click Save to Export, for example, as PDF');
});

test('ordinary sentences, prices and decimals come through untouched', () => {
  for (const s of ['On it.', 'Let me look.', 'Hi, Pranav.', 'It costs $5 and $10 later.', 'Version 3.5 is out.', "It's 9:30, don't be late!"]) {
    assert.equal(speakable(s), s);
  }
  assert.equal(speakable('C++ and C# both work.'), 'C plus plus and C sharp both work.');
});

test('nothing in, nothing out', () => {
  assert.equal(speakable(''), '');
  assert.equal(speakable(null), '');
  assert.equal(speakable('```\nonly code\n```'), 'The code is in the bubble.');
});
