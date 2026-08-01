import { formatDecimal, multiplyDecimal, parseDecimal, roundToUnit, splitEvenly } from "./money.js";

function requireMember(memberIds, memberId) {
  if (!memberIds.has(memberId)) throw new Error(`Unknown memberId: ${memberId}`);
}

function toBaseUnits(amount, rateToBase = "1") {
  return multiplyDecimal(parseDecimal(amount), parseDecimal(rateToBase));
}

function normalizeExpense(memberIds, expense) {
  requireMember(memberIds, expense.payerMemberId);

  const baseAmount = toBaseUnits(expense.amount, expense.rateToBase);
  const debtors = expense.debtors ?? [];
  if (debtors.length === 0) throw new Error("Expense must include at least one debtor");

  debtors.forEach((debtor) => requireMember(memberIds, debtor.memberId));

  if (expense.splitMode === "custom") {
    const debtorAmounts = debtors.map((debtor) => ({
      memberId: debtor.memberId,
      amount: toBaseUnits(debtor.amount, expense.rateToBase),
    }));

    const totalDebtorAmount = debtorAmounts.reduce((sum, debtor) => sum + debtor.amount, 0n);
    if (totalDebtorAmount !== baseAmount) {
      throw new Error("Custom debtor amounts must equal expense amount");
    }

    return { payerMemberId: expense.payerMemberId, baseAmount, debtorAmounts };
  }

  if (expense.splitMode !== "equal") throw new Error(`Unsupported splitMode: ${expense.splitMode}`);

  const shares = splitEvenly(baseAmount, debtors.length);
  return {
    payerMemberId: expense.payerMemberId,
    baseAmount,
    debtorAmounts: debtors.map((debtor, index) => ({
      memberId: debtor.memberId,
      amount: shares[index],
    })),
  };
}

export function calculateSettlement(input) {
  const members = input.members ?? [];
  const memberIds = new Set(members.map((member) => member.id));
  if (memberIds.size !== members.length) throw new Error("Member IDs must be unique");
  if (members.length < 2) throw new Error("At least two members are required");

  const balances = new Map(members.map((member) => [member.id, 0n]));

  for (const expense of input.expenses ?? []) {
    const normalized = normalizeExpense(memberIds, expense);
    balances.set(
      normalized.payerMemberId,
      balances.get(normalized.payerMemberId) + normalized.baseAmount,
    );

    for (const debtor of normalized.debtorAmounts) {
      balances.set(debtor.memberId, balances.get(debtor.memberId) - debtor.amount);
    }
  }

  const debtors = [];
  const creditors = [];

  for (const [memberId, balance] of balances.entries()) {
    if (balance < 0n) debtors.push({ memberId, amount: -balance });
    if (balance > 0n) creditors.push({ memberId, amount: balance });
  }

  debtors.sort((a, b) => a.memberId.localeCompare(b.memberId));
  creditors.sort((a, b) => a.memberId.localeCompare(b.memberId));

  const roundingUnit = input.roundingUnit ?? "0";
  const items = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = debtor.amount < creditor.amount ? debtor.amount : creditor.amount;

    const roundedAmount = roundToUnit(amount, roundingUnit);
    if (roundedAmount > 0n) {
      items.push({
        fromMemberId: debtor.memberId,
        toMemberId: creditor.memberId,
        amount: formatDecimal(roundedAmount),
      });
    }

    debtor.amount -= amount;
    creditor.amount -= amount;

    if (debtor.amount === 0n) debtorIndex += 1;
    if (creditor.amount === 0n) creditorIndex += 1;
  }

  return {
    baseCurrencyCode: input.baseCurrencyCode ?? "JPY",
    balances: Object.fromEntries(
      [...balances.entries()].map(([memberId, amount]) => [memberId, formatDecimal(amount)]),
    ),
    items,
  };
}

