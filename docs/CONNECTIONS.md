# Connections

What can be linked to the bed from outside. For now that is one thing: last night's sleep from
a watch or band, by way of Apple Health, which the [autopilot](AUTOPILOT.md) uses to tune how
it judges sleep. Controlling the bed from Shortcuts, Home Assistant or a script is covered in
[iPhone Shortcuts](IOS_SHORTCUTS.md) and the [API](../server/API.md).

## Link Apple Health

**iPhone only.** Apple Watch and Whoop write sleep to Apple Health, and Fitbit devices
(including the Fitbit Air) do through the Google Health app's Apple Health connection, which
lists sleep sessions and stages among what it writes. Apple Health has no web address a Pod
could ask: only something on the phone can read it. So the link is an iPhone Shortcut. One run
sends the last two weeks of sleep, so it is tapped every week or so, not every day.

### Add the ready-made Shortcut

1. On the iPhone, open **[Send sleep to SevenSleep](https://github.com/jalen-cheng/sevensleep/raw/main/docs/shortcuts/Send%20sleep%20to%20SevenSleep.shortcut)**, tap the download in Safari, and
   tap **Add Shortcut**.
2. It asks for one thing, your Pod's address at home: leave `http://sevensleep.local` unless
   your Pod has another name. If the keyboard hides the button to finish, swipe down to put it
   away.
3. At home, tap the Shortcut once to run it. The first run asks to read Sleep from Health, to
   send the health samples to your Pod, and to show notifications: allow each (**Always Allow**
   for the samples, or it asks every time).
4. A notification from SevenSleep says what happened, for example "1 sleep received from Apple
   Health. Matched 1 stay in bed." **Data > Sleep** then shows the tracker's times on that night.

**Run it at home.** The Pod's home address works nowhere else, so away from home Shortcuts says
it could not connect, and nothing is lost: the next run at home sends the same two weeks.

**When to run it.** Every week or so, or whenever you want the Sleep page to show your tracker's
times. Each run sends every night of the last two weeks at once, so a missed week costs nothing,
and the 7 nights the sleep rules are fitted to can arrive in one tap. Sending a night twice
changes nothing, and a night the Pod has no stay in bed for is passed over.

If you would sooner not think about it, **Shortcuts > Automation** can run it for you (**Wi-Fi**:
when the iPhone joins your home network, set to **Run Immediately**), so it only runs at home. An iPhone only lets a
Shortcut read health data while it is unlocked, so a run that comes while the phone is locked
waits until you next use it.

It reads the Sleep samples that began in the last two weeks and sends each one's start, end and
stage.

| What you see | What it means |
|---|---|
| "No sleep found in what Apple Health sent" | The Shortcut reached the Pod, and Health has no sleep for the last two weeks. Look in **Health > Browse > Sleep**: if last night is not there, your tracker's app is not writing sleep to Apple Health |
| "Could not connect to the server", or the address not found | The phone cannot reach the Pod: it is away from home, or not on the home Wi-Fi. At home, allow Shortcuts under **Settings > Privacy & Security > Local Network**, or put the Pod's IP address in the Shortcut's first action |
| "…received… No stay in bed saved on the Pod overlaps it" | The sleep arrived, but the Pod has no saved stay for those hours. It saves stays of 20 minutes or more, and only while a person is on the bed |
| Nothing at all | Notifications for Shortcuts are off: **Settings > Notifications > Shortcuts** |

The file is made by `scripts/build_shortcuts.py`, with every action written the way working
exported shortcuts write it, and signed with `shortcuts sign` on a Mac. It was added and run in
Xcode's iPhone simulator (iOS 27.2) with two sleep entries in Health: every action came in
complete, and it sent what the Pod expects. The same actions, without the home Wi-Fi check
that 3.21 to 3.26 had, have run on a real iPhone against a real Pod. The by-hand version below
has not been run at all.

### Or build it by hand

The same actions, in order:

1. **Text**: `http://sevensleep.local` (or your Pod's address at home).
2. **Find Health Samples** where **Type** is **Sleep** and **Start Date** is in the last 14 days.
3. **Repeat with Each** over the Health Samples. Inside it:
   - **Get Details of Health Sample**: **Start Date** of Repeat Item, then **Format Date** on
     it with **ISO 8601** and **Include ISO 8601 Time** on.
   - The same two actions for **End Date**.
   - **Get Details of Health Sample**: **Value** of Repeat Item.
   - **Text**: the first Formatted Date, `|`, the second Formatted Date, `|`, the Value.
4. After **End Repeat**, **Get Contents of URL**: the Text from step 1 followed by
   `/api/autopilot/sleepTimes`, Method **POST**, Request Body **JSON** with two text fields,
   `source` = `Apple Health` and `samples` = **Repeat Results**.
5. **Get Dictionary Value** for `message` in the Contents of URL, and **Show Notification**
   with it.
8. Under **Otherwise**, a **Show Notification** saying nothing was sent.

## Without a tracker

**Data > Sleep > Manual override** takes the time you fell asleep and the time you woke for
the stay shown. It is filed the way a tracker's record is, under "You", and counts toward the
same 7 nights. A tracker that reports the same night later replaces it.

## AI agents (MCP)

An agent that speaks the Model Context Protocol (Claude Code, Claude Desktop, Cursor and others)
can read and control the bed through the MCP server in the repository's `mcp/` folder. It runs
on your computer and talks to the Pod over your network: four tools that read (status,
schedule, recent sleep, autopilot) and eight that change the bed (temperature, power, alarms,
a night's schedule, the autopilot, away mode). `SEVENSLEEP_READ_ONLY=1` leaves the changing
ones out.
[mcp/README.md](https://github.com/jalen-cheng/sevensleep/blob/main/mcp/README.md) has the
setup. An agent that can make web requests needs none of it: [the API](../server/API.md) is
enough.

## Other trackers, Android and scripts

There is no direct Whoop or Fitbit link: their data is on their servers, and the phone already
has it in Apple Health.

**Android is not supported.** Health Connect has no route built here. Apps that post Health
Connect data to an address exist (HC Webhook, HCGateway), but the bed does not read their
formats.

Any script that sends this request works, from any device:

```bash
curl -X POST http://sevensleep.local/api/autopilot/sleepTimes -H 'Content-Type: application/json' \
  -d '{"source":"Whoop","asleepAt":"2026-11-18T23:12:00-08:00","awakeAt":"2026-11-19T06:48:00-08:00"}'
```

Times have to say their zone (`-08:00`, or `Z`); one without is refused.

## What the bed does with it

**Where a record is kept.** On the Pod, inside the file of the stay in bed it overlaps
(`/persistent/free-sleep-data/autopilot_nights/`, one file a stay; the record is its `tracker`
field: who sent it, when you fell asleep and woke, and any stretches awake between). Nothing
is sent anywhere else. A night split in two by a restart gets it in both halves. A record that
overlaps no saved stay has nowhere to go and is not kept, apart from the last one received,
which **Data > Sleep** shows under "Last record" with whether a stay matched it. That line is
the quickest check that the Shortcut pulled the right night.

Sending the same night again, or a corrected version of it, replaces what was there. Sleeps in
the future, older than 100 days or longer than 18 hours are refused.

**How it is compared.** Minute by minute over the stay. For each minute the record says asleep
or awake, and so does the bed (its saved movement, run through its sleep rules). The share of
minutes on which the two agree is the match shown under "Sleep detection" on Data > Sleep,
and each night's Summary shows the record's own times beside the bed's.

**Fitting.** The bed's own numbers (15 still minutes, 20 moving seconds, breathing not asked
for) are guesses, and a watch or band is the better judge of when you slept. When the tracker's
record says when you were awake in the night, that is used, not only when you fell asleep and
woke: the bed's saved minutes are replayed under each candidate set of numbers and scored on
how many minutes they disagree with the tracker. That is what lets it learn about lying awake
at 3 am. It needs 7 nights. A fitted set is only taken up if, fitted to all the nights but one
and tried on that one, it does at least a tenth better than the default; otherwise the default
stays. **Data > Sleep** shows the result: "Tuned to Apple Health: 94% match over 8 nights", or
"Default, checked against…" while it is not.

Naps are filed but not used for fitting, and sleep stages are not used at all. A wrist tracker
is treated here as the reference. It is not a sleep lab: in comparisons with one, wrist devices
find sleep well and miss some quiet waking (Fitbit Sense and Charge 5: about 93% of sleep and
48% of waking found; no such test of the Fitbit Air was found).
