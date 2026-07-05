import { describe, it, expect } from 'bun:test';
import { registerDashboardRoutes } from '../../../src/server/dashboard/routes.js';

describe('dashboard routes', () => {
  it('registers all five routes (four data endpoints + ui)', () => {
    const registered: string[] = [];
    const fakeApp = { get: (path: string, ..._rest: any[]) => { registered.push(path); } };
    registerDashboardRoutes(fakeApp as any, {} as any);
    expect(registered).toEqual(expect.arrayContaining([
      '/dashboard', '/dashboard/board', '/dashboard/decisions', '/dashboard/blocked', '/dashboard/cost',
    ]));
  });
});
