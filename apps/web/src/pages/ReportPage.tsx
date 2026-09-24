import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { TraceableClaim } from '@shanhai/contracts';
import { api } from '../api.ts';
import { useGame } from '../game-context.tsx';

export function ReportPage() {
  const { year: yearParam } = useParams();
  const { world } = useGame();
  const queryClient = useQueryClient();
  const fallbackYear = world.phase === 'year_review' ? world.year : Math.max(1, world.year - 1);
  const requestedYear = Number(yearParam);
  const year = Number.isInteger(requestedYear) && requestedYear > 0 ? requestedYear : fallbackYear;
  const shouldQuery = world.phase === 'year_review' || world.year > 1;
  const canBackfill = year < world.year;
  const report = useQuery({
    queryKey: ['report', world.saveId, year],
    queryFn: () => api.getReport(world.saveId, year),
    enabled: shouldQuery,
    retry: false
  });
  const backfill = useMutation({
    mutationFn: () => api.backfillReport(world.saveId, year),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['report', world.saveId, year] })
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
    return (
      <div className="document-page empty-document">
        <p className="eyebrow">ANNUAL REPORT</p>
        <h1>该年度报告不存在</h1>
        <p>只有完整结算的年度才会写入正式报告。</p>
        {canBackfill && (
          <>
            <p>第 {year} 年已经结束，可以仅依据历史留痕补算一份可追溯报告；补算不会改变任何游戏状态或后续年份的正式报告。</p>
            <button
              className="button button-secondary"
              disabled={backfill.isPending}
              onClick={() => backfill.mutate()}
            >
              {backfill.isPending ? '正在依据历史台账补算…' : `补算第 ${year} 年报告`}
            </button>
            {backfill.isError && <p className="negative">补算失败：{(backfill.error as Error).message}</p>}
          </>
        )}
        <Link className="button button-secondary" to="/play">返回山林</Link>
      </div>
    );
  }

  const data = report.data;
  const maxMagnitude = Math.max(5, ...data.speciesChanges.map((item) => Math.abs(item.populationChangePercent)));

  return (
    <div className="document-page report-document">
      <header className="report-header">
        <p className="eyebrow">ANNUAL ECOLOGICAL REPORT · YEAR {data.year}</p>
        <h1>{data.headline}</h1>
        <p>
          全图种群变化 <strong className={data.populationChangePercent < 0 ? 'negative' : 'positive'}>{formatPercent(data.populationChangePercent)}</strong>，错误采集记录 {data.incorrectSamples} 次。
          {data.provenance === 'backfilled' && <span className="provenance-badge">历史补算 · 不影响后续报告</span>}
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
          <div><p className="eyebrow">DISTRIBUTION MIGRATION</p><h2>分布迁移</h2></div>
          <span>每条结论均可回溯到年初基线、年末快照或扩散台账</span>
        </div>
        {data.distributionMigrations.length === 0 ? (
          <p className="empty-copy">本年度未检测到达到阈值的分布迁移。</p>
        ) : (
          <div className="trace-list">
            {data.distributionMigrations.map((migration) => (
              <article className="trace-card" key={migration.claim.id}>
                <ClaimHeader claim={migration.claim} driverLabel={migrationDriverLabel(migration.driver)} />
                <p>{migration.claim.conclusion}</p>
                <Evidence claim={migration.claim} />
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="document-section">
        <div className="section-heading">
          <div><p className="eyebrow">PHENOLOGY SHIFT</p><h2>物候偏移</h2></div>
          <span>与进入下一年时的确定性越冬结算同源；观察记录决定置信度</span>
        </div>
        {data.phenologyShifts.length === 0 ? (
          <p className="empty-copy">越冬模型未推演到花期偏移。</p>
        ) : (
          <div className="trace-list">
            {data.phenologyShifts.map((shift) => (
              <article className="trace-card" key={shift.claim.id}>
                <ClaimHeader claim={shift.claim} extra={`盛花第 ${shift.baselinePeakDay} 日 → 第 ${shift.observedPeakDay} 日 · 实地观察 ${shift.observationCount} 次`} />
                <p>{shift.claim.conclusion}</p>
                <Evidence claim={shift.claim} />
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="document-section">
        <div className="section-heading">
          <div><p className="eyebrow">RESTORATION OUTCOMES</p><h2>修复成效</h2></div>
          <span>按修复动作归因到干扰、健康与种子库的实际变化</span>
        </div>
        {data.restorationOutcomes.length === 0 ? (
          <p className="empty-copy">本年度没有执行生态修复。</p>
        ) : (
          <div className="trace-list">
            {data.restorationOutcomes.map((outcome) => (
              <article className="trace-card" key={outcome.claim.id}>
                <ClaimHeader claim={outcome.claim} extra={`${outcome.siteName} · 执行 ${outcome.count} 次`} />
                <p>{outcome.claim.conclusion}</p>
                <Evidence claim={outcome.claim} />
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="document-section">
        <div className="section-heading">
          <div><p className="eyebrow">SAMPLING ERRORS</p><h2>采集误差台账</h2></div>
          <span>共 {data.samplingErrors.length} 条，逐条对应样本记录及生态影响</span>
        </div>
        {data.samplingErrors.length === 0 ? (
          <p className="empty-copy">本年度没有不符合协议的采集。</p>
        ) : (
          <div className="trace-table-wrap">
            <table className="trace-table">
              <thead>
                <tr>
                  <th>时间</th><th>区域</th><th>物种</th><th>方式</th>
                  <th>健康</th><th>种群</th><th>种子库</th><th>干扰</th><th>证据</th>
                </tr>
              </thead>
              <tbody>
                {data.samplingErrors.map((error) => (
                  <tr key={error.sampleId}>
                    <td>{seasonLabel(error.season)}季 第{error.day}日</td>
                    <td>{error.siteName}</td>
                    <td>{error.speciesName}</td>
                    <td>{error.methodLabel}</td>
                    <td className="negative">{signed(error.healthDelta)}</td>
                    <td className="negative">{signed(error.populationDelta)}</td>
                    <td className="negative">{signed(error.seedBankDelta)}</td>
                    <td className="negative">+{error.disturbanceDelta}</td>
                    <td><Evidence claim={error.claim} compact /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="document-section two-document-columns">
        <div>
          <p className="eyebrow">DISTRIBUTION EVENTS</p>
          <h2>分布等级变化</h2>
          <ul className="insight-list">
            {data.distributionChanges.map((change) => <li key={change}>{change}</li>)}
          </ul>
        </div>
        <div>
          <p className="eyebrow">NEXT YEAR</p>
          <h2>下一年度建议</h2>
          <ol className="recommendation-list">
            {data.recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}
          </ol>
        </div>
      </section>

      <section className="document-section">
        <div className="section-heading">
          <div><p className="eyebrow">DATA QUALITY</p><h2>数据完备性与采集偏差</h2></div>
          <span>观察 {data.dataQuality.observationCount} · 采集 {data.dataQuality.sampleCount} · 修复 {data.dataQuality.restorationCount}</span>
        </div>
        <div className="coverage-grid">
          {data.dataQuality.siteCoverage.map((site) => (
            <div className="coverage-cell" key={site.siteId}>
              <strong>{site.siteName}</strong>
              <span>观察 {site.observations} 次 · 采集 {site.samples} 次</span>
            </div>
          ))}
        </div>
        <ul className="insight-list">
          {data.dataQuality.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
        </ul>
        <p className="report-meta">
          报告生成时间 {new Date(data.generatedAt).toLocaleString('zh-CN')} · 来源：
          {data.provenance === 'live' ? '年度四季结算正式报告' : '历史证据补算（与正式报告物理隔离）'}
        </p>
      </section>
    </div>
  );
}

function ClaimHeader({ claim, driverLabel, extra }: { claim: TraceableClaim; driverLabel?: string; extra?: string }) {
  return (
    <div className="trace-card-head">
      <span className={`confidence confidence-${claim.confidence}`}>置信度 · {confidenceLabel(claim.confidence)}</span>
      {driverLabel && <span className="trace-tag">{driverLabel}</span>}
      {extra && <span className="trace-tag">{extra}</span>}
    </div>
  );
}

function Evidence({ claim, compact = false }: { claim: TraceableClaim; compact?: boolean }) {
  if (claim.evidence.length === 0) {
    return <small className="negative">缺少证据</small>;
  }
  return (
    <ul className={compact ? 'evidence-list evidence-compact' : 'evidence-list'}>
      {claim.evidence.map((item) => (
        <li key={`${item.kind}:${item.refId}`} title={`证据类型 ${item.kind} · 引用 ${item.refId}`}>
          <span className="evidence-kind">{evidenceKindLabel(item.kind)}</span>
          {item.detail}
        </li>
      ))}
    </ul>
  );
}

function migrationDriverLabel(driver: string): string {
  const labels: Record<string, string> = {
    dispersal: '实际扩散',
    local_change: '局部消长',
    local_extinction: '局部消失',
    colonization: '新见占据'
  };
  return labels[driver] ?? driver;
}

function evidenceKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    sample: '样本',
    observation: '观察',
    restoration: '修复',
    species_state: '状态快照',
    environment: '环境/台账'
  };
  return labels[kind] ?? kind;
}

function confidenceLabel(confidence: TraceableClaim['confidence']): string {
  return confidence === 'high' ? '高' : confidence === 'medium' ? '中' : '低';
}

function seasonLabel(season: string): string {
  return { spring: '春', summer: '夏', autumn: '秋', winter: '冬' }[season] ?? season;
}

function formatPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function signed(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}
