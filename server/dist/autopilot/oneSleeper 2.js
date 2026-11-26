const SIDES = ['left', 'right'];
const DEFAULT_SIDE = 'left';
// The bed's minute, from each side's. The stay stays with the side it began on; a new one
// begins on the side the sleeper is on. Lying across both, the sleeper is taken to be on the
// side pressed harder, and the minute's movement is the greater of the two: a turn felt on
// either side is a turn.
export function mergeSides(sideMinutes, bedSoFar = {}) {
    const occupied = SIDES.filter(side => sideMinutes[side].isInBed);
    const pressureOn = (side) => bedSoFar.pressure?.[side] ?? 0;
    let bodySide = occupied[0];
    if (occupied.length === SIDES.length) {
        if (pressureOn('left') !== pressureOn('right'))
            bodySide = pressureOn('left') > pressureOn('right') ? 'left' : 'right';
        else
            bodySide = bedSoFar.staySide ?? DEFAULT_SIDE;
    }
    const movements = occupied.flatMap((side) => {
        const movementSeconds = sideMinutes[side].movementSeconds;
        return movementSeconds === undefined ? [] : [movementSeconds];
    });
    return {
        isInBed: occupied.length > 0,
        movementSeconds: movements.length > 0 ? Math.max(...movements) : undefined,
        staySide: bedSoFar.staySide ?? bodySide ?? DEFAULT_SIDE,
        bodySide,
    };
}
!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="45db4e73-f7d9-5754-bd0e-109a785f09eb")}catch(e){}}();
//# sourceMappingURL=oneSleeper%202.js.map
//# debugId=45db4e73-f7d9-5754-bd0e-109a785f09eb
