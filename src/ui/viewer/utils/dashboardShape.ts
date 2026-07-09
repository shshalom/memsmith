// Pure transforms: /dashboard/* payloads → render models
// Never throws on missing fields.

/** Raw observation row as returned by /dashboard/* endpoints */
interface RawRow {
  id?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  obs_type?: string;
  lifecycle_state?: string;
  [key: string]: unknown;
}

/** Raw board payload: { open, active, blocked, deferred, resolved, superseded } */
interface RawBoard {
  open?: RawRow[];
  active?: RawRow[];
  blocked?: RawRow[];
  deferred?: RawRow[];
  resolved?: RawRow[];
  superseded?: RawRow[];
  [key: string]: RawRow[] | undefined;
}

/** Raw cost payload */
interface RawCost {
  discoveryTokens?: number;
  distilledTokens?: number | null;
  /** Legacy field — kept for back-compat with old costPanel shape */
  estUsd?: number;
  /** New field from the reworked costPanel (savings story) */
  estUsdSaved?: number;
  savedTokens?: number;
  preTokens?: number;
  pctSmaller?: number;
  activeProvider?: string;
  localGeneration?: boolean;
}

/** Raw decision chain entry: { head: RawRow, history: RawRow[] } */
interface RawDecisionChain {
  head?: RawRow;
  history?: RawRow[];
}

// ── KPI output ──────────────────────────────────────────────────────────────

export interface Kpis {
  open: number;
  blocked: number;
  resolved: number;
  usd: number;
}

export function toKpis(board: unknown, cost: unknown): Kpis {
  const b = (board ?? {}) as RawBoard;
  const c = (cost ?? {}) as RawCost;
  return {
    open:     Array.isArray(b.open)     ? b.open.length     : 0,
    blocked:  Array.isArray(b.blocked)  ? b.blocked.length  : 0,
    resolved: Array.isArray(b.resolved) ? b.resolved.length : 0,
    usd:      typeof c.estUsdSaved === 'number' ? c.estUsdSaved : (typeof c.estUsd === 'number' ? c.estUsd : 0),
  };
}

// ── Kanban columns ───────────────────────────────────────────────────────────

export interface KanbanItem {
  id: string;
  title: string;
}

export interface KanbanColumn {
  state: string;
  items: KanbanItem[];
}

const KANBAN_ORDER = ['open', 'active', 'blocked', 'deferred', 'resolved', 'superseded'] as const;

function rowTitle(row: RawRow): string {
  const meta = row.metadata;
  if (meta && typeof meta.title === 'string' && meta.title.trim()) {
    return meta.title.trim();
  }
  if (typeof row.content === 'string' && row.content.trim()) {
    return row.content.split('\n')[0].trim();
  }
  return '';
}

function rowId(row: RawRow): string {
  return typeof row.id === 'string' ? row.id : String(row.id ?? '');
}

export function toKanbanColumns(board: unknown): KanbanColumn[] {
  const b = (board ?? {}) as RawBoard;
  return KANBAN_ORDER.map(state => {
    const rows: RawRow[] = Array.isArray(b[state]) ? (b[state] as RawRow[]) : [];
    return {
      state,
      items: rows.map(row => ({ id: rowId(row), title: rowTitle(row) })),
    };
  });
}

// ── Decision chains ──────────────────────────────────────────────────────────

export interface DecisionHeadItem {
  id: string;
  title: string;
  why?: string;
}

export interface DecisionChain {
  head: DecisionHeadItem;
  history: KanbanItem[];
}

export function toDecisionChains(decisions: unknown): DecisionChain[] {
  if (!Array.isArray(decisions)) return [];
  return decisions.map((d: unknown) => {
    const entry = (d ?? {}) as RawDecisionChain;
    const head = (entry.head ?? {}) as RawRow;
    const history = Array.isArray(entry.history) ? entry.history : [];
    const meta = head.metadata ?? {};
    const why = typeof meta.why === 'string' ? meta.why : undefined;
    return {
      head: {
        id: rowId(head),
        title: rowTitle(head),
        ...(why !== undefined ? { why } : {}),
      },
      history: history.map((r: RawRow) => ({ id: rowId(r), title: rowTitle(r) })),
    };
  });
}
