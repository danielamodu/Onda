import { getAddress, isAddress, type Address } from "viem";
import { base, baseSepolia } from "@/lib/payments/base/chains";

const networkConfig = {
  8453: { chain: base, name: "Base", tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  84532: { chain: baseSepolia, name: "Base Sepolia", tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
} as const;

export type SupportedBaseChainId = keyof typeof networkConfig;
export type BasePublicConfig = {
  chainId: SupportedBaseChainId;
  chainName: string;
  tokenAddress: Address;
  destinationAddress: Address | null;
  confirmations: number;
};

function selectedNetwork() {
  const chainId = Number(process.env.BASE_CHAIN_ID ?? 84532);
  if (chainId !== 8453 && chainId !== 84532) {
    throw new Error("BASE_CHAIN_ID must be 84532 (Base Sepolia) or 8453 (Base mainnet).");
  }
  return { chainId: chainId as SupportedBaseChainId, ...networkConfig[chainId as SupportedBaseChainId] };
}

function confirmationCount() {
  const value = Number(process.env.BASE_CONFIRMATIONS ?? 2);
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error("BASE_CONFIRMATIONS must be an integer between 1 and 64.");
  }
  return value;
}

export function getBasePublicConfig(): BasePublicConfig {
  const network = selectedNetwork();
  const configuredAddress = process.env.BASE_FUNDING_ADDRESS;
  const destinationAddress = configuredAddress && isAddress(configuredAddress)
    ? getAddress(configuredAddress)
    : null;
  return {
    chainId: network.chainId,
    chainName: network.name,
    tokenAddress: getAddress(network.tokenAddress),
    destinationAddress,
    confirmations: confirmationCount(),
  };
}

export function getBaseFundingConfig() {
  const publicConfig = getBasePublicConfig();
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL is required to verify Base payments.");
  if (!/^https?:\/\//i.test(rpcUrl)) throw new Error("BASE_RPC_URL must be an HTTP or HTTPS URL.");
  if (!publicConfig.destinationAddress) throw new Error("BASE_FUNDING_ADDRESS must be a valid wallet address.");
  const network = selectedNetwork();
  return { ...publicConfig, chain: network.chain, rpcUrl, destinationAddress: publicConfig.destinationAddress };
}
