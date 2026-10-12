import { Prisma, type PrismaClient } from "@prisma/client";
import { parseUnits } from "viem";

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export class LedgerConflictError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConflictError";
  }
}

export class LedgerInsufficientFundsError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInsufficientFundsError";
  }
}

export class ReservationExistsError extends LedgerConflictError {
  constructor(message = "This payment already has an active treasury reservation.") {
    super(message);
    this.name = "ReservationExistsError";
  }
}

class TreasuryContentionError extends LedgerError {
  constructor() {
    super("Treasury ledger contention; retry the operation.");
    this.name = "TreasuryContentionError";
  }
}

export type TreasuryIdentity = {
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  treasuryAddress: string;
};

export type TreasuryBalances = {
  creditedUnits: bigint;
  reservedUnits: bigint;
  debitedUnits: bigint;
  availableUnits: bigint;
};

export type ActiveReservation = {
  id: string;
  paymentId: string | null;
  amountUnits: bigint;
};

type LedgerTables = Pick<Prisma.TransactionClient, "treasuryAccount" | "treasuryLedgerEntry">;
export type TreasuryTx = LedgerTables;

export type TreasuryDb = Pick<PrismaClient, "$transaction" | "treasuryAccount" | "treasuryLedgerEntry">;

export function fundingCreditKey(chainId: number, transactionHash: string) {
  return `funding:${chainId}:${transactionHash.toLowerCase()}`;
}

export function reserveKey(paymentId: string, attemptNumber: number) {
  return `reserve:${paymentId}:${attemptNumber}`;
}

export function debitKey(providerIdempotencyKey: string) {
  return `settle:${providerIdempotencyKey}`;
}

export function releaseKey(reservationId: string) {
  return `release:${reservationId}`;
}

export function baseUnitsFromDecimalString(value: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new LedgerError("Ledger amounts must be non-negative decimal strings.");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new LedgerError("Ledger token decimals are invalid.");
  try {
    return parseUnits(value, decimals);
  } catch {
    throw new LedgerError("Ledger amount cannot be represented in token base units.");
  }
}

export async function getOrCreateTreasuryAccount(
  client: Pick<Prisma.TransactionClient, "treasuryAccount">,
  identity: TreasuryIdentity,
): Promise<{ id: string; version: number; tokenDecimals: number }> {
  const where = {
    chainId_tokenAddress_treasuryAddress: {
      chainId: identity.chainId,
      tokenAddress: identity.tokenAddress,
      treasuryAddress: identity.treasuryAddress,
    },
  };
  const existing = await client.treasuryAccount.findUnique({ where });
  if (existing) return existing;
  try {
    return await client.treasuryAccount.create({
      data: {
        chainId: identity.chainId,
        tokenAddress: identity.tokenAddress,
        tokenSymbol: identity.tokenSymbol,
        tokenDecimals: identity.tokenDecimals,
        treasuryAddress: identity.treasuryAddress,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await client.treasuryAccount.findUnique({ where });
      if (!raced) throw new LedgerError("Treasury account could not be loaded after a concurrent creation.");
      return raced;
    }
    throw error;
  }
}

type LedgerEntryRow = {
  id: string;
  type: string;
  amountUnits: bigint;
  paymentId: string | null;
  reservationId: string | null;
};

async function loadEntries(tx: TreasuryTx, treasuryAccountId: string): Promise<LedgerEntryRow[]> {
  const rows = await tx.treasuryLedgerEntry.findMany({
    where: { treasuryAccountId },
    select: { id: true, type: true, amountUnits: true, paymentId: true, reservationId: true },
  });
  return rows.map((row) => ({
    id: String(row.id),
    type: String(row.type),
    amountUnits: BigInt(String(row.amountUnits)),
    paymentId: row.paymentId == null ? null : String(row.paymentId),
    reservationId: row.reservationId == null ? null : String(row.reservationId),
  }));
}

export function summarizeLedger(entries: LedgerEntryRow[]): TreasuryBalances & { activeReservations: ActiveReservation[] } {
  let creditedUnits = BigInt(0);
  let debitedUnits = BigInt(0);
  const consumed = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "CREDIT") creditedUnits += entry.amountUnits;
    if (entry.type === "DEBIT") {
      debitedUnits += entry.amountUnits;
      if (entry.reservationId) consumed.add(entry.reservationId);
    }
    if (entry.type === "RELEASE" && entry.reservationId) consumed.add(entry.reservationId);
  }
  const activeReservations: ActiveReservation[] = [];
  let reservedUnits = BigInt(0);
  for (const entry of entries) {
    if (entry.type === "RESERVE" && !consumed.has(entry.id)) {
      reservedUnits += entry.amountUnits;
      activeReservations.push({ id: entry.id, paymentId: entry.paymentId, amountUnits: entry.amountUnits });
    }
  }
  return { creditedUnits, reservedUnits, debitedUnits, availableUnits: creditedUnits - debitedUnits - reservedUnits, activeReservations };
}

export async function getTreasuryBalances(
  client: Pick<Prisma.TransactionClient, "treasuryAccount">,
  treasuryAccountId: string,
): Promise<TreasuryBalances> {
  return readAccountSnapshot(client, treasuryAccountId);
}

type AccountSnapshotClient = Pick<Prisma.TransactionClient, "treasuryAccount">;

// O(1) read of the transactionally-maintained balance snapshot carried on the
// TreasuryAccount row. availableUnits is always derived, never stored, so it
// cannot disagree with its own components. The append-only TreasuryLedgerEntry
// history stays the source of truth; reconcileSnapshot recomputes from it.
async function readAccountSnapshot(
  client: AccountSnapshotClient,
  treasuryAccountId: string,
): Promise<TreasuryBalances> {
  const account = await client.treasuryAccount.findUnique({
    where: { id: treasuryAccountId },
    select: { creditedUnits: true, reservedUnits: true, debitedUnits: true },
  });
  if (!account) throw new LedgerError("Treasury account is missing.");
  const creditedUnits = BigInt(String(account.creditedUnits));
  const reservedUnits = BigInt(String(account.reservedUnits));
  const debitedUnits = BigInt(String(account.debitedUnits));
  return { creditedUnits, reservedUnits, debitedUnits, availableUnits: creditedUnits - reservedUnits - debitedUnits };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new LedgerError("Unexpected ledger record shape.");
  return value as Record<string, unknown>;
}

export async function withGuardedTreasurySection<T>(
  deps: TreasuryDb,
  treasuryAccountId: string,
  work: (tx: Prisma.TransactionClient, account: { id: string; version: number; tokenDecimals: number }) => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const account = await deps.treasuryAccount.findUnique({ where: { id: treasuryAccountId } });
    if (!account) throw new LedgerError("Treasury account is missing.");
    try {
      return await deps.$transaction(async (tx) => {
        const outcome = await work(tx, account);
        const bumped = await tx.treasuryAccount.updateMany({
          where: { id: treasuryAccountId, version: account.version },
          data: { version: account.version + 1 },
        });
        if (bumped.count === 0) throw new TreasuryContentionError();
        return outcome;
      }, { maxWait: 15_000, timeout: 30_000 });
    } catch (error) {
      if (error instanceof TreasuryContentionError && attempt < maxAttempts) continue;
      // A raced idempotent insert (CREDIT or DEBIT) surfaces as P2002 and, on
      // Postgres, poisons this transaction — so the duplicate cannot be
      // confirmed with an in-transaction read. Prisma has already rolled back;
      // retry with a fresh transaction, where the operation's own idempotency
      // pre-check now observes the committed row and converges without
      // re-inserting. RESERVE/RELEASE translate their own P2002 and never reach
      // here. Bounded by maxAttempts so a genuinely terminal conflict surfaces.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        attempt < maxAttempts
      ) {
        continue;
      }
      throw error;
    }
  }
}

// Active reservation for a payment: the one RESERVE entry for that payment not
// yet consumed by a RELEASE or DEBIT. Bounded by the payment's settlement
// attempts (indexed by paymentId + reservationId), never a full-account scan.
export async function findActiveReservationForPayment(
  tx: TreasuryTx,
  treasuryAccountId: string,
  paymentId: string,
): Promise<ActiveReservation | null> {
  const reserves = await tx.treasuryLedgerEntry.findMany({
    where: { treasuryAccountId, paymentId, type: "RESERVE" },
    select: { id: true, paymentId: true, amountUnits: true },
    orderBy: { createdAt: "asc" },
  });
  for (const reserve of reserves) {
    if (!(await reservationConsumer(tx, reserve.id))) {
      return { id: String(reserve.id), paymentId: reserve.paymentId, amountUnits: BigInt(String(reserve.amountUnits)) };
    }
  }
  return null;
}

async function reservationConsumer(tx: TreasuryTx, reservationId: string): Promise<boolean> {
  const consumer = await tx.treasuryLedgerEntry.findFirst({
    where: { reservationId, type: { in: ["RELEASE", "DEBIT"] } },
    select: { id: true },
  });
  return consumer !== null;
}

async function findActiveReservationById(
  tx: TreasuryTx,
  treasuryAccountId: string,
  reservationId: string,
): Promise<ActiveReservation | null> {
  const reserve = await tx.treasuryLedgerEntry.findFirst({
    where: { id: reservationId, treasuryAccountId, type: "RESERVE" },
    select: { id: true, paymentId: true, amountUnits: true },
  });
  if (!reserve) return null;
  if (await reservationConsumer(tx, reserve.id)) return null;
  return { id: String(reserve.id), paymentId: reserve.paymentId, amountUnits: BigInt(String(reserve.amountUnits)) };
}

export async function findDebitByKey(
  tx: TreasuryTx,
  treasuryAccountId: string,
  providerIdempotencyKey: string,
): Promise<{ id: string } | null> {
  const found = await tx.treasuryLedgerEntry.findFirst({
    where: { treasuryAccountId, idempotencyKey: debitKey(providerIdempotencyKey) },
    select: { id: true },
  });
  return found ? { id: String(asRecord(found).id) } : null;
}

export async function creditFundingDeposit(
  tx: TreasuryTx,
  input: {
    treasuryAccountId: string;
    paymentId: string;
    chainId: number;
    amountUnits: bigint;
    transactionHash: string;
    reference?: string;
  },
): Promise<{ entryId: string; duplicate: boolean }> {
  if (input.amountUnits <= BigInt(0)) throw new LedgerError("Funding credits must be positive.");
  const key = fundingCreditKey(input.chainId, input.transactionHash);
  const existing = await tx.treasuryLedgerEntry.findFirst({ where: { idempotencyKey: key }, select: { id: true } });
  if (existing) return { entryId: String(asRecord(existing).id), duplicate: true };
  const snapshot = await readAccountSnapshot(tx, input.treasuryAccountId);
  // NOTE: no in-transaction P2002 handling here, by design — mirrors
  // debitSettlement. On Postgres a unique-violation aborts the whole
  // transaction (25P02), so the duplicate cannot be re-read inside it. A
  // concurrent duplicate (same funding idempotency key) propagates P2002 to
  // withGuardedTreasurySection, which rolls back and retries; the pre-check
  // above then sees the committed row and returns duplicate without re-insert.
  const created = await tx.treasuryLedgerEntry.create({
    data: {
      treasuryAccountId: input.treasuryAccountId,
      paymentId: input.paymentId,
      type: "CREDIT",
      amountUnits: input.amountUnits,
      balanceAfterUnits: snapshot.availableUnits + input.amountUnits,
      idempotencyKey: key,
      reference: input.reference ?? input.transactionHash.toLowerCase(),
    },
  });
  await tx.treasuryAccount.update({
    where: { id: input.treasuryAccountId },
    data: { creditedUnits: { increment: input.amountUnits } },
  });
  return { entryId: String(asRecord(created).id), duplicate: false };
}

export async function creditVerifiedTempoDeposit(
  tx: TreasuryTx & Pick<Prisma.TransactionClient, "treasuryAccount">,
  input: {
    treasuryAccountId: string;
    paymentId: string;
    chainId: number;
    tokenAddress: string;
    amountUnits: bigint;
    transactionHash: string;
    reference?: string;
  },
): Promise<{ entryId: string; duplicate: boolean }> {
  const account = await tx.treasuryAccount.findUnique({
    where: { id: input.treasuryAccountId },
    select: { chainId: true, tokenAddress: true },
  });
  if (!account) throw new LedgerError("Treasury account is missing.");
  if (account.chainId !== input.chainId || account.tokenAddress.toLowerCase() !== input.tokenAddress.toLowerCase()) {
    throw new LedgerConflictError("Funding evidence is not for this treasury account; historical or foreign-chain deposits cannot back Tempo settlements.");
  }
  return creditFundingDeposit(tx, input);
}

export async function checkReserveFits(
  tx: TreasuryTx,
  input: {
    treasuryAccountId: string;
    paymentId: string;
    amountUnits: bigint;
  },
): Promise<{ availableUnits: bigint }> {
  if (input.amountUnits <= BigInt(0)) throw new LedgerError("Settlement reservations must be positive.");
  const active = await findActiveReservationForPayment(tx, input.treasuryAccountId, input.paymentId);
  if (active) throw new ReservationExistsError();
  const snapshot = await readAccountSnapshot(tx, input.treasuryAccountId);
  if (snapshot.availableUnits < input.amountUnits) {
    throw new LedgerInsufficientFundsError("Treasury available balance cannot cover this settlement.");
  }
  return { availableUnits: snapshot.availableUnits };
}

export async function reserveForSettlement(
  tx: TreasuryTx,
  input: {
    treasuryAccountId: string;
    paymentId: string;
    attemptNumber: number;
    amountUnits: bigint;
    idempotencyKey?: string;
  },
): Promise<{ reservationId: string }> {
  if (input.amountUnits <= BigInt(0)) throw new LedgerError("Settlement reservations must be positive.");
  await checkReserveFits(tx, {
    treasuryAccountId: input.treasuryAccountId,
    paymentId: input.paymentId,
    amountUnits: input.amountUnits,
  });
  const snapshot = await readAccountSnapshot(tx, input.treasuryAccountId);
  try {
    const created = await tx.treasuryLedgerEntry.create({
      data: {
        treasuryAccountId: input.treasuryAccountId,
        paymentId: input.paymentId,
        type: "RESERVE",
        amountUnits: input.amountUnits,
        balanceAfterUnits: snapshot.availableUnits - input.amountUnits,
        idempotencyKey: input.idempotencyKey ?? reserveKey(input.paymentId, input.attemptNumber),
        reference: `settlement attempt ${input.attemptNumber}`,
      },
    });
    await tx.treasuryAccount.update({
      where: { id: input.treasuryAccountId },
      data: { reservedUnits: { increment: input.amountUnits } },
    });
    return { reservationId: String(asRecord(created).id) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ReservationExistsError("This settlement reservation was already recorded.");
    }
    throw error;
  }
}

export async function releaseReservation(
  tx: TreasuryTx,
  input: { treasuryAccountId: string; reservationId: string; reason: string },
): Promise<{ entryId: string; alreadyReleased: boolean }> {
  const reservation = await findActiveReservationById(tx, input.treasuryAccountId, input.reservationId);
  if (!reservation) return { entryId: "", alreadyReleased: true };
  const snapshot = await readAccountSnapshot(tx, input.treasuryAccountId);
  try {
    const created = await tx.treasuryLedgerEntry.create({
      data: {
        treasuryAccountId: input.treasuryAccountId,
        paymentId: reservation.paymentId,
        type: "RELEASE",
        amountUnits: reservation.amountUnits,
        balanceAfterUnits: snapshot.availableUnits + reservation.amountUnits,
        reservationId: reservation.id,
        idempotencyKey: releaseKey(reservation.id),
        reference: input.reason.slice(0, 240),
      },
    });
    await tx.treasuryAccount.update({
      where: { id: input.treasuryAccountId },
      data: { reservedUnits: { decrement: reservation.amountUnits } },
    });
    return { entryId: String(asRecord(created).id), alreadyReleased: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { entryId: "", alreadyReleased: true };
    }
    throw error;
  }
}

export async function debitSettlement(
  tx: TreasuryTx,
  input: {
    treasuryAccountId: string;
    paymentId: string;
    providerIdempotencyKey: string;
    reservationId: string;
    amountUnits: bigint;
    transactionHash: string;
  },
): Promise<{ entryId: string; duplicate: boolean }> {
  if (input.amountUnits <= BigInt(0)) throw new LedgerError("Settlement debits must be positive.");
  const key = debitKey(input.providerIdempotencyKey);
  const existing = await tx.treasuryLedgerEntry.findFirst({ where: { idempotencyKey: key }, select: { id: true } });
  if (existing) return { entryId: String(asRecord(existing).id), duplicate: true };
  const reservation = await findActiveReservationById(tx, input.treasuryAccountId, input.reservationId);
  if (!reservation) throw new LedgerConflictError("There is no active treasury reservation for this settlement.");
  if (reservation.paymentId !== input.paymentId || reservation.amountUnits !== input.amountUnits) {
    throw new LedgerConflictError("The settlement debit does not match its treasury reservation.");
  }
  const snapshot = await readAccountSnapshot(tx, input.treasuryAccountId);
  // NOTE: no P2002 handling here on purpose. In Postgres any error poisons
  // the enclosing transaction, so a duplicate can only be confirmed with a
  // fresh read outside of it — see the callers, which treat a duplicate key
  // as a successful replay after confirming the row exists.
  const created = await tx.treasuryLedgerEntry.create({
    data: {
      treasuryAccountId: input.treasuryAccountId,
      paymentId: input.paymentId,
      type: "DEBIT",
      amountUnits: input.amountUnits,
      balanceAfterUnits: snapshot.availableUnits,
      reservationId: reservation.id,
      idempotencyKey: key,
      reference: input.transactionHash.toLowerCase(),
    },
  });
  // Debit moves the hold from reserved to debited: available is unchanged.
  await tx.treasuryAccount.update({
    where: { id: input.treasuryAccountId },
    data: { reservedUnits: { decrement: input.amountUnits }, debitedUnits: { increment: input.amountUnits } },
  });
  return { entryId: String(asRecord(created).id), duplicate: false };
}

export type ReconciliationReport = TreasuryBalances & {
  onChainBalanceUnits: bigint;
  ledgerHeldUnits: bigint;
  driftUnits: bigint;
  status: "balanced" | "shortfall" | "surplus";
};

export function reconcileTreasury(
  balances: TreasuryBalances,
  onChainBalanceUnits: bigint,
): ReconciliationReport {
  const ledgerHeldUnits = balances.creditedUnits - balances.debitedUnits;
  const driftUnits = onChainBalanceUnits - ledgerHeldUnits;
  return {
    ...balances,
    onChainBalanceUnits,
    ledgerHeldUnits,
    driftUnits,
    status: driftUnits === BigInt(0) ? "balanced" : driftUnits < BigInt(0) ? "shortfall" : "surplus",
  };
}

export type SnapshotReconciliation = {
  snapshot: TreasuryBalances;
  recomputed: TreasuryBalances;
  drift: { creditedUnits: bigint; reservedUnits: bigint; debitedUnits: bigint; availableUnits: bigint };
  consistent: boolean;
};

// Recompute balances by scanning the append-only ledger (the authoritative
// source) — the one place a full scan is intentional. Used for backfill
// verification and the reconcile op; never on the hot path.
export async function recomputeBalancesFromLedger(
  tx: TreasuryTx,
  treasuryAccountId: string,
): Promise<TreasuryBalances> {
  const summary = summarizeLedger(await loadEntries(tx, treasuryAccountId));
  return {
    creditedUnits: summary.creditedUnits,
    reservedUnits: summary.reservedUnits,
    debitedUnits: summary.debitedUnits,
    availableUnits: summary.availableUnits,
  };
}

// Compare the maintained snapshot to a fresh recomputation from the ledger.
// Reports drift WITHOUT writing: the ledger stays authoritative and history is
// never overwritten to hide a discrepancy.
export async function reconcileSnapshot(
  tx: TreasuryTx,
  treasuryAccountId: string,
): Promise<SnapshotReconciliation> {
  const snapshot = await readAccountSnapshot(tx, treasuryAccountId);
  const recomputed = await recomputeBalancesFromLedger(tx, treasuryAccountId);
  const drift = {
    creditedUnits: snapshot.creditedUnits - recomputed.creditedUnits,
    reservedUnits: snapshot.reservedUnits - recomputed.reservedUnits,
    debitedUnits: snapshot.debitedUnits - recomputed.debitedUnits,
    availableUnits: snapshot.availableUnits - recomputed.availableUnits,
  };
  const consistent =
    drift.creditedUnits === BigInt(0) && drift.reservedUnits === BigInt(0) && drift.debitedUnits === BigInt(0);
  return { snapshot, recomputed, drift, consistent };
}
