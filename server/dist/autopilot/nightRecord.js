// Counts the times a sleeper stopped being asleep and later slept again

!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="b0a9b1f3-e6a9-5bb4-8f53-f730ba4369d8")}catch(e){}}();
export function countWakeUps(minutes) {
    let wakeUps = 0;
    let hasSlept = false;
    let isBroken = false;
    for (const minute of minutes) {
        if (minute.stage === 'asleep') {
            if (isBroken)
                wakeUps++;
            hasSlept = true;
            isBroken = false;
        }
        else if (hasSlept) {
            isBroken = true;
        }
    }
    return wakeUps;
}
const MINUTE_MS = 60_000;
// The stays of a bed that one person sleeps in. With the autopilot off, and in records from
// before 3.26, each side keeps its own, so a sleeper who lies across the middle, or moves over
// in the night, leaves two for the same hours. Of stays
// that share time, the one with the most sleep is kept. Most sleep first.
export function pickBedStays(stays) {
    const asleepMinutes = (stay) => stay.minutes.filter(minute => minute.stage === 'asleep').length;
    const endMs = (stay) => stay.startedAtMs + stay.minutes.length * MINUTE_MS;
    const sharesTime = (first, second) => first.startedAtMs < endMs(second) && second.startedAtMs < endMs(first);
    const kept = [];
    const bySleep = [...stays].sort((first, second) => (asleepMinutes(second) - asleepMinutes(first) || second.minutes.length - first.minutes.length));
    for (const stay of bySleep) {
        if (!kept.some(keptStay => sharesTime(keptStay, stay)))
            kept.push(stay);
    }
    return kept;
}
//# sourceMappingURL=nightRecord.js.map
//# debugId=b0a9b1f3-e6a9-5bb4-8f53-f730ba4369d8
