import { describe, expect, it } from 'vitest';
import { createSpeciesState, generateSiteState } from '@shanhai/game-core';
import {
  buildAnnualReport,
  type BuildReportInput,
  type SampleEvidenceRow
} from './annual-report.ts';

function baseInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  const winterFoothill = generateSiteState('save', 'seed-unit', 1, 'winter', 10, 'foothill');
  const baseline = createSpeciesState('save', 'seed-unit', 1, 'spring', 'foothill', 'prunus-davidiana');
  const final = {
    ...createSpeciesState('save', 'seed-unit', 1, 'winter', 'foothill', 'prunus-davidiana'),
    population: baseline.population * 0.8,
    health: baseline.health - 8
  };
  return {
    year: 1,
    provenance: 'live',
    generatedAt: '2026-01-01T00:00:00.000Z',
    baselineSpecies: [baseline],
    finalSpecies: [final],
    dispersalEvents: [],
    samples: [],
    observations: [
      {
        id: 'obs-1',
        year: 1,
        season: 'spring',
        day: 4,
        siteId: 'foothill',
        speciesId: 'prunus-davidiana',
        kind: 'plant',
        score: 90
      }
    ],
    restorations: [],
    winterSites: [winterFoothill],
    restorationUnlocked: false,
    ...overrides
  };
}

describe('buildAnnualReport', () => {
  it('ties every sampling error to sample and site evidence', () => {
    const samples: SampleEvidenceRow[] = [
      {
        id: 'sample-1',
        year: 1,
        season: 'spring',
        day: 3,
        siteId: 'foothill',
        speciesId: 'prunus-davidiana',
        method: 'litter',
        protocolMatch: false,
        effects: { health: -4, populationDelta: -1.8, seedBankDelta: -22.4 },
        disturbanceDelta: 0.0035
      },
      {
        id: 'sample-2',
        year: 1,
        season: 'spring',
        day: 4,
        siteId: 'foothill',
        speciesId: 'prunus-davidiana',
        method: 'photo',
        protocolMatch: true,
        effects: { health: 0, populationDelta: 0, seedBankDelta: 0 },
        disturbanceDelta: 0
      }
    ];
    const report = buildAnnualReport(baseInput({ samples }));
    expect(report.incorrectSamples).toBe(1);
    expect(report.samplingErrors).toHaveLength(1);
    const error = report.samplingErrors[0]!;
    expect(error.sampleId).toBe('sample-1');
    expect(error.populationDelta).toBe(-1.8);
    expect(error.disturbanceDelta).toBe(0.0035);
    expect(error.claim.evidence.map((item) => item.kind)).toEqual(['sample', 'environment']);
    expect(report.dataQuality.sampleCount).toBe(2);
    expect(report.dataQuality.incorrectSampleCount).toBe(1);
  });

  it('builds dispersal conclusions from the ledger and baseline snapshots', () => {
    const input = baseInput({
      dispersalEvents: [
        {
          id: 'dispersal-1',
          year: 1,
          speciesId: 'prunus-davidiana',
          fromSiteId: 'foothill',
          toSiteId: 'mixed_forest',
          migrants: 4.2,
          sourcePopulationAfter: 175.8,
          targetPopulationAfter: 46.2
        }
      ]
    });
    const report = buildAnnualReport(input);
    const dispersal = report.distributionMigrations.find((item) => item.driver === 'dispersal');
    expect(dispersal).toBeTruthy();
    expect(dispersal?.fromSiteId).toBe('foothill');
    expect(dispersal?.toSiteId).toBe('mixed_forest');
    expect(dispersal?.migrants).toBe(4.2);
    expect(dispersal?.claim.confidence).toBe('high');
    expect(dispersal?.claim.evidence.some((item) => item.refId === 'dispersal-1')).toBe(true);
  });

  it('downgrades phenology confidence when there are no observations', () => {
    const report = buildAnnualReport(baseInput({ observations: [] }));
    for (const shift of report.phenologyShifts) {
      expect(shift.observationCount).toBe(0);
      expect(shift.claim.confidence).toBe('low');
      expect(shift.claim.evidence.some((item) => item.kind === 'environment')).toBe(true);
    }
    expect(report.dataQuality.caveats.join('')).toContain('物候');
  });

  it('attributes restoration outcomes only to recorded actions', () => {
    const report = buildAnnualReport(
      baseInput({
        restorations: [
          {
            id: 'restoration-1',
            year: 1,
            season: 'summer',
            day: 5,
            siteId: 'foothill',
            speciesId: 'prunus-davidiana',
            action: 'reduce_disturbance',
            disturbanceBefore: 0.12,
            disturbanceAfter: 0.05,
            healthBefore: 80,
            healthAfter: 83,
            seedBankBefore: 40,
            seedBankAfter: 40
          }
        ]
      })
    );
    expect(report.restorationOutcomes).toHaveLength(1);
    const outcome = report.restorationOutcomes[0]!;
    expect(outcome.action).toBe('reduce_disturbance');
    expect(outcome.disturbanceBefore).toBe(0.12);
    expect(outcome.disturbanceAfter).toBe(0.05);
    expect(outcome.healthAfter).toBe(83);
    expect(outcome.claim.evidence[0]?.kind).toBe('restoration');
    expect(report.dataQuality.restorationCount).toBe(1);
  });

  it('marks backfilled provenance and explains the isolation guarantee', () => {
    const report = buildAnnualReport(baseInput({ provenance: 'backfilled' }));
    expect(report.provenance).toBe('backfilled');
    expect(report.dataQuality.caveats.join('')).toContain('补算');
  });
});
