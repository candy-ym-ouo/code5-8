import { SPECIES_BY_ID, SITES } from './catalog.ts';
import {
  applyOverwinter,
  createSpeciesState,
  disperseSpecies,
  generateSiteState,
  getStatus,
  getSuitability,
  round
} from './simulation.ts';
import type { SiteState, SpeciesState } from './types.ts';

export interface YearStates {
  species: SpeciesState[];
  sites: SiteState[];
}

/**
 * Deterministically rebuilds the first-year opening snapshot.
 * This is the same derivation used when a save is created, so historical
 * reports can be reconstructed without touching live state.
 */
export function buildInitialYearStates(saveId: string, seed: string): YearStates {
  const species: SpeciesState[] = [];
  const sites: SiteState[] = [];
  for (const site of SITES) {
    const siteState = generateSiteState(saveId, seed, 1, 'spring', 1, site.id);
    sites.push(siteState);
    for (const definition of SPECIES_BY_ID.values()) {
      if (!definition.zones[site.id]) {
        continue;
      }
      const state = createSpeciesState(saveId, seed, 1, 'spring', site.id, definition.id);
      state.suitability = round(getSuitability(definition, siteState), 3);
      state.status = getStatus(state.population, definition.zones[site.id]!.carryingCapacity, state.health);
      species.push(state);
    }
  }
  return { species, sites };
}

/**
 * Deterministically derives the opening snapshot of `nextYear` from the
 * persisted year-end states of the previous year (overwintering, suitability
 * refresh and dispersal). Pure: callers decide what to persist.
 */
export function deriveNextYearStates(input: {
  saveId: string;
  seed: string;
  nextYear: number;
  currentSpecies: SpeciesState[];
  currentSites: SiteState[];
}): YearStates {
  const { saveId, seed, nextYear, currentSpecies, currentSites } = input;
  const siteMap = new Map(currentSites.map((site) => [site.siteId, site]));
  const nextSites: SiteState[] = [];
  for (const site of SITES) {
    const previous = siteMap.get(site.id);
    nextSites.push(
      generateSiteState(
        saveId,
        seed,
        nextYear,
        'spring',
        1,
        site.id,
        Math.max(0.02, (previous?.disturbance ?? 0.08) * 0.92)
      )
    );
  }
  const nextSiteMap = new Map(nextSites.map((site) => [site.siteId, site]));

  const nextSpecies: SpeciesState[] = [];
  for (const state of currentSpecies) {
    const site = siteMap.get(state.siteId);
    const nextSite = nextSiteMap.get(state.siteId);
    const definition = SPECIES_BY_ID.get(state.speciesId);
    if (!site || !nextSite || !definition) {
      continue;
    }
    const overwintered = applyOverwinter(state, site);
    const nextState: SpeciesState = {
      ...overwintered,
      year: nextYear,
      suitability: round(getSuitability(definition, nextSite), 3)
    };
    nextState.status = getStatus(
      nextState.population,
      definition.zones[state.siteId]!.carryingCapacity,
      nextState.health
    );
    nextSpecies.push(nextState);
  }

  return { species: disperseSpecies(nextSpecies, nextSites), sites: nextSites };
}
