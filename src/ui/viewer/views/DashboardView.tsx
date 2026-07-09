import React, { useEffect, useState } from 'react';
import { fetchDashboard } from '../utils/serverData';
import {
  toKpis, toKanbanColumns, toDecisionChains,
  type Kpis, type KanbanColumn, type DecisionChain,
} from '../utils/dashboardShape';

// ── Blocked panel types ──────────────────────────────────────────────────────

interface BlockedByBlocker {
  [blockerName: string]: Array<{ id?: string; content?: string; metadata?: Record<string, unknown> }>;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function KpiStrip({ kpis }: { kpis: Kpis }) {
  return (
    <div className="dash-kpi-strip">
      <div className="dash-kpi-card">
        <span className="dash-kpi-value">{kpis.open}</span>
        <span className="dash-kpi-label">Open</span>
      </div>
      <div className="dash-kpi-card dash-kpi-card--blocked">
        <span className="dash-kpi-value">{kpis.blocked}</span>
        <span className="dash-kpi-label">Blocked</span>
      </div>
      <div className="dash-kpi-card">
        <span className="dash-kpi-value">{kpis.resolved}</span>
        <span className="dash-kpi-label">Resolved</span>
      </div>
      <div className="dash-kpi-card dash-kpi-card--cost">
        <span className="dash-kpi-value">${kpis.usd.toFixed(2)}</span>
        <span className="dash-kpi-label">Est. Cost</span>
      </div>
    </div>
  );
}

function LifecycleKanban({ columns }: { columns: KanbanColumn[] }) {
  return (
    <section className="dash-section">
      <h2 className="dash-section-title">Lifecycle Board</h2>
      <div className="dash-kanban">
        {columns.map(col => (
          <div key={col.state} className={`dash-kanban-col dash-kanban-col--${col.state}`}>
            <div className="dash-kanban-col-header">
              <span className="dash-kanban-state">{col.state}</span>
              <span className="dash-kanban-count">{col.items.length}</span>
            </div>
            <ul className="dash-kanban-items">
              {col.items.length === 0 ? (
                <li className="dash-kanban-empty">—</li>
              ) : (
                col.items.map(item => (
                  <li key={item.id} className="dash-kanban-item" title={item.title}>
                    {item.title || item.id}
                  </li>
                ))
              )}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function DecisionLog({ chains }: { chains: DecisionChain[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (chains.length === 0) {
    return (
      <section className="dash-section">
        <h2 className="dash-section-title">Decision Log</h2>
        <p className="dash-empty">No decisions recorded yet.</p>
      </section>
    );
  }

  return (
    <section className="dash-section">
      <h2 className="dash-section-title">Decision Log</h2>
      <ul className="dash-decisions">
        {chains.map(chain => (
          <li key={chain.head.id} className="dash-decision-chain">
            <div className="dash-decision-head">
              <span className="dash-decision-title">{chain.head.title || chain.head.id}</span>
              {chain.head.why && (
                <span className="dash-decision-why">{chain.head.why}</span>
              )}
              {chain.history.length > 0 && (
                <button
                  className="dash-decision-toggle"
                  onClick={() => toggle(chain.head.id)}
                  aria-expanded={expanded.has(chain.head.id)}
                >
                  {expanded.has(chain.head.id) ? '▾' : '▸'} {chain.history.length} superseded
                </button>
              )}
            </div>
            {expanded.has(chain.head.id) && chain.history.length > 0 && (
              <ul className="dash-decision-history">
                {chain.history.map(h => (
                  <li key={h.id} className="dash-decision-history-item">
                    {h.title || h.id}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CostPanel({ cost }: { cost: unknown }) {
  const c = (cost ?? {}) as { discoveryTokens?: number; distilledTokens?: number | null; estUsd?: number; estUsdSaved?: number; savedTokens?: number; preTokens?: number; pctSmaller?: number; activeProvider?: string; localGeneration?: boolean };
  const usd = typeof c.estUsdSaved === 'number' ? c.estUsdSaved : (typeof c.estUsd === 'number' ? c.estUsd : null);
  return (
    <section className="dash-section">
      <h2 className="dash-section-title">Cost</h2>
      <dl className="dash-cost-dl">
        <dt>Discovery tokens</dt>
        <dd>{typeof c.discoveryTokens === 'number' ? c.discoveryTokens.toLocaleString() : '—'}</dd>
        {c.distilledTokens != null && (
          <>
            <dt>Distilled tokens</dt>
            <dd>{c.distilledTokens.toLocaleString()}</dd>
          </>
        )}
        {typeof c.savedTokens === 'number' && (
          <>
            <dt>Saved tokens</dt>
            <dd>{c.savedTokens.toLocaleString()}</dd>
          </>
        )}
        {typeof c.pctSmaller === 'number' && c.preTokens !== 0 && (
          <>
            <dt>Compression</dt>
            <dd>{(c.pctSmaller * 100).toFixed(1)}%</dd>
          </>
        )}
        <dt>Est. USD saved</dt>
        <dd>${usd != null ? usd.toFixed(4) : '0.0000'}</dd>
        {c.activeProvider !== undefined && (
          <>
            <dt>Provider</dt>
            <dd>{c.activeProvider}{c.localGeneration ? ' (local)' : ''}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

/** Blocked-on-whom seam — renders groups by blocker; empty state is intentional */
function BlockedByPanel({ byBlocker }: { byBlocker: BlockedByBlocker | null }) {
  // TODO(team-identity): this seam will show per-team blocked items once team context is wired
  if (!byBlocker || Object.keys(byBlocker).length === 0) {
    return (
      <section className="dash-section dash-section--seam">
        <h2 className="dash-section-title">Blocked on Whom</h2>
        <p className="dash-empty">No blockers tracked yet.</p>
      </section>
    );
  }

  return (
    <section className="dash-section dash-section--seam">
      <h2 className="dash-section-title">Blocked on Whom</h2>
      {Object.entries(byBlocker).map(([blocker, items]) => (
        <div key={blocker} className="dash-blocker-group">
          <h3 className="dash-blocker-name">{blocker}</h3>
          <ul className="dash-blocker-items">
            {items.map((item, idx) => {
              const id = item.id ?? String(idx);
              const title =
                (item.metadata?.title as string | undefined) ??
                (typeof item.content === 'string' ? item.content.split('\n')[0] : '') ??
                id;
              return (
                <li key={id} className="dash-blocker-item">{title}</li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

// ── Main DashboardView ───────────────────────────────────────────────────────

interface DashboardData {
  board: unknown;
  decisions: unknown;
  cost: unknown;
  byBlocker: BlockedByBlocker | null;
}

export function DashboardView() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      fetchDashboard('board'),
      fetchDashboard('decisions'),
      fetchDashboard('cost'),
      fetchDashboard('blocked'),
    ])
      .then(([board, decisions, cost, blocked]) => {
        if (cancelled) return;
        setData({
          board,
          decisions,
          cost,
          byBlocker: (blocked && typeof blocked === 'object' && !Array.isArray(blocked))
            ? (blocked as BlockedByBlocker)
            : null,
        });
      })
      .catch(err => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div className="dash-loading">Loading dashboard…</div>;
  }

  if (error || !data) {
    return <div className="dash-error">Failed to load dashboard data.</div>;
  }

  const kpis = toKpis(data.board, data.cost);
  const columns = toKanbanColumns(data.board);
  const chains = toDecisionChains(data.decisions);

  return (
    <div className="dashboard-view">
      <KpiStrip kpis={kpis} />
      <LifecycleKanban columns={columns} />
      <DecisionLog chains={chains} />
      <CostPanel cost={data.cost} />
      <BlockedByPanel byBlocker={data.byBlocker} />
    </div>
  );
}
