'use strict';

// 零依赖 ZIP 读写（仅用到 Node 内置 zlib）。
//
// 方案包不需要压缩率（陶片照片本身已是 JPEG/PNG/WebP），写出时统一使用
// “stored（不压缩，method=0）”，产物确定、可重复；读取时同时支持
// stored 与 deflate（method=8），便于与系统 zip 工具互通。
//
// 安全约束（unzip）：
//   - 校验 EOCD / 中央目录 / 本地文件头签名与边界；
//   - 校验每条目 CRC32 与解压后长度（损坏即抛错，整包拒绝）；
//   - 拒绝 ZIP64、分卷盘、加密条目与数据描述符等本工作台不产生的特性；
//   - 拒绝绝对路径、盘符、反斜杠与包含 “..” 的越界路径；
//   - 拒绝重名条目；
//   - 限制条目数与解压后总字节数（防 zip bomb）。

const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;

class ZipError extends Error {}

// ---------- CRC32 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- 写出 ----------

// entries: [{ name: string, data: Buffer }] → Buffer（ZIP，stored）。
// 时间字段固定，保证同一内容字节级可复现（便于核对摘要）。
function createZip(entries) {
  const DOS_DATE = 0x0021; // 1980-01-01
  const chunks = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    if (nameBuf.length === 0 || nameBuf.length > 0xffff) throw new ZipError('ZIP 条目名长度非法');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(0, 6); // 通用标志位
    local.writeUInt16LE(0, 8); // method = stored
    local.writeUInt16LE(0, 10); // DOS time
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小
    local.writeUInt32LE(data.length, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度
    chunks.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // 打包版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // 盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42);
    centrals.push({ header: central, name: nameBuf });

    offset += local.length + nameBuf.length + data.length;
  }

  let cdSize = 0;
  for (const c of centrals) {
    chunks.push(c.header, c.name);
    cdSize += c.header.length + c.name.length;
  }
  const cdOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // 盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始盘号
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

// ---------- 读取 ----------

// 拒绝绝对路径 / 盘符 / 反斜杠 / “..” 越界段；目录条目（以 / 结尾）允许但由上层忽略。
function safeZipName(name) {
  if (name.length === 0) throw new ZipError('ZIP 条目名为空');
  if (name[0] === '/' || name[0] === '\\') throw new ZipError(`ZIP 条目使用绝对路径：${name}`);
  if (/^[a-zA-Z]:/.test(name)) throw new ZipError(`ZIP 条目使用盘符路径：${name}`);
  if (name.includes('\\')) throw new ZipError(`ZIP 条目包含反斜杠：${name}`);
  const parts = name.split('/');
  for (const p of parts) {
    if (p === '..') throw new ZipError(`ZIP 条目包含越界路径段 “..”：${name}`);
  }
  return name;
}

function u16(buf, off) { return buf.readUInt16LE(off); }
function u32(buf, off) { return buf.readUInt32LE(off); }

// buffer → Map<name, { data: Buffer, method: number }>（目录条目不含于返回值）。
function unzip(buffer, { maxEntries = 200000, maxTotalBytes = 512 * 1024 * 1024 } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new ZipError('数据过短，不是合法 ZIP');

  // EOCD 最多允许 64KB 注释：自尾部向前扫描签名。
  const scanStart = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (u32(buf, i) === SIG_EOCD) {
      const commentLen = u16(buf, i + 20);
      if (i + 22 + commentLen === buf.length) { eocd = i; break; }
    }
    if (u32(buf, i) === SIG_ZIP64_EOCD) {
      throw new ZipError('不支持 ZIP64 格式的方案包');
    }
  }
  if (eocd < 0) throw new ZipError('未找到 ZIP 结束记录（EOCD），包已损坏');

  const disk = u16(buf, eocd + 4);
  const cdDisk = u16(buf, eocd + 6);
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('不支持分卷 ZIP');
  const totalEntries = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('不支持 ZIP64 格式的方案包');
  }
  if (totalEntries > maxEntries) throw new ZipError(`ZIP 条目数超过上限 ${maxEntries}`);
  if (cdOffset + cdSize > eocd) throw new ZipError('ZIP 中央目录越界，包已损坏');

  const files = new Map();
  let p = cdOffset;
  let declaredTotal = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cdOffset + cdSize) throw new ZipError('ZIP 中央目录头越界，包已损坏');
    if (u32(buf, p) !== SIG_CENTRAL) throw new ZipError('ZIP 中央目录签名错误，包已损坏');

    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const crc = u32(buf, p + 16);
    const compSize = u32(buf, p + 20);
    const uncompSize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOffset = u32(buf, p + 42);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > cdOffset + cdSize) throw new ZipError('ZIP 中央目录条目越界');

    const name = safeZipName(buf.slice(p + 46, nameEnd).toString('utf8'));

    // extra 中若出现 ZIP64 扩展（0x0001）即拒绝（前面的 0xffffffff 兜底之外）。
    let ep = nameEnd;
    const extraEnd = ep + extraLen;
    while (ep + 4 <= extraEnd) {
      const tag = u16(buf, ep);
      const size = u16(buf, ep + 2);
      if (tag === 0x0001) throw new ZipError('不支持 ZIP64 格式的方案包');
      ep += 4 + size;
    }

    const isDir = name.endsWith('/');
    if (!isDir) {
      if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
        throw new ZipError('不支持 ZIP64 格式的方案包');
      }
      if (files.has(name)) throw new ZipError(`ZIP 内存在重复文件：${name}`);
      declaredTotal += uncompSize;
      if (declaredTotal > maxTotalBytes) throw new ZipError('ZIP 解压后总大小超过上限');
    }
    if (method !== 0 && method !== 8) throw new ZipError(`ZIP 条目使用不支持的压缩方式（${method}）：${name}`);
    if (flags & 0x0001) throw new ZipError(`ZIP 条目已加密，无法读取：${name}`);

    // 定位本地文件头（大小以中央目录为准，不信任本地头）。
    if (localOffset + 30 > buf.length || u32(buf, localOffset) !== SIG_LOCAL) {
      throw new ZipError(`ZIP 本地文件头损坏：${name}`);
    }
    const localNameLen = u16(buf, localOffset + 26);
    const localExtraLen = u16(buf, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) throw new ZipError(`ZIP 文件数据越界：${name}`);
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: maxTotalBytes });
      } catch (e) {
        throw new ZipError(`ZIP 条目解压失败：${name}（${e.message}）`);
      }
    }
    if (data.length !== uncompSize) {
      throw new ZipError(`ZIP 条目长度与中央目录不符：${name}`);
    }
    if (crc32(data) !== crc) throw new ZipError(`ZIP 条目 CRC32 校验失败：${name}（包已损坏）`);

    if (!isDir) files.set(name, { data, method });
    p = extraEnd + commentLen;
  }

  return files;
}

module.exports = { createZip, unzip, crc32, ZipError };
