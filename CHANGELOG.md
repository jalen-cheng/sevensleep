# Changelog

What changed in each version of SevenSleep, newest first. Patches are listed under their
version. Anything older is in the [git history](https://github.com/jalen-cheng/sevensleep/commits/main).

## 3.25
- Docs: SevenSleep compared with Free Sleep, with how to switch and how to go back.
- The in-bed alarm counts hours from falling asleep, not from getting into bed, and is named "Alarm after a long sleep".
- A wake time moved later during the night keeps the bed on for it, and a cancelled one-time alarm gives the night its own wake time back.
- Fixes from a review of everything since 3.20: the firmware timer on the night the clocks change, a press inside a dialog turning the bed on, and a more careful boot-slot check.
- The MCP server (1.0.2) sends a change to both sides when they are linked, and takes whole degrees.

### 3.25.1
- The internet block refuses blocked IPv6 connections at once instead of leaving them to time out, so `sevensleep.local` no longer hangs on a device that tries the Pod's public IPv6 address or `https://` first.

## 3.24
- How to help with the autopilot, and a call for anyone with a Pod 6.
- The docs site has one menu on a phone.
- The hardware watchdog checks that systemd holds the device before it is kept.
- Minor UI changes: the plain 7 is the icon again, and the logo is centred.

### 3.24.1
- Send sleep to SevenSleep sends the last two weeks in one run, so it is tapped now and then and needs no daily automation.

### 3.24.2
- Minor UI changes: the Temperature dial is framed by an outline with no grey fill, and a press anywhere beside the navigation turns an off side on.

### 3.24.3
- An MCP server in `mcp/` gives AI agents twelve tools for the bed. It runs on your computer, so the Pod needs no update for it.
- The installer confirms the running boot slot, so the hub does not fall back to its stock slot after a few boots; the install guide checks it first and says to block the Pod at the router too.

### 3.24.4
- Docs: how to read the hub's flash wear, what happens as it runs out, and how little SevenSleep writes.
- A night the autopilot is steering runs to a one-time alarm set for it. It used to end at the scheduled alarm the one-time alarm replaced, and the bed went back to the schedule's temperature while the sleeper slept on.

## 3.23
- Wi-Fi and hardware watchdogs for the Pod, off until switched on.
- The SevenSleep lettering is the logo in the app and on the docs site.

## 3.22
- The autopilot acts on the room once it has moved 2°F, by half as much.
- A scheduled night asks the firmware for its own length, so the bed turns itself off if the server stops.
- Fewer writes to the Pod's flash.

## 3.21
- The Temperature page says what the autopilot is doing and links to its settings.
- The README lists the autopilot's limits.

## 3.20
- While you sleep, the autopilot supersedes the schedule's temperature changes.
- Naps and short lie-downs are not backdated.
- Calibrate with a sleep tracker: 7 nights, and the last record received is shown.
- Ready-made Shortcuts cut from fourteen to six.

### 3.20.1
- A sleeper who stirred is asleep again after 5 calm minutes, not 15 still ones.

### 3.20.2
- Biometrics is named Biometrics (legacy).
- Install guide fixes after a stranger's read of it, including the way back to Eight Sleep.
- Minor UI changes.

## 3.19
- The autopilot can be given a base temperature.
- Flowcharts of the whole system and of left and right.

## 3.18
- A body is told from a thing left on the bed.
- Sleep and wake times can be set by hand.
