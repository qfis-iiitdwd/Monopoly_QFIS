const { GameError } = require('../errors');

// Wraps an async handler so rejections reach the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function intParam(v, name) {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new GameError(`${name} must be an integer`);
  return n;
}

module.exports = { h, intParam };
