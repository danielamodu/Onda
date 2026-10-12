import { keccak256, stringToBytes, type Hex } from "viem";

export function settlementIdempotencyScope(paymentId: string) {
  return `onda-settlement:${paymentId}`;
}

export function settlementMemo(paymentId: string): Hex {
  return keccak256(stringToBytes(settlementIdempotencyScope(paymentId)));
}

export function settlementAttemptKey(paymentId: string, attemptNumber: number) {
  return `${paymentId}:settlement:${attemptNumber}`;
}
