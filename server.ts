import express from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DB_PATH, initDb, openDb, seedDb, withTransaction } from './src/db.ts';
import { calculateTd, computeConfidence, computePairDifference } from './src/logic.ts';
import type {
  ConfidenceLevel,
  ModuleRecord,
  ObservationCreate,
  ObservationRecord,
  ObservationSource,
} from './src/types.ts';

const VALID_SOURCES = new Set<ObservationSource>(['G', 'O', 'I', 'L']);
const VALID_CONFIDENCES = new Set<ConfidenceLevel>(['LOW', 'MEDIUM', 'HIGH']);

function paramStr(val: string | string[] | undefined): string {
  return Array.isArray(val) ? val[0] ?? '' : val ?? '';
}

export function createApp(dbPath: string = DEFAULT_DB_PATH) {
  initDb(dbPath);
  seedDb(dbPath);

  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });

  app.use(express.json());

  app.get('/api/modules', (_req: Request, res: Response) => {
    const db = openDb(dbPath);
    try {
      const rows = db.prepare('SELECT * FROM module').all() as unknown as ModuleRecord[];
      const modules = rows.map((m) => ({
        ...m,
        current_td: m.state === 'T1' ? calculateTd(m.t1_start_date) : null,
      }));
      res.json(modules);
    } finally {
      db.close();
    }
  });

  app.post('/api/modules/:module_id/start_t1', (req: Request, res: Response) => {
    const moduleId = paramStr(req.params.module_id);
    try {
      const now = new Date().toISOString();
      const outcome = withTransaction(dbPath, (db) => {
        const row = db
          .prepare('SELECT state FROM module WHERE id = ?')
          .get(moduleId) as { state: string } | undefined;

        if (!row) {
          return { status: 404, body: { detail: 'Module not found' } };
        }
        if (row.state === 'T1') {
          return { status: 400, body: { detail: 'Module already in T1' } };
        }

        db.prepare("UPDATE module SET state = 'T1', t1_start_date = ? WHERE id = ?").run(
          now,
          moduleId,
        );
        return { status: 200, body: { status: 'ok', t1_start_date: now } };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      res.status(500).json({ detail: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  app.get('/api/observations/:module_id', (req: Request, res: Response) => {
    const moduleId = paramStr(req.params.module_id);
    const db = openDb(dbPath);
    try {
      const rows = db
        .prepare('SELECT * FROM observation WHERE module_id = ? ORDER BY timestamp ASC')
        .all(moduleId) as unknown as ObservationRecord[];
      res.json(rows);
    } finally {
      db.close();
    }
  });

  app.post('/api/observations', (req: Request, res: Response) => {
    const body = req.body as Partial<ObservationCreate> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(422).json({ detail: 'Invalid request body' });
      return;
    }

    const { module_id, category, qualitative_value, source, user_confidence, comment } = body;

    if (
      typeof module_id !== 'string' ||
      typeof category !== 'string' ||
      typeof qualitative_value !== 'string' ||
      typeof source !== 'string' ||
      typeof user_confidence !== 'string'
    ) {
      res.status(422).json({ detail: 'Missing or invalid required observation fields' });
      return;
    }

    const trimmedVal = qualitative_value.trim();
    if (trimmedVal === '' || trimmedVal === '0') {
      res.status(422).json({
        detail: "Qualitative value cannot be empty or zero. Use 'NO_DATA' if unknown.",
      });
      return;
    }

    if (!VALID_SOURCES.has(source as ObservationSource)) {
      res.status(422).json({ detail: 'Invalid source. Expected G, O, I, or L.' });
      return;
    }

    if (!VALID_CONFIDENCES.has(user_confidence as ConfidenceLevel)) {
      res.status(422).json({ detail: 'Invalid user_confidence. Expected LOW, MEDIUM, or HIGH.' });
      return;
    }

    const safeComment = typeof comment === 'string' ? comment : '';

    try {
      const outcome = withTransaction(dbPath, (db) => {
        const mod = db.prepare('SELECT id FROM module WHERE id = ?').get(module_id);
        if (!mod) {
          return { status: 404, body: { detail: 'Module not found' } };
        }

        const now = new Date().toISOString();
        const result = db
          .prepare(
            `INSERT INTO observation (module_id, timestamp, category, qualitative_value, source, user_confidence, comment)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(module_id, now, category, qualitative_value, source, user_confidence, safeComment);

        return { status: 200, body: { status: 'ok', id: Number(result.lastInsertRowid) } };
      });
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      res.status(500).json({ detail: err instanceof Error ? err.message : 'Internal error' });
    }
  });

  app.get('/api/pairs/:pair_id/difference', (req: Request, res: Response) => {
    const pairId = paramStr(req.params.pair_id);
    const db = openDb(dbPath);
    try {
      const modules = db
        .prepare('SELECT id FROM module WHERE pair_id = ? ORDER BY id')
        .all(pairId) as Array<{ id: string }>;

      if (modules.length !== 2) {
        res.status(400).json({ detail: 'Pair does not have exactly 2 modules' });
        return;
      }

      const m1 = modules[0].id;
      const m2 = modules[1].id;

      const m1Obs = db
        .prepare('SELECT * FROM observation WHERE module_id = ? ORDER BY timestamp ASC')
        .all(m1) as unknown as ObservationRecord[];
      const m2Obs = db
        .prepare('SELECT * FROM observation WHERE module_id = ? ORDER BY timestamp ASC')
        .all(m2) as unknown as ObservationRecord[];

      const diffs = computePairDifference(m1Obs, m2Obs);
      res.json({
        m1_id: m1,
        m2_id: m2,
        differences: diffs,
      });
    } finally {
      db.close();
    }
  });

  app.get('/api/confidence/:module_id/:category', (req: Request, res: Response) => {
    const moduleId = paramStr(req.params.module_id);
    const category = paramStr(req.params.category);
    const db = openDb(dbPath);
    try {
      const rows = db
        .prepare(
          'SELECT * FROM observation WHERE module_id = ? AND category = ? ORDER BY timestamp ASC',
        )
        .all(moduleId, category) as unknown as ObservationRecord[];
      res.json(computeConfidence(rows));
    } finally {
      db.close();
    }
  });

  app.get('/api/export', (_req: Request, res: Response) => {
    const db = openDb(dbPath);
    try {
      const modules = db.prepare('SELECT * FROM module').all();
      const observations = db.prepare('SELECT * FROM observation').all();
      res.json({ modules, observations });
    } finally {
      db.close();
    }
  });

  app.post('/api/import', upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ detail: 'No file uploaded' });
      return;
    }

    let data: { modules?: unknown; observations?: unknown };
    try {
      data = JSON.parse(req.file.buffer.toString('utf8'));
    } catch {
      res.status(400).json({ detail: 'Invalid JSON file' });
      return;
    }

    if (!Array.isArray(data?.modules) || !Array.isArray(data?.observations)) {
      res.status(400).json({ detail: 'Missing required keys in JSON' });
      return;
    }

    try {
      withTransaction(dbPath, (db) => {
        db.exec('DELETE FROM observation');
        db.exec('DELETE FROM module');

        const insertMod = db.prepare(`
          INSERT INTO module (id, name, pair_id, state, t1_start_date)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const m of data.modules as Array<Record<string, unknown>>) {
          insertMod.run(
            String(m.id),
            String(m.name),
            String(m.pair_id),
            String(m.state),
            m.t1_start_date == null ? null : String(m.t1_start_date),
          );
        }

        const insertObs = db.prepare(`
          INSERT INTO observation (id, module_id, timestamp, category, qualitative_value, source, user_confidence, comment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const o of data.observations as Array<Record<string, unknown>>) {
          insertObs.run(
            Number(o.id),
            String(o.module_id),
            String(o.timestamp),
            String(o.category),
            String(o.qualitative_value),
            String(o.source),
            String(o.user_confidence),
            String(o.comment ?? ''),
          );
        }
      });

      res.json({ status: 'ok', message: 'Import successful' });
    } catch (err) {
      res.status(400).json({
        detail: err instanceof Error ? err.message : 'Failed to import data',
      });
    }
  });

  const staticDir = path.join(process.cwd(), 'app', 'static');
  app.use(express.static(staticDir));

  return app;
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const PORT = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ARGUS BIO-MAP server listening on http://0.0.0.0:${PORT}`);
  });
}
