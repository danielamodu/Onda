import { decodeEventLog, type Address, type Hex } from "viem";

export const tip20Abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transferWithMemo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "memo", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "TransferWithMemo",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
      { indexed: true, name: "memo", type: "bytes32" },
    ],
  },
] as const;

export type MemoTransferLog = {
  from: Address;
  to: Address;
  value: bigint;
  memo: Hex;
};

function isAddressString(value: unknown): value is Address {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isBytes32String(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
}

export function decodeMemoTransferLog(log: { data: Hex; topics: readonly Hex[] }): MemoTransferLog | null {
  let decoded: { args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({ abi: tip20Abi, eventName: "TransferWithMemo", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  } catch {
    return null;
  }
  const { from, to, value, memo } = decoded.args;
  if (!isAddressString(from) || !isAddressString(to) || typeof value !== "bigint" || !isBytes32String(memo)) {
    return null;
  }
  return { from, to, value, memo };
}
