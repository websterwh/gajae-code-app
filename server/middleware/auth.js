import { apiKeysDb, userDb } from '../modules/database/index.js';

import { isDesktopMode, secureEqual } from './desktop-auth.js';

const IMPLICIT_OWNER_PASSWORD_HASH = 'disabled:desktop-key-auth';

let implicitOwnerId = null;
const getImplicitOwner = () => {
  if (implicitOwnerId !== null) {
    const cached = userDb.getUserById(implicitOwnerId);
    if (cached) {
      return cached;
    }
    implicitOwnerId = null;
  }

  let owner = userDb.getFirstUser();
  if (!owner) {
    const created = userDb.createUser('owner', IMPLICIT_OWNER_PASSWORD_HASH);
    owner = userDb.getUserById(Number(created.id)) ?? { id: Number(created.id), username: created.username };
  }
  implicitOwnerId = owner.id;
  return owner;
};

const providedApiKey = (req) => (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '');

/**
 * A revocable per-user key from Settings. The lookup updates `last_used`, so it
 * is skipped for requests that carry no key at all.
 */
const isKnownApiKey = (value) => {
  if (!value) return false;
  try {
    return Boolean(apiKeysDb.validateApiKey(value));
  } catch {
    // The database is not open yet (startup) or unreadable; the deployment key
    // remains the only credential in that case.
    return false;
  }
};

// Optional API key middleware for non-desktop deployments. A deployment with no
// key configured keeps the implicit-owner behaviour; a deployment with one
// requires it (or a revocable per-user key) on every API request.
export const hasValidApiKey = (req) => {
  if (isDesktopMode()) return true;
  const provided = providedApiKey(req);
  if (provided) {
    return (Boolean(process.env.API_KEY) && secureEqual(provided, process.env.API_KEY))
      || isKnownApiKey(provided);
  }
  return !process.env.API_KEY;
};

/**
 * The stronger form for surfaces the sign-in gate exempts (`/api/gjc`). "No key
 * configured" is not a credential there: reaching the port would otherwise be
 * enough to start agent jobs and push. The app's own callers arrive with a
 * session cookie instead, which the route checks separately.
 */
const hasExplicitCredential = (req) => isDesktopMode()
  || (Boolean(process.env.API_KEY) && secureEqual(providedApiKey(req), process.env.API_KEY))
  || isKnownApiKey(providedApiKey(req));

const validateApiKey = (req, res, next) => {
  if (!hasValidApiKey(req)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// The desktop middleware validates the per-boot key before this attaches the
// implicit owner to protected HTTP routes.
const authenticateToken = (req, res, next) => {
  req.user = getImplicitOwner();
  return next();
};

// The WebSocket gateway runs desktopAuth.authenticateWebSocket before this
// attaches the implicit owner.
const authenticateWebSocket = () => {
  const owner = getImplicitOwner();
  return { userId: owner.id, username: owner.username };
};

export {
  hasExplicitCredential,
  validateApiKey,
  authenticateToken,
  authenticateWebSocket,
};
