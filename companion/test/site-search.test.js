const test = require('node:test');
const assert = require('node:assert');
const { siteSearch } = require('../src/reflex/router');

test('a search named for a site runs on that site, the name cut from the query', () => {
  assert.deepStrictEqual(siteSearch('on YouTube. For music'), { site: 'youtube', query: 'music', url: 'https://www.youtube.com/results?search_query=music' });
  assert.deepStrictEqual(siteSearch('youtube for lofi beats'), { site: 'youtube', query: 'lofi beats', url: 'https://www.youtube.com/results?search_query=lofi%20beats' });
  assert.deepStrictEqual(siteSearch('cheap desks on Amazon'), { site: 'amazon', query: 'cheap desks', url: 'https://www.amazon.com/s?k=cheap%20desks' });
  assert.strictEqual(siteSearch('amazon').url, 'https://www.amazon.com');
});

test('a plain search is not a site search', () => {
  assert.strictEqual(siteSearch('norbert wiener'), null);
  assert.strictEqual(siteSearch('how to type faster on a keyboard'), null);
  assert.strictEqual(siteSearch('youtube downloader for windows'), null);
});
