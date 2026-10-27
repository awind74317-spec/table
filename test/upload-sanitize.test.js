import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeUploadBasename } from '../src/server.js';

// 纯字符串逻辑，不依赖运行平台的 path 语义——因此这里的断言在 Windows 与 Linux 上结果一致，
// 恰好覆盖了 CI 里「Windows 通过、Ubuntu 失败」的跨平台缺口（旧代码用 path.basename，
// 在 Linux 上不把 `\` 当分隔符，放过了 Windows 风格穿越名 ..\..\hack.txt）。
test('safeUploadBasename: 跨平台收敛为纯基名，杜绝路径穿越与 .. 残留', () => {
  // 关键回归：Windows 风格穿越名（本 bug 的根因输入）
  assert.equal(safeUploadBasename('..\\..\\hack.txt'), 'hack.txt');
  // Unix 风格穿越名
  assert.equal(safeUploadBasename('../../hack.txt'), 'hack.txt');
  // 混合分隔符
  assert.equal(safeUploadBasename('a/../b\\..\\hack.txt'), 'hack.txt');
  // 普通文件名不受影响
  assert.equal(safeUploadBasename('notes.md'), 'notes.md');
  // 前导点 / 纯点段被消解（不产生隐藏文件，不残留 .）
  assert.equal(safeUploadBasename('.hidden.txt'), 'hidden.txt');
  assert.equal(safeUploadBasename('..'), '');
  assert.equal(safeUploadBasename('.'), '');
  // 连续点收敛为单个点，绝不残留 ..
  assert.equal(safeUploadBasename('ha..ck.txt'), 'ha.ck.txt');

  // 不变量：任何输入的输出都不含 `..`、不含路径分隔符
  const attacks = ['..\\..\\x.txt', '../../x.txt', 'a\\b/c..d', '....//x', 'p a t h\\f.txt', '..\\/..\\/etc\\passwd'];
  for (const input of attacks) {
    const out = safeUploadBasename(input);
    assert.ok(!out.includes('..'), `no .. residue: ${input} -> ${out}`);
    assert.ok(!/[\\/]/.test(out), `no separators: ${input} -> ${out}`);
  }

  // 空/异常输入安全
  assert.equal(safeUploadBasename(''), '');
  assert.equal(safeUploadBasename(undefined), '');
  assert.equal(safeUploadBasename(null), '');
});
