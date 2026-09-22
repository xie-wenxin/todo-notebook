/* ═══════════════════════════════════════════════════════════
   test-zip.mjs — ZIP 打包 / 解包的单元测试
   备份能不能救回数据，全靠这个文件。跑：node tools/test-zip.mjs
   ═══════════════════════════════════════════════════════════ */

import { createZip, readZip, crc32 } from '../js/zip.js';

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    fails.push(name + (detail ? '  → ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  → ' + detail : ''));
  }
}

function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, `得到 ${g}，期望 ${w}`);
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ── 1. CRC32 ──────────────────────────────────────────── */

console.log('\n  ── CRC32 ──');
{
  /* 经典测试向量：字符串 "123456789" 的 CRC32 是 0xCBF43926 */
  eq('"123456789" 的 CRC32', crc32(enc.encode('123456789')), 0xCBF43926);
  eq('空数据的 CRC32', crc32(new Uint8Array(0)), 0);
  ok('CRC32 是 32 位无符号', crc32(enc.encode('随便什么')) >= 0
    && crc32(enc.encode('随便什么')) <= 0xFFFFFFFF);
}

/* ── 2. 空包 ───────────────────────────────────────────── */

console.log('\n  ── 基本读写 ──');
{
  const zip = await createZip([]);
  ok('空包也是合法 zip', zip.size >= 22, 'size=' + zip.size);
  const back = await readZip(zip);
  eq('空包读回来是空数组', back.length, 0);
}

/* ── 3. 文本往返 ───────────────────────────────────────── */

{
  const zip = await createZip([
    { name: 'hello.txt', data: '你好，本子！' },
  ]);
  const back = await readZip(zip);
  eq('一条记录', back.length, 1);
  eq('文件名对', back[0].name, 'hello.txt');
  eq('中文内容原样往返', dec.decode(back[0].data), '你好，本子！');
}

/* ── 4. 中文文件名 ─────────────────────────────────────── */

{
  const zip = await createZip([
    { name: '待办本子-备份-20260921.zip.txt', data: 'x' },
  ]);
  const back = await readZip(zip);
  eq('中文文件名原样往返', back[0].name, '待办本子-备份-20260921.zip.txt');
}

/* ── 5. 二进制原样往返 ─────────────────────────────────── */

console.log('\n  ── 二进制 ──');
{
  /* 造一段包含全部 256 种字节的数据，任何编码转换都会露馅 */
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;

  const zip = await createZip([{ name: 'all.bin', data: bytes }]);
  const back = await readZip(zip);
  ok('256 种字节一个都没变', same(back[0].data, bytes),
    `长度 ${back[0].data.length} vs ${bytes.length}`);
}

{
  /* 大一点的二进制，模拟一张照片 */
  const big = new Uint8Array(300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 13) & 0xFF;

  const zip = await createZip([{ name: 'photos/p1.jpg', data: big }]);
  const back = await readZip(zip);
  eq('30 万字节的长度对', back[0].data.length, big.length);
  ok('30 万字节的内容对', same(back[0].data, big));
  ok('压缩后没膨胀太多（存储模式）', zip.size < big.length + 4096,
    `zip=${zip.size} raw=${big.length}`);
}

/* ── 6. 多条目 + 嵌套路径 ──────────────────────────────── */

console.log('\n  ── 多条目 ──');
{
  const zip = await createZip([
    { name: 'data.json', data: JSON.stringify({ app: 'todo-notebook', n: 1 }) },
    { name: 'photos/a.jpg', data: new Uint8Array([1, 2, 3]) },
    { name: 'photos/a.thumb.jpg', data: new Uint8Array([4, 5]) },
    { name: 'photos/a.json', data: '{"id":"a"}' },
  ]);
  const back = await readZip(zip);

  eq('4 条记录', back.length, 4);
  eq('顺序保持', back.map(e => e.name),
    ['data.json', 'photos/a.jpg', 'photos/a.thumb.jpg', 'photos/a.json']);
  eq('json 内容对', JSON.parse(dec.decode(back[0].data)).app, 'todo-notebook');
  eq('小路文件内容对', [...back[1].data], [1, 2, 3]);
  eq('缩略图内容对', [...back[2].data], [4, 5]);
}

/* ── 7. 边界情况 ───────────────────────────────────────── */

console.log('\n  ── 边界 ──');
{
  const zip = await createZip([{ name: 'empty.txt', data: '' }]);
  const back = await readZip(zip);
  eq('空文件也有一条记录', back.length, 1);
  eq('空文件长度是 0', back[0].data.length, 0);
}
{
  /* 文件名含空格和斜杠 */
  const zip = await createZip([{ name: 'my notes/2026 09 21.txt', data: 'ok' }]);
  const back = await readZip(zip);
  eq('带空格斜杠的文件名', back[0].name, 'my notes/2026 09 21.txt');
}
{
  const zip = await createZip([{ name: 'a.txt', data: 'A' }]);
  const buf = await zip.arrayBuffer();
  eq('ArrayBuffer 也能读', (await readZip(buf)).length, 1);
  eq('未压缩方式标记为 0', new DataView(buf).getUint16(8, true), 0);
  eq('zip 签名正确', new DataView(buf).getUint32(0, true), 0x04034B50);
}
{
  let threw = false;
  try {
    await readZip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]));
  } catch { threw = true; }
  ok('拿非 zip 文件来读会明确报错，而不是读出乱码', threw);
}

/* ── 8. 大包 ───────────────────────────────────────────── */

console.log('\n  ── 规模 ──');
{
  /* 模拟 40 张照片 + 一份数据，验证多条目不会错位 */
  const entries = [{ name: 'data.json', data: '{"days":[]}' }];
  for (let i = 0; i < 40; i++) {
    const px = new Uint8Array(4000 + i);
    px.fill(i & 0xFF);
    entries.push({ name: `photos/p${i}.jpg`, data: px });
  }

  const zip = await createZip(entries);
  const back = await readZip(zip);

  eq('41 条全部读回来', back.length, 41);
  let allGood = true;
  for (let i = 0; i < 40; i++) {
    const rec = back.find(e => e.name === `photos/p${i}.jpg`);
    if (!rec || rec.data.length !== 4000 + i || rec.data[0] !== (i & 0xFF)) { allGood = false; break; }
  }
  ok('40 张照片每条都对应正确（没有错位）', allGood);
}

/* ── 结果 ──────────────────────────────────────────────── */

console.log('');
console.log(`  结果：${pass} 通过，${fail} 失败`);
if (fail) {
  console.log('');
  console.log('  失败项：');
  for (const f of fails) console.log('    · ' + f);
}
console.log('');

process.exit(fail ? 1 : 0);
