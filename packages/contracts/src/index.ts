import { z } from 'zod';

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export const SITE_IDS = ['foothill', 'mixed_forest', 'stream_valley', 'ridge'] as const;
export type SiteId = (typeof SITE_IDS)[number];

export const PHASES = ['active', 'season_review', 'year_review'] as const;
export type GamePhase = (typeof PHASES)[number];

export const PHENOLOGY_STAGES = [
  'leafing',
  'budding',
  'early_bloom',
  'full_bloom',
  'late_bloom',
  'fruiting',
  'leaf_color',
  'leaf_fall',
  'dormant'
] as const;
export type PhenologyStage = (typeof PHENOLOGY_STAGES)[number];

export const LEAF_TEXTURES = ['smooth', 'leathery', 'rough', 'pubescent', 'waxy', 'needle', 'compound'] as const;
export type LeafTexture = (typeof LEAF_TEXTURES)[number];

export const SAMPLE_METHODS = ['photo', 'rubbing', 'litter', 'cutting'] as const;
export type SampleMethod = (typeof SAMPLE_METHODS)[number];

const ObservationValuesSchema = z.object({
  phenology: z.enum(PHENOLOGY_STAGES),
  leafTexture: z.enum(LEAF_TEXTURES),
  dominantColor: z.string().trim().min(1).max(30),
  temperatureC: z.number().min(-30).max(50),
  humidity: z.number().min(0).max(100),
  soilMoisture: z.number().min(0).max(100),
  lightLux: z.number().min(0).max(200000),
  note: z.string().trim().max(500).default('')
});

const EnvironmentValuesSchema = z.object({
  temperatureC: z.number().min(-30).max(50),
  humidity: z.number().min(0).max(100),
  soilMoisture: z.number().min(0).max(100),
  lightLux: z.number().min(0).max(200000),
  note: z.string().trim().max(500).default('')
});

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('MOVE_ZONE'), siteId: z.enum(SITE_IDS) }),
  z.object({ type: z.literal('WAIT') }),
  z.object({ type: z.literal('OBSERVE_PLANT'), speciesId: z.string().min(1), values: ObservationValuesSchema }),
  z.object({ type: z.literal('RECORD_ENVIRONMENT'), values: EnvironmentValuesSchema }),
  z.object({ type: z.literal('TAKE_SAMPLE'), speciesId: z.string().min(1), method: z.enum(SAMPLE_METHODS) }),
  z.object({
    type: z.literal('RESTORE_HABITAT'),
    speciesId: z.string().min(1),
    action: z.enum(['reduce_disturbance', 'protect_seed_bank', 'restore_wetland', 'establish_plot'])
  }),
  z.object({ type: z.literal('END_SEASON') }),
  z.object({ type: z.literal('BEGIN_NEXT_SEASON') }),
  z.object({ type: z.literal('BEGIN_NEXT_YEAR') })
]);

export type GameCommand = z.infer<typeof CommandSchema>;

export const CommandRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(8).max(120),
  command: CommandSchema
});
export type CommandRequest = z.infer<typeof CommandRequestSchema>;

export const ImportSaveSchema = z.object({
  token: z.string().trim().min(20)
});

export const PublicSiteSchema = z.object({
  id: z.enum(SITE_IDS),
  name: z.string(),
  habitat: z.string(),
  description: z.string(),
  mapX: z.number(),
  mapY: z.number()
});

export const PublicSpeciesSchema = z.object({
  id: z.string(),
  name: z.string(),
  latinName: z.string(),
  lifeForm: z.string(),
  description: z.string(),
  protected: z.boolean()
});

export interface CatalogMeta {
  version: string;
  sites: Array<z.infer<typeof PublicSiteSchema>>;
  species: Array<z.infer<typeof PublicSpeciesSchema>>;
}

export interface SiteSnapshot {
  id: SiteId;
  name: string;
  habitat: string;
  description: string;
  mapX: number;
  mapY: number;
  current: boolean;
  environment: {
    weather: string;
    temperatureC: number;
    humidity: number;
    soilMoisture: number;
    lightLux: number;
    windSpeed: number;
    disturbance: number;
  };
  species: SpeciesSnapshot[];
}

export interface SpeciesSnapshot {
  id: string;
  name: string;
  latinName: string;
  lifeForm: string;
  protected: boolean;
  population: number;
  carryingCapacity: number;
  health: number;
  seedBank: number;
  suitability: number;
  status: 'growing' | 'stable' | 'vulnerable' | 'endangered' | 'absent';
  phenology: {
    stage: PhenologyStage;
    label: string;
    dominantColor: string;
    leafTexture: LeafTexture;
    bloomStartDay: number;
    bloomPeakDay: number;
    bloomEndDay: number;
  };
  sampleLimits: Record<SampleMethod, { used: number; limit: number; allowed: boolean; reason?: string }>;
  unlocked: boolean;
}

export interface RecentEvent {
  id: string;
  sequence: number;
  type: string;
  message: string;
  effects: string[];
  createdAt: string;
}

export interface SeasonReview {
  year: number;
  season: Season;
  observationCount: number;
  averageObservationScore: number;
  sampleCount: number;
  incorrectSamples: number;
  changes: string[];
}

/** 可追溯证据引用：每条结论都必须能回溯到具体的存档记录。 */
export interface ReviewEvidence {
  kind: 'sample' | 'observation' | 'restoration' | 'species_state' | 'environment';
  refId: string;
  year: number;
  season?: Season;
  day?: number;
  siteId?: SiteId;
  speciesId?: string;
  detail: string;
}

/** 带证据链的结论文案，evidence 为空时不允许展示为确定性结论。 */
export interface TraceableClaim {
  id: string;
  conclusion: string;
  evidence: ReviewEvidence[];
  confidence: 'high' | 'medium' | 'low';
}

/** 分布迁移：实际扩散事件必须给出迁出地、迁入地与迁移个体数。 */
export interface DistributionMigration {
  speciesId: string;
  speciesName: string;
  fromSiteId: SiteId;
  fromSiteName: string;
  toSiteId: SiteId;
  toSiteName: string;
  migrants: number;
  startPopulation: number;
  endPopulation: number;
  statusBefore: string;
  statusAfter: string;
  driver: 'dispersal' | 'local_change' | 'local_extinction' | 'colonization';
  claim: TraceableClaim;
}

/** 物候偏移：以年初基线与年末状态的 shift 差值为准，绑定该物种的观察证据。 */
export interface PhenologyShift {
  speciesId: string;
  speciesName: string;
  siteId: SiteId;
  siteName: string;
  season: Season;
  baselineStartDay: number;
  baselinePeakDay: number;
  baselineEndDay: number;
  observedStartDay: number;
  observedPeakDay: number;
  observedEndDay: number;
  shiftDays: number;
  observationCount: number;
  claim: TraceableClaim;
}

/** 修复成效：按修复动作归因，给出动作次数与可观测的状态变化。 */
export interface RestorationOutcome {
  action: string;
  actionLabel: string;
  siteId: SiteId;
  siteName: string;
  speciesId: string | null;
  speciesName: string | null;
  count: number;
  disturbanceBefore: number;
  disturbanceAfter: number;
  healthBefore: number | null;
  healthAfter: number | null;
  seedBankBefore: number | null;
  seedBankAfter: number | null;
  claim: TraceableClaim;
}

/** 采集误差：错误采集必须逐条对应样本记录及其生态影响。 */
export interface SamplingError {
  sampleId: string;
  speciesId: string;
  speciesName: string;
  siteId: SiteId;
  siteName: string;
  season: Season;
  day: number;
  method: SampleMethod;
  methodLabel: string;
  healthDelta: number;
  populationDelta: number;
  seedBankDelta: number;
  disturbanceDelta: number;
  claim: TraceableClaim;
}

export interface AnnualReview {
  year: number;
  headline: string;
  populationChangePercent: number;
  speciesChanges: Array<{
    speciesId: string;
    name: string;
    populationChangePercent: number;
    healthChange: number;
    status: string;
  }>;
  distributionChanges: string[];
  incorrectSamples: number;
  recommendations: string[];
  restorationUnlocked: boolean;
  /** 分布迁移（实际扩散 + 等级变化），每条结论带证据链。 */
  distributionMigrations: DistributionMigration[];
  /** 物候偏移，按物种 × 区域汇总，缺观察证据时降级为低置信度。 */
  phenologyShifts: PhenologyShift[];
  /** 本年度已执行修复动作的成效归因；未解锁时为空数组。 */
  restorationOutcomes: RestorationOutcome[];
  /** 采集误差台账，逐条可追溯到 samples 表。 */
  samplingErrors: SamplingError[];
  /** 数据完备性与采集偏差说明，避免把观察偏差当成生态结论。 */
  dataQuality: {
    observationCount: number;
    sampleCount: number;
    incorrectSampleCount: number;
    restorationCount: number;
    siteCoverage: Array<{ siteId: SiteId; siteName: string; observations: number; samples: number }>;
    caveats: string[];
  };
  /** live=年度结算生成；backfilled=仅依据历史证据补算，不影响任何后续状态。 */
  provenance: 'live' | 'backfilled';
  generatedAt: string;
}

export interface BackfillAnnualReportResult {
  year: number;
  provenance: 'backfilled';
  report: AnnualReview;
}


export interface WorldSnapshot {
  saveId: string;
  revision: number;
  year: number;
  season: Season;
  seasonLabel: string;
  day: number;
  slot: number;
  actionPoints: number;
  phase: GamePhase;
  currentSiteId: SiteId;
  restorationUnlocked: boolean;
  sites: SiteSnapshot[];
  recentEvents: RecentEvent[];
  seasonReview: SeasonReview | null;
  annualReview: AnnualReview | null;
}

export interface JournalEntry {
  id: string;
  kind: 'plant' | 'environment' | 'sample';
  year: number;
  season: Season;
  day: number;
  slot: number;
  siteId: SiteId;
  siteName: string;
  speciesId: string | null;
  speciesName: string | null;
  score: number | null;
  note: string;
  createdAt: string;
  details: Record<string, unknown>;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
  traceId: string;
  retryable: boolean;
}

export const SEASON_LABELS: Record<Season, string> = {
  spring: '春',
  summer: '夏',
  autumn: '秋',
  winter: '冬'
};

export const SLOT_LABELS = ['晨', '午', '暮'];
