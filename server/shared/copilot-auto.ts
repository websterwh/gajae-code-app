/**
 * GitHub Copilot Auto routing.
 *
 * Auto is not a model in Copilot's catalog. `POST /auto` picks a concrete model
 * for the prompt and mints the `Copilot-Session-Token` that the following chat
 * request must carry. That token is bound to the selected model, so both the
 * model choice and the token have to reach the runtime together.
 *
 * This is intentionally isolated from the app's catalog and adapter so the
 * request shape can be tested without a live Copilot credential.
 */

export const GJC_COPILOT_AUTO_MODEL_ID = 'github-copilot/auto';

const DEFAULT_COPILOT_BASE_URL = 'https://api.githubcopilot.com';
const AUTO_TIMEOUT_MS = 5_000;
const COPILOT_API_VERSION = '2026-08-01';
// VS Code's AutoV2Fetcher sends its balance routing preference. Without it the
// server can select an internal fast model that the chat endpoints refuse.
const COPILOT_AUTO_TIER = 'balance';

/**
 * Copilot gates Auto behind its client identity. `code-oss` is the honest
 * open-source VS Code baseline and accepts GJC's existing OAuth token; the
 * licensed `vscode-chat` identity rejects that token as malformed.
 */
const COPILOT_CLIENT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.67.0',
  'Editor-Version': 'vscode/1.139.0',
  'Editor-Plugin-Version': 'copilot-chat/0.67.0',
  'Copilot-Integration-Id': 'code-oss',
} as const;

export type CopilotAutoSelection = {
  /** Concrete Copilot model id, e.g. `gpt-5.6-luna`. */
  modelId: string;
  /** Token that authorizes the selected model for this routing decision. */
  sessionToken: string;
  /** Unix seconds reported by Copilot; null when the response omitted it. */
  expiresAt: number | null;
  /** Endpoints Copilot says the selected model accepts for this session. */
  supportedEndpoints: string[];
};

type CopilotAutoResponse = {
  session_token?: unknown;
  selected_model?: { id?: unknown; supported_endpoints?: unknown } | null;
  expires_at?: unknown;
};

type FetchLike = typeof fetch;

export type ResolveCopilotAutoInput = {
  apiKey: string;
  prompt: string;
  hasImage?: boolean;
  baseUrl?: string;
  signal?: AbortSignal;
  fetch?: FetchLike;
};

function copilotBaseUrl(baseUrl: string | undefined): string {
  const value = baseUrl?.trim() || DEFAULT_COPILOT_BASE_URL;
  return value.replace(/\/+$/, '');
}

function copilotAccessToken(apiKey: string): string {
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown };
    if (typeof parsed.token === 'string' && parsed.token.trim()) return parsed.token.trim();
  } catch {
    // Raw OAuth token, which is also the shape used by env credentials.
  }
  return apiKey.trim();
}

function autoRequestHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${copilotAccessToken(apiKey)}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': COPILOT_API_VERSION,
    ...COPILOT_CLIENT_HEADERS,
  };
}

/**
 * A model can be advertised for both endpoints; GJC's static catalog may only
 * know one. Prefer `/responses` when Copilot says the Auto pick supports it,
 * because the chat-completions path rejects some Auto-only models outright.
 */
export function copilotAutoModelApi(
  selection: CopilotAutoSelection,
): 'openai-responses' | undefined {
  return selection.supportedEndpoints.some((endpoint) => endpoint === '/responses' || endpoint === 'ws:/responses')
    ? 'openai-responses'
    : undefined;
}

/**
 * Headers the selected model's chat request needs so Copilot accepts the Auto
 * session token. Existing model headers stay in place; these override only the
 * identity/version fields the Auto path requires.
 */
export function copilotAutoModelHeaders(sessionToken: string): Record<string, string> {
  return {
    ...COPILOT_CLIENT_HEADERS,
    'X-GitHub-Api-Version': COPILOT_API_VERSION,
    'Copilot-Session-Token': sessionToken,
  };
}

/**
 * Resolve a prompt through Copilot's Auto router.
 *
 * The response body is never included in errors: a malformed response can still
 * contain a session token.
 */
export async function resolveCopilotAutoSelection(
  input: ResolveCopilotAutoInput,
): Promise<CopilotAutoSelection> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTO_TIMEOUT_MS);
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await (input.fetch ?? fetch)(`${copilotBaseUrl(input.baseUrl)}/auto`, {
      method: 'POST',
      headers: autoRequestHeaders(input.apiKey),
      body: JSON.stringify({
        prompt: input.prompt,
        tier: COPILOT_AUTO_TIER,
        ...(input.hasImage ? { has_image: true } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const suffix = response.status === 404
        ? ' This Copilot account or API version may not expose Auto.'
        : '';
      throw new Error(`GitHub Copilot Auto routing failed (HTTP ${response.status}).${suffix}`);
    }

    const data = await response.json() as CopilotAutoResponse;
    const sessionToken = typeof data.session_token === 'string' ? data.session_token.trim() : '';
    const modelId = typeof data.selected_model?.id === 'string' ? data.selected_model.id.trim() : '';
    if (!sessionToken || !modelId) {
      throw new Error('GitHub Copilot Auto returned no selected model or session token.');
    }

    const supportedEndpoints = Array.isArray(data.selected_model?.supported_endpoints)
      ? data.selected_model.supported_endpoints.filter((endpoint): endpoint is string => typeof endpoint === 'string')
      : [];
    return {
      modelId,
      sessionToken,
      expiresAt: typeof data.expires_at === 'number' && Number.isFinite(data.expires_at)
        ? data.expires_at
        : null,
      supportedEndpoints,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('GitHub Copilot Auto routing timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
  }
}

/** Attach the Auto session token to a resolved model without mutating the catalog entry. */
export function withCopilotAutoSession<T extends { headers?: Record<string, string> }>(
  model: T,
  selection: CopilotAutoSelection,
): T {
  return {
    ...model,
    headers: {
      ...model.headers,
      ...copilotAutoModelHeaders(selection.sessionToken),
    },
  };
}
