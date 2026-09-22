/* ═══════════════════════════════════════════════════════════
   read-xlsx.mjs — 把 .xlsx 拆开看内容
   xlsx 本质是个 zip（里面是 XML），要用 DEFLATE 解压。
   用法：node tools/read-xlsx.mjs "课表.xlsx"
   ═══════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('找不到文件：' + file);
  process.exit(1);
}

/* ── 读 zip（支持 DEFLATE） ────────────────────────────── */

function readZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是一个 zip / xlsx 文件');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = Buffer.from(u8.subarray(p + 46, p + 46 + nameLen)).toString('utf8');

    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = Buffer.from(u8.subarray(start, start + compSize));

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}（${name}）`);

    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ── 小工具 ────────────────────────────────────────────── */

const colToNum = (col) => {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};
const numToCol = (n) => {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};
const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, '&');

/* ── 解压出来 ──────────────────────────────────────────── */

const buf = fs.readFileSync(file);
const zip = readZip(buf);

console.log('');
console.log('文件：' + path.basename(file) + '   ' + (buf.length / 1024).toFixed(1) + ' KB');
console.log('包内文件：');
for (const name of zip.keys()) console.log('   ' + name + '  (' + zip.get(name).length + ' B)');

/* 共享字符串表 */
const shared = [];
const ssRaw = zip.get('xl/sharedStrings.xml');
if (ssRaw) {
  const ss = ssRaw.toString('utf8');
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]);
    shared.push(decode(parts.join('')));
  }
  console.log('\n共享字符串 ' + shared.length + ' 条');
}

/* 工作表 */
const sheets = [...zip.keys()].filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();

for (const sheetName of sheets) {
  const xml = zip.get(sheetName).toString('utf8');

  const cells = new Map();
  let maxR = 0, maxC = 0;

  for (const rowM of xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const r = Number(rowM[1]);
    maxR = Math.max(maxR, r);

    for (const cM of rowM[2].matchAll(/<c([^>]*?)\/>|<c([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const attrs = cM[1] || cM[2] || '';
      const inner = cM[3] || '';
      const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
      if (!ref) continue;

      const col = colToNum(ref[1]);
      maxC = Math.max(maxC, col);

      const t = /\bt="([^"]+)"/.exec(attrs);
      const type = t ? t[1] : '';
      let val = '';

      if (type === 's') {
        const v = /<v>(\d+)<\/v>/.exec(inner);
        val = v ? (shared[Number(v[1])] || '') : '';
      } else if (type === 'inlineStr') {
        val = decode([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        val = v ? decode(v[1]) : '';
      }

      if (val !== '') cells.set(ref[1] + r, val);
    }
  }

  /* 合并单元格 */
  const merges = [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map(m => m[1]);

  console.log('\n' + '═'.repeat(80));
  console.log(sheetName.replace('xl/worksheets/', '').replace('.xml', '')
    + `   最大行 ${maxR} × 最大列 ${numToCol(maxC)}(${maxC})`);
  console.log('═'.repeat(80));

  for (let r = 1; r <= maxR; r++) {
    const parts = [];
    for (let c = 1; c <= maxC; c++) {
      const v = cells.get(numToCol(c) + r);
      if (v !== undefined && v !== '') parts.push(numToCol(c) + r + '=' + v);
    }
    if (parts.length) console.log('  行' + String(r).padStart(2) + ':  ' + parts.join('  |  '));
  }

  if (merges.length) {
    console.log('\n  合并单元格 ' + merges.length + ' 处：');
    console.log('   ' + merges.join('  '));
  }
}
console.log('');
