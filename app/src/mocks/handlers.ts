import { http, HttpResponse } from 'msw/http';
import { delay } from 'msw/utils/delay';
import { sse } from 'msw/sse';
import type { SleepRecord } from '@api/sleepSchema.ts';
import type { Jobs } from '@api/jobs.ts';
import {
  getServices,
  updateServices,
  getSchedules,
  updateSchedules,
  getSettings,
  updateSettings,
  getDeviceStatus,
  updateDeviceStatus,
  getServerStatus,
  listSleepRecords,
  setSleepRecords,
  listMovementRecords,
  listVitalsRecords,
  filterByQuery,
  listLogs,
  getLogFiles,
  handleJobs,
} from './mockData';

type Side = 'left' | 'right';

type Filters = {
  startTime?: string;
  endTime?: string;
  side?: Side;
};

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const toFilters = (request: Request): Filters => {
  const url = new URL(request.url);
  const startTime = url.searchParams.get('startTime') ?? undefined;
  const endTime = url.searchParams.get('endTime') ?? undefined;
  const sideParam = url.searchParams.get('side') ?? undefined;
  const side = sideParam === 'left' || sideParam === 'right' ? sideParam : undefined;
  return { startTime, endTime, side };
};

// The sides a request for 'left', 'right' or 'both' applies to
const alarmSides = (side: Side | 'both' | undefined): Side[] => (side === 'left' || side === 'right' ? [side] : ['left', 'right']);

const notFound = (message: string) => HttpResponse.json({ message }, { status: 404 });

// As on a Pod, there is no sleep data unless biometrics is switched on in Settings
const isBiometricsOn = () => getServices().biometrics.enabled;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// A made-up stay in bed, minute by minute: a while awake, sleep with a wake-up or two, then up
const buildDemoNight = (startedAtMs: number, asleepMinutes: number, variant: number) => {
  const settlingMinutes = 14 + variant * 2;
  const isNap = asleepMinutes < 180;
  const wakeUpAt = isNap ? [] : [Math.round(asleepMinutes * 0.42), Math.round(asleepMinutes * 0.78)].slice(0, 1 + (variant % 2));
  const totalMinutes = settlingMinutes + asleepMinutes + 8;
  const minutes = Array.from({ length: totalMinutes }, (_unused, index) => {
    const sinceAsleep = index - settlingMinutes;
    const isAwakeBreak = wakeUpAt.some(at => sinceAsleep >= at && sinceAsleep < at + 5);
    const isAsleep = sinceAsleep >= 0 && sinceAsleep < asleepMinutes && !isAwakeBreak;
    const progress = Math.min(1, Math.max(0, sinceAsleep / asleepMinutes));
    const wobble = Math.sin(index / 7 + variant) + Math.sin(index / 23);
    // The night curve: two degrees cool early, back by late night, a degree warm at the end
    const offsetF = isNap || sinceAsleep < 0 ? undefined
      : Math.round(progress < 0.1 ? -20 * progress : progress < 0.5 ? -2 : progress < 0.85 ? (progress - 0.85) * 5.7 : (progress - 0.85) * 6.7);
    return {
      movementSeconds: isAsleep ? (index % 37 === 0 ? 6 : 0) : 18,
      heartRate: isAsleep ? Math.round(55 + wobble) : 66,
      breathingRate: Math.round((isAsleep ? 14.5 + wobble * 0.5 : 17 + wobble) * 10) / 10,
      breathingSpread: isAsleep ? 1 : 4,
      pressure: Math.round(2400 + wobble * 60 + (isAsleep ? 0 : 250)),
      stage: isAsleep ? 'asleep' : 'awake',
      offsetF,
    };
  });
  const asleepAtMs = startedAtMs + settlingMinutes * MINUTE_MS;
  const awakeAtMs = asleepAtMs + asleepMinutes * MINUTE_MS;
  return {
    side: 'left', startedAtMs, minutes, minutesLogged: totalMinutes, kind: isNap ? 'nap' : 'night', asleepAtMs, awakeAtMs,
    heartRate: 55, breathingRate: 14.5, wakeUps: wakeUpAt.length,
    tracker: isNap ? undefined : {
      source: 'Apple Health', asleepAtMs: asleepAtMs - (9 - variant % 6) * MINUTE_MS, awakeAtMs: awakeAtMs + (variant % 5 - 2) * MINUTE_MS,
      receivedAtMs: awakeAtMs + 40 * MINUTE_MS,
    },
  };
};


export const handlers = [
  http.post('/api/metrics/presence/sensors/empty', async () => {
    await delay(120);
    return new HttpResponse(null, { status: 204 });
  }),
  // Saved nights: one for each of the last two weeks on the left side, each with a watch's times
  // a few minutes off the bed's, and a nap yesterday afternoon
  http.get('/api/autopilot/nights', async ({ request }) => {
    await delay(80);
    const query = new URL(request.url).searchParams;
    const date = query.get('date');
    // The demo's sleeper lies on the left; asked for the bed as a whole, that is their record
    if (!date || query.get('side') === 'right') return HttpResponse.json([]);
    const dayStartMs = new Date(`${date}T00:00:00`).getTime();
    const daysAgo = Math.round((new Date().setHours(0, 0, 0, 0) - dayStartMs) / DAY_MS);
    if (daysAgo < 0 || daysAgo > 13) return HttpResponse.json([]);
    const night = buildDemoNight(dayStartMs - (70 - daysAgo * 3) * MINUTE_MS, 450 + daysAgo * 5, daysAgo);
    const nap = daysAgo === 1 ? [buildDemoNight(dayStartMs + 15 * 60 * MINUTE_MS, 45, 3)] : [];
    return HttpResponse.json([night, ...nap]);
  }),
  http.post('/api/autopilot/sleepTimes', async () => HttpResponse.json({ message: '1 sleep received from You. Matched 1 stay in bed.' })),
  http.get('/api/autopilot/nights/export', async () => {
    await delay(80);
    return HttpResponse.json({ exportedAt: new Date().toISOString(), nights: [] }, {
      headers: { 'Content-Disposition': 'attachment; filename="sevensleep-nights-demo.json"' },
    });
  }),
  // The autopilot early in the night: the left sleeper asleep, the right side empty
  http.get('/api/autopilot', async () => {
    await delay(60);
    return HttpResponse.json({
      available: true,
      enabled: getSettings().autopilot.enabled,
      room: { temperatureF: 68, humidityPercent: 46 },
      left: {
        stage: 'asleep', minutesAsleep: 62, offsetF: -3,
        lastChange: '81°F, heading for 3°F cooler (time of night, first sleep cycle)', learned: { early: -0.5, middle: 0, late: 0 },
        sleepKind: 'night', rules: { stillMinutesToSleep: 10, restlessSecondsToWake: 20, calmMinutesToResume: 5 },
        tracker: {
          source: 'Apple Health', syncedAt: new Date().toISOString(), nights: 8, agreementPercent: 94, isTuned: true, nightsNeeded: 7,
          lastSleeps: [{ asleepAtMs: new Date().setHours(0, 0, 0, 0) - 65 * MINUTE_MS, awakeAtMs: new Date().setHours(6, 32, 0, 0) }],
          lastMatchedStays: 1,
        },
      },
      right: {
        stage: 'out', learned: { early: 0, middle: 0, late: 0 },
        rules: { stillMinutesToSleep: 15, restlessSecondsToWake: 20, calmMinutesToResume: 5 },
      },
    });
  }),
  // The bed's presence sensors: someone on the left, nobody on the right
  http.get('/api/metrics/presence/sensors', async () => {
    await delay(60);
    const changedAt = new Date().toISOString();
    return HttpResponse.json({
      available: true,
      left: { present: true, signal: 4310, baseline: 3890, changedAt },
      right: { present: false, signal: 3955, baseline: 3950, changedAt },
    });
  }),
  http.get('/api/services', async () => {
    await delay(120);
    return HttpResponse.json(deepClone(getServices()));
  }),
  http.post('/api/services', async ({ request }) => {
    const body = (await request.json()) as Partial<ReturnType<typeof getServices>>;
    const updated = updateServices(body);
    await delay(120);
    return HttpResponse.json(deepClone(updated));
  }),
  http.get('/api/schedules', async () => {
    await delay(120);
    return HttpResponse.json(deepClone(getSchedules()));
  }),
  http.post('/api/schedules', async ({ request }) => {
    const body = (await request.json()) as Partial<ReturnType<typeof getSchedules>>;
    const updated = updateSchedules(body);
    await delay(120);
    return HttpResponse.json(deepClone(updated));
  }),
  http.get('/api/settings', async () => {
    await delay(120);
    return HttpResponse.json(deepClone(getSettings()));
  }),
  http.post('/api/settings', async ({ request }) => {
    const body = (await request.json()) as Partial<ReturnType<typeof getSettings>>;
    let updated = updateSettings(body);
    // As on a Pod: switching the autopilot on links the sides, and unlinking them switches it off
    if (updated.autopilot.enabled && !updated.linkSides) {
      const isUnlinking = body.linkSides === false && body.autopilot?.enabled !== true;
      updated = updateSettings(isUnlinking ? { autopilot: { enabled: false } } : { linkSides: true });
    }
    await delay(120);
    return HttpResponse.json(deepClone(updated));
  }),
  // A one-time alarm is kept as an override on each side's settings, as the server does
  http.post('/api/alarm/time', async ({ request }) => {
    const body = (await request.json()) as { side?: Side | 'both'; time?: string };
    if (!body.time) return HttpResponse.json({ error: 'Invalid request data' }, { status: 400 });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const override = { scheduleOverrides: { alarm: { disabled: false, timeOverride: body.time, expiresAt } } };
    updateSettings(Object.fromEntries(alarmSides(body.side).map(alarmSide => [alarmSide, override])));
    await delay(120);
    return HttpResponse.json(deepClone(getSettings()));
  }),
  http.post('/api/alarm/time/cancel', async ({ request }) => {
    const body = (await request.json()) as { side?: Side | 'both' };
    const override = { scheduleOverrides: { alarm: { disabled: false, timeOverride: '', expiresAt: '' } } };
    updateSettings(Object.fromEntries(alarmSides(body.side).map(alarmSide => [alarmSide, override])));
    await delay(120);
    return HttpResponse.json(deepClone(getSettings()));
  }),
  // "Test for a minute": nothing to vibrate in the demo
  http.post('/api/alarm', async () => {
    await delay(120);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/deviceStatus', async () => {
    await delay(120);
    return HttpResponse.json(deepClone(getDeviceStatus()));
  }),
  http.post('/api/deviceStatus', async ({ request }) => {
    const body = (await request.json()) as Partial<ReturnType<typeof getDeviceStatus>>;
    updateDeviceStatus(body);
    await delay(120);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/serverStatus', async () => {
    await delay(150);
    return HttpResponse.json(deepClone(getServerStatus()));
  }),
  http.get('/api/metrics/sleep', async ({ request }) => {
    const filters = toFilters(request);
    const records = isBiometricsOn() ? listSleepRecords() : [];
    // @ts-expect-error
    const filtered = filterByQuery(records, filters, (record: SleepRecord) => Date.parse(record.entered_bed_at));
    await delay(150);
    return HttpResponse.json(deepClone(filtered));
  }),
  http.delete('/api/metrics/sleep/:id', async ({ params }) => {
    const id = Number(params.id);
    const records = listSleepRecords();
    const next = records.filter((record) => record.id !== id);
    if (next.length === records.length) {
      return notFound('Sleep record not found');
    }
    setSleepRecords(next);
    await delay(80);
    return new HttpResponse(null, { status: 204 });
  }),
  http.put('/api/metrics/sleep/:id', async ({ params, request }) => {
    const id = Number(params.id);
    const updates = (await request.json()) as Partial<SleepRecord>;
    const records = deepClone(listSleepRecords());
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) {
      return notFound('Sleep record not found');
    }
    const updatedRecord = { ...records[index], ...updates } satisfies SleepRecord;
    records[index] = updatedRecord;
    setSleepRecords(records);
    await delay(80);
    return HttpResponse.json(updatedRecord);
  }),
  http.get('/api/metrics/movement', async () => {
    // const filters = toFilters(request);
    const records = isBiometricsOn() ? listMovementRecords() : [];
    // const filtered = filterByQuery(records, filters, (record: MovementRecord) => record.timestamp * 1000);
    await delay(120);
    return HttpResponse.json(records);
  }),
  http.get('/api/metrics/vitals', async () => {
    // const filters = toFilters(request);
    const records = isBiometricsOn() ? listVitalsRecords() : [];
    // const filtered = filterByQuery(records, filters, (record: VitalsRecord) => record.timestamp * 1000);
    await delay(120);
    return HttpResponse.json(records);
  }),
  http.get('/api/metrics/vitals/summary', async () => {
    await delay(120);
    return HttpResponse.json({
      avgHeartRate: 55,
      minHeartRate: 45,
      maxHeartRate: 68,
      avgHRV: 63,
      avgBreathingRate: 12,
    });
  }),
  http.post('/api/jobs', async ({ request }) => {
    const jobs = (await request.json()) as Jobs;
    handleJobs(jobs);
    await delay(150);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/logs', async () => {
    await delay(120);
    return HttpResponse.json({ logs: getLogFiles() });
  }),
  // Stream existing and newly appended demo log entries until the viewer disconnects.
  sse('/api/logs/:filename', ({ params, request, client }) => {
    const filename = String(params.filename);
    const logStore = listLogs();
    const initialLogs = deepClone(logStore[filename] ?? []);
    if (!logStore[filename]) {
      client.send({ data: JSON.stringify({ message: 'Log file not found' }) });
      client.close();
      return;
    }

    initialLogs.forEach((entry) => {
      client.send({ data: JSON.stringify({ message: entry }) });
    });
    let lastIndex = initialLogs.length;
    const interval = setInterval(() => {
      const latest = listLogs()[filename] ?? [];
      if (latest.length > lastIndex) {
        try {
          latest.slice(lastIndex).forEach((entry) => {
            client.send({ data: JSON.stringify({ message: entry }) });
          });
        } catch {
          // The page that was reading has closed the stream
          clearInterval(interval);
        }
        lastIndex = latest.length;
      }
    }, 2000);
    request.signal.addEventListener('abort', () => clearInterval(interval), { once: true });
  }),
];
