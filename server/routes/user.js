import express from 'express';
// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { githubTokensDb, userDb } from '../modules/database/index.js';
import { applyGithubToken, clearGithubToken, isGithubToken } from '../modules/git/github-auth.service.js';
import { authenticateToken } from '../middleware/auth.js';
import { getSystemGitConfig } from '../utils/gitConfig.js';
import { asyncHandler } from '../shared/utils.js';

const router = express.Router();

function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => { reject(error); });
    child.on('close', (code) => {
      if (code === 0) { resolve({ stdout, stderr }); return; }
      const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

router.get('/git-config', authenticateToken, asyncHandler(async (req, res) => {
  try {
    const userId = req.user.id;
    let gitConfig = userDb.getGitConfig(userId);

    // If database is empty, try to get from system git config
    if (!gitConfig || (!gitConfig.git_name && !gitConfig.git_email)) {
      const systemConfig = await getSystemGitConfig();

      // If system has values, save them to database for this user
      if (systemConfig.git_name || systemConfig.git_email) {
        userDb.updateGitConfig(userId, systemConfig.git_name, systemConfig.git_email);
        gitConfig = systemConfig;
        console.log(`Auto-populated git config from system for user ${userId}: ${systemConfig.git_name} <${systemConfig.git_email}>`);
      }
    }

    res.json({
      success: true,
      gitName: gitConfig?.git_name || null,
      gitEmail: gitConfig?.git_email || null
    });
  } catch (error) {
    console.error('Error getting git config:', error);
    res.status(500).json({ error: 'Failed to get git configuration' });
  }
}));

// Apply git config globally via git config --global
router.post('/git-config', authenticateToken, asyncHandler(async (req, res) => {
  try {
    const userId = req.user.id;
    const { gitName, gitEmail } = req.body;

    if (!gitName || !gitEmail) {
      return res.status(400).json({ error: 'Git name and email are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(gitEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    userDb.updateGitConfig(userId, gitName, gitEmail);

    try {
      await spawnAsync('git', ['config', '--global', 'user.name', gitName]);
      await spawnAsync('git', ['config', '--global', 'user.email', gitEmail]);
      console.log(`Applied git config globally: ${gitName} <${gitEmail}>`);
    } catch (gitError) {
      console.error('Error applying git config:', gitError);
    }

    res.json({
      success: true,
      gitName,
      gitEmail
    });
  } catch (error) {
    console.error('Error updating git config:', error);
    res.status(500).json({ error: 'Failed to update git configuration' });
  }
}));

// The GitHub token is stored per user, then materialised into the container:
// the server's own environment (agents inherit it), ~/.git-credentials (so
// clones, fetches and pushes work), and a sourced env file for SSH shells.
const scopeCache = new Map();
const SCOPE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * What the saved token may do, read from GitHub rather than guessed from the
 * token string. A classic token reports its scopes in `x-oauth-scopes`; a
 * fine-grained token reports no scope header at all, so `fineGrained` tells the
 * caller the permissions cannot be introspected here.
 */
router.get('/github-token/scopes', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const token = githubTokensDb.getActiveGithubToken(userId);
  if (!token) {
    return res.json({ success: true, connected: false, login: null, scopes: [], fineGrained: false });
  }
  const cached = scopeCache.get(userId);
  if (cached && Date.now() - cached.at < SCOPE_CACHE_TTL_MS) {
    return res.json({ success: true, ...cached.value });
  }
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gajae-code-app',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: response.status === 401 ? 'GitHub rejected the saved token.' : `GitHub returned ${response.status}.`,
      });
    }
    const scopeHeader = response.headers.get('x-oauth-scopes');
    const scopes = scopeHeader
      ? scopeHeader.split(',').map((scope) => scope.trim()).filter(Boolean)
      : [];
    const body = await response.json().catch(() => ({}));
    const value = {
      connected: true,
      login: typeof body.login === 'string' ? body.login : null,
      scopes,
      fineGrained: scopeHeader === null,
    };
    scopeCache.set(userId, { at: Date.now(), value });
    res.json({ success: true, ...value });
  } catch (error) {
    res.status(502).json({ success: false, error: error instanceof Error ? error.message : 'GitHub could not be reached.' });
  }
}));

router.get('/github-token', authenticateToken, asyncHandler(async (req, res) => {
  const token = githubTokensDb.getActiveGithubToken(req.user.id);
  res.json({ success: true, connected: Boolean(token) });
}));

router.post('/github-token', authenticateToken, asyncHandler(async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!isGithubToken(token)) {
    return res.status(400).json({ success: false, error: 'That does not look like a GitHub token.' });
  }

  const userId = req.user.id;
  // One active token: the CLI, the agents and git all read the same value.
  for (const existing of githubTokensDb.getGithubTokens(userId)) {
    githubTokensDb.deleteGithubToken(userId, existing.id);
  }
  githubTokensDb.createGithubToken(userId, 'gajae-code-app', token, 'Saved from Git settings');
  // A new token can see a different set of repositories than the old one.
  repositoryCache.delete(userId);
  scopeCache.delete(userId);
  await applyGithubToken(token);
  console.log(`GitHub token saved for user ${userId}; git, gh and agents now use it.`);
  res.json({ success: true, connected: true });
}));

router.delete('/github-token', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  for (const existing of githubTokensDb.getGithubTokens(userId)) {
    githubTokensDb.deleteGithubToken(userId, existing.id);
  }
  repositoryCache.delete(userId);
  scopeCache.delete(userId);
  await clearGithubToken();
  res.json({ success: true, connected: false });
}));
const REPOSITORY_CACHE_TTL_MS = 60 * 1000;
const repositoryCache = new Map();

/** Owner/name and description, ranked so the typed fragment wins outright. */
function repositoryScore(query, repository) {
  const needle = query.toLowerCase();
  if (!needle) return 0;
  const name = String(repository.full_name || '').toLowerCase();
  if (name === needle) return 100;
  if (name.endsWith(`/${needle}`)) return 90;
  if (name.includes(needle)) return 80;
  if (String(repository.description || '').toLowerCase().includes(needle)) return 40;
  let cursor = 0;
  let score = 0;
  for (const character of needle) {
    const found = name.indexOf(character, cursor);
    if (found === -1) return -1;
    score += found === cursor ? 2 : 1;
    cursor = found + 1;
  }
  return score;
}

const REPOSITORY_PAGE_SIZE = 100;
// A page budget keeps an account with thousands of repositories from turning
// one request into a minute of waiting; 1000 repositories is well past the
// point where the picker's search stops being useful.
const REPOSITORY_MAX_PAGES = 10;
const REPOSITORY_FETCH_BUDGET_MS = 8000;
const REPOSITORY_RESULT_LIMIT = 20;

async function fetchGithubRepositoryPage(token, page) {
  const response = await fetch(
    `https://api.github.com/user/repos?per_page=${REPOSITORY_PAGE_SIZE}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gajae-code-app',
      },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) {
    throw new Error(response.status === 401
      ? 'GitHub rejected the saved token.'
      : `GitHub returned ${response.status}.`);
  }
  const batch = await response.json();
  return Array.isArray(batch) ? batch : [];
}

/**
 * Every repository the account owns or collaborates on, across pages. The
 * picker searches this list, so a fork that has not been pushed to recently
 * must still be in it rather than falling off after the first page.
 */
async function fetchGithubRepositories(token) {
  const repositories = [];
  const deadline = Date.now() + REPOSITORY_FETCH_BUDGET_MS;
  for (let page = 1; page <= REPOSITORY_MAX_PAGES; page += 1) {
    const batch = await fetchGithubRepositoryPage(token, page);
    repositories.push(...batch);
    if (batch.length < REPOSITORY_PAGE_SIZE || Date.now() >= deadline) break;
  }
  return repositories;
}

// Backs the repository picker in add-workspace. One listing per minute is
// enough: the list only needs to be current while a workspace is being added,
// and the typed text is matched against the whole list rather than the rows a
// previous search happened to return.
router.get('/github-repositories', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const token = githubTokensDb.getActiveGithubToken(userId);
  if (!token) return res.status(400).json({ success: false, error: 'Save a GitHub token in Git settings first.' });
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  try {
    const cached = repositoryCache.get(userId);
    const repositories = cached && Date.now() - cached.at < REPOSITORY_CACHE_TTL_MS
      ? cached.repositories
      : await fetchGithubRepositories(token);
    repositoryCache.set(userId, { at: Date.now(), repositories });
    const ranked = repositories
      .map((repository) => ({ repository, score: repositoryScore(query, repository) }))
      .filter(({ score }) => score >= 0);
    if (query) {
      ranked.sort((first, second) => second.score - first.score
        || String(first.repository.full_name).localeCompare(String(second.repository.full_name)));
    }
    const data = ranked
      .slice(0, REPOSITORY_RESULT_LIMIT)
      .map(({ repository }) => ({
        fullName: repository.full_name,
        name: repository.name,
        private: Boolean(repository.private),
        description: repository.description || '',
        cloneUrl: repository.clone_url,
      }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(502).json({ success: false, error: error instanceof Error ? error.message : 'GitHub could not be reached.' });
  }
}));

export default router;
