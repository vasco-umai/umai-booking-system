const logger = require('../lib/logger');
const { ErrorCodes } = require('../lib/errors');

function errorHandler(err, req, res, _next) {
  const requestId = req.id || 'unknown';
  const status = err.status || 500;
  const code = err.code || ErrorCodes.INTERNAL_ERROR;

  if (status >= 500) {
    logger.error({ err, requestId, method: req.method, url: req.originalUrl }, 'Unhandled server error');
  } else {
    logger.warn({ requestId, method: req.method, url: req.originalUrl, status, code }, err.message);
  }

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message,
    code,
    requestId,
  });
}

module.exports = errorHandler;
