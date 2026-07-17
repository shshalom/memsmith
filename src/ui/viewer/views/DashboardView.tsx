import React, { useEffect, useState } from 'react';
import { fetchDashboard } from '../utils/serverData';
import { toDecisionChains, type DecisionChain } from '../utils/dashboardShape';

// ── Metrics payload (matches /dashboard/metrics) ─────────────────────────────

interface AttentionItem { id: string; type: string; lifecycle: string; reason: string; title: string; content: string; createdAt: string; }
interface Metrics {
  total: number;
  embedded: number;
  embeddedPct: number;
  decisions: number;
  byType: Array<{ type: string; count: number }>;
  work: Record<string, number>;
  attention: AttentionItem[];
  activity: Array<{ day: string; count: number }>;
}
interface Cost {
  savedTokens?: number; pctSmaller?: number; estUsdSaved?: number; activeProvider?: string; localGeneration?: boolean;
}
interface UserNote { id: string; content: string; created_at: string; obs_type: string | null; lifecycle_state: string | null; }
interface Spend {
  available: boolean; scoped: boolean; totalCostUsd: number; totalTokens: number;
  days: Array<{ date: string; costUsd: number; totalTokens: number }>; agentsDetected: string[]; reason?: string;
}

const LC_COLOR: Record<string, string> = {
  resolved: 'var(--color-lifecycle-resolved, #6bbf7c)',
  active: 'var(--color-warn, #e9a23b)',
  blocked: 'var(--color-danger, #e5654f)',
  deferred: 'var(--color-lifecycle-superseded, #b18bd0)',
  open: 'var(--color-info, #6aa9d8)',
};
const LC_ORDER = ['resolved', 'active', 'blocked', 'deferred', 'open'];
// Attention reason → badge style + short label.
const REASON_BADGE: Record<string, { cls: string; label: string }> = {
  'security alert': { cls: 'dash-badge--blocked', label: 'security' },
  'security note': { cls: 'dash-badge--open', label: 'security' },
  'parked decision': { cls: 'dash-badge--deferred', label: 'parked' },
  'attention': { cls: 'dash-badge--open', label: 'attention' },
};

// ── Sub-components ───────────────────────────────────────────────────────────

function KpiHero({ m }: { m: Metrics }) {
  const cards = [
    { n: m.total.toLocaleString(), l: 'Memories', hint: 'observations stored', accent: true },
    { n: m.decisions.toLocaleString(), l: 'Decisions', hint: 'reasoning recorded', accent: false },
    { n: Math.round(m.embeddedPct * 100) + '%', l: 'Embedded', hint: 'semantic-searchable', accent: false },
    { n: 'local', l: 'Runtime', hint: 'embedded Postgres · no Docker', accent: false },
  ];
  return (
    <div className="dash-kpis">
      {cards.map((k, i) => (
        <div className="dash-kpi" key={k.l} style={{ animationDelay: `${0.03 + i * 0.06}s` }}>
          <div className={`dash-kpi-n${k.accent ? ' dash-kpi-n--accent' : ''}`}>{k.n}</div>
          <div className="dash-kpi-l">{k.l}</div>
          <div className="dash-kpi-hint">{k.hint}</div>
        </div>
      ))}
    </div>
  );
}

function WorkInFlight({ work }: { work: Record<string, number> }) {
  const total = LC_ORDER.reduce((s, k) => s + (work[k] || 0), 0) || 1;
  return (
    <div className="dash-card">
      <h2 className="dash-h2">Work in flight</h2>
      <p className="dash-cap">Parked &amp; blocked vs. completed — across decisions, features, bugfixes &amp; refactors.</p>
      <div className="dash-stack">
        {LC_ORDER.filter(k => (work[k] || 0) > 0).map(k => (
          <span key={k} style={{ width: `${((work[k] || 0) / total * 100).toFixed(2)}%`, background: LC_COLOR[k] }} title={`${k}: ${work[k]}`} />
        ))}
      </div>
      <div className="dash-legend">
        {LC_ORDER.map(k => (
          <div className="dash-leg" key={k}>
            <span className="dash-leg-dot" style={{ background: LC_COLOR[k] }} />
            <span className="dash-leg-name">{k}</span>
            <span className="dash-leg-val">{(work[k] || 0).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Composition({ byType }: { byType: Array<{ type: string; count: number }> }) {
  const max = Math.max(1, ...byType.map(t => t.count));
  return (
    <div className="dash-card">
      <h2 className="dash-h2">Memory composition</h2>
      <p className="dash-cap">What kind of knowledge is captured.</p>
      <div className="dash-bars">
        {byType.map(t => (
          <div className="dash-bar-row" key={t.type}>
            <span className="dash-bar-t">{t.type}</span>
            <div className="dash-bar-track"><div className="dash-bar-fill" style={{ width: `${(t.count / max * 100).toFixed(1)}%` }} /></div>
            <span className="dash-bar-c">{t.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityChart({ activity }: { activity: Array<{ day: string; count: number }> }) {
  if (!activity.length) return null;
  const max = Math.max(1, ...activity.map(a => a.count));
  return (
    <div className="dash-card">
      <h2 className="dash-h2">Capture activity</h2>
      <p className="dash-cap">Observations recorded per day.</p>
      <div className="dash-spark">
        {activity.map(a => (
          <div className="dash-spark-col" key={a.day} title={`${a.day}: ${a.count}`}>
            <div className="dash-spark-bar" style={{ height: `${Math.max(4, a.count / max * 100)}%` }} />
            <span className="dash-spark-x">{a.day.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NeedsAttention({ items }: { items: AttentionItem[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  return (
    <div className="dash-card">
      <h2 className="dash-h2">Needs attention</h2>
      <p className="dash-cap">Parked decisions &amp; security items — click any to read the full observation.</p>
      {items.length === 0 ? (
        <p className="dash-empty">Nothing flagged for attention — no parked decisions, unfinished items, or security alerts. ✦</p>
      ) : (
        <div className="dash-attn">
          {items.map(a => {
            const b = REASON_BADGE[a.reason] ?? REASON_BADGE['attention']!;
            const isOpen = open.has(a.id);
            const expandable = (a.content || '').trim().length > (a.title || '').trim().length;
            return (
              <div
                className={`dash-attn-item${expandable ? ' dash-attn-item--clickable' : ''}${isOpen ? ' dash-attn-item--open' : ''}`}
                key={a.id}
                onClick={expandable ? () => toggle(a.id) : undefined}
                role={expandable ? 'button' : undefined}
                tabIndex={expandable ? 0 : undefined}
                onKeyDown={expandable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(a.id); } } : undefined}
                aria-expanded={expandable ? isOpen : undefined}
              >
                <span className={`dash-badge ${b.cls}`}>{b.label}</span>
                <div className="dash-attn-body">
                  <div className="dash-attn-title">
                    {a.title || '(untitled)'}
                    {expandable && <span className="dash-attn-chevron">{isOpen ? '▾' : '▸'}</span>}
                  </div>
                  {isOpen && <div className="dash-attn-full">{a.content}</div>}
                  <div className="dash-attn-meta"><span className="dash-attn-type">{a.type}</span> · {String(a.id).slice(0, 8)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fmtUsd(n: number): string {
  return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function thisMonthCost(days: Spend['days']): number {
  // Current month prefix YYYY-MM from the most recent day in the data.
  if (!days.length) return 0;
  const latest = days[days.length - 1]!.date.slice(0, 7);
  return days.filter(d => d.date.startsWith(latest)).reduce((s, d) => s + d.costUsd, 0);
}

function SpendPanel({ spend }: { spend: Spend | null }) {
  if (!spend || !spend.available) {
    return (
      <div className="dash-card">
        <h2 className="dash-h2">AI coding spend</h2>
        <p className="dash-cap">Real cost from your local Claude Code / Codex usage logs (ccusage).</p>
        <p className="dash-empty">Usage logs unavailable{spend?.reason ? ` — ${spend.reason}` : ''}.</p>
      </div>
    );
  }
  const monthCost = thisMonthCost(spend.days);
  const maxCost = Math.max(0.0001, ...spend.days.map(d => d.costUsd));
  return (
    <div className="dash-card">
      <h2 className="dash-h2">AI coding spend</h2>
      <p className="dash-cap">
        Real cost from this project&apos;s Claude Code usage logs (ccusage{spend.scoped ? ', project-scoped' : ', all projects'}).
      </p>
      <div className="dash-spend-figs">
        <div className="dash-spend-fig">
          <div className="dash-spend-n">{fmtUsd(spend.totalCostUsd)}</div>
          <div className="dash-spend-l">Historical billed</div>
        </div>
        <div className="dash-spend-fig">
          <div className="dash-spend-n">{fmtTok(spend.totalTokens)}</div>
          <div className="dash-spend-l">Tokens processed</div>
        </div>
        <div className="dash-spend-fig">
          <div className="dash-spend-n">{monthCost > 0 ? fmtUsd(monthCost) : '$0'}</div>
          <div className="dash-spend-l">This month</div>
        </div>
      </div>
      {spend.days.length > 0 && (
        <div className="dash-spend-spark">
          {spend.days.map(d => (
            <div className="dash-spark-col" key={d.date} title={`${d.date}: ${fmtUsd(d.costUsd)}`}>
              <div className="dash-spark-bar dash-spark-bar--spend" style={{ height: `${Math.max(4, d.costUsd / maxCost * 100)}%` }} />
              <span className="dash-spark-x">{d.date.slice(5)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="dash-spend-note">ⓘ Subscription / flat-rate sessions report <b>$0 billable</b> — the token volume is real, the billed cost isn&apos;t metered per-token.</p>
    </div>
  );
}

function CompressionNote({ cost }: { cost: Cost | null }) {
  const saved = Number(cost?.savedTokens ?? 0);
  const provider = cost?.activeProvider ?? 'local';
  return (
    <div className="dash-note">
      <span className="dash-note-ico">{saved > 0 ? '✦' : '◷'}</span>
      <span className="dash-note-txt">
        {saved > 0 ? (
          <>Context compression has saved <b>{saved.toLocaleString()}</b> tokens (<b>{((cost?.pctSmaller ?? 0) * 100).toFixed(0)}%</b> smaller), ~<b>${Number(cost?.estUsdSaved ?? 0).toFixed(4)}</b> — running on <b>{provider}</b>.</>
        ) : (
          <>Token-saving compression is <b>armed</b> but idle: it activates when injected memory exceeds the context budget. Nothing to compress yet — generation runs on <b>{provider}</b>.</>
        )}
      </span>
    </div>
  );
}

function DecisionLog({ chains }: { chains: DecisionChain[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  if (chains.length === 0) return null;
  return (
    <div className="dash-card">
      <h2 className="dash-h2">Decision log</h2>
      <p className="dash-cap">Architectural &amp; design choices, with supersession history.</p>
      <ul className="dash-decisions">
        {chains.map(chain => (
          <li key={chain.head.id} className="dash-decision-chain">
            <div className="dash-decision-head">
              <span className="dash-decision-title">{chain.head.title || chain.head.id}</span>
              {chain.head.why && <span className="dash-decision-why">{chain.head.why}</span>}
              {chain.history.length > 0 && (
                <button className="dash-decision-toggle" onClick={() => toggle(chain.head.id)} aria-expanded={expanded.has(chain.head.id)}>
                  {expanded.has(chain.head.id) ? '▾' : '▸'} {chain.history.length} superseded
                </button>
              )}
            </div>
            {expanded.has(chain.head.id) && chain.history.length > 0 && (
              <ul className="dash-decision-history">
                {chain.history.map(h => <li key={h.id} className="dash-decision-history-item">{h.title || h.id}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function NotesPanel({ notes }: { notes: UserNote[] }) {
  if (notes.length === 0) return (
    <div className="dash-card">
      <h2 className="dash-h2">Notes</h2>
      <p className="dash-cap">Your saved notes — observations you directed to memory.</p>
      <p className="dash-empty">No notes yet.</p>
    </div>
  );
  return (
    <div className="dash-card">
      <h2 className="dash-h2">Notes</h2>
      <p className="dash-cap">Your saved notes — observations you directed to memory.</p>
      <ul className="dash-decisions">
        {notes.map(n => (
          <li key={n.id} className="dash-decision-chain">
            <div className="dash-decision-head">
              <span className="dash-decision-title">{n.content}</span>
              <span className="dash-attn-meta">{relTime(n.created_at)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Main DashboardView ───────────────────────────────────────────────────────

export function DashboardView() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [cost, setCost] = useState<Cost | null>(null);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [chains, setChains] = useState<DecisionChain[]>([]);
  const [notes, setNotes] = useState<UserNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    Promise.all([fetchDashboard('metrics'), fetchDashboard('cost'), fetchDashboard('decisions'), fetchDashboard('notes')])
      .then(([m, c, d, n]) => {
        if (cancelled) return;
        if (!m) { setError('metrics unavailable'); return; }
        setMetrics(m as Metrics);
        setCost((c ?? null) as Cost | null);
        setChains(toDecisionChains(d));
        const notesPayload = n as { notes?: UserNote[] } | null;
        setNotes(notesPayload?.notes ?? []);
      })
      .catch(err => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    // Spend loads separately — ccusage can take ~2s, so it shouldn't block the
    // rest of the dashboard; it fills in when ready.
    fetchDashboard('spend').then(s => { if (!cancelled) setSpend((s ?? null) as Spend | null); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="dash-loading">Loading dashboard…</div>;
  if (error || !metrics) return <div className="dash-error">Failed to load dashboard data.</div>;

  return (
    <div className="dashboard-view">
      <KpiHero m={metrics} />
      <div className="dash-grid">
        <WorkInFlight work={metrics.work} />
        <Composition byType={metrics.byType} />
      </div>
      <ActivityChart activity={metrics.activity} />
      <SpendPanel spend={spend} />
      <NeedsAttention items={metrics.attention} />
      <NotesPanel notes={notes} />
      <DecisionLog chains={chains} />
      <CompressionNote cost={cost} />
    </div>
  );
}
