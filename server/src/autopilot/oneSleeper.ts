// One sleeper on a bed whose sides are linked. Each side has its own sensors, so a sleeper who
// moves over in the night leaves one side and turns up on the other: sensed side by side, that
// reads as getting out of bed and a stranger getting in. This puts the two sides' minutes
// together into one for the bed, so the sleep carries on wherever on the bed the sleeper lies.
// Keep this file free of runtime imports so the tests can load it.
import type { Side } from '../db/schedulesSchema.js';

export type SideMinute = {
  isInBed: boolean;
  // How many of the minute's seconds had movement; undefined when the sensor could not say
  movementSeconds?: number;
};

export type BedMinute = SideMinute & {
  // The side whose stay in bed this minute is added to
  staySide: Side;
  // The side the sleeper lay on. Undefined when nobody was in bed.
  bodySide?: Side;
};

type BedSoFar = {
  // The side that holds the stay under way, when there is one
  staySide?: Side;
  // How hard each side is pressed, to say where a sleeper lying across the middle mostly is
  pressure?: Partial<Record<Side, number>>;
};

const SIDES: Side[] = ['left', 'right'];
const DEFAULT_SIDE: Side = 'left';

// The bed's minute, from each side's. The stay stays with the side it began on; a new one
// begins on the side the sleeper is on. Lying across both, the sleeper is taken to be on the
// side pressed harder, and the minute's movement is the greater of the two: a turn felt on
// either side is a turn.
export function mergeSides(sideMinutes: Record<Side, SideMinute>, bedSoFar: BedSoFar = {}): BedMinute {
  const occupied = SIDES.filter(side => sideMinutes[side].isInBed);
  const pressureOn = (side: Side) => bedSoFar.pressure?.[side] ?? 0;
  let bodySide: Side | undefined = occupied[0];
  if (occupied.length === SIDES.length) {
    if (pressureOn('left') !== pressureOn('right')) bodySide = pressureOn('left') > pressureOn('right') ? 'left' : 'right';
    else bodySide = bedSoFar.staySide ?? DEFAULT_SIDE;
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
