import { Router } from 'express';

import { asyncHandler } from '@/shared/utils.js';

import { collectUsageOverview, type UsageOverview } from './stats.service.js';

export type StatsService = {
  overview: (options?: { refresh?: boolean }) => Promise<UsageOverview>;
};

export function createStatsRouter(service: StatsService = { overview: collectUsageOverview }): Router {
  const router = Router();

  // `refresh=1` is the page's retry button: it bypasses the in-memory cache.
  router.get('/overview', asyncHandler(async (request, response) => {
    const refresh = request.query.refresh === '1' || request.query.refresh === 'true';
    response.json({ success: true, data: await service.overview({ refresh }) });
  }));

  return router;
}

export const statsRoutes = createStatsRouter();
