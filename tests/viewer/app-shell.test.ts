import { describe, test, expect } from 'bun:test';
import { getInitialView, VIEWS } from '../../src/ui/viewer/views/viewState.js';
describe('app shell view state', () => {
  test('default view is observations', () => { expect(getInitialView()).toBe('observations'); });
  test('VIEWS lists observations + dashboard', () => {
    expect(VIEWS.map(v => v.id)).toEqual(expect.arrayContaining(['observations', 'dashboard']));
  });
});
