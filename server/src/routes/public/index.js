const path = require('path');
const fs = require('fs');
const { Router } = require('express');
const { requireApiKey } = require('../../middleware/apiKey');
const { requireIdempotencyKey } = require('../../middleware/idempotency');
const publicErrorEnvelope = require('../../middleware/publicErrorEnvelope');
const availabilityRoutes = require('./availability');
const bookingsRoutes = require('./bookings');

const router = Router();

// Public OpenAPI spec — unauthenticated so consumers can introspect before
// being issued a key, and so Retell / Vapi can fetch it as a function-spec.
const openapiPath = path.resolve(__dirname, '..', '..', '..', 'openapi.yaml');
router.get('/openapi.yaml', (_req, res) => {
  res.type('application/yaml');
  fs.createReadStream(openapiPath).on('error', () => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'OpenAPI spec not found.' } });
  }).pipe(res);
});

// Health probe (no auth) — useful for the other team to verify connectivity
// independently of their key being activated.
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', api: 'public', version: '1' });
});

// Everything below this line requires a valid API key.
router.use(requireApiKey);

router.use('/availability', availabilityRoutes);
router.use('/bookings', requireIdempotencyKey, bookingsRoutes);

// Public-API-scoped error envelope. Must be the LAST thing mounted on this
// router so errors from sub-routers funnel into it.
router.use(publicErrorEnvelope);

module.exports = router;
