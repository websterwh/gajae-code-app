import { Router, type Response } from 'express';

import { asyncHandler, routeParam } from '@/shared/utils.js';

import { INSTALL_MANAGERS, type InstallManager } from '../mcp/index.js';

import { packagesService, type PackagesService } from './packages.service.js';
import { packageSuggestService, type PackageSuggestService, type SuggestManager } from './suggest.service.js';

function fail(response: Response, error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Package request failed.';
  const status = /not found/iu.test(message) ? 404
    : /already running|is pinned/iu.test(message) ? 409
      : /required|must be|has no name|invalid|cannot be pinned/iu.test(message) ? 400
        : 500;
  return response.status(status).json({ success: false, error: { message } });
}

export function createPackagesRouter(
  service: PackagesService = packagesService,
  suggestions: PackageSuggestService = packageSuggestService,
): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_request, response) => {
    try {
      response.json({ success: true, data: await service.list() });
    } catch (error) {
      fail(response, error);
    }
  }));

  // Names, not installs: the client queries this while the user types, then
  // installs through POST / with the manager the suggestion named.
  router.get('/suggest', asyncHandler(async (request, response) => {
    const query = typeof request.query.q === 'string' ? request.query.q : '';
    // An unknown or absent manager means "search everything", never a 400: the
    // query string is typed a character at a time and may arrive incomplete.
    const requested = typeof request.query.manager === 'string' ? request.query.manager : '';
    const manager: SuggestManager = INSTALL_MANAGERS.includes(requested as InstallManager)
      ? requested as InstallManager
      : 'auto';
    try {
      response.json({ success: true, data: await suggestions.suggest(query, manager) });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.post('/', asyncHandler(async (request, response) => {
    try {
      response.status(201).json({ success: true, data: await service.add(request.body ?? {}) });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.patch('/:manager/:name', asyncHandler(async (request, response) => {
    try {
      response.json({
        success: true,
        data: await service.setPin(
          routeParam(request.params.manager),
          routeParam(request.params.name),
          (request.body ?? {}).pin ?? null,
        ),
      });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.post('/:manager/:name/upgrade', asyncHandler(async (request, response) => {
    try {
      response.json({
        success: true,
        data: await service.upgrade(routeParam(request.params.manager), routeParam(request.params.name)),
      });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.delete('/:manager/:name', asyncHandler(async (request, response) => {
    try {
      await service.remove(routeParam(request.params.manager), routeParam(request.params.name));
      response.status(204).end();
    } catch (error) {
      fail(response, error);
    }
  }));

  return router;
}

export default createPackagesRouter();
