import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { GameCommand, Season, WorldSnapshot } from '@shanhai/contracts';
import { createApp } from '../src/app.ts';

describe('closed-loop API', () => {
  let app: ReturnType<typeof createApp>['app'];
  let store: ReturnType<typeof createApp>['store'];
  let agent: ReturnType<typeof request.agent>;

  beforeAll(() => {
    const created = createApp({ databasePath: ':memory:', loggerEnabled: false });
    app = created.app;
    store = created.store;
    agent = request.agent(app);
  });

  afterAll(() => store.close());

  it('accepts configured browser origins and rejects unknown origins', async () => {
    await request(app)
      .post('/api/save')
      .set('Origin', 'http://127.0.0.1:5173')
      .expect(201);
    await request(app)
      .post('/api/save')
      .set('Origin', 'https://attacker.example')
      .expect(403);
  });

  it('returns a client error for malformed JSON', async () => {
    await request(app)
      .post('/api/save/import')
      .set('Content-Type', 'application/json')
      .send('{"token":')
      .expect(400)
      .expect((response) => {
        expect(response.body.code).toBe('INVALID_JSON');
      });
  });

  it('creates, observes, samples, evolves and continues into the next year', async () => {
    const createResponse = await agent.post('/api/save').expect(201);
    let world = createResponse.body as WorldSnapshot;
    expect(world.year).toBe(1);
    expect(world.season).toBe('spring');
    expect(world.sites.length).toBe(4);
    const baseline = store.db
      .prepare('SELECT year_start_species_json FROM saves WHERE id = ?')
      .get(world.saveId) as unknown as { year_start_species_json: string };
    expect(JSON.parse(baseline.year_start_species_json).length).toBeGreaterThan(0);

    world = await command(agent, world, {
      type: 'OBSERVE_PLANT',
      speciesId: 'prunus-davidiana',
      values: {
        phenology: 'leafing',
        leafTexture: 'smooth',
        dominantColor: '#557a45',
        temperatureC: 16,
        humidity: 60,
        soilMoisture: 50,
        lightLux: 30000,
        note: '自动化闭环观察'
      }
    });
    expect(world.recentEvents[0]?.type).toBe('OBSERVE_PLANT');

    const beforeSample = world.sites
      .flatMap((site) => site.species)
      .find((species) => species.id === 'prunus-davidiana')!;
    world = await command(agent, world, {
      type: 'TAKE_SAMPLE',
      speciesId: 'prunus-davidiana',
      method: 'litter'
    });
    const afterSample = world.sites
      .flatMap((site) => site.species)
      .find((species) => species.id === 'prunus-davidiana')!;
    expect(afterSample.health).toBeLessThan(beforeSample.health);
    expect(world.recentEvents[0]?.message).toContain('不符合采集协议');

    const requestBody = {
      expectedRevision: world.revision,
      idempotencyKey: 'idempotency-test-key-001',
      command: { type: 'WAIT' as const }
    };
    const first = await agent.post(`/api/save/${world.saveId}/commands`).send(requestBody).expect(200);
    const second = await agent.post(`/api/save/${world.saveId}/commands`).send(requestBody).expect(200);
    expect(second.body.world.revision).toBe(first.body.world.revision);
    expect(second.body.event.id).toBe(first.body.event.id);
    world = first.body.world as WorldSnapshot;

    for (const season of ['spring', 'summer', 'autumn', 'winter'] as Season[]) {
      expect(world.season).toBe(season);
      world = await advanceToDayEight(agent, world);
      world = await command(agent, world, { type: 'END_SEASON' });
      if (season !== 'winter') {
        expect(world.phase).toBe('season_review');
        world = await command(agent, world, { type: 'BEGIN_NEXT_SEASON' });
      }
    }

    expect(world.phase).toBe('year_review');
    expect(world.annualReview?.year).toBe(1);
    expect(world.annualReview?.incorrectSamples).toBeGreaterThan(0);
    expect(world.annualReview?.speciesChanges.length).toBeGreaterThan(0);
    expect(world.annualReview?.speciesChanges.some((item) => item.populationChangePercent === 100)).toBe(false);
    expect(world.annualReview?.populationChangePercent).not.toBe(100);
    expect(world.annualReview?.speciesChanges.every((item) => Number.isFinite(item.populationChangePercent))).toBe(true);
    expect(world.annualReview?.speciesChanges.every((item) => Number.isFinite(item.healthChange))).toBe(true);

    const findings = world.annualReview?.findings ?? [];
    expect(new Set(findings.map((finding) => finding.category))).toEqual(
      new Set(['distribution', 'phenology', 'restoration', 'sampling'])
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.evidence.length > 0)).toBe(true);
    expect(findings.some((finding) => finding.category === 'sampling' && finding.severity === 'warning')).toBe(true);
    expect(world.annualReview?.generatedBy).toBe('settlement');
    const findingIds = new Set(findings.map((finding) => finding.id));
    const recommendationItems = world.annualReview?.recommendationItems ?? [];
    expect(recommendationItems.length).toBeGreaterThan(0);
    expect(
      recommendationItems.every((item) => item.findingIds.every((id) => findingIds.has(id)))
    ).toBe(true);

    world = await command(agent, world, { type: 'BEGIN_NEXT_YEAR' });
    expect(world.year).toBe(2);
    expect(world.season).toBe('spring');
    expect(world.phase).toBe('active');

    const journal = await agent.get(`/api/save/${world.saveId}/journal`).expect(200);
    expect(journal.body.entries.length).toBeGreaterThan(0);
    expect(journal.body.entries.find((entry: { kind: string }) => entry.kind === 'sample').slot).toBeGreaterThan(0);
    const historyCount = store.db
      .prepare('SELECT COUNT(*) AS count FROM environment_history WHERE save_id = ?')
      .get(world.saveId) as unknown as { count: number };
    expect(Number(historyCount.count)).toBeGreaterThan(0);
    const report = await agent.get(`/api/save/${world.saveId}/report/1`).expect(200);
    expect(report.body.year).toBe(1);

    const firstExport = await agent.post(`/api/save/${world.saveId}/export`).expect(200);
    expect(firstExport.body.token).toHaveLength(43);
    const latestExport = await agent.post(`/api/save/${world.saveId}/export`).expect(200);
    await agent.post('/api/save/import').send({ token: firstExport.body.token }).expect(400);
    const imported = await agent.post('/api/save/import').send({ token: latestExport.body.token }).expect(200);
    expect(imported.body.saveId).toBe(world.saveId);
    expect(imported.body.year).toBe(2);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  }, 30_000);

  it('backfills a missing historical report without contaminating later years', async () => {
    const backfillAgent = request.agent(app);
    const createResponse = await backfillAgent.post('/api/save').expect(201);
    let world = createResponse.body as WorldSnapshot;

    world = await command(backfillAgent, world, {
      type: 'TAKE_SAMPLE',
      speciesId: 'prunus-davidiana',
      method: 'litter'
    });
    for (const season of ['spring', 'summer', 'autumn', 'winter'] as Season[]) {
      world = await advanceToDayEight(backfillAgent, world);
      world = await command(backfillAgent, world, { type: 'END_SEASON' });
      if (season !== 'winter') {
        world = await command(backfillAgent, world, { type: 'BEGIN_NEXT_SEASON' });
      }
    }
    expect(world.phase).toBe('year_review');
    const originalReport = world.annualReview!;
    expect(originalReport.generatedBy).toBe('settlement');

    world = await command(backfillAgent, world, { type: 'BEGIN_NEXT_YEAR' });
    expect(world.year).toBe(2);

    // 模拟历史报告缺失，并记录补算前的存档与日志状态。
    store.db.prepare('DELETE FROM annual_reports WHERE save_id = ? AND year = 1').run(world.saveId);
    const saveBefore = store.db.prepare('SELECT * FROM saves WHERE id = ?').get(world.saveId) as Record<string, unknown>;
    const countRows = (sql: string) =>
      Number((store.db.prepare(sql).get(world.saveId) as unknown as { count: number }).count);
    const countsBefore = {
      events: countRows('SELECT COUNT(*) AS count FROM game_events WHERE save_id = ?'),
      speciesStates: countRows('SELECT COUNT(*) AS count FROM species_states WHERE save_id = ?'),
      siteStates: countRows('SELECT COUNT(*) AS count FROM site_states WHERE save_id = ?'),
      seasonSummaries: countRows('SELECT COUNT(*) AS count FROM season_summaries WHERE save_id = ?'),
      receipts: countRows('SELECT COUNT(*) AS count FROM command_receipts WHERE save_id = ?')
    };

    await backfillAgent.get(`/api/save/${world.saveId}/report/1`).expect(404);
    const backfillResponse = await backfillAgent.post(`/api/save/${world.saveId}/report/1/backfill`).expect(200);
    const backfilled = backfillResponse.body as typeof originalReport;
    expect(backfilled.year).toBe(1);
    expect(backfilled.generatedBy).toBe('backfill');

    // 补算结论必须与当年结算结论完全一致（生成方式与时间戳除外）。
    const { generatedAt: _originalAt, generatedBy: _originalBy, ...originalConclusions } = originalReport;
    const { generatedAt: _backfillAt, generatedBy: _backfillBy, ...backfilledConclusions } = backfilled;
    expect(backfilledConclusions).toEqual(originalConclusions);

    // 补算不得污染存档进度、事件流、状态表与其他年份数据。
    const saveAfter = store.db.prepare('SELECT * FROM saves WHERE id = ?').get(world.saveId) as Record<string, unknown>;
    expect(saveAfter.revision).toBe(saveBefore.revision);
    expect(saveAfter.year).toBe(saveBefore.year);
    expect(saveAfter.season).toBe(saveBefore.season);
    expect(saveAfter.phase).toBe(saveBefore.phase);
    expect(saveAfter.restoration_unlocked).toBe(saveBefore.restoration_unlocked);
    expect(countRows('SELECT COUNT(*) AS count FROM game_events WHERE save_id = ?')).toBe(countsBefore.events);
    expect(countRows('SELECT COUNT(*) AS count FROM species_states WHERE save_id = ?')).toBe(countsBefore.speciesStates);
    expect(countRows('SELECT COUNT(*) AS count FROM site_states WHERE save_id = ?')).toBe(countsBefore.siteStates);
    expect(countRows('SELECT COUNT(*) AS count FROM season_summaries WHERE save_id = ?')).toBe(countsBefore.seasonSummaries);
    expect(countRows('SELECT COUNT(*) AS count FROM command_receipts WHERE save_id = ?')).toBe(countsBefore.receipts);

    // 已存在的报告不得被补算覆盖；当前或未来年份不可补算。
    await backfillAgent.post(`/api/save/${world.saveId}/report/1/backfill`).expect(409);
    await backfillAgent.post(`/api/save/${world.saveId}/report/2/backfill`).expect(409);
    await backfillAgent.post(`/api/save/${world.saveId}/report/9/backfill`).expect(409);

    const persisted = await backfillAgent.get(`/api/save/${world.saveId}/report/1`).expect(200);
    expect(persisted.body.generatedBy).toBe('backfill');
    const yearOneReportRow = store.db
      .prepare('SELECT report_json FROM annual_reports WHERE save_id = ? AND year = 1')
      .get(world.saveId) as unknown as { report_json: string };

    // 后续年份照常结算，其报告不受补算影响，补算报告也不被改写。
    for (const season of ['spring', 'summer', 'autumn', 'winter'] as Season[]) {
      world = await advanceToDayEight(backfillAgent, world);
      world = await command(backfillAgent, world, { type: 'END_SEASON' });
      if (season !== 'winter') {
        world = await command(backfillAgent, world, { type: 'BEGIN_NEXT_SEASON' });
      }
    }
    expect(world.phase).toBe('year_review');
    expect(world.annualReview?.year).toBe(2);
    expect(world.annualReview?.generatedBy).toBe('settlement');
    expect(world.annualReview?.findings.length).toBeGreaterThan(0);

    const yearOneReportRowAfter = store.db
      .prepare('SELECT report_json FROM annual_reports WHERE save_id = ? AND year = 1')
      .get(world.saveId) as unknown as { report_json: string };
    expect(yearOneReportRowAfter.report_json).toBe(yearOneReportRow.report_json);

    const yearTwo = await backfillAgent.get(`/api/save/${world.saveId}/report/2`).expect(200);
    expect(yearTwo.body.generatedBy).toBe('settlement');

    // 第 2 年报告的补算走“上一年末状态 → 越冬/扩散推导”的重建路径，
    // 结论同样必须与当年结算完全一致。
    const yearTwoReport = world.annualReview!;
    world = await command(backfillAgent, world, { type: 'BEGIN_NEXT_YEAR' });
    expect(world.year).toBe(3);
    const revisionBeforeYearTwoBackfill = world.revision;
    store.db.prepare('DELETE FROM annual_reports WHERE save_id = ? AND year = 2').run(world.saveId);
    const yearTwoBackfill = await backfillAgent.post(`/api/save/${world.saveId}/report/2/backfill`).expect(200);
    expect(yearTwoBackfill.body.generatedBy).toBe('backfill');
    const { generatedAt: _y2At, generatedBy: _y2By, ...yearTwoConclusions } = yearTwoReport;
    const { generatedAt: _y2bAt, generatedBy: _y2bBy, ...yearTwoBackfilled } = yearTwoBackfill.body as typeof yearTwoReport;
    expect(yearTwoBackfilled).toEqual(yearTwoConclusions);
    const worldAfter = await backfillAgent.get(`/api/save/${world.saveId}/world`).expect(200);
    expect(worldAfter.body.year).toBe(3);
    expect(worldAfter.body.revision).toBe(revisionBeforeYearTwoBackfill);
  }, 60_000);
});

async function command(
  agent: ReturnType<typeof request.agent>,
  world: WorldSnapshot,
  commandBody: GameCommand
): Promise<WorldSnapshot> {
  const response = await agent
    .post(`/api/save/${world.saveId}/commands`)
    .send({
      expectedRevision: world.revision,
      idempotencyKey: `test-${world.revision}-${commandBody.type}-${Math.random().toString(16).slice(2)}`,
      command: commandBody
    });
  if (response.status !== 200) {
    throw new Error(
      `${commandBody.type} failed at year ${world.year} ${world.season} day ${world.day}: ${response.status} ${JSON.stringify(response.body)}`
    );
  }
  return response.body.world as WorldSnapshot;
}

async function advanceToDayEight(
  agent: ReturnType<typeof request.agent>,
  initialWorld: WorldSnapshot
): Promise<WorldSnapshot> {
  let world = initialWorld;
  let guard = 0;
  while (world.day < 8) {
    world = await command(agent, world, { type: 'WAIT' });
    guard += 1;
    if (guard > 40) {
      throw new Error('Unable to advance to day 8');
    }
  }
  return world;
}
