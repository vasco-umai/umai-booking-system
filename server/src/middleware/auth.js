const jwt = require('jsonwebtoken');

function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    // Pin algorithm: without this, a crafted header with alg: none would be accepted.
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Requires team lead or super admin
function requireTeamLead(req, res, next) {
  if (req.admin.role === 'admin' || req.admin.teamRole === 'lead') {
    return next();
  }
  return res.status(403).json({ error: 'Team lead access required' });
}

// Helper: resolve effective teamId from JWT or query param override (super admin only)
function getEffectiveTeamId(req) {
  if (req.admin.role === 'admin' && req.query.team_id) {
    return parseInt(req.query.team_id);
  }
  return req.admin.teamId;
}

module.exports = { requireAdmin, requireRole, requireTeamLead, getEffectiveTeamId };
