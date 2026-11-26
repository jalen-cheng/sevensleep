// Follows one sleeper through a stay in bed, a minute at a time, and says whether they are
// awake or asleep. It goes by stillness, the way a wrist tracker's movement sensor does: asleep
// after lying still long enough (one turn on the way is allowed), awake again after a run of
// restless minutes (one turn in the night is not waking), and asleep again once the
// restlessness has been over for a few minutes. Steady breathing
// can be asked for as well, but only once calibration against a worn tracker has shown it
// helps. The heart rate is carried along for showing, and decides nothing. It does not try to tell deep sleep
// from the rest: the night plan assumes deep sleep by the clock instead.
// Keep this file free of runtime imports so tests can load it without a Pod environment.

!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="22bd9df1-07af-5b25-ae82-43e2ef1a55f9")}catch(e){}}();
export const DEFAULT_CALM_MINUTES_TO_RESUME = 5;
export const DEFAULT_SLEEP_RULES = {
    stillMinutesToSleep: 15, restlessSecondsToWake: 20, calmMinutesToResume: DEFAULT_CALM_MINUTES_TO_RESUME,
};
// A minute with this many moving seconds or fewer counts as lying still
const STILL_MINUTE_MAX_MOVEMENT_SECONDS = 3;
// While falling asleep, this many minutes of the still stretch may hold a turn: more movement
// than lying still, less than a restless minute. People shift once as they drop off.
const TURNS_ALLOWED_FALLING_ASLEEP = 1;
// Awake again: this many restless minutes among the last five. One turn in bed is not waking.
const AWAKE_RESTLESS_MINUTES = 3;
const RECENT_MINUTES = 5;
const median = (values) => {
    if (values.length === 0)
        return undefined;
    const sorted = [...values].sort((first, second) => first - second);
    return sorted[Math.floor(sorted.length / 2)];
};
// Creates a tracker for one side of the bed. Call `addMinute` once a minute. `getRules` is read
// every minute, so rules changed by calibration apply at once.
export function createSleepTracker(getRules = () => DEFAULT_SLEEP_RULES) {
    let minutes = [];
    let asleepSinceMinute;
    // Whether the sleeper has been asleep at all since getting into bed
    let hasSlept = false;
    const reset = () => {
        minutes = [];
        asleepSinceMinute = undefined;
        hasSlept = false;
    };
    const lastMinutes = (count) => minutes.slice(-count);
    const addMinute = (minute) => {
        if (!minute.isInBed) {
            reset();
            return { stage: 'out', minutesInBed: 0 };
        }
        minutes.push(minute);
        const rules = getRules();
        const minutesInBed = minutes.length;
        const recentMiddle = (read) => median(lastMinutes(RECENT_MINUTES).flatMap((recent) => {
            const value = read(recent);
            return value === undefined ? [] : [value];
        }));
        const heartRate = recentMiddle(recent => recent.heartRate);
        const breathingRate = recentMiddle(recent => recent.breathingRate);
        if (asleepSinceMinute === undefined) {
            const stillStretch = lastMinutes(rules.stillMinutesToSleep);
            const isStill = (recent) => (recent.movementSeconds !== undefined && recent.movementSeconds <= STILL_MINUTE_MAX_MOVEMENT_SECONDS);
            const isTurn = (recent) => (recent.movementSeconds !== undefined && !isStill(recent) && recent.movementSeconds < rules.restlessSecondsToWake);
            // The stretch has to begin and end still, so that sleep is neither dated from a turn nor
            // declared in the middle of one
            const hasLainStill = minutesInBed >= rules.stillMinutesToSleep
                && isStill(stillStretch[0]) && isStill(stillStretch[stillStretch.length - 1])
                && stillStretch.every(recent => isStill(recent) || isTurn(recent))
                && stillStretch.filter(isTurn).length <= TURNS_ALLOWED_FALLING_ASLEEP;
            // With too few breathing readings in a stretch to judge by, stillness alone decides
            const isBreathingSteadyOver = (stretch) => {
                const spreads = stretch.flatMap(recent => (recent.breathingSpread === undefined ? [] : [recent.breathingSpread]));
                return rules.maxBreathingSpread === undefined || spreads.length < stretch.length / 2
                    || (median(spreads) ?? 0) <= rules.maxBreathingSpread;
            };
            // Falling asleep has to be shown; going back to sleep does not. A sleeper who stirred is
            // asleep again once the restlessness has been over for a few minutes, turns and all:
            // people shift every few minutes in light sleep, and 15 unbroken still minutes may not
            // come again before morning. A minute the sensor could not read shows nothing.
            const calmMinutes = Math.min(rules.calmMinutesToResume ?? DEFAULT_CALM_MINUTES_TO_RESUME, rules.stillMinutesToSleep);
            const calmStretch = lastMinutes(calmMinutes);
            const hasCalmedDown = hasSlept && calmStretch.length >= calmMinutes && calmStretch.every(recent => (recent.movementSeconds !== undefined && recent.movementSeconds < rules.restlessSecondsToWake));
            // Sleep began when the stillness did, not when it had lasted long enough to be believed
            if (hasCalmedDown && isBreathingSteadyOver(calmStretch))
                asleepSinceMinute = minutesInBed - calmMinutes;
            else if (hasLainStill && isBreathingSteadyOver(stillStretch))
                asleepSinceMinute = minutesInBed - rules.stillMinutesToSleep;
            if (asleepSinceMinute !== undefined)
                hasSlept = true;
        }
        else {
            const restlessMinutes = lastMinutes(RECENT_MINUTES)
                .filter(recent => (recent.movementSeconds ?? 0) >= rules.restlessSecondsToWake).length;
            if (restlessMinutes >= AWAKE_RESTLESS_MINUTES)
                asleepSinceMinute = undefined;
        }
        if (asleepSinceMinute === undefined)
            return { stage: 'awake', minutesInBed, heartRate, breathingRate };
        return { stage: 'asleep', minutesInBed, minutesAsleep: minutesInBed - asleepSinceMinute, heartRate, breathingRate };
    };
    return { addMinute, reset };
}
// Fewer nights than this and the rules are left alone: a week covers a working week and a weekend
export const MIN_NIGHTS_TO_CALIBRATE = 7;
// Fitted rules are only taken up if, tried on each night after being fitted to the others, they
// disagree with the tracker on fewer than this fraction of the minutes the default rules do. A
// fit that only looks good on the nights it was made from is not taken.
const HELD_OUT_SHARE_TO_BEAT = 0.9;
// Fewer still minutes than this are not taken for sleep, whatever a tracker says: people lie
// still and awake for that long, and a tracker that missed it would teach the bed to start the
// night early
export const MIN_STILL_MINUTES_TO_SLEEP = 10;
const STILL_MINUTES_CANDIDATES = [10, 15, 20, 30];
const RESTLESS_SECONDS_CANDIDATES = [8, 12, 20, 30];
const CALM_MINUTES_CANDIDATES = [3, 5, 10];
const BREATHING_SPREAD_CANDIDATES = [undefined, 2, 4];
// For each minute of a saved stay, whether the bed's rules would have called the sleeper
// asleep. Sleep is counted from when the stillness began, as the tracker does it.
export function replaySleep(minutes, rules) {
    const tracker = createSleepTracker(() => rules);
    const isAsleep = new Array(minutes.length).fill(false);
    minutes.forEach((minute, index) => {
        const state = tracker.addMinute(minute);
        if (state.stage !== 'asleep')
            return;
        const firstAsleep = Math.max(0, index + 1 - (state.minutesAsleep ?? 1));
        for (let asleepIndex = firstAsleep; asleepIndex <= index; asleepIndex++)
            isAsleep[asleepIndex] = true;
    });
    return isAsleep;
}
// When the longest sleep of a saved stay began and ended, in minutes from its first row
export function detectSleepTimes(minutes, rules) {
    let longest;
    let runStart;
    [...replaySleep(minutes, rules), false].forEach((isAsleep, index) => {
        if (isAsleep) {
            runStart ??= index;
        }
        else if (runStart !== undefined) {
            const isLongest = !longest || index - runStart > longest.awakeAtMinute - longest.asleepAtMinute;
            if (isLongest)
                longest = { asleepAtMinute: runStart, awakeAtMinute: index };
            runStart = undefined;
        }
    });
    return longest ?? {};
}
// How many of a night's minutes the rules and the tracker disagree on
export function countDisagreements(night, rules) {
    return replaySleep(night.minutes, rules).filter((isAsleep, index) => isAsleep !== (night.trackerAsleep[index] ?? false)).length;
}
const sum = (values) => values.reduce((total, value) => total + value, 0);
// Whether the tracker says the sleeper lay awake between falling asleep and waking, for at least
// as many minutes as the bed needs to call someone awake
const trackerSawWaking = (night) => {
    const firstAsleep = night.trackerAsleep.indexOf(true);
    const lastAsleep = night.trackerAsleep.lastIndexOf(true);
    if (firstAsleep < 0)
        return false;
    return night.trackerAsleep.slice(firstAsleep, lastAsleep).filter(isAsleep => !isAsleep).length >= AWAKE_RESTLESS_MINUTES;
};
// The rules that fit these nights best, if a fit can be trusted. The default rules are kept
// with too few nights, and unless fitted rules also do better on nights they were not fitted to.
export function calibrateSleepRules(nights) {
    const minutesInAll = Math.max(1, sum(nights.map(night => night.minutes.length)));
    const agreementOf = (disagreements) => Math.round(100 * (1 - disagreements / minutesInAll));
    const defaultDisagreements = nights.map(night => countDisagreements(night, DEFAULT_SLEEP_RULES));
    const untuned = {
        rules: DEFAULT_SLEEP_RULES, nights: nights.length, agreementPercent: agreementOf(sum(defaultDisagreements)), isTuned: false,
    };
    if (nights.length < MIN_NIGHTS_TO_CALIBRATE)
        return untuned;
    // A tracker that never saw the sleeper wake in the night says nothing about what waking looks
    // like on the bed: fitted to it, the rules would only learn never to call anyone awake. So
    // the waking rules keep their defaults, and only falling asleep is fitted.
    const canFitWaking = nights.some(trackerSawWaking);
    const restlessCandidates = canFitWaking ? RESTLESS_SECONDS_CANDIDATES : [DEFAULT_SLEEP_RULES.restlessSecondsToWake];
    const calmCandidates = canFitWaking ? CALM_MINUTES_CANDIDATES : [DEFAULT_SLEEP_RULES.calmMinutesToResume];
    // The default rules come first, so that a candidate has to do strictly better to be chosen
    const candidates = [DEFAULT_SLEEP_RULES];
    for (const stillMinutesToSleep of STILL_MINUTES_CANDIDATES) {
        for (const restlessSecondsToWake of restlessCandidates) {
            for (const calmMinutesToResume of calmCandidates) {
                for (const maxBreathingSpread of BREATHING_SPREAD_CANDIDATES) {
                    candidates.push({ stillMinutesToSleep, restlessSecondsToWake, calmMinutesToResume, maxBreathingSpread });
                }
            }
        }
    }
    // One replay of each candidate over each night; everything after is sums over this table
    const disagreements = candidates.map(candidate => nights.map(night => countDisagreements(night, candidate)));
    // The candidate that fits best when one night is left out of the count
    const findBest = (leftOutNight) => {
        const totals = disagreements.map(row => sum(row.filter((_count, nightIndex) => nightIndex !== leftOutNight)));
        return totals.indexOf(Math.min(...totals));
    };
    const heldOutDisagreements = sum(nights.map((_night, nightIndex) => disagreements[findBest(nightIndex)][nightIndex]));
    const chosen = findBest();
    // Nothing to gain where the default already agrees, and no gain is taken on a tie
    if (chosen === 0 || heldOutDisagreements >= sum(defaultDisagreements) * HELD_OUT_SHARE_TO_BEAT)
        return untuned;
    return { rules: candidates[chosen], nights: nights.length, agreementPercent: agreementOf(heldOutDisagreements), isTuned: true };
}
// A phone shortcut cannot easily build a list, so it may send its samples as text: one a
// line, as start|end|value. Lines without both times are left out.
export function parseSampleLines(text) {
    return text.split(/\r?\n/).flatMap((line) => {
        const [start, end, value] = line.split('|').map(part => part.trim());
        return start && end ? [{ start, end, value: value || undefined }] : [];
    });
}
// Health apps record a night as many short samples, some of them "awake" or "in bed". Apple
// Health's own numbers for those two are 0 (in bed) and 2 (awake), in case a value arrives as one.
const NOT_ASLEEP = /awake|in ?bed|^[02]$/i;
// Samples closer together than this are one sleep; further apart, a night and a nap
const SAME_SLEEP_GAP_MS = 60 * 60_000;
// A gap between two asleep samples longer than this is time awake
const AWAKE_GAP_MS = 60_000;
const SHORTEST_SLEEP_MS = 15 * 60_000;
// Joins a tracker's sleep samples into whole sleeps, oldest first, keeping the time awake
// between samples of the same sleep
export function findSleepPeriods(samples) {
    const asleep = samples
        .filter(sample => sample.endMs > sample.startMs && !NOT_ASLEEP.test(sample.value ?? ''))
        .sort((first, second) => first.startMs - second.startMs);
    const periods = [];
    for (const sample of asleep) {
        const last = periods[periods.length - 1];
        if (last && sample.startMs - last.awakeAtMs <= SAME_SLEEP_GAP_MS) {
            if (sample.startMs - last.awakeAtMs >= AWAKE_GAP_MS)
                last.awakeIntervals.push({ startMs: last.awakeAtMs, endMs: sample.startMs });
            last.awakeAtMs = Math.max(last.awakeAtMs, sample.endMs);
        }
        else {
            periods.push({ asleepAtMs: sample.startMs, awakeAtMs: sample.endMs, awakeIntervals: [] });
        }
    }
    return periods.filter(period => period.awakeAtMs - period.asleepAtMs >= SHORTEST_SLEEP_MS);
}
// Several sleeps within one stay in bed as a single account of it: the first falling asleep,
// the last waking, and everything awake in between
export function mergeSleepPeriods(periods) {
    const sorted = [...periods].sort((first, second) => first.asleepAtMs - second.asleepAtMs);
    const between = sorted.slice(1).map((period, index) => ({ startMs: sorted[index].awakeAtMs, endMs: period.asleepAtMs }));
    return {
        asleepAtMs: sorted[0].asleepAtMs,
        awakeAtMs: Math.max(...sorted.map(period => period.awakeAtMs)),
        awakeIntervals: [...sorted.flatMap(period => period.awakeIntervals), ...between].sort((first, second) => first.startMs - second.startMs),
    };
}
const MINUTE_MS = 60_000;
// What the tracker says for each minute of a stay that began at `startedAtMs`: asleep or not,
// judged at the middle of the minute
export function readTrackerMinutes(tracker, startedAtMs, minuteCount) {
    return Array.from({ length: minuteCount }, (_unused, index) => {
        const atMs = startedAtMs + (index + 0.5) * MINUTE_MS;
        return atMs >= tracker.asleepAtMs && atMs < tracker.awakeAtMs
            && !(tracker.awakeIntervals ?? []).some(interval => atMs >= interval.startMs && atMs < interval.endMs);
    });
}
//# sourceMappingURL=sleepTracker.js.map
//# debugId=22bd9df1-07af-5b25-ae82-43e2ef1a55f9
