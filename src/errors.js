// A rule violation that should be reported to the caller (HTTP 4xx), not logged as a crash.
class GameError extends Error {
  constructor(message, status = 400, code = 'rejected') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { GameError };
