import { isIPv4 } from "node:net";

// Test-only: builds a tiny, real MaxMind DB (.mmdb) country database in
// memory, so geoip/region tests exercise the actual mmdb-lib reader rather
// than a mock — without downloading or committing a third-party database.
// Same layout as GeoLite2-Country / DB-IP Country Lite: an IPv6 tree (IPv4
// lives under ::/96), 24-bit records, and { country: { iso_code } } data.
// Spec: https://maxmind.github.io/MaxMind-DB/

type Ref = { node: number } | { data: number } | null;
interface TreeNode {
  left: Ref;
  right: Ref;
}

function ipv6Bits(address: string): number[] {
  const [head, tail = ""] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = [
    ...headGroups,
    ...Array<string>(8 - headGroups.length - tailGroups.length).fill("0"),
    ...tailGroups,
  ];
  return groups.flatMap((group) => {
    const value = parseInt(group, 16);
    return Array.from({ length: 16 }, (_, i) => (value >> (15 - i)) & 1);
  });
}

// The bits that select `network` (e.g. "203.0.113.0/24", "2401:4900::/32").
function networkBits(network: string): number[] {
  const [address, length] = network.split("/");
  if (isIPv4(address)) {
    const v4 = address.split(".").flatMap((octet) => Array.from({ length: 8 }, (_, i) => (Number(octet) >> (7 - i)) & 1));
    return [...Array<number>(96).fill(0), ...v4].slice(0, 96 + Number(length));
  }
  return ipv6Bits(address).slice(0, Number(length));
}

function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([(2 << 5) | bytes.length]), bytes]);
}

function encodeUint(type: 5 | 6, value: number): Buffer {
  const bytes: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([(type << 5) | bytes.length, ...bytes]);
}

// uint64 is an "extended" type (9): type bits 0, then a byte holding 9 - 7.
function encodeUint64(value: number): Buffer {
  const bytes: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([bytes.length, 9 - 7, ...bytes]);
}

function encodeMap(entries: [string, Buffer][]): Buffer {
  return Buffer.concat([
    Buffer.from([(7 << 5) | entries.length]),
    ...entries.flatMap(([key, value]) => [encodeString(key), value]),
  ]);
}

function writeRecord(buffer: Buffer, offset: number, value: number) {
  buffer.writeUIntBE(value, offset, 3);
}

// `builtAt` becomes the database's build_epoch metadata (defaults to now).
export function buildCountryMmdb(networks: Record<string, string>, builtAt: Date = new Date()): Buffer {
  const nodes: TreeNode[] = [{ left: null, right: null }];
  const dataRecords: Buffer[] = [];

  for (const [network, isoCode] of Object.entries(networks)) {
    dataRecords.push(encodeMap([["country", encodeMap([["iso_code", encodeString(isoCode)]])]]));
    const dataIndex = dataRecords.length - 1;
    const bits = networkBits(network);

    let current = 0;
    bits.forEach((bit, depth) => {
      const side = bit ? "right" : "left";
      if (depth === bits.length - 1) {
        nodes[current][side] = { data: dataIndex };
        return;
      }
      const next = nodes[current][side];
      if (next !== null && "node" in next) {
        current = next.node;
      } else {
        nodes.push({ left: null, right: null });
        nodes[current][side] = { node: nodes.length - 1 };
        current = nodes.length - 1;
      }
    });
  }

  const nodeCount = nodes.length;
  const dataOffsets: number[] = [];
  let offset = 0;
  for (const record of dataRecords) {
    dataOffsets.push(offset);
    offset += record.length;
  }

  const recordValue = (ref: Ref): number => {
    if (ref === null) return nodeCount;
    if ("node" in ref) return ref.node;
    return nodeCount + 16 + dataOffsets[ref.data];
  };

  const tree = Buffer.alloc(nodeCount * 6);
  nodes.forEach((node, i) => {
    writeRecord(tree, i * 6, recordValue(node.left));
    writeRecord(tree, i * 6 + 3, recordValue(node.right));
  });

  const metadata = encodeMap([
    ["node_count", encodeUint(6, nodeCount)],
    ["record_size", encodeUint(5, 24)],
    ["ip_version", encodeUint(5, 6)],
    ["database_type", encodeString("Polimatiq-Test-Country")],
    ["binary_format_major_version", encodeUint(5, 2)],
    ["binary_format_minor_version", encodeUint(5, 0)],
    ["build_epoch", encodeUint64(Math.floor(builtAt.getTime() / 1000))],
  ]);

  return Buffer.concat([
    tree,
    Buffer.alloc(16),
    ...dataRecords,
    Buffer.from("ABCDEF4D61784D696E642E636F6D", "hex"),
    metadata,
  ]);
}
