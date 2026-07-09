export const VIEWS = [
  { id: 'observations', label: 'Observations' },
  { id: 'dashboard', label: 'Dashboard' },
] as const;

export type ViewId = typeof VIEWS[number]['id'];

export function getInitialView(): ViewId {
  return 'observations';
}
