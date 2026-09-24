import type {
  AnnualReview,
  DistributionMigration,
  PhenologyShift,
  RestorationOutcome,
  ReviewEvidence,
  SamplingError,
  SampleMethod,
  Season,
  SiteId,
  TraceableClaim
} from '@shanhai/contracts';
import { SEASON_LABELS } from '@shanhai/contracts';
import {
  applyOverwinter,
  getPhenologyWindow,
  round,
  SPECIES_BY_ID,
  SITES,
  SITES_BY_ID,
  type SiteState,
  type SpeciesState
} from '@shanhai/game-core';

export interface SampleEvidenceRow {
  id: string;
  year: number;
  season: Season;
  day: number;
  siteId: SiteId;
  speciesId: string;
  method: SampleMethod;
  protocolMatch: boolean;
  effects: { health: number; populationDelta: number; seedBankDelta: number; messages?: string[] };
  /** 采样当次造成的区域干扰增量，由 game-service 依据干扰台账回填。 */
  disturbanceDelta: number;
}

export interface ObservationEvidenceRow {
  id: string;
  year: number;
  season: Season;
  day: number;
  siteId: SiteId;
  speciesId: string | null;
  kind: 'plant' | 'environment';
  score: number;
}

export interface RestorationEvidenceRow {
  id: string;
  year: number;
  season: Season;
  day: number;
  siteId: SiteId;
  speciesId: string | null;
  action: string;
  disturbanceBefore: number;
  disturbanceAfter: number;
  healthBefore: number | null;
  healthAfter: number | null;
  seedBankBefore: number | null;
  seedBankAfter: number | null;
}

export interface DispersalEvidenceRow {
  id: string;
  year: number;
  speciesId: string;
  fromSiteId: SiteId;
  toSiteId: SiteId;
  migrants: number;
  sourcePopulationAfter: number;
  targetPopulationAfter: number;
}

export interface BuildReportInput {
  year: number;
  provenance: 'live' | 'backfilled';
  generatedAt: string;
  baselineSpecies: SpeciesState[];
  finalSpecies: SpeciesState[];
  /** 该年 1 月 1 日基线（即上一年年末扩散后的状态）；用于该年的实际迁入结论。 */
  dispersalEvents: DispersalEvidenceRow[];
  samples: SampleEvidenceRow[];
  observations: ObservationEvidenceRow[];
  restorations: RestorationEvidenceRow[];
  /** 该年冬季区域状态，用于推演下一年春季物候偏移（与 BEGIN_NEXT_YEAR 同一确定性函数）。 */
  winterSites: SiteState[];
  restorationUnlocked: boolean;
}

const SAMPLE_LABELS: Record<SampleMethod, string> = {
  photo: '拍照',
  rubbing: '拓印',
  litter: '落叶采集',
  cutting: '标准剪取'
};

const RESTORATION_LABELS: Record<string, string> = {
  reduce_disturbance: '降低区域干扰',
  protect_seed_bank: '保留种子区',
  restore_wetland: '恢复湿生带',
  establish_plot: '设置长期观察样方'
};

const STATUS_LABELS: Record<string, string> = {
  growing: '增长',
  stable: '稳定',
  vulnerable: '脆弱',
  endangered: '濒危',
  absent: '局部消失'
};

/**
 * 年度报告唯一构造入口。live 与 backfilled 共用同一套确定性计算，
 * 差别只体现在 provenance 与证据来源；调用方必须保证这里拿到的全部是
 * 该年度的历史快照，构造过程不读取、不修改任何游戏状态。
 */
export function buildAnnualReport(input: BuildReportInput): AnnualReview {
  const initialByKey = new Map(input.baselineSpecies.map((state) => [stateKey(state), state]));
  const finalByKey = new Map(input.finalSpecies.map((state) => [stateKey(state), state]));
  const keys = new Set([...initialByKey.keys(), ...finalByKey.keys()]);

  const speciesAggregate = new Map<
    string,
    { startPopulation: number; finalPopulation: number; startHealth: number; finalHealth: number; count: number; status: string }
  >();
  const distributionMigrations: DistributionMigration[] = [];
  const distributionChangeTexts: string[] = [];

  // 1) 区域等级变化与局部消长（年内基线 → 年末）
  for (const key of keys) {
    const initial = initialByKey.get(key);
    const final = finalByKey.get(key);
    const state = final ?? initial;
    if (!state) {
      continue;
    }
    const aggregate = speciesAggregate.get(state.speciesId) ?? {
      startPopulation: 0,
      finalPopulation: 0,
      startHealth: 0,
      finalHealth: 0,
      count: 0,
      status: 'stable'
    };
    aggregate.startPopulation += initial?.population ?? 0;
    aggregate.finalPopulation += final?.population ?? 0;
    aggregate.startHealth += initial?.health ?? 0;
    aggregate.finalHealth += final?.health ?? 0;
    aggregate.count += 1;
    aggregate.status = worstStatus(aggregate.status, final?.status ?? initial?.status ?? 'stable');
    speciesAggregate.set(state.speciesId, aggregate);

    if (initial && final) {
      const changeRatio = initial.population > 0 ? (final.population - initial.population) / initial.population : 0;
      if (initial.status !== final.status) {
        distributionChangeTexts.push(
          `${SITES_BY_ID.get(state.siteId)?.name ?? state.siteId}：${SPECIES_BY_ID.get(state.speciesId)?.name ?? state.speciesId} 由 ${STATUS_LABELS[initial.status] ?? initial.status} 变为 ${STATUS_LABELS[final.status] ?? final.status}`
        );
        const startEvidence = stateEvidence(`${key}:start`, input.year, 'spring', 1, initial, '年初基线快照');
        const endEvidence = stateEvidence(`${key}:end`, input.year, 'winter', 10, final, '年末结算快照');
        distributionMigrations.push(
          migrationFromLocalChange({
            input,
            initial,
            final,
            driver: final.population <= 1 && initial.population > 1 ? 'local_extinction' : 'local_change',
            migrants: Math.abs(final.population - initial.population),
            claimId: `migration-status-${key}`,
            conclusion:
              final.population <= 1 && initial.population > 1
                ? `${speciesName(state.speciesId)}在${siteName(state.siteId)}局部消失（年初 ${round(initial.population, 1)} → 年末 ${round(final.population, 1)}），状态由${STATUS_LABELS[initial.status] ?? initial.status}转为${STATUS_LABELS[final.status] ?? final.status}`
                : `${speciesName(state.speciesId)}在${siteName(state.siteId)}的保护等级由${STATUS_LABELS[initial.status] ?? initial.status}转为${STATUS_LABELS[final.status] ?? final.status}（种群 ${round(initial.population, 1)} → ${round(final.population, 1)}，${formatPercent(changeRatio * 100)}）`,
            evidence: [startEvidence, endEvidence]
          })
        );
      } else if (Math.abs(changeRatio) >= 0.15) {
        distributionMigrations.push(
          migrationFromLocalChange({
            input,
            initial,
            final,
            driver: 'local_change',
            migrants: Math.abs(final.population - initial.population),
            claimId: `migration-local-${key}`,
            conclusion: `${speciesName(state.speciesId)}在${siteName(state.siteId)}种群${changeRatio < 0 ? '收缩' : '扩张'} ${formatPercent(Math.abs(changeRatio * 100))}（${round(initial.population, 1)} → ${round(final.population, 1)}），等级仍为${STATUS_LABELS[final.status] ?? final.status}`,
            evidence: [
              stateEvidence(`${key}:start`, input.year, 'spring', 1, initial, '年初基线快照'),
              stateEvidence(`${key}:end`, input.year, 'winter', 10, final, '年末结算快照')
            ]
          })
        );
      }
    } else if (final && final.population > 1) {
      distributionMigrations.push(
        migrationFromLocalChange({
          input,
          initial: initial ?? final,
          final,
          driver: 'colonization',
          migrants: final.population,
          claimId: `migration-colonize-${key}`,
          conclusion: `${speciesName(final.speciesId)}新见于${siteName(final.siteId)}，年末记录到 ${round(final.population, 1)} 个个体`,
          evidence: [stateEvidence(`${key}:end`, input.year, 'winter', 10, final, '年末结算快照（年初无该区域记录）')]
        })
      );
    }
  }

  // 2) 实际跨区域扩散事件（年初由上一年越冬扩散台账提供）
  for (const event of input.dispersalEvents) {
    const fromInitial = initialByKey.get(`${event.fromSiteId}:${event.speciesId}`);
    const toInitial = initialByKey.get(`${event.toSiteId}:${event.speciesId}`);
    const evidence: ReviewEvidence[] = [
      {
        kind: 'environment',
        refId: event.id,
        year: event.year,
        siteId: event.fromSiteId,
        speciesId: event.speciesId,
        detail: `扩散台账：${round(event.migrants, 2)} 个个体从${siteName(event.fromSiteId)}迁入${siteName(event.toSiteId)}`
      }
    ];
    if (fromInitial) {
      evidence.push(stateEvidence(`${event.fromSiteId}:${event.speciesId}:baseline`, event.year, 'spring', 1, fromInitial, '迁出地年初种群'));
    }
    if (toInitial) {
      evidence.push(stateEvidence(`${event.toSiteId}:${event.speciesId}:baseline`, event.year, 'spring', 1, toInitial, '迁入地年初种群'));
    }
    distributionMigrations.push({
      speciesId: event.speciesId,
      speciesName: speciesName(event.speciesId),
      fromSiteId: event.fromSiteId,
      fromSiteName: siteName(event.fromSiteId),
      toSiteId: event.toSiteId,
      toSiteName: siteName(event.toSiteId),
      migrants: round(event.migrants, 2),
      startPopulation: round(fromInitial?.population ?? 0, 2),
      endPopulation: round(toInitial?.population ?? event.targetPopulationAfter, 2),
      statusBefore: fromInitial?.status ?? 'absent',
      statusAfter: toInitial?.status ?? 'absent',
      driver: 'dispersal',
      claim: {
        id: `migration-dispersal-${event.id}`,
        conclusion: `${speciesName(event.speciesId)}有 ${round(event.migrants, 2)} 个个体从${siteName(event.fromSiteId)}扩散至${siteName(event.toSiteId)}（迁移后两地种群分别为 ${round(event.sourcePopulationAfter, 1)} / ${round(event.targetPopulationAfter, 1)}）`,
        evidence,
        confidence: 'high'
      }
    });
  }
  distributionMigrations.sort((left, right) => right.migrants - left.migrants);

  // 3) 物种年度汇总
  let totalStart = 0;
  let totalFinal = 0;
  const speciesChanges = [...speciesAggregate.entries()].map(([speciesId, aggregate]) => {
    totalStart += aggregate.startPopulation;
    totalFinal += aggregate.finalPopulation;
    return {
      speciesId,
      name: speciesName(speciesId),
      populationChangePercent: percentChange(aggregate.startPopulation, aggregate.finalPopulation),
      healthChange: round(
        aggregate.finalHealth / Math.max(1, aggregate.count) - aggregate.startHealth / Math.max(1, aggregate.count),
        1
      ),
      status: aggregate.status
    };
  });
  speciesChanges.sort((left, right) => left.populationChangePercent - right.populationChangePercent);

  // 4) 物候偏移：以确定性越冬推演为准，观察记录只决定置信度
  const phenologyShifts = buildPhenologyShifts(input);

  // 5) 修复成效
  const restorationOutcomes = buildRestorationOutcomes(input);

  // 6) 采集误差台账
  const samplingErrors = buildSamplingErrors(input);
  const incorrectSamples = samplingErrors.length;

  // 7) 数据质量
  const dataQuality = buildDataQuality(input);

  const recommendations = buildRecommendations({
    incorrectSamples,
    speciesChanges,
    distributionMigrations,
    phenologyShifts,
    restorationOutcomes
  });

  const populationChangePercent = percentChange(totalStart, totalFinal);
  const headline =
    populationChangePercent < -5
      ? '今年的人为干扰和气候压力已改变物种分布'
      : populationChangePercent < 1
        ? '生态系统总体稳定，但局部种群正在调整'
        : '适宜生境中的种群实现增长，分布正在恢复';

  return {
    year: input.year,
    headline,
    populationChangePercent,
    speciesChanges,
    distributionChanges: distributionChangeTexts.length > 0 ? distributionChangeTexts : ['本年度未发生跨等级分布状态变化。'],
    incorrectSamples,
    recommendations,
    restorationUnlocked: input.restorationUnlocked,
    distributionMigrations,
    phenologyShifts,
    restorationOutcomes,
    samplingErrors,
    dataQuality,
    provenance: input.provenance,
    generatedAt: input.generatedAt
  };
}

interface LocalMigrationContext {
  input: BuildReportInput;
  initial: SpeciesState;
  final: SpeciesState;
  driver: DistributionMigration['driver'];
  migrants: number;
  claimId: string;
  conclusion: string;
  evidence: ReviewEvidence[];
}

function migrationFromLocalChange(context: LocalMigrationContext): DistributionMigration {
  return {
    speciesId: context.final.speciesId,
    speciesName: speciesName(context.final.speciesId),
    fromSiteId: context.final.siteId,
    fromSiteName: siteName(context.final.siteId),
    toSiteId: context.final.siteId,
    toSiteName: siteName(context.final.siteId),
    migrants: round(context.migrants, 2),
    startPopulation: round(context.initial.population, 2),
    endPopulation: round(context.final.population, 2),
    statusBefore: context.initial.status,
    statusAfter: context.final.status,
    driver: context.driver,
    claim: {
      id: context.claimId,
      conclusion: context.conclusion,
      evidence: context.evidence,
      confidence: context.input.provenance === 'backfilled' && context.evidence.length < 2 ? 'medium' : 'high'
    }
  };
}

function buildPhenologyShifts(input: BuildReportInput): PhenologyShift[] {
  const winterSiteMap = new Map(input.winterSites.map((site) => [site.siteId, site]));
  const plantObservations = input.observations.filter((row) => row.kind === 'plant' && row.speciesId);
  const observationByKey = new Map<string, ObservationEvidenceRow[]>();
  for (const row of plantObservations) {
    const list = observationByKey.get(`${row.siteId}:${row.speciesId}`) ?? [];
    list.push(row);
    observationByKey.set(`${row.siteId}:${row.speciesId}`, list);
  }

  const shifts: PhenologyShift[] = [];
  for (const final of input.finalSpecies) {
    const definition = SPECIES_BY_ID.get(final.speciesId);
    const winterSite = winterSiteMap.get(final.siteId);
    if (!definition || !winterSite) {
      continue;
    }
    // 与 BEGIN_NEXT_YEAR 完全一致的确定性越冬推演，保证报告与下一年状态同源。
    const projected = applyOverwinter(final, winterSite);
    const shiftDays = round((projected.phenology.shift ?? 0) - (final.phenology.shift ?? 0), 0);
    if (shiftDays === 0) {
      continue;
    }
    const observedRows = observationByKey.get(stateKey(final)) ?? [];
    // 选取该物种有花期配置的季节展示窗口（多数为春季，山茶含冬季）。
    const targetSeason = pickPhenologySeason(definition.phenology, final.siteId);
    const baselineWindow = getPhenologyWindow(definition, final, targetSeason);
    const observedWindow = getPhenologyWindow(definition, projected, targetSeason);
    if (!baselineWindow || !observedWindow) {
      continue;
    }
    const evidence: ReviewEvidence[] = observedRows
      .filter((row) => row.season === targetSeason)
      .slice(0, 4)
      .map((row) => ({
        kind: 'observation' as const,
        refId: row.id,
        year: row.year,
        season: row.season,
        day: row.day,
        siteId: row.siteId,
        speciesId: row.speciesId ?? undefined,
        detail: `${SEASON_LABELS[row.season]}季第 ${row.day} 日观察记录（评分 ${row.score}）`
      }));
    evidence.push({
      kind: 'environment',
      refId: `winter-site:${final.siteId}`,
      year: input.year,
      season: 'winter',
      siteId: final.siteId,
      detail: `越冬推演依据：${siteName(final.siteId)}冬季气温 ${winterSite.temperatureC}℃（与进入下一年的确定性结算同源）`
    });

    shifts.push({
      speciesId: final.speciesId,
      speciesName: speciesName(final.speciesId),
      siteId: final.siteId,
      siteName: siteName(final.siteId),
      season: targetSeason,
      baselineStartDay: baselineWindow.start,
      baselinePeakDay: baselineWindow.peak,
      baselineEndDay: baselineWindow.end,
      observedStartDay: observedWindow.start,
      observedPeakDay: observedWindow.peak,
      observedEndDay: observedWindow.end,
      shiftDays,
      observationCount: observedRows.length,
      claim: {
        id: `phenology-${stateKey(final)}-${targetSeason}`,
        conclusion: `${speciesName(final.speciesId)}在${siteName(final.siteId)}的${SEASON_LABELS[targetSeason]}季花期整体${shiftDays < 0 ? '提前' : '推迟'} ${Math.abs(shiftDays)} 日（盛花第 ${baselineWindow.peak} 日 → 第 ${observedWindow.peak} 日）`,
        evidence,
        confidence: observedRows.some((row) => row.season === targetSeason) ? 'high' : observedRows.length > 0 ? 'medium' : 'low'
      }
    });
  }
  shifts.sort((left, right) => Math.abs(right.shiftDays) - Math.abs(left.shiftDays) || right.observationCount - left.observationCount);
  return shifts;
}

function pickPhenologySeason(
  phenology: Partial<Record<Season, { start: number; peak: number; end: number }>>,
  _siteId: SiteId
): Season {
  const order: Season[] = ['spring', 'winter', 'summer', 'autumn'];
  for (const season of order) {
    const window = phenology[season];
    if (window && window.start > 0) {
      return season;
    }
  }
  return 'spring';
}

function buildRestorationOutcomes(input: BuildReportInput): RestorationOutcome[] {
  const groups = new Map<string, RestorationEvidenceRow[]>();
  for (const row of input.restorations) {
    const key = `${row.action}:${row.siteId}:${row.speciesId ?? 'site'}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const outcomes: RestorationOutcome[] = [];
  for (const [, rows] of groups) {
    rows.sort((left, right) => left.day - right.day);
    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const evidence: ReviewEvidence[] = rows.slice(0, 5).map((row) => ({
      kind: 'restoration',
      refId: row.id,
      year: row.year,
      season: row.season,
      day: row.day,
      siteId: row.siteId,
      speciesId: row.speciesId ?? undefined,
      detail: `${SEASON_LABELS[row.season]}季第 ${row.day} 日执行「${RESTORATION_LABELS[row.action] ?? row.action}」：干扰 ${round(row.disturbanceBefore, 3)} → ${round(row.disturbanceAfter, 3)}${
        row.healthBefore !== null && row.healthAfter !== null ? `，健康 ${round(row.healthBefore, 1)} → ${round(row.healthAfter, 1)}` : ''
      }${
        row.seedBankBefore !== null && row.seedBankAfter !== null
          ? `，种子库 ${round(row.seedBankBefore, 1)} → ${round(row.seedBankAfter, 1)}`
          : ''
      }`
    }));

    const healthValues = rows.filter(
      (row): row is typeof row & { healthBefore: number; healthAfter: number } =>
        row.healthBefore !== null && row.healthAfter !== null
    );
    const seedValues = rows.filter(
      (row): row is typeof row & { seedBankBefore: number; seedBankAfter: number } =>
        row.seedBankBefore !== null && row.seedBankAfter !== null
    );

    outcomes.push({
      action: first.action,
      actionLabel: RESTORATION_LABELS[first.action] ?? first.action,
      siteId: first.siteId,
      siteName: siteName(first.siteId),
      speciesId: first.speciesId,
      speciesName: first.speciesId ? speciesName(first.speciesId) : null,
      count: rows.length,
      disturbanceBefore: round(first.disturbanceBefore, 3),
      disturbanceAfter: round(last.disturbanceAfter, 3),
      healthBefore: healthValues.length ? round(healthValues[0]!.healthBefore, 1) : null,
      healthAfter: healthValues.length ? round(healthValues[healthValues.length - 1]!.healthAfter, 1) : null,
      seedBankBefore: seedValues.length ? round(seedValues[0]!.seedBankBefore, 1) : null,
      seedBankAfter: seedValues.length ? round(seedValues[seedValues.length - 1]!.seedBankAfter, 1) : null,
      claim: {
        id: `restoration-${first.action}-${first.siteId}-${first.speciesId ?? 'site'}`,
        conclusion: `${siteName(first.siteId)}共执行 ${rows.length} 次「${RESTORATION_LABELS[first.action] ?? first.action}」，区域干扰 ${round(first.disturbanceBefore, 3)} 降至 ${round(last.disturbanceAfter, 3)}${
          healthValues.length
            ? `，${first.speciesId ? speciesName(first.speciesId) : '目标物种'}健康 ${round(healthValues[0]!.healthBefore, 1)} → ${round(healthValues[healthValues.length - 1]!.healthAfter, 1)}`
            : ''
        }`,
        evidence,
        confidence: 'high'
      }
    });
  }
  outcomes.sort((left, right) => left.disturbanceAfter - right.disturbanceAfter);
  return outcomes;
}

function buildSamplingErrors(input: BuildReportInput): SamplingError[] {
  return input.samples
    .filter((row) => !row.protocolMatch)
    .map((row) => {
      const evidence: ReviewEvidence[] = [
        {
          kind: 'sample',
          refId: row.id,
          year: row.year,
          season: row.season,
          day: row.day,
          siteId: row.siteId,
          speciesId: row.speciesId,
          detail: `${SEASON_LABELS[row.season]}季第 ${row.day} 日在${siteName(row.siteId)}对${speciesName(row.speciesId)}执行「${SAMPLE_LABELS[row.method] ?? row.method}」，判定不符合采集协议`
        },
        {
          kind: 'environment',
          refId: `${row.id}:site`,
          year: row.year,
          season: row.season,
          day: row.day,
          siteId: row.siteId,
          detail: `当次影响：健康 ${formatSigned(row.effects.health)}、种群 ${formatSigned(round(row.effects.populationDelta, 2))}、种子库 ${formatSigned(round(row.effects.seedBankDelta, 1))}、区域干扰 +${round(row.disturbanceDelta, 4)}`
        }
      ];
      const claim: TraceableClaim = {
        id: `sampling-error-${row.id}`,
        conclusion: `${SEASON_LABELS[row.season]}季第 ${row.day} 日在${siteName(row.siteId)}对${speciesName(row.speciesId)}的「${SAMPLE_LABELS[row.method] ?? row.method}」与当前物候不匹配，已计入健康、种群、种子库与区域干扰损失`,
        evidence,
        confidence: 'high'
      };
      return {
        sampleId: row.id,
        speciesId: row.speciesId,
        speciesName: speciesName(row.speciesId),
        siteId: row.siteId,
        siteName: siteName(row.siteId),
        season: row.season,
        day: row.day,
        method: row.method,
        methodLabel: SAMPLE_LABELS[row.method] ?? row.method,
        healthDelta: row.effects.health,
        populationDelta: round(row.effects.populationDelta, 2),
        seedBankDelta: round(row.effects.seedBankDelta, 1),
        disturbanceDelta: round(row.disturbanceDelta, 4),
        claim
      };
    })
    .sort((left, right) => left.season.localeCompare(right.season) || left.day - right.day);
}

function buildDataQuality(input: BuildReportInput): AnnualReview['dataQuality'] {
  const siteCoverage = SITES.map((site) => ({
    siteId: site.id,
    siteName: site.name,
    observations: input.observations.filter((row) => row.siteId === site.id).length,
    samples: input.samples.filter((row) => row.siteId === site.id).length
  }));

  const caveats: string[] = [];
  const visitedSites = new Set(input.observations.map((row) => row.siteId));
  const unvisited = siteCoverage.filter((item) => item.observations === 0 && item.samples === 0);
  if (unvisited.length > 0) {
    caveats.push(`${unvisited.map((item) => item.siteName).join('、')}全年无观察或采集记录，相关区域结论仅来自环境推演，证据强度较低。`);
  }
  if (input.observations.length === 0) {
    caveats.push('全年没有任何观察记录，物候偏移结论只能依据越冬模型推演，不能作为实地观测结论。');
  } else if (visitedSites.size <= 1) {
    caveats.push('观察记录集中在单一区域，跨区域分布对比存在采样偏差。');
  }
  const incorrectRatio = input.samples.length > 0 ? input.samples.filter((row) => !row.protocolMatch).length / input.samples.length : 0;
  if (incorrectRatio >= 0.5 && input.samples.length >= 2) {
    caveats.push(`错误采集占比 ${(incorrectRatio * 100).toFixed(0)}%，种群衰退可能主要来自采集误差而非气候或生境变化，解读分布迁移时需扣除该影响。`);
  }
  if (input.provenance === 'backfilled') {
    caveats.push('本报告为历史年份补算结果，仅依据已留存的基线、年末状态与台账重建；补算过程未修改任何游戏状态，也不会影响后续年份的正式报告。');
  }
  if (caveats.length === 0) {
    caveats.push('四区均有记录覆盖，年度结论可追溯到观察、采集、修复与状态快照台账。');
  }

  return {
    observationCount: input.observations.length,
    sampleCount: input.samples.length,
    incorrectSampleCount: input.samples.filter((row) => !row.protocolMatch).length,
    restorationCount: input.restorations.length,
    siteCoverage,
    caveats
  };
}

function buildRecommendations(context: {
  incorrectSamples: number;
  speciesChanges: AnnualReview['speciesChanges'];
  distributionMigrations: DistributionMigration[];
  phenologyShifts: PhenologyShift[];
  restorationOutcomes: RestorationOutcome[];
}): string[] {
  const recommendations: string[] = [];
  if (context.incorrectSamples > 0) {
    recommendations.push('下一年优先使用拍照和条件合适的非破坏性采集，避免在错误物候期重复取样。');
  }
  const declining = context.speciesChanges.filter((item) => item.populationChangePercent < -2);
  if (declining.length > 0) {
    recommendations.push(`重点关注 ${declining.slice(0, 3).map((item) => item.name).join('、')}，并在衰退区域设置观察样方。`);
  }
  if (context.distributionMigrations.some((item) => item.statusAfter === 'endangered' || item.driver === 'local_extinction')) {
    recommendations.push('对濒危或局部消失区域停止剪取，优先执行降低干扰和保留种子区。');
  }
  const strongShift = context.phenologyShifts.find((item) => Math.abs(item.shiftDays) >= 1 && item.claim.confidence !== 'low');
  if (strongShift) {
    recommendations.push(
      `${strongShift.speciesName}花期${strongShift.shiftDays < 0 ? '提前' : '推迟'}已被观察证实，下一年请在${strongShift.siteName}提前安排固定样方复查。`
    );
  }
  if (context.restorationOutcomes.length > 0) {
    recommendations.push('已执行修复的区域需要跨年度复查，确认干扰下降是否转化为种群与种子库恢复。');
  }
  if (recommendations.length < 2) {
    recommendations.push('保持固定样方和连续物候记录，以提高下一年度花期预报置信度。');
  }
  return recommendations;
}

function stateEvidence(
  refId: string,
  year: number,
  season: Season,
  day: number,
  state: SpeciesState,
  detail: string
): ReviewEvidence {
  return {
    kind: 'species_state',
    refId,
    year,
    season,
    day,
    siteId: state.siteId,
    speciesId: state.speciesId,
    detail: `${detail}：种群 ${round(state.population, 2)}、健康 ${round(state.health, 1)}、种子库 ${round(state.seedBank, 1)}、状态 ${STATUS_LABELS[state.status] ?? state.status}`
  };
}

function stateKey(state: SpeciesState): string {
  return `${state.siteId}:${state.speciesId}`;
}

function speciesName(speciesId: string): string {
  return SPECIES_BY_ID.get(speciesId)?.name ?? speciesId;
}

function siteName(siteId: SiteId): string {
  return SITES_BY_ID.get(siteId)?.name ?? siteId;
}

function percentChange(start: number, end: number): number {
  if (start <= 0) {
    return end > 0 ? 100 : 0;
  }
  return round(((end - start) / start) * 100, 1);
}

function worstStatus(left: string, right: string): string {
  const severity: Record<string, number> = {
    growing: 0,
    stable: 1,
    vulnerable: 2,
    endangered: 3,
    absent: 4
  };
  return (severity[right] ?? 1) > (severity[left] ?? 1) ? right : left;
}

function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`;
}
