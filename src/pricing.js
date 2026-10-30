// Pure, deterministic pricing engine. Given the same inputs it always returns the same outputs.
//
//   new price = previous price × (1 + fundamental + trading pressure + noise)
//
// Every component is integer basis points; the combined move is clamped, and the
// resulting price is rounded half-away-from-zero to the paisa and clamped to [min, max].

const crypto = require('crypto');
const { divRound, clamp } = require('./money');

// Fundamental impact of one company from the events effective this round.
// Event configuration: { "industries": { "Energy": -800 }, "companies": { "SOLR": -300 } }
// A company-specific entry replaces (not adds to) its industry entry for that event,
// which is how "a mitigation plan makes the hit smaller" is expressed.
function fundamentalBps(company, events) {
  let total = 0;
  for (const ev of events) {
    const cfg = ev.configuration || {};
    const byCompany = cfg.companies || {};
    const byIndustry = cfg.industries || {};
    if (Object.prototype.hasOwnProperty.call(byCompany, company.ticker)) total += Number(byCompany[company.ticker]);
    else if (Object.prototype.hasOwnProperty.call(byIndustry, company.industry)) total += Number(byIndustry[company.industry]);
  }
  return total;
}

// Aggregate trading pressure: net demand equal to pressure_ref_qty moves the price by
// pressure_scale_bps, linearly, capped at ±pressure_cap_bps.
function tradingBps(netDemand, refQty, settings) {
  const raw = Number(divRound(BigInt(netDemand) * BigInt(settings.pressure_scale_bps), BigInt(refQty)));
  return clamp(raw, -settings.pressure_cap_bps, settings.pressure_cap_bps);
}

// Bounded, reproducible "noise" derived from a hash, not from Math.random().
function noiseBps(seed, roundId, ticker, amplitude) {
  if (!amplitude) return 0;
  const h = crypto.createHash('sha256').update(`${seed}|${roundId}|${ticker}`).digest();
  return (h.readUInt32BE(0) % (2 * amplitude + 1)) - amplitude;
}

function nextPrice(prevPrice, totalBps, settings) {
  const raw = Number(divRound(BigInt(prevPrice) * BigInt(10000 + totalBps), 10000n));
  return clamp(raw, settings.min_price, settings.max_price);
}

// inputs: { roundId, companies:[{id,ticker,industry,pressure_ref_qty}], prevPrices: Map(id->price),
//           netDemand: Map(id->qty), events:[{configuration}], settings }
function computeRound({ roundId, companies, prevPrices, netDemand, events, settings }) {
  return companies.map((c) => {
    const prev = prevPrices.get(c.id);
    if (!Number.isSafeInteger(prev) || prev <= 0) throw new Error(`missing previous price for ${c.ticker}`);
    const demand = netDemand.get(c.id) || 0;
    const f = fundamentalBps(c, events);
    const t = tradingBps(demand, c.pressure_ref_qty, settings);
    const n = noiseBps(settings.noise_seed, roundId, c.ticker, settings.noise_bps);
    const total = clamp(f + t + n, -settings.max_move_down_bps, settings.max_move_up_bps);
    const price = nextPrice(prev, total, settings);
    return {
      company_id: c.id,
      ticker: c.ticker,
      prev_price: prev,
      price,
      fundamental_bps: f,
      trading_bps: t,
      noise_bps: n,
      total_bps: total,
      net_demand: demand,
    };
  });
}

module.exports = { fundamentalBps, tradingBps, noiseBps, nextPrice, computeRound };
