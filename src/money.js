// Money is integer paise. Rates are integer basis points. No floats touch authoritative values.

const BPS = 10000n;

// Rounds a/b to the nearest integer, halves away from zero. Inputs are BigInt.
function divRound(a, b) {
  const neg = (a < 0n) !== (b < 0n);
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = (absA * 2n + absB) / (absB * 2n);
  return neg ? -q : q;
}

// amount * bps / 10000, rounded half away from zero.
function applyBps(amount, bps) {
  return Number(divRound(BigInt(amount) * BigInt(bps), BPS));
}

// amount * bps / 10000, rounded up (used for fees and interest so the house never under-collects).
function ceilBps(amount, bps) {
  const n = BigInt(amount) * BigInt(bps);
  return Number((n + BPS - 1n) / BPS);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

// ₹ formatting for logs / server-generated text. Clients format for display themselves.
function rupees(paise) {
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { divRound, applyBps, ceilBps, clamp, isPositiveInt, rupees };
