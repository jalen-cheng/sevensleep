# Autopilot (Pod 5, experimental)

Off by default. Switch it on in **Settings > Autopilot > Adjust the temperature while I sleep**.
While someone is asleep the temperature is the autopilot's: it moves the bed a few degrees
around a base temperature, and the schedule's temperature changes wait until the night is over.

**Not yet run through a real night.** It is covered by tests and by made-up nights run against
the built server. [Trying it without a night](#trying-it-without-a-night) has the checks that
take minutes.

Where the sensors could be wrong, it is built to do little, not to guess: the rules below hold
whatever the sensors say.

## The rules it keeps

- **One sleeper, whole bed.** It takes the bed to be one sleeper's. Switching it on links the
  two sides, and unlinking them switches it off. While it is on, the two sides are sensed as
  one sleeper: moving over to the other side in the night is the same sleep, in the same record.
- **It supersedes the schedule's temperatures, and nothing else of the schedule.** While it is
  steering a night, scheduled temperature changes are skipped. Bed on, bed off, the warm-up
  before the alarm and the alarm itself run as scheduled. When the night ends the bed is given
  what the schedule wants at that hour.
- **Never more than 4°F** from its base temperature, **one degree at a time**, at most one
  change every 10 minutes, with no exceptions. Each side moves from where it is, so sides that
  were set apart meet a degree at a time and never jump.
- **The base temperature** (**Settings > Autopilot > Base temperature**) is "Bed's setting"
  unless you pick a temperature: whatever the bed is set to when you fall asleep, whether that
  night's schedule or you set it. Pick a temperature and every night is counted from that.
- **Your hand wins.** A temperature you set (app, side buttons, a request to the API), on
  either side, is held exactly as you set it until the end of that third of the night. The
  autopilot then carries on, a degree at a time.
- **It leaves alone**, side by side, a side that is off (setting a temperature never switches
  one on), one in away mode, one warming up for its alarm, and one turned on by hand with the
  schedule paused. The other side is still moved.
- **The night ends at the wake-up time**, or when a one-time alarm goes off, however early.
  From then the bed is the schedule's and the alarm's again, and the autopilot does not start
  another night until the bed has been empty.
- **It hands the bed back.** When a night ends (the wake-up time, the bed empty for 30 minutes,
  or the autopilot switched off), each side still set to what the autopilot last put there is
  given what the schedule wants at that hour, or its base at an hour the schedule does not cover. A temperature you have set since is left alone. If the Pod cannot be reached
  at that moment it tries again the next minute, and after a restart it does so even if the
  sensors are silent.
- **It only asks for temperatures the bed has.** The bed takes about two hundred settings, not
  every whole degree; near its coldest, the next setting down is nine degrees away, and the
  autopilot stays where it is before it goes past what it wants.
- **A restart does not start the night over.** The night under way is saved; after an update
  or reboot it carries on from the same point if someone is still in bed.
- **Once the night has begun it runs by the clock.** Stirring for a few minutes does not send
  the bed back to the set temperature and down again.

## What adds up to the offset

| Part | What happens | Size |
|---|---|---|
| Your changes | How far a temperature you set was from what the autopilot wanted is partly remembered for that third of the night | 0.3 of it each time, up to ±3°F |
| Night curve | Cooler from falling asleep through the first half of the night, back to the set temperature by about 85% of the way to the wake time, then a little warm | -2°F, then 0, then +1°F |
| First sleep cycle | A little cooler from 20 to 90 minutes after falling asleep. Deep sleep itself is not detected | -1°F |
| The room | Once the room is 2°F from where it was at sleep onset, the bed goes half as far the other way | up to ±2°F |

When these add up to more than 4°F, they are cut from the bottom of the table up, so what you
taught it is the last to go.

<img src="diagrams/night-curve.svg" width="680" alt="Chart: degrees from the base temperature through a night of 8 hours. At the base on falling asleep, 2°F cooler through the first half, 3°F cooler during the first sleep cycle, back at the base late in the night and 1°F warm at wake time, never more than 4°F from the base">

The chart is the curve and the first sleep cycle with nothing learned yet. What you teach it
moves a third of the night up or down by up to 3°F.

**The room** counts once it has moved 2°F from where it was when you fell asleep: the bed then
goes half as far the other way (a room 2°F warmer makes the bed 1°F cooler), never more than
2°F (`roomOffsetF` in `nightPlan.ts`). Under 2°F nothing happens, so a reading that wanders is
not taken for a room that changed. The reading is the air sensor at the cover. With a sleeper
in bed it held within 0.7°F for eight hours while the surface under them went from 74 to 92°F
(n=1), so it does not follow the sleeper or the bed. What it does through a real swing of the
room has not been seen yet, which is why the part is this cautious. A reading older than a few
minutes counts for nothing.

**Learning.** At 0.3, a one-degree change takes two nights that agree before it shows. A change
is counted once per hold, not once per button press, and for no more than 4°F however large it
was, so one odd night teaches it a little over a degree at most. What it has learned stays
until you correct it the other way. Any request that
sets the temperature counts as yours, including one from an automation of your own. The one
exception is the bed turning itself on when you get in (In-bed detection): that temperature is
held like any other but teaches nothing, since it is a rule and not tonight's choice.

The night runs from falling asleep to that night's wake-up time (8 hours if the night has no
schedule), or to a one-time alarm when one is set for that morning. The base does not move during it: scheduled temperature changes are skipped while
the night is steered, so the curve is the only thing shaping the night.

**If your schedule cools early and warms late,** that no longer adds to the curve: only the
temperature the bed has when you fall asleep is used, and the schedule's later changes wait.

## How much of this is evidence

Less than the first version of this page claimed. The studies show that taking heat from the
body in sleep can change sleep; none tested this curve, these sizes, or a water-cooled cover
set in degrees.

| Study | What it found | What it does not show |
|---|---|---|
| Kräuchi et al. 2018, Physiol Behav 185:23 | 15 young men, randomised crossover, a passive mattress that draws heat away: 16% more slow-wave sleep, in the second part of the night | An early cooling pulse; anything about a setpoint |
| Herberger et al. 2024, Sci Rep | The same kind of passive mattress: deep sleep up 7.5 minutes a night, give or take 21.6, heart rate down 2.4 bpm, the gain building after about four hours | That cooling early in the night is the part that matters |
| Moyen et al. 2024, Bioengineering 11:352 | Eight Sleep's own study, 54 people, a week off then a week on, not randomised, each choosing their own temperatures: 14 more minutes of deep sleep in men who slept cooler in the first half | That any given curve beats the schedule a sleeper already likes |
| Raymann et al. 2008, Brain 131:500 | Warming the skin by 0.4°C with a thermosuit cut waking in the night | That a degree of water temperature does the same |

So the curve is a starting guess to test against your own nights, and your corrections are the
part most likely to be right. Nothing here measures whether the autopilot improves sleep; the
saved nights record whether it steered, so nights with and without it can be compared later.

**The room reading is unproven, so it is not used.** It comes from the sensor at the cover,
which may read the sleeper as well as the room. Each saved minute has it, the air temperature
at the hub on the floor and the mattress surface, so a few nights will show which one follows
the room. The mattress surface is deliberately never acted on: it follows the water, so the
autopilot would be answering its own changes.

## How it tells you are asleep

In three steps, once a minute for each side. The first two say whether a person is there at
all; only the third is about sleep.

With the autopilot on, the two sides' minutes are put together before the third step
(`server/src/autopilot/oneSleeper.ts`): someone is in bed when either side has a body on it,
and the minute's movement is the greater of the two. The stay is kept by the side it began
on, and a row sensed on the other side says so (`bodySide`). Until 3.26 each side was followed
on its own, and a sleeper who moved over was read as getting up, with a second, short sleep
begun on the other side. It has been run through a made-up crossing, not yet a real one.

**1. Is anything on the side?** The capacitive sensors under the cover say so (in-bed
detection, [How it works](HOW_IT_WORKS.md)). They cannot tell a person from a laptop.

**2. Is it a body?** (`server/src/autopilot/bodySignal.ts`) The cover's piezo sensor (500
readings a second per side, on the firmware's sensor bus) is knocked by every heartbeat and
breath of someone lying on the bed, however still, and not at all by a thing. Measured on one
Pod 5 as the swing of a quiet second: an empty bed, or one with a laptop on it, 13,000 to
24,000; one person lying still, 1,100,000 to 2,100,000 on their own side and 225,000 to
440,000 on the other. A minute is a body's when it reads at least 5 times the empty bed's
level: on those figures a person is 50 to 100 times it on their own side, a laptop 1.

The empty level is each Pod's own, set once when it is set up: from the first ten minutes
with nothing on either side (their lower quartile), and only if it falls between 5,000 and
50,000, the range an empty bed can read. Outside that the measuring goes on. It is kept in
`autopilot_state.json` and not adjusted afterwards; **Settings > In-bed detection > Bed is
empty now** measures it afresh, with the capacitive baseline. A side with a thing on it and no
body is simply an empty side: no stay, no sleep, no steering. Until the empty level is set,
and in a minute when the piezo sent too little, the capacitive sensors are taken at their
word.

This step was added after a laptop left on the bed was logged as asleep for 77 minutes one
afternoon and 177 that evening. Replayed through the check, both come out as nobody in bed.
It has not yet been through a real night; what it rests on is the gap between those figures.

<img src="diagrams/person-check.svg" width="560" alt="Flowchart: anything on the side, then is it a body, then a person is in bed">

**3. Is the body asleep?** (`server/src/autopilot/sleepTracker.ts`) By stillness, the way a
wrist tracker's movement sensor does. Each minute is summed up as a count of seconds with
movement: **still** is 3 or fewer, a **turn** is more than that and under 20, **restless** is
20 or more.

- **Asleep:** 15 minutes that begin and end still, with no restless minute among them and at
  most one turn (people shift once as they drop off). The bed can only act on it once the 15
  minutes are up. A night's sleep is then counted from when the stretch began. A nap, or a
  short lie-down that only looked like sleep (anything under 3 hours), is counted from when it
  was first taken for sleep and no earlier: 15 minutes of lying still are not added to it
  after the fact.
- **Awake again:** 3 minutes out of 5 restless. A turn in bed, or two, is not waking.
- **Asleep again:** 5 minutes in a row with no restless one, turns and all. Falling asleep has
  to be shown; going back to sleep does not. Until 3.20.1 this took the same 15 still minutes
  as falling asleep. Checked against a watch (n=1), a sleeper who shifted every 5 to 15 minutes
  toward morning was called awake for most of it: the bed agreed with the watch on 41% of the
  minutes. With this rule the same record replays at 73%, and the times the watch or the sleeper
  said awake are still seen. That is limited data, and the number of minutes is one of the
  things a tracker's record tunes.
- **Restless** was 12 moving seconds until 3.25.2. A band reported sleep with no waking but
  some restlessness (n=1), while the bed called much of the morning awake. At 20 seconds the
  saved records with a tracker replay at 86% and 94% agreement, from 72% and 82%, and the time
  in bed before sleep and after waking is still read as awake. A higher number agrees more
  still, but only because these records hold almost no waking to miss, so it stops at 20.
- **Out of bed** starts it over.

<img src="diagrams/stillness-rule.svg" width="560" alt="Flowchart: the minute's moving seconds, then the check for falling asleep or for waking">

Movement is judged against the sleeper's own quiet level over the last quarter of an hour, so
a whole minute of fidgeting counts as movement and not as the new normal. A minute in which the
sensor sent too little, or a dead flat line, is not counted as lying still, so a sensor that
stops is not taken for a sleeper. Lying awake and still does read as
asleep, which is the known weak point of judging by movement.

Deep sleep is not detected.

**Heart rate and breathing are switched off for now** (`USES_HEART_AND_BREATHING` in
`autopilotMonitor.ts`): they are not worked out, shown or saved. The breathing estimate read a
rate of 8 to 19 a minute from an empty bed with a laptop on it, in half its minutes, and the
heart rate came through in about one minute in eight with a sleeper on the bed. Neither
decided anything. They are the way to tell lying awake from sleeping, so they are worth
making trustworthy; what follows describes the estimate as it stands.

**Breathing.** Each breath is a slow swell in the piezo signal. Every 10 seconds the last 30
are averaged down to 10 readings a second, drift and heartbeats are taken out, and the rate is
the shift at which that slow signal best matches itself, between 8 and 30 breaths a minute
(`server/src/autopilot/breathingRate.ts`). Each minute's rate, and how far apart its readings
were, are saved with the night. On this Pod it read 17 to 18 breaths a minute for a sleeper
lying still and awake, who breathes 14 to 16 asleep by their watch. That fits, and is one
person on one evening.

What breathing can tell, from sleep-lab studies:

- The rate barely moves: 16.8 breaths a minute awake against 15.2 to 15.9 in every sleep stage,
  in 38 adults who differed from each other by 2 to 3 (Gutierrez et al. 2016, Physiol Rep
  4:e12949). No range of rates marks sleep.
- Its steadiness does: variability is highest awake and in REM and falls into deep sleep. So
  the bed measures the spread of its readings, not the rate. That spread is of 30-second
  estimates, which is not the same thing as the breath-to-breath variability the studies
  measured, and has yet to be shown to follow it.
- No published rule turns either into "asleep" or "deep sleep". Systems with figures use a
  trained model on breathing and movement together (93% for asleep against awake by radar,
  about 71% of deep sleep found: Diao et al. 2026, arXiv 2604.16442).

So steady breathing is not asked for by default. It is one of the things calibration against a
sleep tracker tries, and it is only switched on when that makes the bed agree better with the
tracker on nights it was not fitted to.

**Getting up in the night.** Less than 30 minutes out of bed is the same night.

**Naps.** A sleep of under 3 hours is a nap; that is how saved sleeps are sorted. Nobody knows
how long a sleep will last when it begins, so whether the autopilot steers it from the start
goes by when it began:

1. against when you have actually been falling asleep and waking, from your newest 14 saved
   nights (once there are 3). The schedule's times are when the bed runs, not when you sleep;
2. with too few saved nights, against the schedule's bedtime and wake-up time;
3. with neither, by the hour: between 9:00 and 19:00 looks like a nap.

A sleep that begins up to 3 hours before your usual time, or any time until your usual waking,
is steered from the start. Any other is left alone, and if it is still going after 3 hours the
autopilot takes over from there.

## Trying it without a night

Sleep detection can be checked without the autopilot on, in about 20 minutes: lie down and
keep still for 20 minutes. The stay is saved once it has lasted 20 minutes and shows under
**Data > Sleep**: "Nap" from the minute the bed took you for asleep (after 15 still minutes;
lying awake and still reads as asleep, as said above), or "In bed" if it did not.
`GET /api/autopilot` says `awake` or `asleep` for each side as it happens.

The body check takes two minutes: put a laptop on the bed where you sleep and wait. Even if
Settings > In-bed detection shows that side as in bed, nothing is saved under Data > Sleep
however long it stays. Then lie down beside it for 20 minutes: that stay is saved.

## Changing things by hand

There is no separate control for either: the ordinary ones are the manual ones.

- **The temperature.** Set it as on any other night: the **Temperature** page, the Pod's side
  buttons, a Shortcut or the API. During a steered night the autopilot holds what you set until
  the end of that third of the night, then carries on from there, and remembers part of the
  difference for that third on later nights ("Your changes" in the table above).
- **When you slept.** **Data > Sleep**, pick the night, then **Manual override** under its
  Summary. The two times are filed as that night's record, as a tracker's would be, and count
  toward the 7 nights the sleep rules are fitted to.
- **The base.** **Settings > Autopilot > Base temperature**.

## Linking a sleep tracker

A watch or band is a better judge of when you slept than the bed's own guesses, and its record
can be sent, two weeks at a time, so the bed fits its sleep rules to it: 7 nights, and only a fit that
does better on nights it was not fitted to is taken up. The link is an iPhone Shortcut that
reads Apple Health (Apple Watch, Whoop and Fitbit all write there).
[Connections](CONNECTIONS.md#link-apple-health) has the steps, and what is done with what is
sent. Without a tracker you can say when you slept yourself: **Data > Sleep > Set when you
slept** files your own times with that stay, and they are used in the same way.

<img src="diagrams/tracker-tuning.svg" width="560" alt="Flowchart: a night's record is filed with its stay, and from seven nights rule sets are replayed and only taken up if they do better on a night left out">

What made a night different (a drink, a late coffee, a cold) does not have to be known or
entered. The bed is not predicting sleep from causes: the record says when you slept, and the
rules are fitted to that. What such a night can do is sit badly with the others, since one set
of rules is fitted to all of them; a rule set that only suits the odd night fails the check
on the nights left out and is not taken.

## Where nights are kept

Every stay in bed of 20 minutes or more is saved on the Pod, whether or not the autopilot is
switched on, as one file in `/persistent/free-sleep-data/autopilot_nights/`: a row per minute
(moving seconds and the raw size of the movement signal, heart rate, breathing rate and spread,
pressure on the bed, state, what the bed was set to and its water temperature, the autopilot's
offset, the air at the cover and at the hub, the mattress surface), the bed's sleep
and wake times, whether the autopilot steered, the empty bed's piezo level the body check
went by, and the tracker's record if one was sent. A
night is about 50 KB. The newest 180 files are kept (three months for two sides), under 10 MB
of the Pod's 14 GB free. An open stay is written every 10 minutes, so a restart loses at most
that, and starts a new file.

<img src="screenshots/nights.png" width="260" alt="Data > Nights: a night's summary and its breathing rate">

**Data > Sleep** shows one day at a time, last night first, with arrows and a calendar to move:
bedtime, wake time, duration and wake-ups, then movement, pressure on the bed and the
autopilot's temperature changes against the clock. A night belongs to the morning it ended on.
With the sides linked the bed is shown as one sleeper's, whichever side they lay on (where both
sides saw the same hours, as with the autopilot off or in older records, the one with the most
sleep); otherwise the side this device controls.
**Export** downloads the nights of the last week, two weeks, one, two or three months as one
JSON file. `GET /api/autopilot/nights` and `GET /api/autopilot/nights/export` return the same.
**Biometrics (legacy)** is a different system: the original project's sleep analysis, a separate
service with its own database and its own page under Data. The autopilot and Data > Sleep do
not use it and do not need it installed.

## Seeing what it does

**Data > Sleep** shows each stay, with the temperature changes the autopilot made against the
clock. `GET /api/autopilot` says whether each side is awake or asleep and gives the last
change with its reasons (see
[server/API.md](../server/API.md#autopilot)), and the server log has a line for every change.
What it has learned is kept in `/persistent/free-sleep-data/autopilot_state.json`; delete the
file and restart SevenSleep to forget it.

## Code

`server/src/autopilot/`: `heartRate.ts` and `breathingRate.ts` (the estimates), `bodySignal.ts`
(a body or a thing), `sleepTracker.ts`
(the sleep rules, and fitting them to a tracker), `nightPlan.ts` (curve, learning, room, limits,
steps, the test's clock), `scheduledBase.ts` (the schedule's temperature at a time, what a
night's offset is counted from, night or nap), `nightLog.ts`
(the saved nights), `autopilotMonitor.ts` (state, and the only file that touches the Pod). The
first six are pure and tested in `tests/autopilot.test.mjs`.

Two other open-source projects informed the rules above: Sleepypod's temperature controller
(manual targets are absolute and held, relative changes are worked out from the schedule and
never from the autopilot's own last setting, a temperature never switches a side on) and
Nightstand (learn slowly from repeated corrections).
