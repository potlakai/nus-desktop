'use strict';
function trustedSender(event, contents) {
  return Boolean(contents && !contents.isDestroyed() && event && event.sender === contents && event.senderFrame === contents.mainFrame);
}
module.exports = { trustedSender };
