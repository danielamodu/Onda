import { createPublicClient, http, getAddress, isAddress, type Address, type Hex } from "viem";
import { SettlementConfigurationError } from "@/lib/payments/settlement/errors";
import { tip20Abi } from "@/lib/payments/tempo/abi";

export const TEMPO_MODERATO_CHAIN_ID = 42431;
export const TEMPO_MODERATO_CHAIN_NAME = "Tempo Moderato";
export const TEMPO_MODERATO_RPC_URL = "https://rpc.moderato.tempo.xyz";
export const TEMPO_MODERATO_EXPLORER_URL = "https://explore.testnet.tempo.xyz";
export const TEMPO_CANONICAL_ASSET = "AlphaUSD";
export const RECEIVE_POLICY_GUARD_ADDRESS: Address = "0xB10C000000000000000000000000000000000000";

export type TempoSettlementConfig = {
  chainId: typeof TEMPO_MODERATO_CHAIN_ID;
  rpcUrl: string;
  tokenAddress: Address;
  settlementPrivateKey: Hex;
  explorerUrl: string;
};

export type TempoPublicConfig = {
  chainId: typeof TEMPO_MODERATO_CHAIN_ID;
  chainName: string;
  rpcUrl: string;
  tokenAddress: Address;
  tokenSymbol: string;
  treasuryAddress: Address | null;
  explorerUrl: string;
};

export function getTempoSettlementConfig(): TempoSettlementConfig {
  const chainId = Number(process.env.TEMPO_CHAIN_ID ?? "");
  if (!Number.isInteger(chainId) || chainId !== TEMPO_MODERATO_CHAIN_ID) {
    throw new SettlementConfigurationError(
      "TEMPO_CHAIN_ID must be 42431 (Tempo Moderato). Mainnet and other chains are not enabled.",
    );
  }
  const rpcUrl = (process.env.TEMPO_RPC_URL ?? "").trim();
  if (!/^https?:\/\//i.test(rpcUrl)) {
    throw new SettlementConfigurationError("TEMPO_RPC_URL must be set to an HTTP or HTTPS Tempo RPC endpoint.");
  }
  const tokenAddress = (process.env.TEMPO_SETTLEMENT_TOKEN_ADDRESS ?? "").trim();
  if (!isAddress(tokenAddress)) {
    throw new SettlementConfigurationError(
      "TEMPO_SETTLEMENT_TOKEN_ADDRESS must be set to the verified TIP-20 settlement token address.",
    );
  }
  const privateKey = (process.env.TEMPO_SETTLEMENT_PRIVATE_KEY ?? "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new SettlementConfigurationError(
      "TEMPO_SETTLEMENT_PRIVATE_KEY must be set to the server settlement key. It is never exposed to the frontend.",
    );
  }
  return {
    chainId: TEMPO_MODERATO_CHAIN_ID,
    rpcUrl,
    tokenAddress: getAddress(tokenAddress),
    settlementPrivateKey: privateKey as Hex,
    explorerUrl: TEMPO_MODERATO_EXPLORER_URL,
  };
}

export function getTempoPublicConfig(): TempoPublicConfig {
  const { chainId, rpcUrl, tokenAddress, explorerUrl } = getTempoSettlementConfig();
  return { chainId, chainName: TEMPO_MODERATO_CHAIN_NAME, rpcUrl, tokenAddress, tokenSymbol: TEMPO_CANONICAL_ASSET, treasuryAddress: getTempoTreasuryAddress(), explorerUrl };
}

function getTempoTreasuryAddress(): Address | null {
  const configured = (process.env.TEMPO_TREASURY_ADDRESS ?? "").trim();
  if (!configured) return null;
  if (!isAddress(configured)) {
    throw new SettlementConfigurationError("TEMPO_TREASURY_ADDRESS must be a valid wallet address.");
  }
  return getAddress(configured);
}

export type TempoFundingConfig = TempoPublicConfig & {
  treasuryAddress: Address;
};

export function getTempoFundingConfig(): TempoFundingConfig {
  const publicConfig = getTempoPublicConfig();
  if (!publicConfig.treasuryAddress) {
    throw new SettlementConfigurationError("TEMPO_TREASURY_ADDRESS must be set to the controlled Onda treasury address.");
  }
  return { ...publicConfig, treasuryAddress: publicConfig.treasuryAddress };
}

export type TempoFundingUiConfig = {
  chainId: typeof TEMPO_MODERATO_CHAIN_ID;
  chainName: string;
  tokenAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  treasuryAddress: Address;
  explorerUrl: string;
};

export async function getTempoFundingUiConfig(): Promise<TempoFundingUiConfig> {
  const config = getTempoFundingConfig();
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: config.tokenAddress, abi: tip20Abi, functionName: "decimals" }),
    client.readContract({ address: config.tokenAddress, abi: tip20Abi, functionName: "symbol" }),
  ]);
  if (!Number.isInteger(decimals) || decimals < 2 || decimals > 36 || symbol !== config.tokenSymbol) {
    throw new SettlementConfigurationError("The configured Tempo settlement token failed its identity check.");
  }
  return {
    chainId: config.chainId,
    chainName: config.chainName,
    tokenAddress: config.tokenAddress,
    tokenSymbol: config.tokenSymbol,
    tokenDecimals: decimals,
    treasuryAddress: config.treasuryAddress,
    explorerUrl: config.explorerUrl,
  };
}
