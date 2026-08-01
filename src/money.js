const SCALE_DIGITS = 4;
const SCALE = 10n ** BigInt(SCALE_DIGITS);

export function parseDecimal(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid decimal number");
    value = String(value);
  }

  if (typeof value !== "string") throw new Error("Decimal value must be a string or number");

  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid decimal: ${value}`);

  const sign = trimmed.startsWith("-") ? -1n : 1n;
  const unsigned = trimmed.startsWith("-") ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ""] = unsigned.split(".");
  const paddedFraction = `${fraction.slice(0, SCALE_DIGITS)}${"0".repeat(SCALE_DIGITS)}`.slice(0, SCALE_DIGITS);

  return sign * (BigInt(whole) * SCALE + BigInt(paddedFraction));
}

export function formatDecimal(units) {
  const sign = units < 0n ? "-" : "";
  const absolute = units < 0n ? -units : units;
  const whole = absolute / SCALE;
  const fraction = String(absolute % SCALE).padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function multiplyDecimal(leftUnits, rightUnits) {
  return (leftUnits * rightUnits) / SCALE;
}

export function roundToUnit(amountUnits, roundingUnit) {
  const unit = parseDecimal(roundingUnit ?? "0");
  if (unit <= 0n) return amountUnits;

  const half = unit / 2n;
  if (amountUnits >= 0n) return ((amountUnits + half) / unit) * unit;
  return -roundToUnit(-amountUnits, roundingUnit);
}

export function splitEvenly(totalUnits, count) {
  if (!Number.isInteger(count) || count <= 0) throw new Error("Split count must be positive");

  const divisor = BigInt(count);
  const base = totalUnits / divisor;
  let remainder = totalUnits % divisor;

  return Array.from({ length: count }, () => {
    const extra = remainder > 0n ? 1n : remainder < 0n ? -1n : 0n;
    remainder -= extra;
    return base + extra;
  });
}

