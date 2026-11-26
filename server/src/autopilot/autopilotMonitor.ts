// The autopilot's running half: takes the bed's sensor readings in, follows each sleeper minute
// by minute, saves each stay in bed, and (when switched on in Settings) moves a side's
// temperature by a few degrees around what the schedule set. The decisions are made by the pure
// modules beside this file; this one holds the state and talks to the Pod. Pod 5 only: it needs
// the sensor bus.
//
// The autopilot takes the bed to be one sleeper's: the sides are linked while it is on, the two
// sides are sensed as one sleeper and saved as one stay that follows them across the bed
// (oneSleeper.ts), and one night is steered for the whole bed. With it off, each side is sensed
// and saved on its own.
//
// Who sets the temperature, most to least binding:
//   - a side that is off, in away mode, or under wake-up heat is left alone
//   - a temperature set by hand is held exactly until the end of that third of the night
//   - otherwise the night's base temperature plus the autopilot's offset, approached one
//     setting at a time. The base is the autopilot's own, when one is set in Settings; if
//     not, what the bed was set to when the sleeper fell asleep
// While a night is being steered the temperature is the autopilot's: the schedule's
// temperature changes wait (its bed on, bed off, warm-up and alarm still run). When the night
// ends, or the autopilot is switched off, the bed is given what the schedule wants at that
// hour, or failing that its base.
import { readFileSync, renameSync, writeFileSync } from 'fs';
import moment from 'moment-timezone';
import config from '../config.js';
import logger from '../logger.js';
import schedulesDB from '../db/schedules.js';
import settingsDB from '../db/settings.js';
import { Side } from '../db/schedulesSchema.js';
import { MAX_TEMPERATURE_F, MIN_TEMPERATURE_F, stepTemperatureF, temperatureFToLevel } from '../db/temperatureCurve.js';
import { connectFranken } from '../8sleep/frankenServer.js';
import { getPendingOneOffAlarm } from '../jobs/alarmScheduler.js';
import { setAutopilotSteering } from '../jobs/autopilotSteering.js';
import { isSomeoneInBed } from '../jobs/inBedCheck.js';
import { isManualHoldActive } from '../jobs/manualHold.js';
import { didOneOffAlarmFireWithin } from '../jobs/oneOffAlarmState.js';
import { isPreWarmActive } from '../jobs/preWarmState.js';
import { findNightDay } from '../jobs/scheduleTiming.js';
import { updateDeviceStatus } from '../routes/deviceStatus/updateDeviceStatus.js';
import type { AutopilotSideSnapshot, AutopilotSnapshot, TrackerLink } from './autopilotSnapshot.js';
import { addEmptyMinute, findEmptySwing, isBodyFelt } from './bodySignal.js';
import { BREATHING_WINDOW_SECONDS, estimateBreathingRate, measureBreathingSpread } from './breathingRate.js';
import {
  HEART_RATE_WINDOW_SECONDS, countMovementSeconds, estimateHeartRate, fillLostSamples, findQuietSwing, measureSwing,
} from './heartRate.js';
import { registerManualChangeListener } from './manualChanges.js';
import { deleteNight, listNights, pruneNights, saveNight } from './nightLog.js';
import {
  LearnedOffsets, MAX_OFFSET_F, MAX_STEP_F, NO_LEARNED_OFFSETS, NightPart, POLICY_VERSION, Plan,
  learnFromCorrection, nightPartAt, planTemperature,
} from './nightPlan.js';
import { NightDetail, NightMinute, NightRecord, NightSummary, countWakeUps, pickBedStays } from './nightRecord.js';
import { mergeSides } from './oneSleeper.js';
import {
  NAP_UNDER_MINUTES, UsualSleep, findScheduledTemperatureF, findUsualSleep, isNightExpected, isWithinScheduledNight,
  kindOfSleep,
} from './scheduledBase.js';
import {
  Calibration, CalibrationNight, DEFAULT_SLEEP_RULES, MIN_NIGHTS_TO_CALIBRATE, MinuteSummary, SleepPeriod, SleepRules, SleepState,
  calibrateSleepRules, createSleepTracker,
  mergeSleepPeriods, readTrackerMinutes,
} from './sleepTracker.js';

const SIDES: Side[] = ['left', 'right'];
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// A heart-rate estimate is made this often, from the last HEART_RATE_WINDOW_SECONDS of signal
const ESTIMATE_EVERY_SECONDS = 5;
// An estimate is only kept when the signal repeats this clearly and the sleeper lay still for it
const MIN_CONFIDENCE = 0.45;
const MAX_MOVEMENT_SECONDS_IN_WINDOW = 1;
// A breathing estimate is made this often, from the last BREATHING_WINDOW_SECONDS of signal,
// and kept when it repeats this clearly and the window had little movement
const BREATHING_ESTIMATE_EVERY_SECONDS = 10;
const MIN_BREATHING_CONFIDENCE = 0.4;
const MAX_MOVEMENT_SECONDS_IN_BREATHING_WINDOW = 2;
// A minute's movement is only trusted when this many of its seconds arrived and were not flat.
// Without that check a sensor that stopped sending, or sent a dead line, would read as lying still.
const MIN_SECONDS_HEARD_IN_MINUTE = 45;
// A sleeper's usual sleep and wake times come from this many of their newest saved nights
const USUAL_SLEEP_NIGHTS = 14;
// The bed is not moved more often than this: the water takes minutes to follow
const MIN_MINUTES_BETWEEN_CHANGES = 10;
// With no schedule to say when the night ends, it is taken to be this long
const DEFAULT_NIGHT_HOURS = 8;
// Sensor readings older than this are not used
const SURROUNDINGS_STALE_MS = 2 * MINUTE_MS;
// Out of bed for less than this is the same stay and the same night: a trip to the bathroom
// does not start the night over
const OUT_GRACE_MINUTES = 30;
// A stay shorter than this is not saved: sitting on the bed, making it
const MIN_STAY_MINUTES = 20;
// A stay is cut off at this length, so a sensor stuck on "in bed" cannot grow one file for days
const MAX_STAY_MINUTES = 16 * 60;
// An open stay is written out this often, so a restart loses little
const SAVE_EVERY_MINUTES = 10;
// Calibration looks at this many of the newest nights that a sleep tracker reported on, and
// only at stays long enough to say something
const CALIBRATION_NIGHTS = 14;
const MIN_CALIBRATION_MINUTES = 60;
// A tracker's sleep belongs with a saved stay when they share at least this much time
const MIN_TRACKER_OVERLAP_MS = 10 * MINUTE_MS;
// The quiet level that movement is judged against comes from this many minutes, as the lower
// quartile of each minute's seconds and then of those minutes
const QUIET_SWING_MINUTES = 15;
const QUIET_SWING_FRACTION = 0.25;
// A stay keeps one row a minute; if the loop was held up, no more than this many are filled in
const MAX_MISSED_MINUTES_FILLED = 120;
// Heart rate and breathing are not worked out for now. The breathing estimate reads a rate
// from an empty bed's hum as readily as from a sleeper, and the heart rate comes through in
// too few minutes to use; neither decided anything. The estimators stay (heartRate.ts,
// breathingRate.ts) to be made trustworthy and switched back on here.
const USES_HEART_AND_BREATHING = false;
// Reading a sleeper's habits looks at this many of the newest saved stays
const USUAL_SLEEP_FILES = 40;
// What was learned from the sleeper's corrections and from a linked sleep tracker, and any
// night being steered. Kept beside the settings folder, not in it, so writing it does not make
// the job scheduler rebuild every job.
const STATE_FILE = `${config.dbFolder}autopilot_state.json`;

// A temperature the sleeper set by hand during a night. It is held as it is, not adjusted.
type ManualHold = {
  targetTemperatureF: number;
  // It lasts for the third of the night it was made in
  part: NightPart;
  // How far it was from what the autopilot wanted then, which is what gets learned from it
  correctionF: number;
};

// The sleep the autopilot is steering, from falling asleep until the bed is empty. There is one
// for the whole bed: the autopilot takes the bed to be one sleeper's, and the sides are linked
// while it is on.
type Night = {
  // The side its sleeper fell asleep on, whose schedule and settings it goes by
  side: Side;
  asleepSinceMs: number;
  wakeAtMs: number;
  // The wake time the schedule gave the night, to go back to when a one-time alarm is cancelled
  scheduledWakeAtMs?: number;
  // The temperature the bed was set to when sleep began, by the schedule or by hand: the
  // night's base, unless the autopilot has been given one of its own
  temperatureAtOnsetF: number;
  roomAtOnsetF?: number;
  // The last temperature the autopilot set on each side, so it can tell its own setting from
  // someone else's
  applied?: Partial<Record<Side, number>>;
  hold?: ManualHold;
  // Set on a night found after a restart with nobody in bed: it only remains to be ended
  isEnding?: boolean;
};

// What is sensed and saved for each side, whether or not the autopilot is on
type SideState = {
  tracker: ReturnType<typeof createSleepTracker>;
  // The last seconds of piezo signal, newest last, and each one's swing
  recentSeconds: number[][];
  minuteSwings: number[];
  // Each recent minute's quiet swing, and the quiet level they add up to
  quietSwings: number[];
  quietSwing?: number;
  // The quiet swing of minutes with nothing on the bed, gathered while the empty level is being measured
  emptySwings: number[];
  wasInBed: boolean;
  minuteHeartRates: number[];
  minuteBreathingRates: number[];
  secondsSinceEstimate: number;
  secondsSinceBreathingEstimate: number;
  sleep: SleepState;
  // The stay in bed being saved, and how many minutes in a row the side has been empty during it
  stay?: NightRecord;
  minutesOut: number;
  // Whether this stay's sleep began at a time that looks like the night's
  isNightExpected: boolean;
};

// What the autopilot is doing with the bed
type BedState = {
  night?: Night;
  // Set when a night ended with someone still in bed (at the wake-up time), so that another
  // is not begun until the bed has been empty
  isDoneUntilEmpty?: boolean;
  lastPlan?: Plan;
  lastChangeAtMs?: number;
  lastChangeReason?: string;
};

type SavedState = {
  // Each of these was once kept per side; a file in that shape is read by taking its left side
  learned?: LearnedOffsets | Record<Side, LearnedOffsets>;
  rules?: SleepRules | Record<Side, SleepRules>;
  trackerLink?: TrackerLink;
  night?: Night;
  // Each side's piezo level with the bed empty, kept so a restart with someone in bed still has it
  emptySwing?: Partial<Record<Side, number>>;
};

let learned: LearnedOffsets = { ...NO_LEARNED_OFFSETS };
let rules: SleepRules = DEFAULT_SLEEP_RULES;
let trackerLink: TrackerLink | undefined;
// Each side's piezo level with the bed empty (bodySignal.ts). Measured once, when the Pod is
// set up, and kept in the state file; measured again only when the bed is marked empty by hand.
let emptySwing: Partial<Record<Side, number>> = {};
// A night found in the saved state at start, waiting to be picked up again or undone
let nightFromLastRun: Night | undefined;
const bed: BedState = {};

const newSideState = (): SideState => ({
  tracker: createSleepTracker(() => rules),
  recentSeconds: [],
  minuteSwings: [],
  quietSwings: [],
  emptySwings: [],
  wasInBed: false,
  minuteHeartRates: [],
  minuteBreathingRates: [],
  secondsSinceEstimate: 0,
  secondsSinceBreathingEstimate: 0,
  sleep: { stage: 'out', minutesInBed: 0 },
  minutesOut: 0,
  isNightExpected: false,
});

const sides: Record<Side, SideState> = { left: newSideState(), right: newSideState() };
type Reading = { value: number; atMs: number };
let room: { temperatureF: number; humidityPercent?: number; atMs: number } | undefined;
let hubRoom: Reading | undefined;
const surfaces: Partial<Record<Side, Reading>> = {};
const pressures: Partial<Record<Side, Reading>> = {};
let lastPiezoAtMs = 0;

const median = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
};

const roundTo = (value: number | undefined, places: number) => (
  value === undefined ? undefined : Math.round(value * 10 ** places) / 10 ** places
);
// A reading's value while it is fresh
const fresh = (reading: Reading | undefined, nowMs: number) => (
  reading && nowMs - reading.atMs < SURROUNDINGS_STALE_MS ? reading.value : undefined
);
const readRoomF = (nowMs: number) => (room && nowMs - room.atMs < SURROUNDINGS_STALE_MS ? room.temperatureF : undefined);

// A wake time further off than this is not this night's
const MAX_HOURS_TO_WAKE = 14;

// When a one-time alarm is waiting for this side, the moment it goes off: it stands in for the
// night's scheduled alarm, so it is the night's wake time too
const findOneOffWakeMs = (side: Side, nowMs: number): number | undefined => {
  const now = moment.tz(nowMs, settingsDB.data.timeZone);
  const firesAt = getPendingOneOffAlarm(settingsDB.data, side, now);
  return firesAt && firesAt.diff(now, 'hours') <= MAX_HOURS_TO_WAKE ? firesAt.valueOf() : undefined;
};

// The base temperature the autopilot has been given in Settings, when it has one
const readOwnBaseF = (): number | undefined => settingsDB.data.autopilot.baseTemperatureF ?? undefined;
// How far through a night is, from 0 at falling asleep to 1 at the wake time
const nightProgress = (night: Night, nowMs: number) => (
  Math.min(1, (nowMs - night.asleepSinceMs) / (night.wakeAtMs - night.asleepSinceMs))
);

const saveState = () => {
  try {
    const state: SavedState = { learned, rules, trackerLink, night: bed.night, emptySwing };
    // Written beside the file and then moved over it, so a crash mid-write cannot leave half a file
    writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state));
    renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  } catch (error: unknown) {
    logger.warn(`Autopilot could not save its state: ${String(error)}`);
  }
};

// A night under way runs to a one-time alarm set for it, also one set after the sleeper dropped
// off. Without this the night ended at the scheduled alarm it replaced, and the bed went back
// to the schedule's temperature hours before the sleeper was due to wake.
const followOneOffAlarm = (night: Night, nowMs: number) => {
  const wakeAtMs = findOneOffWakeMs(night.side, nowMs) ?? night.scheduledWakeAtMs ?? night.wakeAtMs;
  if (wakeAtMs === night.wakeAtMs) return;
  night.wakeAtMs = wakeAtMs;
  saveState();
};

// Until a side has its empty level, takes each minute with nothing on the bed toward it. Once
// enough minutes agree on a level an empty bed can read, it is set and kept.
const measureEmptySwing = (side: Side, quietSecond: number) => {
  if (emptySwing[side] !== undefined) return;
  const state = sides[side];
  state.emptySwings = addEmptyMinute(state.emptySwings, quietSecond);
  const level = findEmptySwing(state.emptySwings);
  if (level === undefined) return;
  emptySwing[side] = level;
  state.emptySwings = [];
  logger.info(`Autopilot: ${side} side's empty-bed piezo level set to ${Math.round(level)}`);
  saveState();
};

// The bed has been marked empty by hand (Settings > In-bed detection): the piezo level of the
// empty bed is measured afresh, as the capacitive baseline is
export function forgetEmptySwing() {
  emptySwing = {};
  for (const side of SIDES) sides[side].emptySwings = [];
  saveState();
}

// A stay in bed that begins with the minute just ended
const newStay = (side: Side, nowMs: number): NightRecord => ({
  side, startedAtMs: nowMs - MINUTE_MS, minutes: [], policy: POLICY_VERSION, emptySwing: roundTo(emptySwing[side], 0),
});

// Reads a heart rate from the newest seconds of signal, when it is time to and they are clean
const estimateHeartRateNow = (state: SideState) => {
  state.secondsSinceEstimate++;
  if (state.secondsSinceEstimate < ESTIMATE_EVERY_SECONDS || state.recentSeconds.length < HEART_RATE_WINDOW_SECONDS) return;
  state.secondsSinceEstimate = 0;
  const window = state.recentSeconds.slice(-HEART_RATE_WINDOW_SECONDS);
  // A heartbeat cannot be read through a turn in bed, so a window with movement is passed over
  if (countMovementSeconds(window.map(measureSwing), state.quietSwing) > MAX_MOVEMENT_SECONDS_IN_WINDOW) return;
  const estimate = estimateHeartRate(window.flat());
  if (estimate && estimate.confidence >= MIN_CONFIDENCE) state.minuteHeartRates.push(estimate.beatsPerMinute);
};

// The same for breathing, which needs a longer stretch and forgives a little movement
const estimateBreathingRateNow = (state: SideState) => {
  state.secondsSinceBreathingEstimate++;
  if (state.secondsSinceBreathingEstimate < BREATHING_ESTIMATE_EVERY_SECONDS || state.recentSeconds.length < BREATHING_WINDOW_SECONDS) return;
  state.secondsSinceBreathingEstimate = 0;
  if (countMovementSeconds(state.recentSeconds.map(measureSwing), state.quietSwing) > MAX_MOVEMENT_SECONDS_IN_BREATHING_WINDOW) return;
  const estimate = estimateBreathingRate(state.recentSeconds.flat());
  if (estimate && estimate.confidence >= MIN_BREATHING_CONFIDENCE) state.minuteBreathingRates.push(estimate.breathsPerMinute);
};

// One second of a side's piezo signal, as the sensor bus delivers it
export function recordPiezoSecond(side: Side, sentSamples: number[]) {
  lastPiezoAtMs = Date.now();
  // A second that was lost whole says nothing, and is not counted as heard
  const samples = fillLostSamples(sentSamples);
  if (samples.length === 0) return;
  const state = sides[side];
  state.recentSeconds.push(samples);
  if (state.recentSeconds.length > BREATHING_WINDOW_SECONDS) state.recentSeconds.shift();
  state.minuteSwings.push(measureSwing(samples));
  if (!USES_HEART_AND_BREATHING) return;
  estimateHeartRateNow(state);
  estimateBreathingRateNow(state);
}

// How far a side's pressure sensors read above the empty bed, as the presence detector has it
export function recordPressure(side: Side, value: number) {
  pressures[side] = { value, atMs: Date.now() };
}

// The air at the cover and the mattress surface under each side, in °F
export function recordSurroundings(reading: { roomF?: number; humidityPercent?: number; surfaceF: Partial<Record<Side, number>> }) {
  const atMs = Date.now();
  if (reading.roomF !== undefined) room = { temperatureF: reading.roomF, humidityPercent: reading.humidityPercent, atMs };
  for (const side of SIDES) {
    const temperatureF = reading.surfaceF[side];
    if (temperatureF !== undefined) surfaces[side] = { value: temperatureF, atMs };
  }
}

// The air at the hub on the floor, in °F. Saved with each night as a second opinion on the
// room, to show whether the reading at the cover follows the room or the sleeper. Not acted on.
export function recordHubRoom(temperatureF: number) {
  hubRoom = { value: temperatureF, atMs: Date.now() };
}

// Whether the bed is taken to be one sleeper's: the autopilot is on, which keeps the sides linked
const isOneSleepersBed = (): boolean => settingsDB.data.autopilot.enabled && settingsDB.data.linkSides;

// The side whose state speaks for a side. On one sleeper's bed that is whichever side is
// following the sleeper, so both sides report the same sleep.
const stateShownFor = (side: Side): SideState => {
  if (!isOneSleepersBed() || sides[side].sleep.stage !== 'out') return sides[side];
  const followingSide = SIDES.find(candidate => sides[candidate].sleep.stage !== 'out');
  return followingSide ? sides[followingSide] : sides[side];
};

// A sleep is steered from the start when it began at a time that looks like the night's;
// otherwise only once it has lasted too long to be a nap
const maySteer = (state: SideState): boolean => state.isNightExpected || (state.sleep.minutesAsleep ?? 0) >= NAP_UNDER_MINUTES;

// What each side senses, with what the autopilot is doing for the bed repeated on both
// When the sleeper on any of these sides fell asleep in the stay they are in now, by the bed's
// own judgement: the earliest, where more than one side has seen sleep. Undefined until one has.
export function findAsleepSinceMs(chosenSides: Side[]): number | undefined {
  const onsets = chosenSides.flatMap((side) => {
    const asleepAtMs = sides[side].stay?.asleepAtMs;
    return asleepAtMs === undefined ? [] : [asleepAtMs];
  });
  return onsets.length > 0 ? Math.min(...onsets) : undefined;
}

export function getAutopilotSnapshot(nowMs: number = Date.now()): AutopilotSnapshot {
  const describe = (side: Side, shown: SideState = stateShownFor(side)): AutopilotSideSnapshot => ({
    stage: shown.sleep.stage,
    sleepKind: shown.sleep.stage !== 'asleep' ? undefined
      : bed.night || maySteer(shown) ? 'night' : 'nap',
    heartRate: roundTo(shown.sleep.heartRate, 0),
    breathingRate: roundTo(shown.sleep.breathingRate, 0),
    minutesAsleep: shown.sleep.minutesAsleep,
    offsetF: bed.night ? bed.lastPlan?.offsetF : undefined,
    holdingF: bed.night?.hold?.targetTemperatureF,
    lastChange: bed.lastChangeReason,
    learned,
    rules,
    tracker: trackerLink,
  });
  const roomF = readRoomF(nowMs);
  return {
    available: nowMs - lastPiezoAtMs < SURROUNDINGS_STALE_MS,
    enabled: settingsDB.data.autopilot.enabled,
    room: roomF === undefined ? undefined : { temperatureF: Math.round(roomF), humidityPercent: room?.humidityPercent },
    left: describe('left'),
    right: describe('right'),
  };
}

const summarise = ({ minutes, ...rest }: NightRecord): NightSummary => {
  const asleep = minutes.filter(minute => minute.stage === 'asleep');
  const middle = (values: (number | undefined)[]) => median(values.flatMap(value => (value === undefined ? [] : [value])));
  return {
    ...rest,
    minutesLogged: minutes.length,
    heartRate: middle(asleep.map(minute => minute.heartRate)),
    breathingRate: middle(asleep.map(minute => minute.breathingRate)),
    wakeUps: countWakeUps(minutes),
  };
};

type NightRange = { startedFromMs?: number; startedUntilMs?: number; limit?: number };

// Saved stays with any still under way, newest first
const readAllNights = (side?: Side, range: NightRange = {}): NightRecord[] => {
  const open = SIDES.flatMap(openSide => (sides[openSide].stay && (!side || openSide === side) ? [sides[openSide].stay] : []));
  const isOpen = (night: NightRecord) => open.some(stay => stay.side === night.side && stay.startedAtMs === night.startedAtMs);
  const saved = listNights({ side, ...range }).filter(night => !isOpen(night));
  return [...open, ...saved].sort((first, second) => second.startedAtMs - first.startedAtMs);
};

// The stays that ended on a calendar day (YYYY-MM-DD, in the Pod's time zone), in full, longest
// first. A night belongs to the morning it ended on, so today's date shows last night. With a
// side, that side's own record; without, the bed's as one sleeper's: where both sides saw the
// same hours, the side with the most sleep.
export function getNightsOn(date: string, side?: Side): NightDetail[] {
  const dayStartMs = moment.tz(date, 'YYYY-MM-DD', settingsDB.data.timeZone).valueOf();
  const endDate = (night: NightRecord) => moment
    .tz(night.startedAtMs + night.minutes.length * MINUTE_MS, settingsDB.data.timeZone)
    .format('YYYY-MM-DD');
  // A stay that ended on this day began no earlier than its longest length before the day did
  // A stay is saved when the server stops, however brief, so that a restart loses little. The
  // short pieces that leaves behind are not stays anyone would look for; one still under way is.
  const isUnderWay = (night: NightRecord) => SIDES.some(openSide => sides[openSide].stay === night);
  const isWorthShowing = (night: NightRecord) => night.minutes.length >= MIN_STAY_MINUTES || isUnderWay(night);
  const stays = readAllNights(side, { startedFromMs: dayStartMs - (MAX_STAY_MINUTES + 60) * MINUTE_MS, startedUntilMs: dayStartMs + DAY_MS })
    .filter(night => endDate(night) === date && isWorthShowing(night));
  return (side ? stays : pickBedStays(stays))
    .sort((first, second) => second.minutes.length - first.minutes.length)
    .map(night => ({ ...summarise(night), minutes: night.minutes }));
}

// What is saved, for keeping a copy off the Pod: the nights of the last `days` days with their
// minute rows, and what has been learned
export function getNightsExport(days: number, nowMs: number = Date.now()) {
  return {
    exportedAt: new Date(nowMs).toISOString(),
    days,
    timeZone: settingsDB.data.timeZone,
    learned,
    rules,
    trackerLink,
    nights: readAllNights(undefined, { startedFromMs: nowMs - days * DAY_MS }),
  };
}

// Saved stays in bed without their minute rows, newest first, with any stay still under way
export function getNightSummaries(limit: number): NightSummary[] {
  return readAllNights(undefined, { limit }).slice(0, limit).map(summarise);
}

// When the bed's sleeper has been falling asleep and waking, from their saved nights
const readUsualSleep = (): UsualSleep | undefined => {
  const clockMinutes = (atMs: number) => {
    const at = moment.tz(atMs, settingsDB.data.timeZone);
    return at.hours() * 60 + at.minutes();
  };
  return findUsualSleep(listNights({ limit: USUAL_SLEEP_FILES })
    .filter(night => night.kind === 'night')
    .slice(0, USUAL_SLEEP_NIGHTS)
    .flatMap(night => (night.asleepAtMs === undefined || night.awakeAtMs === undefined
      ? []
      : [{ asleepMinutes: clockMinutes(night.asleepAtMs), awakeMinutes: clockMinutes(night.awakeAtMs) }])));
};

const overlapMs = (night: NightRecord, period: SleepPeriod) => (
  Math.min(night.startedAtMs + night.minutes.length * MINUTE_MS, period.awakeAtMs) - Math.max(night.startedAtMs, period.asleepAtMs)
);

// How many of the sleeps a tracker sent are kept to show what arrived
const LAST_SLEEPS_KEPT = 4;

// Fits the sleep rules to the newest saved nights that a sleep tracker reported on, minute by
// minute, and puts them in use
const fitRulesToTracker = (): Calibration => {
  const nights: CalibrationNight[] = readAllNights()
    .filter(night => night.tracker && night.kind === 'night' && night.minutes.length >= MIN_CALIBRATION_MINUTES)
    .slice(0, CALIBRATION_NIGHTS)
    .flatMap(night => (night.tracker ? [{
      minutes: night.minutes.map(minute => ({
        isInBed: minute.stage !== 'out',
        movementSeconds: minute.movementSeconds,
        // Left out while breathing is switched off, so no rule is fitted to readings not to be trusted
        breathingSpread: USES_HEART_AND_BREATHING ? minute.breathingSpread : undefined,
      })),
      trackerAsleep: readTrackerMinutes(night.tracker, night.startedAtMs, night.minutes.length),
    }] : []));
  const calibration = calibrateSleepRules(nights);
  rules = calibration.rules;
  return calibration;
};

// Fits the rules again after a tracker sent its sleeps, and notes how well the bed agrees with it
const recalibrate = (source: string, nowMs: number, periods: SleepPeriod[], matchedStays: number) => {
  const calibration = fitRulesToTracker();
  trackerLink = {
    source,
    syncedAt: new Date(nowMs).toISOString(),
    nights: calibration.nights,
    agreementPercent: calibration.agreementPercent,
    isTuned: calibration.isTuned,
    nightsNeeded: MIN_NIGHTS_TO_CALIBRATE,
    lastSleeps: periods.slice(-LAST_SLEEPS_KEPT).map(({ asleepAtMs, awakeAtMs }) => ({ asleepAtMs, awakeAtMs })),
    lastMatchedStays: matchedStays,
  };
  saveState();
  logger.debug(`Autopilot: sleep rules after ${calibration.nights} tracker nights: ${JSON.stringify(calibration)}`);
};

// Rules saved by an older version were fitted its way. Fitting them again from the same saved
// nights when the autopilot starts means a change to the fitting applies at once, not only once
// the tracker next sends.
const refitSavedRules = () => {
  if (!trackerLink) return;
  const calibration = fitRulesToTracker();
  trackerLink = { ...trackerLink, nights: calibration.nights, agreementPercent: calibration.agreementPercent, isTuned: calibration.isTuned };
  saveState();
  logger.debug(`Autopilot: sleep rules fitted again on start: ${JSON.stringify(calibration)}`);
};

// A worn sleep tracker's account of when the bed's sleeper slept. Its sleeps are filed with
// every saved stay in bed they overlap, on either side unless one is named (a night split in
// two by a restart gets both halves), and the sleep rules are then fitted again. Sending the
// same sleeps again changes nothing. Returns how many stays were matched.
export function applyTrackerSleep(source: string, periods: SleepPeriod[], side?: Side, nowMs: number = Date.now()): number {
  let matched = 0;
  for (const night of readAllNights(side)) {
    const overlapping = periods.filter(period => overlapMs(night, period) >= MIN_TRACKER_OVERLAP_MS);
    if (overlapping.length === 0) continue;
    night.tracker = { source, receivedAtMs: nowMs, ...mergeSleepPeriods(overlapping) };
    saveNight(night);
    matched++;
  }
  recalibrate(source, nowMs, periods, matched);
  return matched;
}

const describePlan = (plan: Plan): string => {
  const reasons = [
    plan.parts.learnedF !== 0 && 'your past changes',
    plan.parts.curveF !== 0 && 'time of night',
    plan.parts.deepF !== 0 && 'first sleep cycle',
    plan.parts.roomF !== 0 && 'the room',
  ].filter(Boolean);
  const direction = plan.offsetF === 0 ? 'the set temperature' : `${Math.abs(plan.offsetF)}°F ${plan.offsetF < 0 ? 'cooler' : 'warmer'}`;
  return `heading for ${direction}${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}${plan.isLimited ? ', at its limit' : ''}`;
};

const formatClock = (timeMs: number) => moment.tz(timeMs, settingsDB.data.timeZone).format('h:mm A');

type PodStatus = Awaited<ReturnType<Awaited<ReturnType<typeof connectFranken>>['getDeviceStatus']>>;
// What a minute's row carries beyond the sleep summary
type MinuteReadings = Pick<NightMinute, 'swingLow' | 'swingMid' | 'swingHigh' | 'targetF' | 'waterF'>;
// A minute as it is followed and saved for a side: what was sensed, and the side whose sensors
// it came from (the other one, when a lone sleeper has moved over)
type SensedMinute = { minute: MinuteSummary; readings: MinuteReadings; sensedOn: Side };
const readPodStatus = async (): Promise<PodStatus> => (await connectFranken()).getDeviceStatus();

// The bed takes about two hundred settings, not every whole degree: at the cold end several
// degrees are one setting. Two temperatures that are the same setting are the same to the bed,
// and the Pod reports back whichever of them it likes.
const isSameSetting = (firstF: number, secondF: number) => temperatureFToLevel(firstF) === temperatureFToLevel(secondF);

// The bed's next setting one step from where it is toward where the plan wants it. Nothing
// when it is there already, or when the next setting would go past the plan (the coldest
// setting is nine degrees below the one above it).
const findNextStep = (currentF: number, wantedF: number): number | undefined => {
  const direction = Math.sign(wantedF - currentF);
  if (direction === 0) return undefined;
  const steppedF = stepTemperatureF(currentF, direction * MAX_STEP_F, MIN_TEMPERATURE_F, MAX_TEMPERATURE_F);
  const isPastThePlan = direction > 0 ? steppedF > wantedF : steppedF < wantedF;
  return isPastThePlan ? undefined : steppedF;
};

// The temperature the schedule wants for a side now; nothing at an hour it does not cover
const findScheduledF = async (side: Side, nowMs: number): Promise<number | undefined> => {
  await schedulesDB.read();
  const now = moment.tz(nowMs, settingsDB.data.timeZone);
  const scheduledNight = schedulesDB.data[side][findNightDay(now, schedulesDB.data[side])];
  const clock = now.format('HH:mm');
  const isCovered = scheduledNight.power.enabled && isWithinScheduledNight(scheduledNight, clock);
  return isCovered ? findScheduledTemperatureF(scheduledNight, clock) : undefined;
};

export class AutopilotMonitor {
  private minuteTimer?: ReturnType<typeof setInterval>;
  private hasCheckedLastRun = false;
  private isMinuteRunning = false;

  start() {
    try {
      const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SavedState;
      const savedLearned = saved.learned && 'left' in saved.learned ? saved.learned.left : saved.learned;
      const savedRules = saved.rules && 'left' in saved.rules ? saved.rules.left : saved.rules;
      learned = { ...NO_LEARNED_OFFSETS, ...savedLearned };
      rules = { ...DEFAULT_SLEEP_RULES, ...savedRules };
      trackerLink = saved.trackerLink;
      nightFromLastRun = saved.night;
      emptySwing = { ...saved.emptySwing };
    } catch {
      // Nothing saved yet
    }
    try {
      refitSavedRules();
    } catch (error) {
      logger.warn(`Autopilot: could not fit the sleep rules again, keeping the saved ones: ${String(error)}`);
    }
    registerManualChangeListener((side, temperatureF, isPersonsOwn) => this.noteManualChange(side, temperatureF, isPersonsOwn));
    this.minuteTimer = setInterval(() => void this.runMinute(), MINUTE_MS);
  }

  stop() {
    clearInterval(this.minuteTimer);
    registerManualChangeListener(undefined);
    for (const side of SIDES) {
      if (sides[side].stay) saveNight(sides[side].stay);
    }
    saveState();
  }

  // A person set a temperature (the app, a request to the API, a side button), on either side:
  // the bed is one sleeper's. While the autopilot has a night under way, that temperature is
  // held exactly as set, and how far it was from what the autopilot wanted is learned from
  // when the hold ends. A temperature a rule of theirs set (`isPersonsOwn` false) is held the
  // same way but teaches nothing.
  private noteManualChange(side: Side, temperatureF: number, isPersonsOwn: boolean) {
    const nowMs = Date.now();
    const night = bed.night;
    if (!settingsDB.data.autopilot.enabled || !night) return;
    // The same setting sent again (a page refreshing, the other linked side) is not a new decision
    const standingF = night.hold ? night.hold.targetTemperatureF : night.applied?.[side];
    if (standingF !== undefined && isSameSetting(standingF, temperatureF)) return;
    const wantedF = isPersonsOwn ? bed.lastPlan?.targetTemperatureF : undefined;
    night.hold = {
      targetTemperatureF: temperatureF,
      part: nightPartAt(nightProgress(night, nowMs)),
      correctionF: wantedF === undefined ? 0 : temperatureF - wantedF,
    };
    bed.lastChangeReason = `${formatClock(nowMs)}: holding the ${temperatureF}°F you set`;
    logger.debug(`Autopilot: set by hand to ${temperatureF}°F; holding it for the ${night.hold.part} part of the night`);
    saveState();
  }

  // A hold has run its course: what it says about the sleeper's taste is kept for later
  // nights, and the bed is the autopilot's to move again from where the hold left it
  private endHold(night: Night) {
    const hold = night.hold;
    if (!hold) return;
    if (hold.correctionF !== 0) learned = learnFromCorrection(learned, hold.part, hold.correctionF);
    night.hold = undefined;
    saveState();
  }

  // Once a minute: sum up the minute for each side and save it, then act for the bed. Each
  // step is fenced off, so trouble on one side or with the Pod does not cost the other its row.
  private async runMinute() {
    // A minute held up past the next one (a Pod slow to answer) is not run twice at once
    if (this.isMinuteRunning) return;
    this.isMinuteRunning = true;
    try {
      await this.runMinuteOnce();
    } finally {
      this.isMinuteRunning = false;
    }
  }

  private async runMinuteOnce() {
    const nowMs = Date.now();
    // A Pod whose sensors have never been heard from has nothing to follow. A night left by
    // the last run is still dealt with, so its offset is taken out even with the sensors silent.
    if (lastPiezoAtMs === 0 && !nightFromLastRun && !bed.night) return;
    let podStatus: PodStatus | undefined;
    try {
      await settingsDB.read();
      podStatus = await readPodStatus();
    } catch (error: unknown) {
      logger.debug(`Autopilot could not read the Pod this minute: ${String(error)}`);
    }
    const sensed: Partial<Record<Side, SensedMinute>> = {};
    for (const side of SIDES) {
      try {
        sensed[side] = this.senseSide(side, nowMs, podStatus);
      } catch (error: unknown) {
        logger.error(error);
      }
    }
    const followed = this.followOneSleeper(sensed, nowMs);
    for (const side of SIDES) {
      const sensedMinute = followed[side];
      if (!sensedMinute) continue;
      try {
        await this.followSide(side, sensedMinute, nowMs);
      } catch (error: unknown) {
        logger.error(error);
      }
    }
    try {
      await this.steerBed(nowMs, podStatus);
    } catch (error: unknown) {
      logger.error(error);
    }
  }

  // On one sleeper's bed, the two sides' minutes become one, given to the side that holds the
  // stay; the other side is followed as empty. A sleeper who moves over in the night is then
  // the same sleeper, still asleep, in the same record. Otherwise each side keeps its own.
  private followOneSleeper(sensed: Partial<Record<Side, SensedMinute>>, nowMs: number): Partial<Record<Side, SensedMinute>> {
    const { left, right } = sensed;
    // A side that could not be sensed this minute leaves the other to be followed on its own
    if (!isOneSleepersBed() || !left || !right) return sensed;
    const staysByStart = SIDES.filter(side => sides[side].stay)
      .sort((first, second) => (sides[first].stay?.startedAtMs ?? 0) - (sides[second].stay?.startedAtMs ?? 0));
    const bedMinute = mergeSides(
      { left: left.minute, right: right.minute },
      { staySide: staysByStart[0], pressure: { left: fresh(pressures.left, nowMs), right: fresh(pressures.right, nowMs) } },
    );
    const otherSide: Side = bedMinute.staySide === 'left' ? 'right' : 'left';
    const body = sensed[bedMinute.bodySide ?? bedMinute.staySide] ?? left;
    return {
      [bedMinute.staySide]: {
        ...body,
        minute: { ...body.minute, isInBed: bedMinute.isInBed, movementSeconds: bedMinute.movementSeconds },
      },
      [otherSide]: { ...sensed[otherSide], minute: { isInBed: false } },
    };
  }

  // What one side's sensors made of the minute just ended
  private senseSide(side: Side, nowMs: number, podStatus: PodStatus | undefined): SensedMinute {
    const state = sides[side];
    const swings = state.minuteSwings;
    const sortedSwings = [...swings].sort((first, second) => first - second);
    const swingAt = (fraction: number) => sortedSwings[Math.min(sortedSwings.length - 1, Math.floor(sortedSwings.length * fraction))];
    const isSignalGood = swings.length >= MIN_SECONDS_HEARD_IN_MINUTE && swingAt(0.5) > 0;
    const quietSecond = isSignalGood ? swingAt(QUIET_SWING_FRACTION) : undefined;

    // The capacitive sensors say something is on the side; the piezo says whether it is a
    // body. A side with a thing on it (a laptop) is an empty side: no stay, no sleep. Where the
    // piezo cannot say, the capacitive sensors are taken at their word, as before.
    if (quietSecond !== undefined && !SIDES.some(isSomeoneInBed)) measureEmptySwing(side, quietSecond);
    const isInBed = isSomeoneInBed(side) && isBodyFelt(quietSecond, emptySwing[side]) !== false;
    // An empty bed is far quieter than a sleeper lying still, so the quiet level starts afresh
    // when someone gets in or out
    if (isInBed !== state.wasInBed) state.quietSwings = [];
    state.wasInBed = isInBed;
    if (quietSecond !== undefined) {
      state.quietSwings.push(quietSecond);
      if (state.quietSwings.length > QUIET_SWING_MINUTES) state.quietSwings.shift();
    }
    state.quietSwing = findQuietSwing(state.quietSwings);

    const minute: MinuteSummary = {
      isInBed,
      heartRate: median(state.minuteHeartRates),
      movementSeconds: isSignalGood ? countMovementSeconds(swings, state.quietSwing) : undefined,
      breathingRate: median(state.minuteBreathingRates),
      breathingSpread: measureBreathingSpread(state.minuteBreathingRates),
    };
    state.minuteHeartRates = [];
    state.minuteBreathingRates = [];
    state.minuteSwings = [];
    const readings: MinuteReadings = {
      swingLow: quietSecond,
      swingMid: isSignalGood ? swingAt(0.5) : undefined,
      swingHigh: isSignalGood ? swingAt(0.9) : undefined,
      targetF: podStatus?.[side].isOn ? podStatus[side].targetTemperatureF : undefined,
      waterF: roundTo(podStatus?.[side].measuredTemperatureF ?? podStatus?.[side].currentTemperatureF, 1),
    };
    return { minute, readings, sensedOn: side };
  }

  // One side's minute: its sleep state, and its row in the stay being saved
  private async followSide(side: Side, sensedMinute: SensedMinute, nowMs: number) {
    const state = sides[side];
    state.sleep = state.tracker.addMinute(sensedMinute.minute);
    if (state.sleep.stage === 'asleep') await this.noteAsleep(side, nowMs);
    this.logMinute(side, sensedMinute, nowMs);
  }

  // What the autopilot does for the bed this minute: end a night that is over, begin one when
  // someone has fallen asleep, and steer the one under way
  private async steerBed(nowMs: number, podStatus: PodStatus | undefined) {
    if (!this.hasCheckedLastRun) {
      this.hasCheckedLastRun = true;
      this.pickUpLastRun();
    }
    const isBedEmpty = !SIDES.some(side => sides[side].stay);
    if (isBedEmpty) bed.isDoneUntilEmpty = false;
    const isEnabled = settingsDB.data.autopilot.enabled;
    const night = bed.night;
    if (night) {
      // A night ends when the autopilot is switched off, when the whole bed has been empty for
      // longer than a trip out of it, and at the wake-up time, from when the bed is the
      // schedule's and the alarm's again. A one-time alarm that has gone off during the night
      // is its wake-up time, however early.
      followOneOffAlarm(night, nowMs);
      const hasAlarmGoneOff = didOneOffAlarmFireWithin(night.side, nowMs - night.asleepSinceMs, nowMs);
      const isOver = !isEnabled || isBedEmpty || night.isEnding || nowMs >= night.wakeAtMs || hasAlarmGoneOff
        || nowMs - night.asleepSinceMs > MAX_STAY_MINUTES * MINUTE_MS;
      if (isOver) {
        // The offset comes out before the night is let go of, so a Pod that cannot be reached
        // now is tried again next minute
        if (!podStatus) return;
        const backToF = await this.withdraw(night, podStatus, nowMs);
        bed.lastChangeReason = `${formatClock(nowMs)}: the night is over${backToF === undefined ? '' : `, back to ${backToF}°F`}`;
        this.release();
        bed.isDoneUntilEmpty = !isBedEmpty;
        return;
      }
    }
    if (!isEnabled || !podStatus) return;
    if (!bed.night && !bed.isDoneUntilEmpty) await this.beginNight(nowMs, podStatus);
    // While a night is being steered the schedule's temperature changes are told to wait
    // (temperatureScheduler.ts asks before each one)
    setAutopilotSteering(bed.night !== undefined);
    const isSomeoneThere = SIDES.some(side => sides[side].sleep.stage !== 'out');
    if (bed.night && isSomeoneThere) await this.steer(bed.night, nowMs, podStatus);
  }

  // After a restart: a night that was being steered carries on if someone is still in bed, so
  // the curve does not start over at four in the morning. Otherwise it is marked to be ended,
  // which takes its offset out.
  private pickUpLastRun() {
    const night = nightFromLastRun;
    nightFromLastRun = undefined;
    if (!night) return;
    bed.night = night;
    const canCarryOn = settingsDB.data.autopilot.enabled && SIDES.some(isSomeoneInBed);
    if (canCarryOn) logger.debug('Autopilot: carrying on the night after a restart');
    else night.isEnding = true;
  }

  // Marks the stay with when sleep began and how late it has lasted so far. Whether it is a nap
  // is a matter of its length, so that is settled as it goes; whether it looks like the night's
  // sleep, which decides if the autopilot steers it from the start, is judged once at its onset.
  private async noteAsleep(side: Side, nowMs: number) {
    const state = sides[side];
    state.stay ??= newStay(side, nowMs);
    const stay = state.stay;
    if (stay.stillSinceMs === undefined || stay.asleepConfirmedAtMs === undefined) {
      const stillSinceMs = Math.max(stay.startedAtMs, nowMs - (state.sleep.minutesAsleep ?? 0) * MINUTE_MS);
      await schedulesDB.read();
      const stillSince = moment.tz(stillSinceMs, settingsDB.data.timeZone);
      const scheduledNight = schedulesDB.data[side][findNightDay(stillSince, schedulesDB.data[side])];
      stay.stillSinceMs = stillSinceMs;
      // Sleep is only known once the stillness has lasted; this is when the bed could first act on it
      stay.asleepConfirmedAtMs = nowMs;
      state.isNightExpected = isNightExpected(stillSince.format('HH:mm'), readUsualSleep(), scheduledNight);
      const hint = state.isNightExpected ? '' : ', at an hour that looks like a nap';
      logger.debug(`Autopilot: ${side} side fell asleep at ${stillSince.format()}${hint}`);
    }
    stay.awakeAtMs = nowMs;
    stay.kind = kindOfSleep((nowMs - stay.stillSinceMs) / MINUTE_MS);
    // A night is counted from when the stillness began. A nap, or a short lie-down that only
    // looked like sleep, is counted from when it was first taken for sleep and no earlier:
    // fifteen minutes of lying still are not added to it after the fact.
    stay.asleepAtMs = stay.kind === 'night' ? stay.stillSinceMs : stay.asleepConfirmedAtMs;
  }

  // Adds the minute to the stay being saved. The stay ends once the side has been empty for
  // longer than a trip out of bed takes.
  private logMinute(side: Side, { minute, readings, sensedOn }: SensedMinute, nowMs: number) {
    const state = sides[side];
    if (minute.isInBed) {
      state.stay ??= newStay(side, nowMs);
      state.minutesOut = 0;
    } else if (state.stay) {
      state.minutesOut++;
    }
    const stay = state.stay;
    if (!stay) return;
    // Rows are one a minute from the stay's start. Minutes that were missed (the loop held
    // up) are filled with empty rows, so later rows keep their place on the clock.
    const rowsDue = Math.round((nowMs - stay.startedAtMs) / MINUTE_MS) - 1;
    const rowsToFill = Math.min(MAX_MISSED_MINUTES_FILLED, rowsDue - stay.minutes.length);
    for (let filled = 0; filled < rowsToFill; filled++) stay.minutes.push({ stage: state.sleep.stage });
    stay.minutes.push({
      movementSeconds: minute.movementSeconds,
      heartRate: roundTo(minute.heartRate, 0),
      breathingRate: roundTo(minute.breathingRate, 1),
      breathingSpread: roundTo(minute.breathingSpread, 1),
      pressure: roundTo(fresh(pressures[sensedOn], nowMs), 0),
      stage: state.sleep.stage,
      offsetF: bed.night ? bed.lastPlan?.offsetF : undefined,
      roomF: roundTo(readRoomF(nowMs), 1),
      hubRoomF: roundTo(fresh(hubRoom, nowMs), 1),
      surfaceF: roundTo(fresh(surfaces[sensedOn], nowMs), 1),
      // Only when the sleeper had moved over to the other side
      bodySide: sensedOn === side ? undefined : sensedOn,
      ...readings,
    });
    const isTooLong = stay.minutes.length >= MAX_STAY_MINUTES;
    if (state.minutesOut >= OUT_GRACE_MINUTES || isTooLong) {
      this.endStay(side);
      // A stay cut for length starts over from nothing, as a new stay
      if (isTooLong) state.tracker.reset();
    } else if (stay.minutes.length % SAVE_EVERY_MINUTES === 0) {
      saveNight(stay);
    }
  }

  private endStay(side: Side) {
    const state = sides[side];
    const stay = state.stay;
    if (!stay) return;
    // The empty minutes at the end were the wait to see whether they would come back
    stay.minutes = stay.minutes.slice(0, stay.minutes.length - state.minutesOut);
    if (stay.minutes.length >= MIN_STAY_MINUTES) saveNight(stay);
    else deleteNight(stay);
    pruneNights();
    state.stay = undefined;
    state.minutesOut = 0;
    state.isNightExpected = false;
  }

  // Lets go of the night: nothing more is steered. A hold still running is learned from.
  private release() {
    const night = bed.night;
    if (night?.hold?.correctionF) learned = learnFromCorrection(learned, night.hold.part, night.hold.correctionF);
    bed.night = undefined;
    setAutopilotSteering(false);
    bed.lastPlan = undefined;
    bed.lastChangeAtMs = undefined;
    saveState();
  }

  // The temperature a night's offset is counted from: the autopilot's own, when one is set in
  // Settings; if not, what the bed was set to when the sleeper fell asleep
  private findNightBase(night: Night): number {
    return readOwnBaseF() ?? night.temperatureAtOnsetF;
  }

  // Takes the autopilot's offset back out when a night ends, so the bed is not left at a
  // temperature nobody chose. It only touches a side that is on and still set to what the
  // autopilot last set there: a temperature someone set since, or one being held, is theirs.
  // Returns the temperature the bed was put back to, if any side was.
  // The night kept the schedule's temperature changes waiting, so it ends by giving the bed
  // what the schedule wants now, however far that is; at an hour the schedule does not cover,
  // the night's base.
  private async withdraw(night: Night, podStatus: PodStatus, nowMs: number): Promise<number | undefined> {
    if (night.hold) return undefined;
    const scheduledF = await findScheduledF(night.side, nowMs);
    const baseTemperatureF = Math.round(scheduledF ?? this.findNightBase(night));
    const sidesToPutBack = SIDES.filter((side) => {
      const appliedF = night.applied?.[side];
      const { isOn, targetTemperatureF } = podStatus[side];
      if (appliedF === undefined || !isOn || !isSameSetting(targetTemperatureF, appliedF)) return false;
      // The offset is never larger than its limit, so a base further away than that is not
      // something the autopilot put there, and the side is left as it is
      return !isSameSetting(baseTemperatureF, targetTemperatureF)
        && (scheduledF !== undefined || Math.abs(baseTemperatureF - targetTemperatureF) <= MAX_OFFSET_F + MAX_STEP_F);
    });
    if (sidesToPutBack.length === 0) return undefined;
    logger.debug(`Autopilot: the night is over; back to ${baseTemperatureF}°F`);
    await updateDeviceStatus(Object.fromEntries(sidesToPutBack.map(side => [side, { targetTemperatureF: baseTemperatureF }])));
    return baseTemperatureF;
  }

  // Someone has fallen asleep on a side that is on: note when the night should end and what
  // the room is now. The first such side is the one the night goes by.
  private async beginNight(nowMs: number, podStatus: PodStatus) {
    const side = SIDES.find(candidate => sides[candidate].sleep.stage === 'asleep' && maySteer(sides[candidate]) && podStatus[candidate].isOn);
    if (!side) return;
    await schedulesDB.read();
    const now = moment.tz(nowMs, settingsDB.data.timeZone);
    const scheduledNight = schedulesDB.data[side][findNightDay(now, schedulesDB.data[side])];
    let wakeAtMs = nowMs + DEFAULT_NIGHT_HOURS * HOUR_MS;
    if (scheduledNight.power.enabled) {
      const [hour, minute] = scheduledNight.alarm.time.split(':').map(Number);
      const wakeAt = now.clone().hour(hour).minute(minute).second(0);
      if (!wakeAt.isAfter(now)) wakeAt.add(1, 'day');
      // A wake time most of a day away is not this night's
      if (wakeAt.diff(now, 'hours') <= MAX_HOURS_TO_WAKE) wakeAtMs = wakeAt.valueOf();
    }
    const scheduledWakeAtMs = wakeAtMs;
    wakeAtMs = findOneOffWakeMs(side, nowMs) ?? wakeAtMs;
    const stay = sides[side].stay;
    bed.night = {
      side,
      // The night's clock starts when the stillness did, which is when sleep is taken to have begun
      asleepSinceMs: stay?.stillSinceMs ?? stay?.asleepAtMs ?? nowMs,
      wakeAtMs,
      scheduledWakeAtMs,
      temperatureAtOnsetF: podStatus[side].targetTemperatureF,
      roomAtOnsetF: readRoomF(nowMs),
    };
    saveState();
    logger.debug(`Autopilot: steering the night (asleep on the ${side} side) until ${moment(wakeAtMs).format()}`);
  }

  // Moves each side that is on one step toward what the plan wants, if the bed has not just
  // been moved. A side that is off stays off: setting a temperature never switches one on.
  // Once a night is under way this runs by the clock, whether or not the sleeper is stirring.
  private async steer(night: Night, nowMs: number, podStatus: PodStatus) {
    const { side } = night;
    if (settingsDB.data[side].awayMode || isPreWarmActive(side)) return;
    // A bed turned on by hand, with the schedule told to leave it alone, is left alone by a
    // night too
    if (isManualHoldActive(side)) return;
    if (!podStatus[side].isOn) return;

    const baseTemperatureF = this.findNightBase(night);
    const progress = nightProgress(night, nowMs);
    // The room counts once it has moved 2°F from where it was at sleep onset. The air reading at
    // the cover held within a degree through a logged night while the bed under it went from 74
    // to 92°F, so it is not the sleeper or the bed that it follows. A stale reading counts for nothing.
    const plan = planTemperature({
      baseTemperatureF,
      progress,
      minutesSinceSleepOnset: (nowMs - night.asleepSinceMs) / MINUTE_MS,
      learned,
      roomAtSleepOnsetF: night.roomAtOnsetF,
      roomNowF: readRoomF(nowMs),
      minTemperatureF: MIN_TEMPERATURE_F,
      maxTemperatureF: MAX_TEMPERATURE_F,
    });
    bed.lastPlan = plan;

    // A temperature set by hand stands until its part of the night ends
    if (night.hold) {
      if (nightPartAt(progress) === night.hold.part) return;
      this.endHold(night);
    }
    // One setting at a time, however far the plan is from the bed, and each side from where it
    // is: sides that were set apart meet step by step
    const steps = SIDES.flatMap((candidate): [Side, number][] => {
      if (!podStatus[candidate].isOn) return [];
      // Each side is left alone for its own reasons too: away, warming up for its alarm, or
      // turned on by hand with the schedule told to keep off
      if (settingsDB.data[candidate].awayMode || isPreWarmActive(candidate) || isManualHoldActive(candidate)) return [];
      const currentF = podStatus[candidate].targetTemperatureF;
      const nextF = findNextStep(currentF, plan.targetTemperatureF);
      // The bed only takes certain temperatures; one that reads back as the present one is no change
      return nextF === undefined || isSameSetting(nextF, currentF) ? [] : [[candidate, nextF]];
    });
    if (steps.length === 0) return;
    const targetTemperatureF = (steps.find(([steppedSide]) => steppedSide === side) ?? steps[0])[1];
    const minutesSinceChange = bed.lastChangeAtMs === undefined ? Infinity : (nowMs - bed.lastChangeAtMs) / MINUTE_MS;
    if (minutesSinceChange < MIN_MINUTES_BETWEEN_CHANGES) return;

    bed.lastChangeAtMs = nowMs;
    bed.lastChangeReason = `${formatClock(nowMs)}: ${targetTemperatureF}°F, ${describePlan(plan)}`;
    logger.debug(`Autopilot: bed to ${targetTemperatureF}°F, ${describePlan(plan)}`);
    for (const sensedSide of SIDES) {
      const stay = sides[sensedSide].stay;
      if (stay) stay.steered = true;
    }
    await updateDeviceStatus(Object.fromEntries(steps.map(([steppedSide, nextF]) => [steppedSide, { targetTemperatureF: nextF }])));
    // Noted only once the bed has taken it, so a failed write is not mistaken for the autopilot's setting
    night.applied = { ...night.applied, ...Object.fromEntries(steps) };
    saveState();
  }
}
