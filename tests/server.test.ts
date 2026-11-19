import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { createApp } from '../server.ts';
import { initDb, seedDb, withTransaction } from '../src/db.ts';

const testDbPath = path.join(os.tmpdir(), `bio_map_test_${process.pid}.db`);

function cleanDb() {
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
}

describe('ARGUS BIO-MAP API', () => {
  let baseUrl = '';
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | null = null;

  beforeEach(async () => {
    cleanDb();
    initDb(testDbPath);
    seedDb(testDbPath);
    if (!server) {
      const app = createApp(testDbPath);
      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          const addr = server!.address() as AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    }
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    cleanDb();
  });

  it('seeds 6 modules in PRE state', async () => {
    const res = await fetch(`${baseUrl}/api/modules`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as Array<{ id: string; state: string }>;
    assert.equal(data.length, 6);
    assert.equal(data[0].id, 'M1');
    assert.equal(data[0].state, 'PRE');
  });

  it('initiates T1 once and computes TD = 1', async () => {
    const res = await fetch(`${baseUrl}/api/modules/M1/start_t1`, { method: 'POST' });
    assert.equal(res.status, 200);

    const listRes = await fetch(`${baseUrl}/api/modules`);
    const modules = (await listRes.json()) as Array<{
      id: string;
      state: string;
      t1_start_date: string | null;
      current_td: number | null;
    }>;
    const m1 = modules.find((m) => m.id === 'M1');
    assert.ok(m1);
    assert.equal(m1.state, 'T1');
    assert.ok(m1.t1_start_date);
    assert.equal(m1.current_td, 1);

    const res2 = await fetch(`${baseUrl}/api/modules/M1/start_t1`, { method: 'POST' });
    assert.equal(res2.status, 400);
  });

  it('adds and retrieves observations', async () => {
    const res = await fetch(`${baseUrl}/api/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        module_id: 'M1',
        category: 'VIGOR',
        qualitative_value: 'HIGH',
        source: 'O',
        user_confidence: 'HIGH',
        comment: 'Looking good',
      }),
    });
    assert.equal(res.status, 200);

    const getRes = await fetch(`${baseUrl}/api/observations/M1`);
    const obs = (await getRes.json()) as Array<{ category: string; qualitative_value: string }>;
    assert.equal(obs.length, 1);
    assert.equal(obs[0].category, 'VIGOR');
    assert.equal(obs[0].qualitative_value, 'HIGH');
  });

  it('computes pair difference', async () => {
    await fetch(`${baseUrl}/api/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        module_id: 'M1',
        category: 'VIGOR',
        qualitative_value: 'HIGH',
        source: 'O',
        user_confidence: 'HIGH',
        comment: '',
      }),
    });
    await fetch(`${baseUrl}/api/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        module_id: 'M2',
        category: 'VIGOR',
        qualitative_value: 'MEDIUM',
        source: 'O',
        user_confidence: 'HIGH',
        comment: '',
      }),
    });

    const res = await fetch(`${baseUrl}/api/pairs/P1/difference`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      m1_id: string;
      m2_id: string;
      differences: Array<{
        category: string;
        m1_val: string;
        m2_val: string;
        is_different: boolean;
      }>;
    };
    assert.equal(data.m1_id, 'M1');
    assert.equal(data.m2_id, 'M2');
    const vigor = data.differences.find((d) => d.category === 'VIGOR');
    assert.ok(vigor);
    assert.equal(vigor.is_different, true);
    assert.equal(vigor.m1_val, 'HIGH');
    assert.equal(vigor.m2_val, 'MEDIUM');
  });

  it('computes confidence score', async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(`${baseUrl}/api/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module_id: 'M1',
          category: 'VIGOR',
          qualitative_value: 'HIGH',
          source: 'L',
          user_confidence: 'HIGH',
          comment: '',
        }),
      });
    }

    const res = await fetch(`${baseUrl}/api/confidence/M1/VIGOR`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { aggregated_confidence: string };
    assert.equal(body.aggregated_confidence, 'HIGH');
  });

  it('enforces DB invariant preventing PRE state with t1_start_date', () => {
    assert.throws(() => {
      withTransaction(testDbPath, (db) => {
        db.prepare(
          'INSERT INTO module (id, name, pair_id, state, t1_start_date) VALUES (?, ?, ?, ?, ?)',
        ).run('M99', 'Test', 'P9', 'PRE', '2023-01-01T00:00:00');
      });
    });
  });

  it('exports and imports JSON backups', async () => {
    const expRes = await fetch(`${baseUrl}/api/export`);
    assert.equal(expRes.status, 200);
    const expData = await expRes.json();

    const form = new FormData();
    form.append(
      'file',
      new Blob([JSON.stringify(expData)], { type: 'application/json' }),
      'data.json',
    );
    const impRes = await fetch(`${baseUrl}/api/import`, { method: 'POST', body: form });
    assert.equal(impRes.status, 200);
  });
});
