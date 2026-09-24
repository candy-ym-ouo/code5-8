import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { ReportFindingCategory, ReportFindingSeverity } from '@shanhai/contracts';
import { api } from '../api.ts';
import { useGame } from '../game-context.tsx';

const CATEGORY_LABELS: Record<ReportFindingCategory, string> = {
  distribution: '分布迁移',
  phenology: '物候偏移',
  restoration: '修复成效',
  sampling: '采集误差'
};

const SEVERITY_LABELS: Record<ReportFindingSeverity, string> = {
  info: '记录',
  notice: '关注',
  warning: '警示',
  critical: '严重'
};

export function ReportPage() {
  const { year: yearParam } = useParams();
  const { world } = useGame();
  const fallbackYear = world.phase === 'year_review' ? world.year : Math.max(1, world.year - 1);
  const requestedYear = Number(yearParam);
  const year = Number.isInteger(requestedYear) && requestedYear > 0 ? requestedYear : fallbackYear;
  const shouldQuery = world.phase === 'year_review' || world.year > 1;
  const report = useQuery({
    queryKey: ['report', world.saveId, year],
    queryFn: () => api.getReport(world.saveId, year),
    enabled: shouldQuery,
    retry: false
  });
  const backfill = useMutation({
    mutationFn: () => api.backfillReport(world.saveId, year),
    onSuccess: () => report.refetch()
  });

  if (!shouldQuery) {
    return (
      <div className="document-page empty-document">
        <p className="eyebrow">ANNUAL REPORT</p>
        <h1>第一年报告尚未生成</h1>
        <p>完成春、夏、秋、冬四季结算后，这里会显示真实的种群、分布、物候与采集归因。</p>
        <Link className="button button-primary" to="/play">返回山林继续观察</Link>
      </div>
    );
  }

  if (report.isLoading) return <p className="empty-copy">正在生成年度观察报告…</p>;
  if (report.isError || !report.data) {
    const canBackfill = year < world.year;
    return (
      <div className="document-page empty-document">
        <p className="eyebrow">ANNUAL REPORT</p>
        <h1>该年度报告不存在</h1>
        <p>
          {canBackfill
            ? '第 ' + year + ' 年已完整结算但缺少报告，可以从历史记录补算，补算不会影响后续年份。'
            : '只有完整结算的年度才会写入报告。'}
        </p>
        {canBackfill && (
          <button
            className="button button-primary"
            type="button"
            disabled={backfill.isPending}
            onClick={() => backfill.mutate()}
          >
            {backfill.isPending ? '正在补算…' : `补算第 ${year} 年度报告`}
          </button>
        )}
        {backfill.isError && <p className="form-error">补算失败：{backfill.error.message}</p>}
        <Link className="button button-secondary" to="/play">返回山林</Link>
      </div>
    );
  }

  const data = report.data;
  const findings = data.findings ?? [];
  const recommendationItems = data.recommendationItems ?? data.recommendations.map((text) => ({ text, findingIds: [] }));
  const maxMagnitude = Math.max(5, ...data.speciesChanges.map((item) => Math.abs(item.populationChangePercent)));

  return (
    <div className="document-page report-document">
      <header className="report-header">
        <p className="eyebrow">ANNUAL ECOLOGICAL REPORT · YEAR {data.year}</p>
        <h1>{data.headline}</h1>
        <p>全图种群变化 <strong className={data.populationChangePercent < 0 ? 'negative' : 'positive'}>{formatPercent(data.populationChangePercent)}</strong>，错误采集记录 {data.incorrectSamples} 次。</p>
        <p className="report-provenance">
          {data.generatedBy === 'backfill' ? '本报告由历史记录补算生成' : '本报告由冬季结算生成'}
          {data.generatedAt && ` · ${new Date(data.generatedAt).toLocaleString('zh-CN')}`}
        </p>
      </header>

      <section className="report-overview">
        <div className="big-number">
          <span>全图种群变化</span>
          <strong className={data.populationChangePercent < 0 ? 'negative' : 'positive'}>{formatPercent(data.populationChangePercent)}</strong>
        </div>
        <div className="report-callout">
          <span>修复状态</span>
          <strong>{data.restorationUnlocked ? '已解锁生态修复' : '暂不需要强制修复'}</strong>
          {data.restorationUnlocked && <Link to="/play">前往当前区域执行 →</Link>}
        </div>
      </section>

      <section className="document-section">
        <div className="section-heading">
          <div><p className="eyebrow">POPULATION CHANGE</p><h2>物种年度变化</h2></div>
          <span>横轴以年度种群变化百分比表示</span>
        </div>
        <div className="bar-chart">
          {data.speciesChanges.map((change) => (
            <div className="bar-row" key={change.speciesId}>
              <Link to={`/play/species/${change.speciesId}`}>{change.name}</Link>
              <div className="bar-track">
                <span
                  className={change.populationChangePercent < 0 ? 'bar-negative' : 'bar-positive'}
                  style={{ width: `${Math.max(3, Math.abs(change.populationChangePercent) / maxMagnitude * 100)}%` }}
                />
              </div>
              <strong className={change.populationChangePercent < 0 ? 'negative' : 'positive'}>
                {formatPercent(change.populationChangePercent)}
              </strong>
              <small>健康 {signed(change.healthChange)} · {change.status}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="document-section">
        <div className="section-heading">
          <div><p className="eyebrow">TRACEABLE FINDINGS</p><h2>可追溯结论</h2></div>
          <span>每条结论都附带来源数据，可回溯到快照、结算与采集记录</span>
        </div>
        {(Object.keys(CATEGORY_LABELS) as ReportFindingCategory[]).map((category) => {
          const items = findings.filter((finding) => finding.category === category);
          if (items.length === 0) return null;
          return (
            <div className="finding-group" key={category}>
              <h3>{CATEGORY_LABELS[category]}</h3>
              {items.map((finding) => (
                <article className={`finding finding-${finding.severity}`} key={finding.id}>
                  <header>
                    <strong>{finding.title}</strong>
                    <span className={`finding-severity severity-${finding.severity}`}>{SEVERITY_LABELS[finding.severity]}</span>
                  </header>
                  <p>{finding.detail}</p>
                  <ul className="evidence-list">
                    {finding.evidence.map((evidence, index) => (
                      <li key={`${finding.id}-evidence-${index}`}>
                        <span>{evidence.label}</span>
                        <strong>{evidence.value}</strong>
                        <code>{evidence.source}</code>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          );
        })}
      </section>

      <section className="document-section two-document-columns">
        <div>
          <p className="eyebrow">DISTRIBUTION EVENTS</p>
          <h2>分布变化</h2>
          <ul className="insight-list">
            {data.distributionChanges.map((change) => <li key={change}>{change}</li>)}
          </ul>
        </div>
        <div>
          <p className="eyebrow">NEXT YEAR</p>
          <h2>下一年度建议</h2>
          <ol className="recommendation-list">
            {recommendationItems.map((recommendation) => (
              <li key={recommendation.text}>
                {recommendation.text}
                {recommendation.findingIds.length > 0 && (
                  <small className="recommendation-trace">关联结论：{recommendation.findingIds.join('、')}</small>
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}

function formatPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function signed(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}
