import type { Address } from "viem";

export function fundingAuthorizationMessage(input: {
  paymentId: string;
  amount: string;
  chainId: number;
  tokenAddress: Address;
  destinationAddress: Address;
  senderAddress: Address;
}) {
  return [
    "Authorize Onda USDC payment",
    `Payment: ${input.paymentId}`,
    `Amount: ${input.amount} USDC`,
    `Network: Base (${input.chainId})`,
    `Token: ${input.tokenAddress.toLowerCase()}`,
    `Destination: ${input.destinationAddress.toLowerCase()}`,
    `Sender: ${input.senderAddress.toLowerCase()}`,
  ].join("\n");
}
