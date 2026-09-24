import { describe, expect, it } from 'vitest';
import { buildAnnualReview, type AnnualReportInput } from './report.ts';
import { buildInitialYearStates, deriveNextYearStates } from './year-cycle.ts';

function makeInput(): AnnualReportInput {
  const initial = buildInitialYearStates('save-report', 'seed-report');
  const finalSpecies = initial.species.map((state) => ({ ...state }));

  const collapsed = finalSpecies.find((state) => state.speciesId === 'prunus-davidiana' && state.siteId === 'foothill')!;
  collapsed.population = 3;
  collapsed.health = 12;
  collapsed.status = 'endangered';

  for (const state of finalSpecies.filter((item) => item.speciesId === 'ginkgo-biloba')) {
    state.phenology = { ...state.phenology, shift: -1 };
  }

  const finalSites = initial.sites.map((site) =>
    site.siteId === 'foothill' ? { ...site, temperatureC: 6.4 } : { ...site }
  );

  return {
    year: 1,
    generatedBy: 'settlement',
    generatedAt: '2026-01-01T00:00:00.000Z',
    yearStartSpecies: initial.species,
    finalSpecies,
    yearStartSites: initial.sites,
    finalSites,
    sampling: {
      total: 3,
      incorrect: 2,
      incorrectRecords: [
        {
          id: 'sample-b',
          siteId: 'foothill',
          speciesId: 'prunus-davidiana',
          method: 'litter',
          season: 'summer',
          day: 2,
          effects: { health: -4, populationDelta: -1.5, seedBankDelta: -5 }
        },
        {
          id: 'sample-a',
          siteId: 'foothill',
          speciesId: 'prunus-davidiana',
          method: 'litter',
          season: 'spring',
          day: 3,
          effects: { health: -4, populationDelta: -2, seedBankDelta: -5 }
        }
      ]
    },
    restoration: [
      {
        id: 'restore-1',
        siteId: 'foothill',
        speciesId: 'prunus-davidiana',
        action: 'reduce_disturbance',
        season: 'autumn',
        day: 4,
        before: { disturbance: 0.2, health: 60, seedBank: 40 },
        after: { disturbance: 0.13, health: 63, seedBank: 40 }
      }
    ],
    phenologyObservations: { total: 5, stageMatched: 4 }
  };
}

describe('buildAnnualReview', () => {
  it('produces traceable findings for distribution, phenology, restoration and sampling', () => {
    const report = buildAnnualReview(makeInput());
    const categories = new Set(report.findings.map((finding) => finding.category));
    expect(categories).toEqual(new Set(['distribution', 'phenology', 'restoration', 'sampling']));
    expect(report.findings.every((finding) => finding.evidence.length > 0)).toBe(true);

    const distribution = report.findings.find((finding) => finding.category === 'distribution' && finding.severity === 'critical');
    expect(distribution?.title).toContain('濒危');
    expect(distribution?.evidence.map((item) => item.source)).toContain('year_start_snapshot:foothill:prunus-davidiana');
    expect(distribution?.evidence.map((item) => item.source)).toContain('winter_settlement:foothill:prunus-davidiana');

    const sampling = report.findings.find((finding) => finding.category === 'sampling');
    expect(sampling?.severity).toBe('warning');
    expect(sampling?.title).toBe('山桃：落叶采集 2 次不符合采集协议');
    const healthEvidence = sampling?.evidence.find((item) => item.label === '累计健康影响');
    expect(healthEvidence?.value).toBe('-8');
    expect(healthEvidence?.source).toBe('samples:sample-a,sample-b');

    const restoration = report.findings.find((finding) => finding.category === 'restoration');
    expect(restoration?.title).toContain('降低区域干扰');
    expect(restoration?.evidence.find((item) => item.label === '区域干扰')?.value).toBe('0.2 → 0.13');
    expect(restoration?.evidence.some((item) => item.source.startsWith('restoration_actions:restore-1'))).toBe(true);

    const shift = report.findings.find((finding) => finding.category === 'phenology' && finding.title.includes('银杏'));
    expect(shift?.title).toContain('偏移 1 旬');
    const projection = report.findings.find((finding) => finding.title.includes('下一年物候偏移'));
    expect(projection?.detail).toContain('提前');

    expect(report.incorrectSamples).toBe(2);
    expect(report.restorationUnlocked).toBe(true);
  });

  it('links every recommendation to existing finding ids', () => {
    const report = buildAnnualReview(makeInput());
    const findingIds = new Set(report.findings.map((finding) => finding.id));
    expect(report.recommendationItems.length).toBeGreaterThan(0);
    for (const item of report.recommendationItems) {
      expect(item.findingIds.length).toBeGreaterThan(0);
      for (const id of item.findingIds) {
        expect(findingIds.has(id)).toBe(true);
      }
    }
    expect(report.recommendations).toEqual(report.recommendationItems.map((item) => item.text));
  });

  it('is deterministic regardless of input ordering', () => {
    const input = makeInput();
    const first = buildAnnualReview(input);
    const shuffled = buildAnnualReview({
      ...input,
      yearStartSpecies: [...input.yearStartSpecies].reverse(),
      finalSpecies: [...input.finalSpecies].reverse(),
      finalSites: [...input.finalSites].reverse(),
      sampling: { ...input.sampling, incorrectRecords: [...input.sampling.incorrectRecords].reverse() }
    });
    expect(shuffled).toEqual(first);
  });
});

describe('year-cycle derivation', () => {
  it('rebuilds the initial year deterministically', () => {
    const first = buildInitialYearStates('save-cycle', 'seed-cycle');
    const second = buildInitialYearStates('save-cycle', 'seed-cycle');
    expect(second).toEqual(first);
    expect(first.species.length).toBeGreaterThan(0);
    expect(first.sites.length).toBe(4);
  });

  it('derives the next year purely from persisted year-end states', () => {
    const initial = buildInitialYearStates('save-cycle', 'seed-cycle');
    const derived = deriveNextYearStates({
      saveId: 'save-cycle',
      seed: 'seed-cycle',
      nextYear: 2,
      currentSpecies: initial.species,
      currentSites: initial.sites
    });
    const repeated = deriveNextYearStates({
      saveId: 'save-cycle',
      seed: 'seed-cycle',
      nextYear: 2,
      currentSpecies: initial.species,
      currentSites: initial.sites
    });
    expect(repeated).toEqual(derived);
    expect(derived.species.every((state) => state.year === 2)).toBe(true);
    expect(derived.species.length).toBe(initial.species.length);
  });
});
