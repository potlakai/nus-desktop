'use strict';
// Send pixels directly. Guidance has no filesystem, shell, or browser tools.
function guideInput(prompt, imageDataUrl) {
  const content = [{ type: 'text', text: String(prompt || '').slice(0, 150000) }];
  if (imageDataUrl) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(imageDataUrl);
    if (!match || match[2].length > 10000000) throw new Error('Invalid guide image');
    content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
  }
  return {
    content,
    cliArgs: ['--input-format', 'stream-json', '--tools=', '--strict-mcp-config', '--no-session-persistence', '--setting-sources='],
    stdin: JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n',
  };
}
module.exports = { guideInput };
