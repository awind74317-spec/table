// Browser-only clipboard proof helper. It never runs by itself; the visible handoff button is its only caller.
(() => {
  const encoder = new TextEncoder();
  const utf8Bytes = value => encoder.encode(String(value)).byteLength;
  // 行尾归一化：把 \r\n 与孤立 \r 都收敛为 \n。操作系统剪贴板会把 \n 往返成 \r\n
  //（Windows 上多行文本每次都会），这是良性且不可避免的转换，不能判为内容被篡改。
  const normalizeEol = value => String(value).replace(/\r\n?/g, '\n');

  // 自诊断：把「回读 vs 预览」的差异归纳成一句可读描述，免得每次都靠猜。
  function describeClipboardDiff(readback, expected) {
    const a = String(readback), b = String(expected);
    if (a === b) return 'identical';
    if (normalizeEol(a) === normalizeEol(b)) return 'line-endings-only (CRLF vs LF)';
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    // 只报结构信息（首个差异位置 + 两侧长度），绝不回显任何剪贴板正文——
    // 正文可能含私有代码 / prompt / 凭据，一旦进错误提示或日志就会泄露。
    return `content mismatch at char index ${i}; expected length ${b.length}, readback length ${a.length}`;
  }

  async function sha256Hex(value) {
    if (!window.crypto?.subtle) throw clipboardError('CLIPBOARD_UNAVAILABLE', 'unavailable', false);
    const hash = await window.crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function clipboardError(code, stage, writeOk, cause = null) {
    const error = new Error(code);
    error.code = code;
    error.stage = stage;
    error.writeOk = writeOk;
    if (cause) error.cause = cause;
    return error;
  }

  async function copyConfirmedText(pkg) {
    const clipboard = window.__rtClipboard ?? window.navigator?.clipboard;
    if (!clipboard?.writeText || !clipboard?.readText) {
      throw clipboardError('CLIPBOARD_UNAVAILABLE', 'unavailable', false);
    }
    if (!pkg || !pkg.userConfirmedAt || pkg.invalidatedAt
      || typeof pkg.fullText !== 'string' || typeof pkg.fullTextSha256 !== 'string') {
      throw clipboardError('CONFIRMED_PACKAGE_REQUIRED', 'unavailable', false);
    }
    // 写入剪贴板之前先验确认包自洽：声明的 fullTextBytes/fullTextSha256 必须由 pkg.fullText 现算重现。
    // 否则审计会记录与正文不符的 taskId/字节数/哈希。任一不符立即拒绝，绝不写入剪贴板。
    // 错误只带 code，不含正文、哈希原值或凭据。
    if (!Number.isSafeInteger(pkg.fullTextBytes) || pkg.fullTextBytes < 0) {
      throw clipboardError('CONFIRMED_PACKAGE_INTEGRITY', 'unavailable', false);
    }
    const expectedBytes = utf8Bytes(pkg.fullText);
    let expectedSha256;
    try { expectedSha256 = await sha256Hex(pkg.fullText); }
    catch (cause) { throw clipboardError('CLIPBOARD_UNAVAILABLE', 'unavailable', false, cause); }
    if (pkg.fullTextBytes !== expectedBytes || pkg.fullTextSha256 !== expectedSha256) {
      throw clipboardError('CONFIRMED_PACKAGE_INTEGRITY', 'unavailable', false);
    }
    try {
      await clipboard.writeText(pkg.fullText);
    } catch (cause) {
      throw clipboardError('CLIPBOARD_WRITE_FAILED', 'write', false, cause);
    }
    let readback;
    try {
      readback = await clipboard.readText();
    } catch (cause) {
      throw clipboardError('CLIPBOARD_READ_FAILED', 'read', true, cause);
    }
    const readbackBytes = utf8Bytes(readback);
    let readbackSha256;
    try { readbackSha256 = await sha256Hex(readback); }
    catch (cause) { throw clipboardError('CLIPBOARD_UNAVAILABLE', 'unavailable', true, cause); }
    // 保真判定按行尾归一化后逐字比对：归一后仍相等 = 内容保真（截断/替换/注入/编码损坏都能抓到），
    // 仅容忍 CRLF↔LF 这一种约定差异。原始字节数与 SHA-256 仍照回读原样回传供审计留痕。
    if (normalizeEol(readback) !== normalizeEol(pkg.fullText)) {
      const error = clipboardError('CLIPBOARD_MISMATCH', 'mismatch', true);
      error.readbackBytes = readbackBytes;
      error.readbackSha256 = readbackSha256;
      error.diff = describeClipboardDiff(readback, pkg.fullText);
      throw error;
    }
    return { readbackOk: true, writeOk: true, readback, readbackBytes, readbackSha256 };
  }

  window.RTHandoffClipboard = Object.freeze({ copyConfirmedText, sha256Hex, utf8Bytes });
})();
