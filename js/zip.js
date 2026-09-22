/* ═══════════════════════════════════════════════════════════
   zip.js — 极简 ZIP 读写（只用「存储」模式，不压缩）

   为什么要手写：备份要把照片一起打包。JSON 里塞 base64 会胀三分之一，
   而且几百 MB 的字符串在手机上会直接把内存撑爆。ZIP 是文件容器，
   能一个个塞进去，浏览器原样下载。
   JPEG 本来就是压缩过的，再套一层 deflate 几乎没收益，所以存储模式正好。

   只实现需要的部分：写本地文件头 + 中央目录 + 结束记录；读的时候扫中央目录。
   ═══════════════════════════════════════════════════════════ */

/* ── CRC32 ─────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ── 小工具 ────────────────────────────────────────────── */

const enc = new TextEncoder();

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1F) << 11)
    | ((d.getMinutes() & 0x3F) << 5)
    | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9)
    | (((d.getMonth() + 1) & 0x0F) << 5)
    | (d.getDate() & 0x1F);
  return { time, date };
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (typeof data === 'string') return enc.encode(data);
  /* 兜底：当作能被 JSON 化的值 */
  return enc.encode(JSON.stringify(data));
}

/* ── 写 ZIP ────────────────────────────────────────────── */

/**
 * @param {Array<{name:string, data:Uint8Array|ArrayBuffer|Blob|string}>} entries
 * @returns {Promise<Blob>}
 */
export async function createZip(entries) {
  const { time, date } = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = await toBytes(e.data);
    const crc = crc32(data);

    /* 本地文件头 30 字节 + 文件名 */
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034B50, true);   // 签名
    lv.setUint16(4, 20, true);           // 需要版本
    lv.setUint16(6, 0x0800, true);       // 标志：文件名是 UTF-8
    lv.setUint16(8, 0, true);            // 压缩方式：0 = 存储
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // 压缩后大小
    lv.setUint32(22, data.length, true); // 原始大小
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // 扩展字段长度
    local.set(nameBytes, 30);

    parts.push(local, data);

    /* 中央目录项 46 字节 + 文件名 */
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014B50, true);
    cv.setUint16(4, 20, true);           // 打包版本
    cv.setUint16(6, 20, true);           // 需要版本
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);           // 扩展字段
    cv.setUint16(32, 0, true);           // 注释
    cv.setUint16(34, 0, true);           // 磁盘号
    cv.setUint16(36, 0, true);           // 内部属性
    cv.setUint32(38, 0, true);           // 外部属性
    cv.setUint32(42, offset, true);      // 本地头偏移
    cen.set(nameBytes, 46);

    central.push(cen);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);

  /* 结束记录 22 字节 */
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054B50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/* ── 读 ZIP ────────────────────────────────────────────── */

/**
 * 只支持存储模式（我们自己导出的包）。遇到压缩过的条目会抛出明确错误，
 * 免得静默读出乱码。
 * @returns {Promise<Array<{name:string, data:Uint8Array}>>}
 */
export async function readZip(input) {
  const buf = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);

  /* 从尾部往回找结束记录（可能有注释，所以倒着扫） */
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是一个 ZIP 文件（找不到结束记录）');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014B50) {
      throw new Error('备份文件解析到一半坏了（中央目录无效）');
    }
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (method !== 0) {
      throw new Error(`备份里有一条是压缩过的（${name}），读不了`);
    }

    /* 本地头里的名字/扩展字段长度可能和中央目录不同，得重新读 */
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;

    out.push({ name, data: bytes.subarray(dataStart, dataStart + compSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

/* ── 下载 / 分享 ───────────────────────────────────────── */

/**
 * 把 Blob 交给用户。iOS 上优先走系统分享面板（能直接存到「文件」App），
 * 不行的话退回到普通下载链接。
 * @returns {Promise<'share'|'download'>}
 */
export async function saveBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'share';
    } catch (e) {
      /* 用户取消不算失败，但也不用再退化到下载 */
      if (e && e.name === 'AbortError') return 'share';
      /* 其他错误就往下走下载 */
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'download';
}
