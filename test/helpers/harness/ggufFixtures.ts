/**
 * Builds GGUF headers in memory so the metadata reader can be tested without
 * downloading a multi-gigabyte model. Only the header is produced: the reader
 * never looks at tensor data.
 */
import type { GgufSource } from "../../../src/helpers/ggufMetadata.js";

export const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

export const TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

const u32 = (value: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);

  return b;
};

const u64 = (value: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));

  return b;
};

const ggufString = (value: string) => {
  const bytes = Buffer.from(value, "utf8");

  return Buffer.concat([u64(bytes.length), bytes]);
};

export interface GgufScalarEntry {
  key: string;
  type: Exclude<(typeof TYPE)[keyof typeof TYPE], typeof TYPE.ARRAY>;
  value?: string | number | bigint | boolean;
}

export interface GgufArrayEntry {
  key: string;
  type: typeof TYPE.ARRAY;
  elementType: Exclude<(typeof TYPE)[keyof typeof TYPE], typeof TYPE.ARRAY>;
  values: Array<string | number | bigint | boolean>;
}

export type GgufEntry = GgufScalarEntry | GgufArrayEntry;

function encodeScalar(type: number, value: string | number | bigint | boolean | undefined): Buffer {
  switch (type) {
    case TYPE.UINT8:
    case TYPE.INT8:
      return Buffer.from([Number(value ?? 0) & 0xff]);
    case TYPE.UINT16:
    case TYPE.INT16: {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(Number(value ?? 0));

      return b;
    }

    case TYPE.UINT32:
    case TYPE.INT32:
      return u32(Number(value ?? 0));
    case TYPE.FLOAT32: {
      const b = Buffer.alloc(4);
      b.writeFloatLE(Number(value ?? 0));

      return b;
    }

    case TYPE.BOOL:
      return Buffer.from([value ? 1 : 0]);
    case TYPE.STRING:
      return ggufString(String(value ?? ""));
    case TYPE.UINT64:
    case TYPE.INT64:
      return u64(typeof value === "bigint" ? value : Number(value ?? 0));
    case TYPE.FLOAT64: {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(Number(value ?? 0));

      return b;
    }

    default:
      throw new Error(`unsupported scalar type ${type}`);
  }
}

function encodeValue(entry: GgufEntry): Buffer {
  if (entry.type === TYPE.ARRAY) {
    const elements = entry.values.map((value) => encodeScalar(entry.elementType, value));

    return Buffer.concat([u32(entry.elementType), u64(entry.values.length), ...elements]);
  }

  return encodeScalar(entry.type, entry.value);
}

export function buildGguf(
  entries: GgufEntry[],
  {
    version = 3,
    magic = GGUF_MAGIC,
    kvCount = null,
  }: { version?: number; magic?: number; kvCount?: number | null } = {}
): Buffer<ArrayBuffer> {
  const parts: Buffer[] = [u32(magic), u32(version), u64(0) /* tensor_count */];
  parts.push(u64(kvCount === null ? entries.length : kvCount));

  for (const entry of entries) {
    parts.push(ggufString(entry.key), u32(entry.type), encodeValue(entry));
  }

  return Buffer.from(Buffer.concat(parts));
}

/** A reader over an in-memory buffer, matching the shape readGgufMetadata expects. */
export function bufferReader(buffer: Buffer): GgufSource {
  return {
    size: buffer.length,
    read: async (offset: number, length: number): Promise<Buffer> =>
      Buffer.from(buffer.subarray(offset, offset + length)),
  };
}

// The #1203 model, as its GGUF declares itself.
export const LLAMA_3_2_3B_ENTRIES: GgufScalarEntry[] = [
  { key: "general.architecture", type: TYPE.STRING, value: "llama" },
  { key: "llama.block_count", type: TYPE.UINT32, value: 28 },
  { key: "llama.context_length", type: TYPE.UINT32, value: 131072 },
  { key: "llama.embedding_length", type: TYPE.UINT32, value: 3072 },
  { key: "llama.attention.head_count", type: TYPE.UINT32, value: 24 },
  { key: "llama.attention.head_count_kv", type: TYPE.UINT32, value: 8 },
  { key: "llama.attention.key_length", type: TYPE.UINT32, value: 128 },
  { key: "llama.attention.value_length", type: TYPE.UINT32, value: 128 },
];
