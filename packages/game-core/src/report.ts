import type {
  AnnualRecommendation,
  AnnualReview,
  ReportEvidence,
  ReportFinding,
  ReportFindingCategory,
  ReportFindingSeverity,
  SampleMethod,
  Season,
  SiteId
} from '@shanhai/contracts';
import { SEASONS, SEASON_LABELS } from '@shanhai/contracts';
import { SPECIES_BY_ID, SITES_BY_ID } from './catalog.ts';
import { getPhenologyWindow, round } from './simulation.ts';
import type { SiteState, SpeciesState } from './types.ts';

export interface SamplingRecord {
  id: string;
  siteId: SiteId;
  speciesId: string;
  method: SampleMethod;
  season: Season;
  day: number;
  effects: { health: number; populationDelta: number; seedBankDelta: number };
}

export interface RestorationRecord {
  id: string;
  siteId: SiteId;
  speciesId: string;
  action: string;
  season: Season;
  day: number;
  before: { disturbance: number; health: number; seedBank: number };
  after: { disturbance: number; health: number; seedBank: number };
}

export interface AnnualReportInput {
  year: number;
  generatedBy: 'settlement' | 'backfill';
  generatedAt: string;
  yearStartSpecies: SpeciesState[];
  finalSpecies: SpeciesState[];
  yearStartSites: SiteState[];
  finalSites: SiteState[];
  sampling: {
    total: number;
    incorrect: number;
    incorrectRecords: SamplingRecord[];
  };
  restoration: RestorationRecord[];
  phenologyObservations: { total: number; stageMatched: number };
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

const STATUS_SEVERITY: Record<string, number> = {
  growing: 0,
  stable: 1,
  vulnerable: 2,
  endangered: 3,
  absent: 4
};

/**
 * Builds the annual review from immutable yearly inputs only. The function is
 * pure and deterministic: settlement and historical backfill feed the same
 * inputs and therefore reach identical, evidence-backed conclusions.
 */
export function buildAnnualReview(input: AnnualReportInput): AnnualReview {
  const yearStartSpecies = sortStates(input.yearStartSpecies);
  const finalSpecies = sortStates(input.finalSpecies);
  const initialByKey = new Map(yearStartSpecies.map((state) => [stateKey(state), state]));
  const finalByKey = new Map(finalSpecies.map((state) => [stateKey(state), state]));
  const keys = [...new Set([...initialByKey.keys(), ...finalByKey.keys()])].sort();

  const findings: ReportFinding[] = [];
  const counters: Record<ReportFindingCategory, number> = {
    distribution: 0,
    phenology: 0,
    restoration: 0,
    sampling: 0
  };
  const addFinding = (
    category: ReportFindingCategory,
    severity: ReportFindingSeverity,
    title: string,
    detail: string,
    evidence: ReportEvidence[]
  ): ReportFinding => {
    counters[category] += 1;
    const finding: ReportFinding = {
      id: `${category}-${counters[category]}`,
      category,
      severity,
      title,
      detail,
      evidence
    };
    findings.push(finding);
    return finding;
  };

  const speciesAggregate = new Map<
    string,
    {
      startPopulation: number;
      finalPopulation: number;
      startHealth: number;
      finalHealth: number;
      count: number;
      status: string;
    }
  >();
  const distributionChanges: string[] = [];
  const distributionFindingIdsBySpecies = new Map<string, string[]>();
  const criticalDistributionIds: string[] = [];

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

    if (initial && final && initial.status !== final.status) {
      const siteName = siteNameOf(state.siteId);
      const speciesName = speciesNameOf(state.speciesId);
      const title = `${siteName}：${speciesName} 由 ${statusLabel(initial.status)} 变为 ${statusLabel(final.status)}`;
      distributionChanges.push(title);
      const worsened = severityOf(final.status) > severityOf(initial.status);
      const severity: ReportFindingSeverity = !worsened
        ? 'notice'
        : final.status === 'endangered' || final.status === 'absent'
          ? 'critical'
          : 'warning';
      const finding = addFinding(
        'distribution',
        severity,
        title,
        worsened
          ? '该区域种群状况在年内恶化，变化已追溯到年初快照与冬季结算数据。'
          : '该区域种群状况在年内改善，变化已追溯到年初快照与冬季结算数据。',
        [
          {
            label: '年初种群 / 健康',
            value: `${formatNumber(initial.population)} 株 / ${formatNumber(initial.health)}`,
            source: `year_start_snapshot:${state.siteId}:${state.speciesId}`
          },
          {
            label: '年末种群 / 健康',
            value: `${formatNumber(final.population)} 株 / ${formatNumber(final.health)}`,
            source: `winter_settlement:${state.siteId}:${state.speciesId}`
          },
          {
            label: '区域环境容纳量',
            value: `${SPECIES_BY_ID.get(state.speciesId)?.zones[state.siteId]?.carryingCapacity ?? '未知'}`,
            source: `catalog:${state.speciesId}:${state.siteId}`
          }
        ]
      );
      const list = distributionFindingIdsBySpecies.get(state.speciesId) ?? [];
      list.push(finding.id);
      distributionFindingIdsBySpecies.set(state.speciesId, list);
      if (severity === 'critical') {
        criticalDistributionIds.push(finding.id);
      }
    }
  }

  if (distributionChanges.length === 0) {
    const totalStart = sumBy(yearStartSpecies, (state) => state.population);
    const totalFinal = sumBy(finalSpecies, (state) => state.population);
    distributionChanges.push('本年度未发生跨等级分布状态变化。');
    addFinding(
      'distribution',
      'info',
      '分布状态总体稳定',
      '各区域种群状态等级在年内未发生跨越，结论基于年初快照与冬季结算的逐区域比对。',
      [
        {
          label: '年初全图种群',
          value: `${formatNumber(totalStart)} 株`,
          source: 'year_start_snapshot'
        },
        {
          label: '年末全图种群',
          value: `${formatNumber(totalFinal)} 株`,
          source: 'winter_settlement'
        }
      ]
    );
  }

  const phenologyFindingIds = buildPhenologyFindings(input, finalSpecies, addFinding);
  const restorationFindingIds = buildRestorationFindings(input, finalByKey, addFinding);
  const samplingFindingIds = buildSamplingFindings(input, addFinding);

  let totalStart = 0;
  let totalFinal = 0;
  const speciesChanges = [...speciesAggregate.entries()].map(([speciesId, aggregate]) => {
    totalStart += aggregate.startPopulation;
    totalFinal += aggregate.finalPopulation;
    return {
      speciesId,
      name: speciesNameOf(speciesId),
      populationChangePercent: percentChange(aggregate.startPopulation, aggregate.finalPopulation),
      healthChange: round(
        aggregate.finalHealth / Math.max(1, aggregate.count) - aggregate.startHealth / Math.max(1, aggregate.count),
        1
      ),
      status: aggregate.status
    };
  });
  speciesChanges.sort(
    (left, right) =>
      left.populationChangePercent - right.populationChangePercent || left.speciesId.localeCompare(right.speciesId)
  );

  const populationChangePercent = percentChange(totalStart, totalFinal);
  const incorrectSamples = input.sampling.incorrect;

  const recommendationItems: AnnualRecommendation[] = [];
  if (incorrectSamples > 0) {
    recommendationItems.push({
      text: '下一年优先使用拍照和条件合适的非破坏性采集，避免在错误物候期重复取样。',
      findingIds: [...samplingFindingIds]
    });
  }
  const declining = speciesChanges.filter((item) => item.populationChangePercent < -2);
  if (declining.length > 0) {
    recommendationItems.push({
      text: `重点关注 ${declining
        .slice(0, 3)
        .map((item) => item.name)
        .join('、')}，并在衰退区域设置观察样方。`,
      findingIds: declining.flatMap((item) => distributionFindingIdsBySpecies.get(item.speciesId) ?? [])
    });
  }
  if (criticalDistributionIds.length > 0) {
    recommendationItems.push({
      text: '对濒危区域停止剪取，优先执行降低干扰和保留种子区。',
      findingIds: [...criticalDistributionIds]
    });
  }
  if (recommendationItems.length < 2) {
    recommendationItems.push({
      text: '保持固定样方和连续物候记录，以提高下一年度花期预报置信度。',
      findingIds: [...phenologyFindingIds]
    });
  }

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
    distributionChanges,
    incorrectSamples,
    recommendations: recommendationItems.map((item) => item.text),
    restorationUnlocked:
      populationChangePercent < -2 ||
      incorrectSamples > 0 ||
      speciesChanges.some((change) => change.status === 'vulnerable' || change.status === 'endangered'),
    findings,
    recommendationItems,
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy
  };
}

function buildPhenologyFindings(
  input: AnnualReportInput,
  finalSpecies: SpeciesState[],
  addFinding: (
    category: ReportFindingCategory,
    severity: ReportFindingSeverity,
    title: string,
    detail: string,
    evidence: ReportEvidence[]
  ) => ReportFinding
): string[] {
  const ids: string[] = [];

  const shiftBySpecies = new Map<string, SpeciesState[]>();
  for (const state of finalSpecies) {
    if ((state.phenology.shift ?? 0) === 0) {
      continue;
    }
    const list = shiftBySpecies.get(state.speciesId) ?? [];
    list.push(state);
    shiftBySpecies.set(state.speciesId, list);
  }
  for (const [speciesId, states] of [...shiftBySpecies.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const definition = SPECIES_BY_ID.get(speciesId);
    if (!definition) {
      continue;
    }
    const season = primaryBloomSeason(definition.phenology);
    const maxShift = Math.max(...states.map((state) => Math.abs(state.phenology.shift ?? 0)));
    const evidence: ReportEvidence[] = states.map((state) => {
      const window = season ? getPhenologyWindow(definition, state, season) : null;
      const base = season ? definition.phenology[season] : null;
      return {
        label: `${siteNameOf(state.siteId)} 花期窗口`,
        value:
          window && base
            ? `第 ${base.start}–${base.end} 日 → 第 ${window.start}–${window.end} 日（偏移 ${formatShift(state.phenology.shift)}）`
            : `偏移 ${formatShift(state.phenology.shift)}`,
        source: `species_states:${input.year}:${state.siteId}:${speciesId}`
      };
    });
    const finding = addFinding(
      'phenology',
      maxShift >= 2 ? 'warning' : 'notice',
      `${speciesNameOf(speciesId)} 花期已偏移 ${maxShift} 旬`,
      '上一年越冬结算留下的物候偏移已作用于本年度花期窗口，偏移量与生效窗口可逐区域核对。',
      evidence
    );
    ids.push(finding.id);
  }
  if (shiftBySpecies.size === 0) {
    const finding = addFinding(
      'phenology',
      'info',
      '本年度物候未发生累积偏移',
      '各物种花期窗口与目录基线一致，未发现由越冬温度累积产生的偏移。',
      [
        {
          label: '受检物种状态数',
          value: `${finalSpecies.length} 条`,
          source: `species_states:${input.year}`
        }
      ]
    );
    ids.push(finding.id);
  }

  const projections = input.finalSites
    .map((site) => ({ site, shift: projectedShift(site.temperatureC) }))
    .filter((entry) => entry.shift !== 0)
    .sort((a, b) => a.site.siteId.localeCompare(b.site.siteId));
  if (projections.length > 0) {
    const finding = addFinding(
      'phenology',
      'notice',
      `冬季温度将推动 ${projections.length} 个区域的下一年物候偏移`,
      '依据越冬偏移规则（冬季均温高于 5°C 花期提前、低于 2°C 花期推迟），下一年花期预计如下调整。',
      projections.map((entry) => ({
        label: `${siteNameOf(entry.site.siteId)} 冬季均温`,
        value: `${formatNumber(entry.site.temperatureC)}°C → 预计 ${entry.shift < 0 ? '提前' : '推迟'} 1 旬`,
        source: `site_states:${input.year}:${entry.site.siteId}`
      }))
    );
    ids.push(finding.id);
  }

  const { total, stageMatched } = input.phenologyObservations;
  const matchedRate = total > 0 ? stageMatched / total : 0;
  const finding = addFinding(
    'phenology',
    total === 0 || matchedRate >= 0.6 ? 'info' : 'notice',
    total === 0 ? '本年度没有物候观察记录' : `物候观察阶段匹配率 ${Math.round(matchedRate * 100)}%`,
    total === 0
      ? '缺少观察记录，物候结论仅依赖模拟状态，置信度有限。'
      : '物候结论的置信度来自玩家观察记录与模拟物候阶段的逐条比对。',
    [
      {
        label: '物候观察次数',
        value: `${total} 次（匹配 ${stageMatched} 次）`,
        source: `observations:${input.year}:plant`
      }
    ]
  );
  ids.push(finding.id);
  return ids;
}

function buildRestorationFindings(
  input: AnnualReportInput,
  finalByKey: Map<string, SpeciesState>,
  addFinding: (
    category: ReportFindingCategory,
    severity: ReportFindingSeverity,
    title: string,
    detail: string,
    evidence: ReportEvidence[]
  ) => ReportFinding
): string[] {
  const ids: string[] = [];
  const actions = [...input.restoration].sort((a, b) => a.id.localeCompare(b.id));
  for (const action of actions) {
    const target = finalByKey.get(`${action.siteId}:${action.speciesId}`);
    const evidence: ReportEvidence[] = [
      {
        label: '区域干扰',
        value: `${formatNumber(action.before.disturbance, 2)} → ${formatNumber(action.after.disturbance, 2)}`,
        source: `restoration_actions:${action.id}`
      },
      {
        label: '目标健康',
        value: `${formatNumber(action.before.health)} → ${formatNumber(action.after.health)}`,
        source: `restoration_actions:${action.id}`
      },
      {
        label: '目标种子库',
        value: `${formatNumber(action.before.seedBank)} → ${formatNumber(action.after.seedBank)}`,
        source: `restoration_actions:${action.id}`
      }
    ];
    if (target) {
      evidence.push({
        label: '目标年末状态',
        value: `${statusLabel(target.status)}（健康 ${formatNumber(target.health)}）`,
        source: `winter_settlement:${action.siteId}:${action.speciesId}`
      });
    }
    const finding = addFinding(
      'restoration',
      'notice',
      `${RESTORATION_LABELS[action.action] ?? action.action}：${speciesNameOf(action.speciesId)}（${siteNameOf(action.siteId)}）`,
      `${SEASON_LABELS[action.season]}季第 ${action.day} 日执行的修复行动已记录前后指标，年末状态可回溯比对。`,
      evidence
    );
    ids.push(finding.id);
  }
  if (actions.length === 0) {
    const finding = addFinding(
      'restoration',
      'info',
      '本年度未执行生态修复行动',
      '没有修复行动记录，修复成效结论为空；如下一年解锁修复，行动的前后指标会写入本报告。',
      [
        {
          label: '修复行动记录数',
          value: '0 条',
          source: `restoration_actions:${input.year}`
        }
      ]
    );
    ids.push(finding.id);
  }
  return ids;
}

function buildSamplingFindings(
  input: AnnualReportInput,
  addFinding: (
    category: ReportFindingCategory,
    severity: ReportFindingSeverity,
    title: string,
    detail: string,
    evidence: ReportEvidence[]
  ) => ReportFinding
): string[] {
  const ids: string[] = [];
  const groups = new Map<string, SamplingRecord[]>();
  for (const record of [...input.sampling.incorrectRecords].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = `${record.speciesId}:${record.method}`;
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  for (const [key, records] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [speciesId, method] = key.split(':') as [string, SampleMethod];
    const totals = records.reduce(
      (sum, record) => ({
        health: sum.health + record.effects.health,
        populationDelta: sum.populationDelta + record.effects.populationDelta,
        seedBankDelta: sum.seedBankDelta + record.effects.seedBankDelta
      }),
      { health: 0, populationDelta: 0, seedBankDelta: 0 }
    );
    const finding = addFinding(
      'sampling',
      'warning',
      `${speciesNameOf(speciesId)}：${SAMPLE_LABELS[method]} ${records.length} 次不符合采集协议`,
      '错误采集造成的累计影响来自每次采集记录的实测效果，可逐条回溯到采集日志。',
      [
        {
          label: '发生时间',
          value: records.map((record) => `${SEASON_LABELS[record.season]}季第${record.day}日`).join('、'),
          source: `samples:${records.map((record) => record.id).join(',')}`
        },
        {
          label: '累计健康影响',
          value: formatSigned(totals.health),
          source: `samples:${records.map((record) => record.id).join(',')}`
        },
        {
          label: '累计种群影响',
          value: `${formatSigned(totals.populationDelta)} 株`,
          source: `samples:${records.map((record) => record.id).join(',')}`
        },
        {
          label: '累计种子库影响',
          value: formatSigned(totals.seedBankDelta),
          source: `samples:${records.map((record) => record.id).join(',')}`
        }
      ]
    );
    ids.push(finding.id);
  }
  if (groups.size === 0) {
    const finding = addFinding(
      'sampling',
      'info',
      input.sampling.total > 0 ? `本年度 ${input.sampling.total} 次采集全部符合协议` : '本年度未进行采集',
      '采集误差结论来自采集记录的协议匹配标记，未发现不符合协议的记录。',
      [
        {
          label: '采集记录数',
          value: `${input.sampling.total} 条`,
          source: `samples:${input.year}`
        }
      ]
    );
    ids.push(finding.id);
  }
  return ids;
}

function projectedShift(temperatureC: number): number {
  return temperatureC > 5 ? -1 : temperatureC < 2 ? 1 : 0;
}

function primaryBloomSeason(phenology: Partial<Record<Season, { start: number; peak: number; end: number }>>): Season | null {
  for (const season of SEASONS) {
    const window = phenology[season];
    if (window && window.start > 0) {
      return season;
    }
  }
  return null;
}

function stateKey(state: SpeciesState): string {
  return `${state.siteId}:${state.speciesId}`;
}

function sortStates(states: SpeciesState[]): SpeciesState[] {
  return [...states].sort((a, b) => stateKey(a).localeCompare(stateKey(b)));
}

function sumBy(states: SpeciesState[], pick: (state: SpeciesState) => number): number {
  return states.reduce((sum, state) => sum + pick(state), 0);
}

function severityOf(status: string): number {
  return STATUS_SEVERITY[status] ?? 1;
}

function worstStatus(left: string, right: string): string {
  return severityOf(right) > severityOf(left) ? right : left;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    growing: '增长',
    stable: '稳定',
    vulnerable: '脆弱',
    endangered: '濒危',
    absent: '局部消失'
  };
  return labels[status] ?? status;
}

function siteNameOf(siteId: SiteId): string {
  return SITES_BY_ID.get(siteId)?.name ?? siteId;
}

function speciesNameOf(speciesId: string): string {
  return SPECIES_BY_ID.get(speciesId)?.name ?? speciesId;
}

function percentChange(start: number, end: number): number {
  if (start <= 0) {
    return end > 0 ? 100 : 0;
  }
  return round(((end - start) / start) * 100, 1);
}

function formatNumber(value: number, digits = 1): string {
  return String(round(value, digits));
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${round(value, 2)}`;
}

function formatShift(shift: number): string {
  return `${shift > 0 ? '+' : ''}${shift} 旬`;
}
