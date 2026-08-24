import React, { useEffect, useState } from 'react';
import { fetchDashboard, isUnauthorized, dataOrNull } from '../utils/serverData';
import { fetchIdentity } from '../utils/settingsData.js';
import { JoinTeamModal } from '../components/JoinTeamModal.js';

// Shown instead of the generic load failure when the server rejected our
// credentials, so an auth problem does not read as missing data.
const UNAUTHORIZED_MESSAGE = 'Not authenticated — reload this page to sign in to your local MemSmith.';
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

/**
 * The Runtime tile.
 *
 * This was the literal string 'local' with the hint 'embedded Postgres · no
 * Docker'. It never read anything, so it displayed "local" on a team install
 * too — and it was accidentally correct right up until someone ran Go Team,
 * which is exactly the moment the answer matters.
 *
 * Reported live: a project whose marker said runtime=server, whose rows were
 * verifiably on the shared database, still showed "local" on the dashboard. The
 * wizard said "This project is now in Team mode" and the dashboard contradicted
 * it, with the dashboard being wrong.
 *
 * `/v1/info` already returned the truth (`runtime: 'server-beta'`) the whole
 * time — the data was one fetch away.
 */
function runtimeTile(runtime: string | null): { n: string; l: string; hint: string; accent: boolean } {
  // 'server-beta' is the legacy literal for the server runtime; treat both as
  // team so the tile does not read "server-beta" at the user.
  // 'team' is what /v1/identity actually returns — its type is 'local' | 'team'
  // (identity-payload.ts:35). 'server'/'server-beta' are the SERVER-wide literals
  // from /v1/info, kept only so a caller pointed at that endpoint still maps
  // sensibly.
  //
  // This mapping originally listed ONLY server/server-beta, because it was
  // written when the tile read /v1/info. Repointing it at /v1/identity — which
  // reports per-project, and was the right move — silently broke it: 'team' fell
  // through to the unknown branch and the tile read "— runtime unavailable" on a
  // correctly converted project. Every layer beneath was working and returning
  // "team"; only this comparison disagreed.
  if (runtime === 'team' || runtime === 'server' || runtime === 'server-beta') {
    return { n: 'team', l: 'Runtime', hint: 'shared Postgres · team workspace', accent: false };
  }
  if (runtime === 'local') {
    return { n: 'local', l: 'Runtime', hint: 'embedded Postgres · no Docker', accent: false };
  }
  // Unknown/unreachable: say so rather than guessing 'local'. Claiming a runtime
  // we could not read is what made this tile misleading in the first place.
  return { n: '—', l: 'Runtime', hint: 'runtime unavailable', accent: false };
}

/**
 * Should the Runtime tile offer Join?
 *
 * The rule, from the product owner:
 *
 *   "when project is on local mode (Not team) - there's nothing to join to.
 *    the moment the project gets converted to team, the join button should
 *    appear to new members (not to the owner - the owner is by nature already in)"
 *
 *   LOCAL -> no team exists yet. Nothing to join. The local route to a team is
 *            GO TEAM (convert), which lives in Settings.
 *   TEAM  -> a workspace exists; a NEW MEMBER on this machine can join it. The
 *            OWNER is already in it by construction.
 *
 * This was previously `runtime === 'local'`, which is the exact inverse: it
 * showed the button where there was nothing to join and hid it where joining is
 * the whole point. That gating was an assumption of mine, not a requirement —
 * the mockup always showed the button on the tile reading "Team".
 *
 * Exported so the rule can be tested directly; the tile only renders it.
 */
export function canJoinFromIdentity(
  runtime: string | null,
  identity: { keyPresent?: boolean } | null,
): boolean {
  // Same normalisation the runtime tile uses. /v1/identity says 'team', while
  // the marker and older responses say 'server'/'server-beta'; if this gate
  // disagreed with the tile the button would appear on some team projects only.
  const isTeam = runtime === 'team' || runtime === 'server' || runtime === 'server-beta';
  if (!isTeam) return false;
  // GATE ON THE KEY, NOT THE ROLE.
  //
  // "Not the owner" was a proxy for "could join". It is the wrong proxy on the
  // machine that matters most: a teammate who has not joined has no api_keys
  // row, so role resolves to null everywhere, and the gate then depends
  // entirely on the runtime half — which /v1/identity derives from
  // `projects.metadata` in the LOCAL database. A fresh clone has no such row,
  // so runtime came back 'local' and the button never rendered for the one
  // person it exists for.
  //
  // `keyPresent` asks the honest question instead: is there a team here that
  // this machine cannot yet open? The owner holds their project's key, so they
  // are excluded because they can already open it — not by inferring intent
  // from a role.
  //
  // Absent keyPresent (older server, unparsed payload) counts as NO key, so the
  // action still shows. Offering Join to someone already joined is a harmless
  // no-op; hiding it from a new teammate strands them with no way in.
  return identity?.keyPresent !== true;
}

function KpiHero({ m, runtime, keyPresent, onJoin }: { m: Metrics; runtime: string | null; keyPresent: boolean | null; onJoin: () => void }) {
  const cards = [
    { n: m.total.toLocaleString(), l: 'Memories', hint: 'observations stored', accent: true },
    { n: m.decisions.toLocaleString(), l: 'Decisions', hint: 'reasoning recorded', accent: false },
    { n: Math.round(m.embeddedPct * 100) + '%', l: 'Embedded', hint: 'semantic-searchable', accent: false },
    runtimeTile(runtime),
  ];
  // Joining belongs ON the Runtime tile, not buried in Settings: the tile is
  // already where you look to see which mode you are in, so it is where you
  // reach when you want to change it. See canJoinFromIdentity for WHEN.
  const canJoin = canJoinFromIdentity(runtime, keyPresent === null ? null : { keyPresent });
  return (
    <div className="dash-kpis">
      {cards.map((k, i) => (
        <div className="dash-kpi" key={k.l} style={{ animationDelay: `${0.03 + i * 0.06}s` }}>
          <div className="dash-kpi-top">
            <div className={`dash-kpi-n${k.accent ? ' dash-kpi-n--accent' : ''}`}>{k.n}</div>
            {k.l === 'Runtime' && canJoin && (
              <button type="button" className="dash-kpi-action" onClick={onJoin}>Join</button>
            )}
          </div>
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
  const [runtime, setRuntime] = useState<string | null>(null);
  // Whether THIS MACHINE holds a key for the project's team decides whether Join
  // is offered. Not the role: a teammate who has not joined has no api_keys row,
  // so role resolves to null for exactly the person the button is for. null =
  // not yet known (identity still in flight or unreachable).
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    Promise.all([fetchDashboard('metrics'), fetchDashboard('cost'), fetchDashboard('decisions'), fetchDashboard('notes')])
      .then(([m, c, d, n]) => {
        if (cancelled) return;
        if (isUnauthorized(m)) { setError(UNAUTHORIZED_MESSAGE); return; }
        if (!m) { setError('metrics unavailable'); return; }
        setMetrics(m as Metrics);
        // dataOrNull collapses the unauthorized sentinel back to null. The
        // sentinel is a Symbol and therefore TRUTHY, so `?? null` would pass it
        // straight through into state and every downstream property read would
        // render garbage. Only the `metrics` branch above wants to see it.
        setCost(dataOrNull(c) as Cost | null);
        setChains(toDecisionChains(dataOrNull(d)));
        const notesPayload = dataOrNull(n) as { notes?: UserNote[] } | null;
        setNotes(notesPayload?.notes ?? []);
      })
      .catch(err => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    // Spend loads separately — ccusage can take ~2s, so it shouldn't block the
    // rest of the dashboard; it fills in when ready.
    fetchDashboard('spend').then(s => { if (!cancelled) setSpend(dataOrNull(s) as Spend | null); }).catch(() => {});
    // Runtime comes from /v1/IDENTITY, which reports THIS PROJECT's runtime.
    //
    // My first version read /v1/info — that is the SERVER's runtime, one value
    // for the whole process ('server-beta' whenever the server runtime is up).
    // So after one project converted, every project's tile read "team",
    // including the still-local dogfood. Reported immediately: switching to the
    // MemSmith project showed "team" when it is local.
    //
    // /v1/identity resolves runtime from the requested project's own marker via
    // its recorded path (see settingsRoutes: "never from the server's cwd"), and
    // the viewer's project cookie scopes the request — the same source Settings
    // already uses to gate the GO TEAM button, so the two cannot disagree.
    //
    // Non-blocking: an unreachable server must leave the tile reading "—", never
    // a fabricated "local".
    fetchIdentity()
      .then(id => {
        if (cancelled) return;
        setRuntime(id && typeof id.runtime === 'string' ? id.runtime : null);
        // Same payload already reports whether this machine holds the project's
        // key (buildIdentityPayload computes it straight from the credential
        // store), so gating Join costs no extra request.
        setKeyPresent(id && typeof id.keyPresent === 'boolean' ? id.keyPresent : null);
      })
      .catch(() => { /* tile shows "runtime unavailable" */ });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="dash-loading">Loading dashboard…</div>;
  if (error === UNAUTHORIZED_MESSAGE) return <div className="dash-error">{UNAUTHORIZED_MESSAGE}</div>;
  if (error || !metrics) return <div className="dash-error">Failed to load dashboard data.</div>;

  return (
    <div className="dashboard-view">
      <JoinTeamModal
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        // Reload rather than patching state: joining changes the runtime, the
        // credential, and every scoped read on the page at once.
        onJoined={() => location.reload()}
      />
      <KpiHero m={metrics} runtime={runtime} keyPresent={keyPresent} onJoin={() => setJoinOpen(true)} />
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
