(() => {
  const LOCAL_ORIGIN = 'http://127.0.0.1:17880';
  if (location.origin !== LOCAL_ORIGIN) return;

  const reply = (requestId, result) => window.postMessage({
    source: 'roundtable-extension',
    requestId,
    ...result,
  }, LOCAL_ORIGIN);

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== LOCAL_ORIGIN) return;
    const message = event.data;
    if (!message || message.source !== 'roundtable-app' || typeof message.requestId !== 'string' || !message.requestId) return;
    if (message.action === 'ping') {
      reply(message.requestId, { ok: true });
      return;
    }
    if (message.action !== 'send') {
      reply(message.requestId, { ok: false, error: 'ACTION_INVALID' });
      return;
    }
    chrome.runtime.sendMessage({
      source: 'roundtable-app',
      action: 'send',
      chatUrl: message.chatUrl,
      taskId: message.taskId,
      text: message.text,
    }).then(result => reply(message.requestId, result ?? { ok: false, error: 'BRIDGE_EMPTY_RESPONSE' }))
      .catch(() => reply(message.requestId, { ok: false, error: 'BRIDGE_UNAVAILABLE' }));
  });
})();
