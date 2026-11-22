// Run with Node 24: node --test tests/autopilot.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEART_RATE_WINDOW_SECONDS, LOST_SAMPLE, PIEZO_SAMPLES_PER_SECOND, countMovementSeconds, estimateHeartRate, fillLostSamples,
  findQuietSwing, measureSwing,
} from '../server/src/autopilot/heartRate.ts';
import {
  MAX_OFFSET_F, NO_LEARNED_OFFSETS, curveOffsetF, learnFromCorrection, nightPartAt,
  planTemperature, roomOffsetF,
} from '../server/src/autopilot/nightPlan.ts';
import {
  findScheduledTemperatureF, findUsualSleep, isNightExpected, isWithinScheduledNight, kindOfSleep,
} from '../server/src/autopilot/scheduledBase.ts';
import { countWakeUps, pickBedStays } from '../server/src/autopilot/nightRecord.ts';
import { isAutopilotSteering, setAutopilotSteering } from '../server/src/jobs/autopilotSteering.ts';
import { OVERDUE_BY_MS, findOverdueJob } from '../server/src/jobs/overdueJobs.ts';
import {
  BREATHING_SAMPLES_PER_SECOND, BREATHING_WINDOW_SECONDS, estimateBreathingRate, measureBreathingSpread,
} from '../server/src/autopilot/breathingRate.ts';
import {
  DEFAULT_SLEEP_RULES, calibrateSleepRules, countDisagreements, createSleepTracker, detectSleepTimes, findSleepPeriods,
  mergeSleepPeriods, parseSampleLines, readTrackerMinutes, replaySleep,
} from '../server/src/autopilot/sleepTracker.ts';
import {
  BODY_SWING_RATIO, MAX_EMPTY_SWING, MIN_EMPTY_SWING, addEmptyMinute, findEmptySwing, isBodyFelt,
} from '../server/src/autopilot/bodySignal.ts';

// A made-up piezo signal: a short 7 Hz knock at every heartbeat, over slow breathing and noise
const makeHeartbeatSignal = (beatsPerMinute, seconds = HEART_RATE_WINDOW_SECONDS) => {
  const samples = [];
  const beatSeconds = 60 / beatsPerMinute;
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let index = 0; index < seconds * PIEZO_SAMPLES_PER_SECOND; index++) {
    const time = index / PIEZO_SAMPLES_PER_SECOND;
    const sinceBeat = time % beatSeconds;
    const knock = Math.exp(-sinceBeat * 12) * Math.sin(2 * Math.PI * 7 * sinceBeat);
    const breathing = 0.8 * Math.sin(2 * Math.PI * 0.25 * time);
    samples.push(Math.round(-45000 + 400000 * knock + 300000 * breathing + 20000 * random()));
  }
  return samples;
};

test('heart rate is read from a knocking signal, at rest and faster', () => {
  for (const beatsPerMinute of [52, 60, 68, 84]) {
    const estimate = estimateHeartRate(makeHeartbeatSignal(beatsPerMinute));
    assert.ok(estimate, `an estimate for ${beatsPerMinute}`);
    assert.ok(Math.abs(estimate.beatsPerMinute - beatsPerMinute) <= 3, `${beatsPerMinute} read as ${estimate.beatsPerMinute}`);
    assert.ok(estimate.confidence >= 0.45, `confidence ${estimate.confidence}`);
  }
});

test('a flat or too-short signal gives no heart rate', () => {
  assert.equal(estimateHeartRate(new Array(7500).fill(-45000)), undefined);
  assert.equal(estimateHeartRate(makeHeartbeatSignal(60, 2)), undefined);
});

test('seconds with a swing far above the usual count as movement', () => {
  const still = new Array(55).fill(1_500_000);
  assert.equal(countMovementSeconds([...still, 9_000_000, 12_000_000, 2_000_000, 1_400_000, 8_000_000]), 3);
  assert.equal(countMovementSeconds(still), 0);
  assert.equal(measureSwing([-5, 3, 10, -2]), 15);
});

test('a whole minute of fidgeting is movement when judged against the quiet level before it', () => {
  const fidgeting = new Array(60).fill(9_000_000);
  // Judged against itself, a minute that is all movement looks like the normal
  assert.equal(countMovementSeconds(fidgeting), 0);
  // Judged against the sleeper's quiet level, every second of it counts
  const quietLevel = findQuietSwing(new Array(15).fill(1_500_000));
  assert.equal(quietLevel, 1_500_000);
  assert.equal(countMovementSeconds(fidgeting, quietLevel), 60);
  assert.equal(countMovementSeconds(new Array(60).fill(1_600_000), quietLevel), 0);
  assert.equal(countMovementSeconds([], quietLevel), 0);
});

// Feeds a tracker the same minute `count` times and returns the last state
const addMinutes = (tracker, count, minute) => {
  let state;
  for (let index = 0; index < count; index++) state = tracker.addMinute(minute);
  return state;
};

test('a sleeper is asleep after lying still, whatever the heart does, and awake again when restless', () => {
  const tracker = createSleepTracker();
  // Settling: some movement every minute
  assert.equal(addMinutes(tracker, 12, { isInBed: true, heartRate: 66, movementSeconds: 6 }).stage, 'awake');
  // Fifteen still minutes: asleep, counted from when the stillness began. The heart rate has
  // not dropped at all and it makes no difference.
  assert.equal(addMinutes(tracker, 14, { isInBed: true, heartRate: 66, movementSeconds: 1 }).stage, 'awake');
  const asleep = addMinutes(tracker, 1, { isInBed: true, heartRate: 66, movementSeconds: 1 });
  assert.equal(asleep.stage, 'asleep');
  assert.equal(asleep.minutesAsleep, 15);
  assert.equal(asleep.heartRate, 66);
  // A turn in bed, even two in a row, does not end sleep; three restless minutes in five do
  assert.equal(addMinutes(tracker, 2, { isInBed: true, movementSeconds: 20 }).stage, 'asleep');
  assert.equal(addMinutes(tracker, 10, { isInBed: true, movementSeconds: 0 }).stage, 'asleep');
  assert.equal(addMinutes(tracker, 3, { isInBed: true, movementSeconds: 20 }).stage, 'awake');
  // Restless sleep is not waking: minutes just under the restless mark do not end it
  addMinutes(tracker, 5, { isInBed: true, movementSeconds: 0 });
  assert.equal(addMinutes(tracker, 5, { isInBed: true, movementSeconds: 19 }).stage, 'asleep');
  // Getting out starts over
  assert.deepEqual(tracker.addMinute({ isInBed: false, movementSeconds: 0 }), { stage: 'out', minutesInBed: 0 });
});

test('a sleeper who stirred is asleep again once the restlessness is over, without lying still for 15 minutes', () => {
  const still = { isInBed: true, movementSeconds: 0 };
  const turning = { isInBed: true, movementSeconds: 8 };
  const restless = { isInBed: true, movementSeconds: 30 };
  const tracker = createSleepTracker();
  // Before any sleep, five calm minutes show nothing: falling asleep takes the full 15 still ones
  assert.equal(addMinutes(tracker, 10, turning).stage, 'awake');
  assert.equal(addMinutes(tracker, 15, still).stage, 'asleep');
  assert.equal(addMinutes(tracker, 3, restless).stage, 'awake');
  // Four minutes with turns in them are not yet enough, the fifth is, and sleep is counted from the first
  assert.equal(addMinutes(tracker, 4, turning).stage, 'awake');
  const resumed = tracker.addMinute(turning);
  assert.equal(resumed.stage, 'asleep');
  assert.equal(resumed.minutesAsleep, 5);
  // A restless minute in the stretch starts the count again
  assert.equal(addMinutes(tracker, 3, restless).stage, 'awake');
  addMinutes(tracker, 4, still);
  assert.equal(tracker.addMinute(restless).stage, 'awake');
  assert.equal(addMinutes(tracker, 4, still).stage, 'awake');
  assert.equal(tracker.addMinute(still).stage, 'asleep');
  // A minute the sensor could not read shows nothing
  assert.equal(addMinutes(tracker, 3, restless).stage, 'awake');
  addMinutes(tracker, 4, still);
  assert.equal(tracker.addMinute({ isInBed: true }).stage, 'awake');
  // Getting out of bed and back in is falling asleep again: five calm minutes are not enough
  tracker.addMinute({ isInBed: false });
  assert.equal(addMinutes(tracker, 14, still).stage, 'awake');
  assert.equal(tracker.addMinute(still).stage, 'asleep');
});

test('rules saved before going back to sleep was a rule get the default for it, never longer than falling asleep', () => {
  const still = { isInBed: true, movementSeconds: 0 };
  const restless = { isInBed: true, movementSeconds: 30 };
  const older = createSleepTracker(() => ({ stillMinutesToSleep: 15, restlessSecondsToWake: 12 }));
  addMinutes(older, 15, still);
  addMinutes(older, 3, restless);
  assert.equal(addMinutes(older, 4, still).stage, 'awake');
  assert.equal(older.addMinute(still).stage, 'asleep');
  const quick = createSleepTracker(() => ({ stillMinutesToSleep: 3, restlessSecondsToWake: 12, calmMinutesToResume: 10 }));
  addMinutes(quick, 3, still);
  addMinutes(quick, 3, restless);
  assert.equal(addMinutes(quick, 2, still).stage, 'awake');
  assert.equal(quick.addMinute(still).stage, 'asleep');
});

test('the rules a tracker is given decide how long stillness has to last', () => {
  const quick = createSleepTracker(() => ({ stillMinutesToSleep: 5, restlessSecondsToWake: 30 }));
  assert.equal(addMinutes(quick, 4, { isInBed: true, movementSeconds: 0 }).stage, 'awake');
  assert.equal(addMinutes(quick, 1, { isInBed: true, movementSeconds: 0 }).stage, 'asleep');
  // Twenty moving seconds is under this tracker's bar for a restless minute
  assert.equal(addMinutes(quick, 5, { isInBed: true, movementSeconds: 20 }).stage, 'asleep');
});

// A made-up stay in bed: restless, then asleep, then up. One row a minute.
const makeStay = ({ restlessMinutes, asleepMinutes, awakeMinutes = 10 }) => [
  ...new Array(restlessMinutes).fill({ isInBed: true, movementSeconds: 8 }),
  ...new Array(asleepMinutes).fill({ isInBed: true, movementSeconds: 0 }),
  ...new Array(awakeMinutes).fill({ isInBed: true, movementSeconds: 40 }),
];

test('a saved stay replays to the minute sleep began and ended', () => {
  const stay = makeStay({ restlessMinutes: 25, asleepMinutes: 400 });
  const detected = detectSleepTimes(stay, DEFAULT_SLEEP_RULES);
  assert.equal(detected.asleepAtMinute, 25);
  // Waking is seen once three restless minutes have passed
  assert.ok(Math.abs(detected.awakeAtMinute - 425) <= 3, `woke at ${detected.awakeAtMinute}`);
  // A stay with no long stillness has no sleep in it
  assert.deepEqual(detectSleepTimes(makeStay({ restlessMinutes: 60, asleepMinutes: 5 }), DEFAULT_SLEEP_RULES), {});
});

test('the longest sleep of a stay is the one reported', () => {
  const stay = [
    ...makeStay({ restlessMinutes: 5, asleepMinutes: 20, awakeMinutes: 15 }),
    ...makeStay({ restlessMinutes: 0, asleepMinutes: 300 }),
  ];
  assert.equal(detectSleepTimes(stay, DEFAULT_SLEEP_RULES).asleepAtMinute, 40);
});

// A night for calibration: the bed's minutes, and what a worn tracker said for each
const makeTrackedNight = (minutes, isTrackerAsleep) => ({ minutes, trackerAsleep: minutes.map((_minute, index) => isTrackerAsleep(index)) });

// This sleeper stirs for three minutes in every twelve, 15 moving seconds each, and the worn
// tracker says they slept through it. The night-to-night length differs a little.
const makeRollingNight = (asleepMinutes) => {
  const minutes = [...new Array(20).fill({ isInBed: true, movementSeconds: 8 })];
  for (let minute = 0; minute < asleepMinutes; minute++) minutes.push({ isInBed: true, movementSeconds: minute % 12 >= 9 ? 15 : 0 });
  minutes.push(...new Array(10).fill({ isInBed: true, movementSeconds: 45 }));
  return makeTrackedNight(minutes, index => index >= 20 && index < 20 + asleepMinutes);
};

test('a stay replays to which minutes were asleep, counted from when the stillness began', () => {
  const stay = makeStay({ restlessMinutes: 25, asleepMinutes: 100 });
  const asleep = replaySleep(stay, DEFAULT_SLEEP_RULES);
  assert.equal(asleep.length, stay.length);
  assert.equal(asleep[24], false);
  assert.equal(asleep[25], true);
  assert.equal(asleep[124], true);
  assert.equal(asleep.slice(130).some(Boolean), false);
});

test('calibration fits the rules to a tracker minute by minute, once there are enough nights', () => {
  const nights = [420, 400, 440, 410, 430, 415, 425, 405].map(makeRollingNight);
  // The default rules want fifteen still minutes and never get them, so they see no sleep
  const defaultDisagreements = countDisagreements(nights[0], DEFAULT_SLEEP_RULES);
  assert.ok(defaultDisagreements > 100, `default rules disagreed on ${defaultDisagreements} minutes`);
  // Six nights are too few to change anything, but the agreement is still reported
  const few = calibrateSleepRules(nights.slice(0, 6));
  assert.deepEqual(few.rules, DEFAULT_SLEEP_RULES);
  assert.equal(few.isTuned, false);
  assert.ok(few.agreementPercent < 80, `agreement ${few.agreementPercent}`);
  const calibrated = calibrateSleepRules(nights);
  assert.equal(calibrated.nights, 8);
  assert.equal(calibrated.isTuned, true);
  assert.ok(calibrated.rules.stillMinutesToSleep < 15, JSON.stringify(calibrated));
  assert.ok(calibrated.agreementPercent >= 95, `agreement ${calibrated.agreementPercent}`);
});

test('when the default rules already fit, calibration leaves them alone', () => {
  const night = makeTrackedNight(makeStay({ restlessMinutes: 25, asleepMinutes: 400 }), index => index >= 25 && index < 425);
  const calibrated = calibrateSleepRules(new Array(8).fill(night));
  assert.deepEqual(calibrated.rules, DEFAULT_SLEEP_RULES);
  assert.equal(calibrated.isTuned, false);
  assert.ok(calibrated.agreementPercent >= 99);
});

test('where the default rules agree on every minute, nothing is tuned', () => {
  // Each night replays to exactly what the tracker said under the default rules
  const makePerfectNight = (asleepMinutes) => {
    const minutes = makeStay({ restlessMinutes: 25, asleepMinutes });
    const asleep = replaySleep(minutes, DEFAULT_SLEEP_RULES);
    return makeTrackedNight(minutes, index => asleep[index]);
  };
  const nights = [400, 380, 420, 390, 410, 405, 395, 415].map(makePerfectNight);
  assert.equal(countDisagreements(nights[0], DEFAULT_SLEEP_RULES), 0);
  const calibrated = calibrateSleepRules(nights);
  assert.equal(calibrated.isTuned, false);
  assert.deepEqual(calibrated.rules, DEFAULT_SLEEP_RULES);
  assert.equal(calibrated.agreementPercent, 100);
});

test('rules that only fit the nights they were made from are not taken', () => {
  // Eight nights with nothing in common: each one's best rules are wrong for the others
  const makeOddNight = (seed) => {
    let state = seed;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const minutes = Array.from({ length: 300 }, () => ({ isInBed: true, movementSeconds: Math.floor(random() * 25) }));
    return makeTrackedNight(minutes, () => random() < 0.5);
  };
  const calibrated = calibrateSleepRules([1, 2, 3, 4, 5, 6, 7, 8].map(makeOddNight));
  assert.equal(calibrated.isTuned, false);
  assert.deepEqual(calibrated.rules, DEFAULT_SLEEP_RULES);
});

test('a health app\'s samples are joined into sleeps, leaving out awake and in-bed ones', () => {
  const at = (hour, minute = 0) => Date.UTC(2026, 10, 18, hour, minute);
  const periods = findSleepPeriods([
    { startMs: at(6), endMs: at(14), value: 'In Bed' },
    { startMs: at(6, 20), endMs: at(8), value: 'Core' },
    { startMs: at(8), endMs: at(8, 10), value: 'Awake' },
    { startMs: at(8, 10), endMs: at(13, 40), value: 'REM' },
    // Apple Health's numbers for in bed and awake are left out like the words
    { startMs: at(6), endMs: at(14), value: '0' },
    { startMs: at(8), endMs: at(8, 10), value: '2' },
    // A nap that afternoon, and a blip too short to count
    { startMs: at(21), endMs: at(21, 40), value: 'Asleep' },
    { startMs: at(23, 30), endMs: at(23, 35) },
  ]);
  // The ten minutes awake are kept as time awake within the night
  assert.deepEqual(periods, [
    { asleepAtMs: at(6, 20), awakeAtMs: at(13, 40), awakeIntervals: [{ startMs: at(8), endMs: at(8, 10) }] },
    { asleepAtMs: at(21), awakeAtMs: at(21, 40), awakeIntervals: [] },
  ]);
});

test('a tracker\'s sleeps within one stay become one account of it, minute by minute', () => {
  const at = (hour, minute = 0) => Date.UTC(2026, 10, 18, hour, minute);
  const merged = mergeSleepPeriods([
    { asleepAtMs: at(10), awakeAtMs: at(13), awakeIntervals: [] },
    { asleepAtMs: at(6), awakeAtMs: at(8, 30), awakeIntervals: [{ startMs: at(7), endMs: at(7, 5) }] },
  ]);
  assert.deepEqual(merged, {
    asleepAtMs: at(6),
    awakeAtMs: at(13),
    awakeIntervals: [{ startMs: at(7), endMs: at(7, 5) }, { startMs: at(8, 30), endMs: at(10) }],
  });
  // A stay that began at 05:50: awake for ten minutes, asleep, awake 07:00 to 07:05
  const minutes = readTrackerMinutes(merged, at(5, 50), 90);
  assert.equal(minutes[9], false);
  assert.equal(minutes[10], true);
  assert.equal(minutes[69], true);
  assert.equal(minutes[70], false);
  assert.equal(minutes[74], false);
  assert.equal(minutes[75], true);
  // With no word on time awake, everything between the two times is asleep
  assert.equal(readTrackerMinutes({ asleepAtMs: at(6), awakeAtMs: at(7) }, at(6), 60).every(Boolean), true);
});

test('a sleep under three hours is a nap, whenever it happens', () => {
  assert.equal(kindOfSleep(40), 'nap');
  assert.equal(kindOfSleep(179), 'nap');
  assert.equal(kindOfSleep(180), 'night');
  assert.equal(kindOfSleep(450), 'night');
});

const clock = (hour, minute = 0) => hour * 60 + minute;

test('the usual sleep times come from saved nights, with bedtimes either side of midnight', () => {
  assert.equal(findUsualSleep([{ asleepMinutes: clock(23), awakeMinutes: clock(7) }]), undefined);
  const usual = findUsualSleep([
    { asleepMinutes: clock(23, 30), awakeMinutes: clock(7, 10) },
    { asleepMinutes: clock(0, 20), awakeMinutes: clock(7, 40) },
    { asleepMinutes: clock(23, 50), awakeMinutes: clock(6, 50) },
  ]);
  assert.deepEqual(usual, { asleepMinutes: clock(23, 50), awakeMinutes: clock(7, 10) });
});

test('whether a sleep looks like the night goes by habit first, then the schedule, then the hour', () => {
  // The schedule runs the bed from 21:00 to 09:00, but this sleeper sleeps about 01:00 to 08:00
  const night = { power: { on: '21:00', off: '09:30', enabled: true, onTemperature: 82 }, alarm: { time: '09:00' } };
  const usual = { asleepMinutes: clock(1), awakeMinutes: clock(8) };
  assert.equal(isNightExpected('00:40', usual, night), true);
  assert.equal(isNightExpected('04:00', usual, night), true);
  assert.equal(isNightExpected('22:30', usual, night), true);
  // An evening doze inside the schedule's hours, well before this sleeper's nights begin
  assert.equal(isNightExpected('21:15', usual, night), false);
  assert.equal(isNightExpected('14:00', usual, night), false);
  // With no nights saved yet, the schedule decides
  assert.equal(isNightExpected('21:15', undefined, night), true);
  assert.equal(isNightExpected('14:00', undefined, night), false);
  // With neither, the hour does
  assert.equal(isNightExpected('14:00', undefined, undefined), false);
  assert.equal(isNightExpected('23:00', undefined, undefined), true);
});

// A made-up piezo signal: slow breathing swells, with heartbeats, drift and noise on top
const makeBreathingSignal = (breathsPerMinute) => {
  const samples = [];
  let seed = 11;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let index = 0; index < BREATHING_WINDOW_SECONDS * BREATHING_SAMPLES_PER_SECOND; index++) {
    const time = index / BREATHING_SAMPLES_PER_SECOND;
    const breath = Math.sin(2 * Math.PI * breathsPerMinute / 60 * time);
    const heartbeat = 0.15 * Math.sin(2 * Math.PI * 1.1 * time);
    samples.push(Math.round(-45000 + 300000 * breath + 300000 * heartbeat + 2000 * time + 40000 * random()));
  }
  return samples;
};

test('a breathing rate is read from slow swells under heartbeats, drift and noise', () => {
  for (const breathsPerMinute of [10, 13, 16, 20, 24]) {
    const estimate = estimateBreathingRate(makeBreathingSignal(breathsPerMinute));
    assert.ok(estimate, `an estimate for ${breathsPerMinute}`);
    assert.ok(Math.abs(estimate.breathsPerMinute - breathsPerMinute) <= 1, `${breathsPerMinute} read as ${estimate.breathsPerMinute}`);
    assert.ok(estimate.confidence >= 0.4, `confidence ${estimate.confidence}`);
  }
  assert.equal(estimateBreathingRate(new Array(15000).fill(-45000)), undefined);
  assert.equal(estimateBreathingRate(makeBreathingSignal(14).slice(0, 5000)), undefined);
});

test('a minute\'s breathing spread needs three readings', () => {
  assert.equal(measureBreathingSpread([14, 15]), undefined);
  assert.equal(measureBreathingSpread([14, 15.5, 13.5, 14]), 2);
});

test('steady breathing is only asked for when the rules say so', () => {
  const stillButUneven = { isInBed: true, movementSeconds: 0, breathingRate: 16, breathingSpread: 6 };
  // By default stillness is enough
  assert.equal(addMinutes(createSleepTracker(), 15, stillButUneven).stage, 'asleep');
  // With the rule on, uneven breathing holds sleep off until it steadies
  const strict = createSleepTracker(() => ({ ...DEFAULT_SLEEP_RULES, maxBreathingSpread: 2 }));
  assert.equal(addMinutes(strict, 20, stillButUneven).stage, 'awake');
  const steady = addMinutes(strict, 15, { isInBed: true, movementSeconds: 0, breathingRate: 14, breathingSpread: 1 });
  assert.equal(steady.stage, 'asleep');
  assert.equal(steady.breathingRate, 14);
  // And with no breathing readings to judge by, stillness decides again
  const blind = createSleepTracker(() => ({ ...DEFAULT_SLEEP_RULES, maxBreathingSpread: 2 }));
  assert.equal(addMinutes(blind, 15, { isInBed: true, movementSeconds: 0 }).stage, 'asleep');
});

test('calibration turns the breathing rule on when the tracker says the sleeper lay awake and still', () => {
  // Lies awake and still for 40 minutes at the start and for 30 in the middle of the night,
  // breathing unevenly both times. Only a tracker that reports time awake can show the second.
  const makeNight = (asleepMinutes) => makeTrackedNight([
    ...new Array(40).fill({ isInBed: true, movementSeconds: 0, breathingSpread: 6 }),
    ...new Array(asleepMinutes).fill({ isInBed: true, movementSeconds: 0, breathingSpread: 1 }),
    ...new Array(6).fill({ isInBed: true, movementSeconds: 30, breathingSpread: 6 }),
    ...new Array(30).fill({ isInBed: true, movementSeconds: 0, breathingSpread: 6 }),
    ...new Array(150).fill({ isInBed: true, movementSeconds: 0, breathingSpread: 1 }),
    ...new Array(10).fill({ isInBed: true, movementSeconds: 45 }),
  ], index => (index >= 40 && index < 40 + asleepMinutes) || (index >= 76 + asleepMinutes && index < 226 + asleepMinutes));
  const nights = [200, 210, 190, 220, 205, 215, 195, 225].map(makeNight);
  assert.ok(countDisagreements(nights[0], DEFAULT_SLEEP_RULES) >= 60);
  const calibrated = calibrateSleepRules(nights);
  assert.equal(calibrated.isTuned, true);
  assert.ok(calibrated.rules.maxBreathingSpread !== undefined, JSON.stringify(calibrated));
  assert.ok(calibrated.agreementPercent >= 95, JSON.stringify(calibrated));
});

test('a minute the sensor said too little in counts neither as still nor as restless', () => {
  const tracker = createSleepTracker();
  addMinutes(tracker, 10, { isInBed: true, movementSeconds: 0 });
  // The sensor goes quiet: stillness is not assumed, so sleep does not begin
  assert.equal(addMinutes(tracker, 20, { isInBed: true }).stage, 'awake');
  assert.equal(addMinutes(tracker, 14, { isInBed: true, movementSeconds: 0 }).stage, 'awake');
  assert.equal(addMinutes(tracker, 1, { isInBed: true, movementSeconds: 0 }).stage, 'asleep');
  // And silence does not wake a sleeper either
  assert.equal(addMinutes(tracker, 10, { isInBed: true }).stage, 'asleep');
});

test('the night curve cools early, returns by late night and ends a degree warm', () => {
  assert.equal(curveOffsetF(0), 0);
  assert.equal(curveOffsetF(0.05), -1);
  assert.equal(curveOffsetF(0.3), -2);
  assert.equal(curveOffsetF(0.85), 0);
  assert.equal(curveOffsetF(1), 1);
  assert.equal(curveOffsetF(1.4), 1);
  assert.equal(curveOffsetF(-1), 0);
});

test('a correction is partly remembered for its part of the night, within a limit', () => {
  assert.equal(nightPartAt(0.2), 'early');
  assert.equal(nightPartAt(0.5), 'middle');
  assert.equal(nightPartAt(0.9), 'late');
  // One degree, one night: too little to show once rounded. Two nights that agree: it shows.
  let learned = learnFromCorrection(NO_LEARNED_OFFSETS, 'early', 1);
  assert.equal(Math.round(learned.early), 0);
  learned = learnFromCorrection(learned, 'early', 1);
  assert.equal(Math.round(learned.early), 1);
  assert.deepEqual({ middle: learned.middle, late: learned.late }, { middle: 0, late: 0 });
  for (let night = 0; night < 20; night++) learned = learnFromCorrection(learned, 'early', 2);
  assert.equal(learned.early, 3);
  assert.ok(Math.abs(learnFromCorrection(learned, 'late', -1).late + 0.3) < 1e-9);
});

test('a room that has moved two degrees moves the bed half as far the other way, never more than two', () => {
  assert.equal(roomOffsetF(68, 70), -1);
  assert.equal(roomOffsetF(68, 66), 1);
  assert.equal(roomOffsetF(68, 68), 0);
  // A reading that wanders less than two degrees is not acted on
  assert.equal(roomOffsetF(68, 69.9), 0);
  assert.equal(roomOffsetF(68, 66.1), 0);
  assert.equal(roomOffsetF(68, 71), -1.5);
  assert.equal(roomOffsetF(60, 80), -2);
  // Nothing without a reading to compare
  assert.equal(roomOffsetF(undefined, 80), 0);
  assert.equal(roomOffsetF(68, undefined), 0);
});

test('the plan adds the parts up by the clock and stays within its limit', () => {
  const base = { baseTemperatureF: 80, learned: NO_LEARNED_OFFSETS, roomAtSleepOnsetF: 68, roomNowF: 68 };
  // In the first half: the curve's two degrees
  const early = planTemperature({ ...base, progress: 0.3 });
  assert.equal(early.targetTemperatureF, 78);
  assert.equal(early.isLimited, false);
  // From 20 to 90 minutes after falling asleep, where deep sleep usually falls: one more
  const deep = planTemperature({ ...base, progress: 0.3, minutesSinceSleepOnset: 45 });
  assert.equal(deep.targetTemperatureF, 77);
  assert.deepEqual(deep.parts, { learnedF: 0, curveF: -2, deepF: -1, roomF: 0 });
  for (const [minutes, expected] of [[19, 78], [20, 77], [89, 77], [90, 78]]) {
    assert.equal(planTemperature({ ...base, progress: 0.3, minutesSinceSleepOnset: minutes }).targetTemperatureF, expected);
  }
  // The end of the night: a degree warm
  assert.equal(planTemperature({ ...base, progress: 1 }).targetTemperatureF, 81);
  // Parts that are not whole numbers and fit within the limit are not reported as cut
  const fractional = planTemperature({ ...base, progress: 0.07, learned: { early: -0.6, middle: 0, late: 0 }, roomNowF: 68.7 });
  assert.equal(fractional.isLimited, false);
  // The bed's own range holds too
  assert.equal(planTemperature({ ...base, baseTemperatureF: 56, progress: 0.3, minutesSinceSleepOnset: 45 }).targetTemperatureF, 55);
});

test('when the parts add up to more than the limit, what the sleeper taught it is cut last', () => {
  const plan = planTemperature({
    baseTemperatureF: 80, progress: 0.3, minutesSinceSleepOnset: 45, learned: { early: -3, middle: 0, late: 0 },
    roomAtSleepOnsetF: 68, roomNowF: 74,
  });
  assert.equal(plan.offsetF, -MAX_OFFSET_F);
  assert.equal(plan.targetTemperatureF, 76);
  assert.equal(plan.isLimited, true);
  // Learned in full, one degree of the curve, and nothing left for the rest
  assert.deepEqual(plan.parts, { learnedF: -3, curveF: -1, deepF: 0, roomF: 0 });
  // A learned preference for warmth and the curve's cooling pull against each other and both count
  const mixed = planTemperature({ baseTemperatureF: 80, progress: 0.3, learned: { early: 3, middle: 0, late: 0 } });
  assert.equal(mixed.targetTemperatureF, 81);
  assert.equal(mixed.isLimited, false);
});

test('one large change by hand teaches no more than the autopilot could itself move', () => {
  // Turned up by fifteen degrees: counted as four, so a little over one is learned
  assert.ok(Math.abs(learnFromCorrection(NO_LEARNED_OFFSETS, 'early', 15).early - 1.2) < 1e-9);
  assert.ok(Math.abs(learnFromCorrection(NO_LEARNED_OFFSETS, 'early', -15).early + 1.2) < 1e-9);
});

test('the plan keeps to the range the bed can be set to when given one', () => {
  const plan = planTemperature({
    baseTemperatureF: 52, progress: 0.3, minutesSinceSleepOnset: 45, learned: NO_LEARNED_OFFSETS, minTemperatureF: 50, maxTemperatureF: 108,
  });
  assert.equal(plan.targetTemperatureF, 50);
  assert.equal(planTemperature({ baseTemperatureF: 108, progress: 1, learned: NO_LEARNED_OFFSETS, minTemperatureF: 50, maxTemperatureF: 108 }).targetTemperatureF, 108);
});

test('the base is the bed-on temperature until a scheduled change comes up, across midnight', () => {
  const night = { power: { on: '22:00', off: '07:30', enabled: true, onTemperature: 82 }, temperatures: { '01:00': 70, '05:30': 76 } };
  assert.equal(findScheduledTemperatureF(night, '23:30'), 82);
  assert.equal(findScheduledTemperatureF(night, '01:00'), 70);
  assert.equal(findScheduledTemperatureF(night, '04:00'), 70);
  assert.equal(findScheduledTemperatureF(night, '06:45'), 76);
  // An afternoon is not this night's to give a temperature for
  assert.equal(isWithinScheduledNight(night, '23:30'), true);
  assert.equal(isWithinScheduledNight(night, '07:29'), true);
  assert.equal(isWithinScheduledNight(night, '07:30'), false);
  assert.equal(isWithinScheduledNight(night, '15:00'), false);
});

test('wake-ups are the breaks in a night\'s sleep, not the time before it or after it', () => {
  const stages = (...runs) => runs.flatMap(([stage, count]) => new Array(count).fill({ stage }));
  assert.equal(countWakeUps(stages(['awake', 20], ['asleep', 200], ['awake', 10])), 0);
  assert.equal(countWakeUps(stages(['awake', 20], ['asleep', 100], ['awake', 6], ['asleep', 90], ['out', 12], ['awake', 4], ['asleep', 60])), 2);
  assert.equal(countWakeUps(stages(['awake', 40])), 0);
});

test('one sleeper seen by both sides is one sleep: the side with the most sleep is kept', () => {
  const stay = (side, startedAtMs, asleep, awake = 0) => ({
    side, startedAtMs, minutes: [...Array(asleep).fill({ stage: 'asleep' }), ...Array(awake).fill({ stage: 'awake' })],
  });
  const nightStartMs = Date.UTC(2026, 10, 18, 7, 0);
  const left = stay('left', nightStartMs, 400, 30);
  const rightSameHours = stay('right', nightStartMs + 20 * 60_000, 90, 300);
  const napLater = stay('right', nightStartMs + 14 * 60 * 60_000, 40, 5);
  const picked = pickBedStays([rightSameHours, napLater, left]);
  assert.deepEqual(picked.map(night => [night.side, night.minutes.length]), [['left', 430], ['right', 45]]);
});

test('one turn on the way to sleep is allowed; two, or a restless minute, start the wait over', () => {
  const still = { isInBed: true, movementSeconds: 1 };
  const turn = { isInBed: true, movementSeconds: 7 };
  const restless = { isInBed: true, movementSeconds: 20 };
  const stageAfter = (minutes) => {
    const tracker = createSleepTracker();
    let state;
    for (const minute of minutes) state = tracker.addMinute(minute);
    return state;
  };
  const fill = (count, minute) => new Array(count).fill(minute);

  // Fifteen minutes with one turn in the middle: asleep, counted from the start of the stretch
  const withOneTurn = stageAfter([...fill(6, still), turn, ...fill(8, still)]);
  assert.equal(withOneTurn.stage, 'asleep');
  assert.equal(withOneTurn.minutesAsleep, 15);
  // Two turns in the stretch, or one restless minute, and it is not sleep yet
  assert.equal(stageAfter([...fill(5, still), turn, ...fill(3, still), turn, ...fill(5, still)]).stage, 'awake');
  assert.equal(stageAfter([...fill(6, still), restless, ...fill(8, still)]).stage, 'awake');
  // Sleep is not dated from a turn, nor declared during one: the stretch begins and ends still
  assert.equal(stageAfter([turn, ...fill(14, still)]).stage, 'awake');
  assert.equal(stageAfter([turn, ...fill(15, still)]).stage, 'asleep');
  assert.equal(stageAfter([...fill(14, still), turn]).stage, 'awake');
});

test('a body is told from a thing on the bed by how hard the piezo is shaken', () => {
  // Figures from one Pod 5: the empty bed's quiet second, a laptop left on it, one person
  // lying still on this side, and the same person felt from the other side
  const emptyBedSwing = 21000;
  assert.equal(isBodyFelt(23400, emptyBedSwing), false);
  assert.equal(isBodyFelt(1150000, emptyBedSwing), true);
  assert.equal(isBodyFelt(225000, emptyBedSwing), true);
  assert.equal(isBodyFelt(emptyBedSwing * BODY_SWING_RATIO, emptyBedSwing), true);
  // Without a reading, or before the empty bed has been measured, it cannot be said
  assert.equal(isBodyFelt(undefined, emptyBedSwing), undefined);
  assert.equal(isBodyFelt(1150000, undefined), undefined);
  assert.equal(isBodyFelt(1150000, 0), undefined);
});

test('the empty bed\'s level needs ten empty minutes and is not raised by a few loud ones', () => {
  let quietSwings = [];
  for (let minute = 0; minute < 9; minute++) quietSwings = addEmptyMinute(quietSwings, 20000 + minute * 100);
  assert.equal(findEmptySwing(quietSwings), undefined);
  quietSwings = addEmptyMinute(quietSwings, 20900);
  assert.equal(findEmptySwing(quietSwings), 20200);
  // Someone sits on the edge for twenty minutes without lying down: the level stays the bed's
  for (let minute = 0; minute < 20; minute++) quietSwings = addEmptyMinute(quietSwings, 600000);
  assert.ok(findEmptySwing(quietSwings) < 21000);
  // Only the newest two hours are kept
  for (let minute = 0; minute < 300; minute++) quietSwings = addEmptyMinute(quietSwings, 15000);
  assert.equal(quietSwings.length, 120);
  assert.equal(findEmptySwing(quietSwings), 15000);
  // A level no empty bed reads is not taken: a dead sensor, or a bed that was not empty
  assert.equal(findEmptySwing(new Array(20).fill(MIN_EMPTY_SWING - 1)), undefined);
  assert.equal(findEmptySwing(new Array(20).fill(300000)), undefined);
  assert.equal(findEmptySwing(new Array(20).fill(MAX_EMPTY_SWING)), MAX_EMPTY_SWING);
});

test('samples sent as text are read one a line, leaving out lines without both times', () => {
  const lines = [
    '2026-11-18T23:12:00-08:00|2026-11-19T01:40:00-08:00|Core',
    ' 2026-11-19T01:40:00-08:00 | 2026-11-19T01:48:00-08:00 | Awake ',
    '',
    '2026-11-19T01:48:00-08:00|2026-11-19T06:30:00-08:00',
    'not a sample',
  ].join('\r\n');
  assert.deepEqual(parseSampleLines(lines), [
    { start: '2026-11-18T23:12:00-08:00', end: '2026-11-19T01:40:00-08:00', value: 'Core' },
    { start: '2026-11-19T01:40:00-08:00', end: '2026-11-19T01:48:00-08:00', value: 'Awake' },
    { start: '2026-11-19T01:48:00-08:00', end: '2026-11-19T06:30:00-08:00', value: undefined },
  ]);
  assert.deepEqual(parseSampleLines(''), []);
});

test('scheduled temperature changes wait only while the autopilot is steering a night', () => {
  assert.equal(isAutopilotSteering(), false);
  setAutopilotSteering(true);
  assert.equal(isAutopilotSteering(), true);
  setAutopilotSteering(false);
  assert.equal(isAutopilotSteering(), false);
});

test('readings the firmware lost are filled in, so a quiet second does not read as movement', () => {
  // A quiet second with a run of lost readings in the middle, as the test Pod sent it
  const quiet = [100, 120, 90, LOST_SAMPLE, LOST_SAMPLE, LOST_SAMPLE, 110, 95];
  assert.deepEqual(fillLostSamples(quiet), [100, 120, 90, 90, 90, 90, 110, 95]);
  assert.equal(measureSwing(fillLostSamples(quiet)), 30);
  assert.ok(measureSwing(quiet) > 2_000_000_000);
  // Lost at the very start: the first good reading stands in. Nothing lost: the same array back.
  assert.deepEqual(fillLostSamples([LOST_SAMPLE, LOST_SAMPLE, 7, 9]), [7, 7, 7, 9]);
  const whole = [1, 2, 3];
  assert.equal(fillLostSamples(whole), whole);
  // A second lost whole is no second at all
  assert.deepEqual(fillLostSamples([LOST_SAMPLE, LOST_SAMPLE]), []);
});

test('a job whose next run is well in the past is found; one a moment late, or waiting, is not', () => {
  const nowMs = Date.UTC(2026, 10, 19, 8, 0);
  const waiting = { name: 'left-monday-power-on', nextRunMs: nowMs + 60_000 };
  assert.equal(findOverdueJob([waiting], nowMs), undefined);
  assert.equal(findOverdueJob([waiting, { name: 'just-late', nextRunMs: nowMs - OVERDUE_BY_MS }], nowMs), undefined);
  assert.equal(findOverdueJob([waiting, { name: 'stuck', nextRunMs: nowMs - OVERDUE_BY_MS - 1 }], nowMs), 'stuck');
  // A job with no run to come (a one-time alarm that has gone off) is not stuck
  assert.equal(findOverdueJob([{ name: 'done' }], nowMs), undefined);
});
