import { BridgeAuthError } from './errors.js';
import { httpFetch } from './http.js';
import type { Logger } from './logger.js';
import type { ResolvedConfig, TokenSet } from './types.js';

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function graphqlFetch<T>(
  config: ResolvedConfig,
  tokens: TokenSet | null,
  query: string,
  variables: Record<string, unknown> | undefined,
  logger: Logger,
): Promise<T> {
  if (!tokens?.accessToken) {
    throw new BridgeAuthError('Not authenticated. Please log in first.', 'UNAUTHENTICATED');
  }

  const url = `${config.apiBaseUrl}/graphql`;
  const response = await httpFetch<GraphQLResponse<T>>(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'x-app-id': config.appId,
      },
      body: { query, variables },
    },
    logger,
  );

  if (response.errors?.length) {
    throw new BridgeAuthError(response.errors[0].message, 'GRAPHQL_ERROR');
  }

  if (!response.data) {
    throw new BridgeAuthError('No data returned from GraphQL', 'GRAPHQL_ERROR');
  }

  return response.data;
}
