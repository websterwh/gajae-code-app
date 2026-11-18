import { getConnection } from '@/modules/database/connection.js';
import { credentialsDb } from '@/modules/database/repositories/credentials.js';
import type { CredentialPublicRow, CreateCredentialResult } from '@/shared/types.js';

const GITHUB_CREDENTIAL_TYPE = 'github_token';

type GithubTokenLookup = CredentialPublicRow & { credential_value: string; github_token: string; user_id: number };

const createGithubToken = (
  userId: number,
  tokenName: string,
  githubToken: string,
  description: string | null = null
): CreateCredentialResult =>
  credentialsDb.createCredential(
    userId,
    tokenName,
    GITHUB_CREDENTIAL_TYPE,
    githubToken,
    description
  );

const getGithubTokens = (userId: number): CredentialPublicRow[] =>
  credentialsDb.getCredentials(userId, GITHUB_CREDENTIAL_TYPE);

const getActiveGithubToken = (userId: number): string | null =>
  credentialsDb.getActiveCredential(userId, GITHUB_CREDENTIAL_TYPE);

/**
 * The container has one shell and its agents inherit one environment, so on
 * boot the most recently saved token is the one to restore even though tokens
 * are stored per user.
 */
const getAnyActiveGithubToken = (): string | null => {
  const row = getConnection()
    .prepare(`
      SELECT credential_value
      FROM user_credentials
      WHERE credential_type = ? AND is_active = 1
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(GITHUB_CREDENTIAL_TYPE) as { credential_value: string } | undefined;
  return row?.credential_value ?? null;
};

const getGithubTokenById = (
  userId: number,
  tokenId: number
): GithubTokenLookup | null => {
  const credential = getConnection()
    .prepare(`
      SELECT *
      FROM user_credentials
      WHERE user_id = ? AND id = ? AND credential_type = ? AND is_active = 1
    `)
    .get(userId, tokenId, GITHUB_CREDENTIAL_TYPE) as
    | (CredentialPublicRow & { credential_value: string; user_id: number })
    | undefined;

  if (credential === undefined) {
    return null;
  }

  return { ...credential, github_token: credential.credential_value };
};

const updateGithubToken = (
  userId: number,
  tokenId: number,
  isActive: boolean
): boolean => credentialsDb.toggleCredential(userId, tokenId, isActive);

const deleteGithubToken = (userId: number, tokenId: number): boolean =>
  credentialsDb.deleteCredential(userId, tokenId);

const toggleGithubToken = (
  userId: number,
  tokenId: number,
  isActive: boolean
): boolean => updateGithubToken(userId, tokenId, isActive);

export const githubTokensDb = {
  createGithubToken,
  getGithubTokens,
  getActiveGithubToken,
  getAnyActiveGithubToken,
  getGithubTokenById,
  updateGithubToken,
  deleteGithubToken,
  toggleGithubToken,
};
