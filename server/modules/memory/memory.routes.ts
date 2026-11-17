import { Router, type Response } from 'express';

import { asyncHandler } from '@/shared/utils.js';

import { memoryService, type MemoryPatch, type MemoryService } from './memory.service.js';

function fail(response: Response, error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Memory request failed.';
  const status = /must be|does not exist|is required|absolute path/iu.test(message) ? 400
    : /failed/iu.test(message) ? 502
      : 500;
  return response.status(status).json({ success: false, error: { message } });
}

export function createMemoryRouter(service: MemoryService = memoryService): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_request, response) => {
    try {
      response.json({ success: true, data: await service.status() });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.put('/', asyncHandler(async (request, response) => {
    try {
      response.json({ success: true, data: await service.update((request.body ?? {}) as MemoryPatch) });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.post('/mempalace/init', asyncHandler(async (request, response) => {
    try {
      response.json({ success: true, data: await service.initPalace(request.body ?? {}) });
    } catch (error) {
      fail(response, error);
    }
  }));

  // The picker already knows its project paths, so the read-only marker check
  // runs on exactly those instead of listing every project on the machine.
  router.post('/mempalace/check', asyncHandler(async (request, response) => {
    try {
      response.json({ success: true, data: await service.projectStatus(request.body ?? {}) });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.post('/mempalace/import', asyncHandler(async (request, response) => {
    try {
      response.json({ success: true, data: await service.importPath(request.body ?? {}) });
    } catch (error) {
      fail(response, error);
    }
  }));

  return router;
}

export default createMemoryRouter();
