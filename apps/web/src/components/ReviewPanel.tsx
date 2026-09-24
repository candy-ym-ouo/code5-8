import { Link } from 'react-router-dom';
import { SEASON_LABELS, type WorldSnapshot } from '@shanhai/contracts';

export function ReviewPanel({
  world,
  busy,
  onContinueSeason,
  onContinueYear
}: {
  world: WorldSnapshot;
  busy: boolean;
  onContinueSeason: () => void;
  onContinueYear: () => void;
}) {
  if (world.phase === 'season_review' && world.seasonReview) {
    return (
      <section className="review-panel">
        <p className="eyebrow">SEASON REVIEW</p>
        <h2>{world.year} 年 · {SEASON_LABELS[world.season]}季记录完成</h2>
        <div className="review-stats">
          <Metric label="观察记录" value={world.seasonReview.observationCount} />
          <Metric label="平均评分" value={world.seasonReview.averageObservationScore} />
          <Metric label="采集次数" value={world.seasonReview.sampleCount} />
          <Metric label="错误采集" value={world.seasonReview.incorrectSamples} alert={world.seasonReview.incorrectSamples > 0} />
        </div>
        <ul className="review-list">
          {world.seasonReview.changes.map((change) => <li key={change}>{change}</li>)}
        </ul>
        <button className="button button-primary" type="button" onClick={onContinueSeason} disabled={busy}>
          进入{SEASON_LABELS[nextSeason(world.season)]}季
        </button>
      </section>
    );
  }

  if (world.phase === 'year_review' && world.annualReview) {
    const report = world.annualReview;
    return (
      <section className="review-panel year-review">
        <p className="eyebrow">ANNUAL REPORT · YEAR {report.year}</p>
        <h2>{report.headline}</h2>
        <p className="review-lead">全图种群变化 {formatPercent(report.populationChangePercent)}，错误采集 {report.incorrectSamples} 次。</p>
        <p className="review-traceability">
          可追溯结论：分布迁移 {report.distributionMigrations.length} 条 · 物候偏移 {report.phenologyShifts.length} 条 · 修复成效 {report.restorationOutcomes.length} 条 · 采集误差 {report.samplingErrors.length} 条
        </p>
        <div className="report-mini-grid">
          {report.speciesChanges.slice(0, 6).map((change) => (
            <article key={change.speciesId}>
              <strong>{change.name}</strong>
              <span className={change.populationChangePercent < 0 ? 'negative' : 'positive'}>
                {formatPercent(change.populationChangePercent)}
              </span>
              <small>健康 {signed(change.healthChange)}</small>
            </article>
          ))}
        </div>
        <div className="review-actions">
          <Link className="button button-secondary" to={`/play/report/${report.year}`}>查看完整年报</Link>
          <button className="button button-primary" type="button" onClick={onContinueYear} disabled={busy}>
            进入第 {report.year + 1} 年
          </button>
        </div>
      </section>
    );
  }

  return null;
}

function Metric({ label, value, alert = false }: { label: string; value: number; alert?: boolean }) {
  return (
    <div className={`metric ${alert ? 'metric-alert' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function signed(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function nextSeason(season: WorldSnapshot['season']): WorldSnapshot['season'] {
  return ({ spring: 'summer', summer: 'autumn', autumn: 'winter', winter: 'spring' } as const)[season];
}
