import zlib from 'node:zlib';

/** Minimal ZIP central-directory reader; avoids a platform dependency on the external unzip CLI. */
export function readZipArchive(bytes) {
  const endSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const minimumEndOffset = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('ZIP end-of-central-directory记录缺失');
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  let offset = bytes.readUInt32LE(endOffset + 16);
  const centralEnd = offset + bytes.readUInt32LE(endOffset + 12);
  if (centralEnd > endOffset) throw new Error('ZIP central-directory范围损坏');
  const centralOffset = offset;
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralEnd) throw new Error('ZIP central-directory记录截断');
    if (bytes.readUInt32LE(offset) !== centralSignature) throw new Error('ZIP central-directory记录损坏');
    const flags = bytes.readUInt16LE(offset + 8);
    const compressionMethod = bytes.readUInt16LE(offset + 10);
    const crc32 = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const fileNameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    if (offset + 46 + fileNameLength + extraLength + commentLength > centralEnd) throw new Error('ZIP central-directory文件名或扩展截断');
    const name = bytes.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    if (entries.has(name)) throw new Error(`ZIP文件名重复：${name}`);
    entries.set(name, { flags, compressionMethod, crc32, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  const contents = new Map();
  return {
    names: [...entries.keys()].sort(),
    read(name, maxBytes = 64 * 1024 * 1024) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      if (entry.uncompressedSize > maxBytes) throw new Error(`ZIP条目超过读取上限：${name}`);
      if (contents.has(name)) return contents.get(name);
      const localOffset = entry.localHeaderOffset;
      if (localOffset + 30 > centralOffset) throw new Error(`ZIP local header截断：${name}`);
      if (bytes.readUInt32LE(localOffset) !== localSignature) throw new Error(`ZIP local header损坏：${name}`);
      const localFlags = bytes.readUInt16LE(localOffset + 6);
      if ((localFlags | entry.flags) & 1) throw new Error(`ZIP加密条目不受支持：${name}`);
      if (bytes.readUInt16LE(localOffset + 8) !== entry.compressionMethod) throw new Error(`ZIP条目压缩方法不一致：${name}`);
      if (!(localFlags & 8) && (bytes.readUInt32LE(localOffset + 14) !== entry.crc32
        || bytes.readUInt32LE(localOffset + 18) !== entry.compressedSize
        || bytes.readUInt32LE(localOffset + 22) !== entry.uncompressedSize)) {
        throw new Error(`ZIP local header与central-directory不一致：${name}`);
      }
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + entry.compressedSize > centralOffset) throw new Error(`ZIP条目正文截断：${name}`);
      const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
      if (entry.compressionMethod === 0 && compressed.length > maxBytes) throw new Error(`ZIP条目超过读取上限：${name}`);
      const content = entry.compressionMethod === 0 ? Buffer.from(compressed)
        : entry.compressionMethod === 8 ? zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, maxBytes) }) : undefined;
      if (!content) throw new Error(`ZIP compression method不支持：${entry.compressionMethod}`);
      if (content.length !== entry.uncompressedSize) throw new Error(`ZIP条目展开长度不一致：${name}`);
      if (zlib.crc32(content) !== entry.crc32) throw new Error(`ZIP条目CRC32不一致：${name}`);
      contents.set(name, content);
      return content;
    }
  };
}
