(() => {
  const CHAT_ORIGIN = 'https://chatgpt.com';
  const CHAT_PATH = /^\/c\/[0-9a-f-]{36,64}$/i;

  function allowedLocation() {
    return location.origin === CHAT_ORIGIN && CHAT_PATH.test(location.pathname) && !location.search.includes('workspace');
  }

  function composer() {
    return document.querySelector('[data-composer-markdown][contenteditable="true"][role="textbox"]');
  }

  function composerText(element) {
    if (!element) return '';
    return element.innerText ?? element.textContent ?? '';
  }

  function stopRunning() {
    return !!document.querySelector('button[aria-label="停止"],button[aria-label="Stop"]');
  }

  function insertText(element, text) {
    element.focus();
    if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(element, text);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      const selection = document.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (!document.execCommand('insertText', false, text)) return false;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return composerText(element).replace(/\s+/g, ' ').trim() === text.replace(/\s+/g, ' ').trim();
  }

  function waitForSendButton() {
    return new Promise(resolve => {
      const started = Date.now();
      const check = () => {
        const button = document.querySelector('button[type="submit"][aria-label="傳送"],button[type="submit"][aria-label="Send"]');
        if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') return resolve(button);
        if (Date.now() - started >= 5000) return resolve(null);
        setTimeout(check, 100);
      };
      check();
    });
  }

  async function send(message) {
    if (!allowedLocation()) return { ok: false, error: 'CHAT_LOCATION_INVALID' };
    if (new URL(message.chatUrl).origin !== location.origin || new URL(message.chatUrl).pathname !== location.pathname) return { ok: false, error: 'CHAT_CHANGED' };
    if (!document.querySelector('button[aria-label="選取 ChatGPT 模型"],button[aria-label="Select ChatGPT model"]')) return { ok: false, error: 'CHAT_MODE_NOT_CONFIRMED' };
    if (typeof message?.text !== 'string' || !message.text || message.text.length > 30_000) return { ok: false, error: 'TEXT_INVALID' };
    if (stopRunning()) return { ok: false, error: 'CHAT_IS_RUNNING' };
    const element = composer();
    if (!element) return { ok: false, error: 'COMPOSER_NOT_FOUND' };
    if (composerText(element).trim()) return { ok: false, error: 'DRAFT_PRESENT' };
    if (!insertText(element, message.text)) return { ok: false, error: 'COMPOSER_INSERT_FAILED' };
    const button = await waitForSendButton();
    if (!button) return { ok: false, error: 'SEND_BUTTON_NOT_FOUND_OR_DISABLED' };
    if (stopRunning() || composerText(element).replace(/\s+/g, ' ').trim() !== message.text.replace(/\s+/g, ' ').trim()) return { ok: false, error: 'COMPOSER_CHANGED' };
    button.click();
    return { ok: true, sent: true };
  }

  if (allowedLocation()) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.source !== 'roundtable-extension' || message.action !== 'send') return;
      send(message).then(sendResponse).catch(() => sendResponse({ ok: false, error: 'CHAT_SEND_FAILED' }));
      return true;
    });
  }
})();
