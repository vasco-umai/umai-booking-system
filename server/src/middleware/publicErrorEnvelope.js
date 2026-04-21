const logger = require('../lib/logger');
const { ErrorCodes } = require('../lib/errors');

/**
 * Error envelope for /api/public/* routes.
 *
 * Shape (stable, documented in openapi.yaml):
 *   { "error": { "code": "SOMETHING", "message": "...", "request_id": "uuid" } }
 *
 * The admin/internal error handler returns a different shape for historical
 * reasons; we don't touch it here — this middleware ONLY runs on public routes.
 */
function publicErrorEnvelope(err, req, res, _next) {
  const requestId = req.id || 'unknown';
  const status = err.status || 500;
  const code = err.code || ErrorCodes.INTERNAL_ERROR;
  const exposeMessage = status < 500;

  const logCtx = {
    requestId,
    method: req.method,
    url: req.originalUrl,
    status,
    code,
    apiKeyId: req.apiKey?.id,
    teamId: req.apiKey?.teamId,
  };
  if (status >= 500) {
    logger.error({ err, ...logCtx }, 'Public API 5xx');
  } else {
    logger.warn(logCtx, err.message);
  }

  res.status(status).json({
    error: {
      code,
      message: exposeMessage ? err.message : 'Internal server error',
      request_id: requestId,
    },
  });
}

module.exports = publicErrorEnvelope;
