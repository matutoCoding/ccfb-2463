// PLY / XYZ 解析器。运行在 Worker 中，全程不接触 DOM。
// 输出点坐标相对 origin 的 Float32Array（保留世界精度），颜色 Uint8，法线 Float32。
import type { Bounds, RawPointCloud, Vec3, WorkerError } from '../core/types';

export class ParseFailure extends Error {
  constructor(
    public code: WorkerError['code'],
    message: string,
    public byteOffset?: number,
  ) {
    super(message);
    this.name = 'ParseFailure';
  }
}

type OnProgress = (loaded: number, total: number, message: string) => void;

interface PlyProperty {
  name: string;
  type: string;
  isList: boolean;
  countType?: string;
  itemType?: string;
}

const TYPE_SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

function readScalar(view: DataView, offset: number, type: string, littleEndian: boolean): number {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, littleEndian);
    case 'ushort': case 'uint16': return view.getUint16(offset, littleEndian);
    case 'int': case 'int32': return view.getInt32(offset, littleEndian);
    case 'uint': case 'uint32': return view.getUint32(offset, littleEndian);
    case 'float': case 'float32': return view.getFloat32(offset, littleEndian);
    case 'double': case 'float64': return view.getFloat64(offset, littleEndian);
    default: throw new ParseFailure('UNSUPPORTED_FORMAT', `不支持的属性类型: ${type}`, offset);
  }
}

// PLY 的 uchar 颜色通常是 0-255；部分老文件用 float 0-1，做启发式兼容
function normalizeColor(v: number, type: string): number {
  if (type === 'float' || type === 'float32' || type === 'double' || type === 'float64') {
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return Math.max(0, Math.min(255, Math.round(v)));
}

interface PlyHeader {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  vertexCount: number;
  vertexProps: PlyProperty[];
  headerLength: number;
  stride: number;
}

function parsePlyHeader(bytes: Uint8Array): PlyHeader {
  const decoder = new TextDecoder('ascii');
  // 头部是纯 ASCII，找到 end_header
  let headerEnd = -1;
  const searchLimit = Math.min(bytes.length, 1 << 20);
  for (let i = 0; i < searchLimit - 10; i++) {
    if (bytes[i] === 0x65 /* e */ && bytes.subarray(i, i + 10).every((v, j) =>
      v === 'end_header'.charCodeAt(j))) {
      headerEnd = i;
      break;
    }
  }
  if (headerEnd < 0) throw new ParseFailure('BAD_HEADER', '找不到 end_header，文件可能不是 PLY');
  // 行尾（含换行符）
  let lineEnd = headerEnd + 10;
  if (bytes[lineEnd] === 0x0d) lineEnd++;
  if (bytes[lineEnd] === 0x0a) lineEnd++;

  const headerText = decoder.decode(bytes.subarray(0, headerEnd));
  const lines = headerText.split(/\r?\n/);
  if (lines[0].trim() !== 'ply') {
    throw new ParseFailure('BAD_MAGIC', 'PLY 文件头必须以 ply 开头');
  }
  let format: PlyHeader['format'] | null = null;
  let vertexCount = 0;
  let vertexProps: PlyProperty[] = [];
  let inVertex = false;
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith('comment') || line.startsWith('obj_info')) continue;
    const tokens = line.split(/\s+/);
    if (tokens[0] === 'format') {
      if (tokens[1] !== 'ascii' && tokens[1] !== 'binary_little_endian' &&
        tokens[1] !== 'binary_big_endian') {
        throw new ParseFailure('UNSUPPORTED_FORMAT', `不支持的 PLY 格式: ${tokens[1]}`);
      }
      format = tokens[1];
    } else if (tokens[0] === 'element') {
      inVertex = tokens[1] === 'vertex';
      if (inVertex) vertexCount = Number(tokens[2]);
      if (!Number.isFinite(vertexCount) || vertexCount < 0) {
        throw new ParseFailure('BAD_HEADER', `顶点数量非法: ${tokens[2]}`);
      }
    } else if (tokens[0] === 'property' && inVertex) {
      if (tokens[1] === 'list') {
        vertexProps.push({
          name: tokens[4], isList: true, countType: tokens[2], itemType: tokens[3], type: 'list',
        });
      } else {
        vertexProps.push({ name: tokens[2], isList: false, type: tokens[1] });
      }
    }
  }
  if (!format) throw new ParseFailure('BAD_HEADER', 'PLY 头缺少 format 声明');
  if (vertexCount === 0) throw new ParseFailure('EMPTY_CLOUD', 'PLY 中没有顶点');
  const hasXYZ = ['x', 'y', 'z'].every((n) => vertexProps.some((p) => !p.isList && p.name === n));
  if (!hasXYZ) throw new ParseFailure('BAD_HEADER', '顶点属性缺少 x/y/z');
  const stride = vertexProps
    .filter((p) => !p.isList)
    .reduce((sum, p) => sum + (TYPE_SIZES[p.type] ?? 0), 0);
  return { format, vertexCount, vertexProps, headerLength: lineEnd, stride };
}

function findProp(props: PlyProperty[], ...names: string[]): PlyProperty | undefined {
  return props.find((p) => !p.isList && names.includes(p.name));
}

function buildRaw(
  count: number,
  fill: (i: number, px: Float32Array, col: Uint8Array | null, nrm: Float32Array | null) => void,
  hasColors: boolean,
  hasNormals: boolean,
  onProgress: OnProgress,
  totalBytes: number,
): RawPointCloud {
  const positions = new Float32Array(count * 3);
  const colors = hasColors ? new Uint8Array(count * 3) : null;
  const normals = hasNormals ? new Float32Array(count * 3) : null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let lastReport = 0;
  for (let i = 0; i < count; i++) {
    fill(i, positions, colors, normals);
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
    if (i - lastReport >= 200000) {
      lastReport = i;
      onProgress(i, count, `解析顶点 ${(i / 1e4).toFixed(0)}/${(count / 1e4).toFixed(0)} 万`);
    }
  }
  if (!Number.isFinite(min[0])) throw new ParseFailure('EMPTY_CLOUD', '没有有效顶点');
  const origin: Vec3 = [min[0], min[1], min[2]];
  // 转为相对坐标，避免大数吃掉浮点精度
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= origin[0];
    positions[i + 1] -= origin[1];
    positions[i + 2] -= origin[2];
  }
  const bounds: Bounds = { min, max };
  onProgress(count, count, `解析完成，共 ${count} 点 / ${(totalBytes / 1048576).toFixed(1)} MB`);
  return { count, positions, origin, colors, normals, bounds };
}

function parsePly(buffer: ArrayBuffer, onProgress: OnProgress): RawPointCloud {
  const bytes = new Uint8Array(buffer);
  const header = parsePlyHeader(bytes);
  const { vertexProps: props, vertexCount: n } = header;
  const px = findProp(props, 'x')!;
  const py = findProp(props, 'y')!;
  const pz = findProp(props, 'z')!;
  const pcR = findProp(props, 'red', 'r', 'diffuse_red');
  const pcG = findProp(props, 'green', 'g', 'diffuse_green');
  const pcB = findProp(props, 'blue', 'b', 'diffuse_blue');
  const pnx = findProp(props, 'nx', 'normal_x');
  const pny = findProp(props, 'ny', 'normal_y');
  const pnz = findProp(props, 'nz', 'normal_z');
  const hasColors = !!(pcR && pcG && pcB);
  const hasNormals = !!(pnx && pny && pnz);
  const scalarProps = props.filter((p) => !p.isList);

  if (header.format === 'ascii') {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(header.headerLength));
    const lines = text.split(/\r?\n/);
    return buildRaw(
      n,
      (i, outPos, outCol, outNrm) => {
        const line = lines[i];
        if (line === undefined) {
          throw new ParseFailure('TRUNCATED', `第 ${i + 1} 个顶点数据缺失`);
        }
        const tokens = line.trim().split(/\s+/).filter(Boolean);
        if (tokens.length < scalarProps.length) {
          throw new ParseFailure('TRUNCATED', `第 ${i + 1} 个顶点字段不足`, header.headerLength);
        }
        const num = tokens.map((t) => {
          const v = Number(t);
          if (!Number.isFinite(v)) {
            throw new ParseFailure('BAD_NUMERIC', `非法数值 "${t}"（顶点 ${i + 1}）`);
          }
          return v;
        });
        const idx = new Map<string, number>();
        scalarProps.forEach((p, k) => idx.set(p.name, k));
        outPos[i * 3] = num[idx.get(px.name)!];
        outPos[i * 3 + 1] = num[idx.get(py.name)!];
        outPos[i * 3 + 2] = num[idx.get(pz.name)!];
        if (outCol && pcR && pcG && pcB) {
          outCol[i * 3] = normalizeColor(num[idx.get(pcR.name)!], pcR.type);
          outCol[i * 3 + 1] = normalizeColor(num[idx.get(pcG.name)!], pcG.type);
          outCol[i * 3 + 2] = normalizeColor(num[idx.get(pcB.name)!], pcB.type);
        }
        if (outNrm && pnx && pny && pnz) {
          outNrm[i * 3] = num[idx.get(pnx.name)!];
          outNrm[i * 3 + 1] = num[idx.get(pny.name)!];
          outNrm[i * 3 + 2] = num[idx.get(pnz.name)!];
        }
      },
      hasColors,
      hasNormals,
      onProgress,
      buffer.byteLength,
    );
  }

  // 二进制
  const littleEndian = header.format === 'binary_little_endian';
  const view = new DataView(buffer);
  // 校验长度
  const expectedMin = header.headerLength + header.stride * n;
  if (buffer.byteLength < expectedMin) {
    throw new ParseFailure(
      'TRUNCATED',
      `文件被截断：需要至少 ${expectedMin} 字节，实际 ${buffer.byteLength} 字节`,
      buffer.byteLength,
    );
  }
  return buildRaw(
    n,
    (i, outPos, outCol, outNrm) => {
      let off = header.headerLength + i * header.stride;
      const values = new Map<string, number>();
      for (const p of scalarProps) {
        const size = TYPE_SIZES[p.type];
        if (off + size > buffer.byteLength) {
          throw new ParseFailure('TRUNCATED', `顶点 ${i + 1} 属性 ${p.name} 越界`, off);
        }
        values.set(p.name, readScalar(view, off, p.type, littleEndian));
        off += size;
      }
      outPos[i * 3] = values.get(px.name)!;
      outPos[i * 3 + 1] = values.get(py.name)!;
      outPos[i * 3 + 2] = values.get(pz.name)!;
      if (outCol && pcR && pcG && pcB) {
        outCol[i * 3] = normalizeColor(values.get(pcR.name)!, pcR.type);
        outCol[i * 3 + 1] = normalizeColor(values.get(pcG.name)!, pcG.type);
        outCol[i * 3 + 2] = normalizeColor(values.get(pcB.name)!, pcB.type);
      }
      if (outNrm && pnx && pny && pnz) {
        outNrm[i * 3] = values.get(pnx.name)!;
        outNrm[i * 3 + 1] = values.get(pny.name)!;
        outNrm[i * 3 + 2] = values.get(pnz.name)!;
      }
    },
    hasColors,
    hasNormals,
    onProgress,
    buffer.byteLength,
  );
}

/**
 * XYZ 文本解析：每行 “x y z [r g b] [nx ny nz]”，# 开头为注释。
 * 列数 3 / 6（xyz+rgb 或 xyz+nrm，按首行数值范围启发式判断）/ 7（xyz+rgb+intensity 忽略）/ 9。
 * 采用分块 TextDecoder 流式处理，避免一次性构造超大字符串。
 */
function parseXyz(buffer: ArrayBuffer, onProgress: OnProgress): RawPointCloud {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder('utf-8');
  // 先扫描统计行数（允许超长文件，两遍扫描：先计数再解析）
  let lineCount = 0;
  let firstTokens: string[] | null = null;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) lineCount++;
  }
  lineCount++; // 末行
  const allText = decoder.decode(bytes);
  const lines = allText.split(/\r?\n/);
  // 推断列布局
  let columns = 3;
  let colorMode: 'none' | 'rgb' | 'normal' = 'none';
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    firstTokens = t.split(/\s+/);
    break;
  }
  if (firstTokens) {
    columns = firstTokens.length;
    if (columns >= 9) colorMode = 'rgb'; // 约定 9 列：xyz rgb nxnynz
    else if (columns === 6) {
      const a = Number(firstTokens[3]), b = Number(firstTokens[4]), c = Number(firstTokens[5]);
      // 颜色分量通常 >=1（0-255），法线分量在 [-1,1]
      colorMode = Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) > 1.5 ? 'rgb' : 'normal';
    }
  }
  const hasColors = colorMode === 'rgb';
  const hasNormals = colorMode === 'normal' || columns >= 9;

  // 紧凑收集有效行
  const dataLines: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t && !t.startsWith('#')) dataLines.push(t);
  }
  const n = dataLines.length;
  if (n === 0) throw new ParseFailure('EMPTY_CLOUD', 'XYZ 文件没有数据行');
  if (n > lineCount * 2 + 10) {
    throw new ParseFailure('BAD_HEADER', 'XYZ 行数异常');
  }

  return buildRaw(
    n,
    (i, outPos, outCol, outNrm) => {
      const tokens = dataLines[i].split(/\s+/);
      if (tokens.length < 3) {
        throw new ParseFailure('BAD_NUMERIC', `第 ${i + 1} 行数值不足 3 列`);
      }
      const num = tokens.map((t) => {
        const v = Number(t);
        if (!Number.isFinite(v)) {
          throw new ParseFailure('BAD_NUMERIC', `非法数值 "${t}"（第 ${i + 1} 行）`);
        }
        return v;
      });
      outPos[i * 3] = num[0];
      outPos[i * 3 + 1] = num[1];
      outPos[i * 3 + 2] = num[2];
      if (outCol && hasColors) {
        outCol[i * 3] = normalizeColor(num[3], 'uchar');
        outCol[i * 3 + 1] = normalizeColor(num[4], 'uchar');
        outCol[i * 3 + 2] = normalizeColor(num[5], 'uchar');
      }
      if (outNrm && hasNormals) {
        const base = columns >= 9 ? 6 : 3;
        outNrm[i * 3] = num[base];
        outNrm[i * 3 + 1] = num[base + 1];
        outNrm[i * 3 + 2] = num[base + 2];
      }
    },
    hasColors,
    hasNormals,
    onProgress,
    buffer.byteLength,
  );
}

export function parsePointCloud(
  fileName: string,
  buffer: ArrayBuffer,
  onProgress: OnProgress,
): RawPointCloud {
  const lower = fileName.toLowerCase();
  // 嗅探魔数：内容优先于扩展名（避免二进制数据中恰好出现 "ply" 字节误判）
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  const magicIsPly = head[0] === 0x70 && head[1] === 0x6c && head[2] === 0x79 &&
    (head[3] === 0x0a || head[3] === 0x0d || head[3] === 0x20);
  if (magicIsPly || (lower.endsWith('.ply') && !lower.match(/\.(xyz|txt|asc)$/))) {
    return parsePly(buffer, onProgress);
  }
  if (lower.endsWith('.xyz') || lower.endsWith('.txt') || lower.endsWith('.asc')) {
    return parseXyz(buffer, onProgress);
  }
  throw new ParseFailure('UNSUPPORTED_FORMAT', `不支持的文件格式: ${fileName}（仅 .ply/.xyz）`);
}
