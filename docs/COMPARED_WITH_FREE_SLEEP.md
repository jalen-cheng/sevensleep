# SevenSleep compared with Free Sleep

SevenSleep is built on [Free Sleep](https://github.com/throwaway31265/free-sleep) 3.0.3 by
throwaway31265, its latest version, and keeps everything it does. These are the notes for
someone running Free Sleep: what switching adds, what to know first, and how to switch or go back.

Switching takes a few minutes over SSH with the hub closed, keeps your settings and schedules,
and is undone with one command.

## Added

- **Pod 5 side buttons work.** Change the temperature, switch a side on or off, stop an alarm.
- **In-bed detection (Pod 5).** The bed knows when you are in it and can turn on as you get in.
- **Autopilot (Pod 5, experimental).** Cooler early in the night, warmer toward morning, learning
  from the changes you make.
- **A record of each night (Pod 5).** Sleep and wake times, wake-ups and movement, which can be
  checked against a watch through Apple Health.
- **Remote access.** Optional Tailscale on the Pod, with the internet block still on.
- **An MCP server for AI agents,** and short requests for iPhone Shortcuts.
- **Updates from the app,** with the old version put back if one fails.

## Improved

- **Alarms** keep going until dismissed, ramp up, and can warm the bed first. A one-time alarm
  goes off even if the bed is off.
- **Temperatures** show what the bed actually aims for, beside what it measures.
- **Both sides can be linked** and controlled as one.
- **The app** is redesigned for a phone, installs to the Home Screen, and opens at
  `http://sevensleep.local`.
- **The internet block** no longer stops the clock syncing, and is restored at every boot.
- **The install** confirms the hub's boot slot, so it does not fall back to stock firmware after
  a few boots.
- **Documentation:** every request in the API, a full install guide, and how each part works.

## Changed

- **The bed turns off 30 minutes after your wake-up time.** There is no separate off time.
- **Daily priming is on by default,** at 2 PM. It can be switched off.
- **Biometrics is named "Biometrics (legacy)".** It is the original's, unchanged.

## Not there yet

- **It has run on one Pod 5.** Pod 3 and Pod 4 use the original's hardware code and are waiting
  for a first report.
- **Switching from Free Sleep, and going back, have not been reported by anyone yet.** Take the
  copy of your settings below first.
- **The sleep record has no stages, heart rate or HRV,** and the autopilot's evidence is one
  sleeper.
- **It is one person's project and changes often.** Support is through
  [GitHub issues](https://github.com/jalen-cheng/sevensleep/issues).

## Switching

Over SSH (`ssh root@<pod-ip> -p 8822`). Keep a copy of your settings first:

```
cp -r /persistent/free-sleep-data/lowdb /persistent/free-sleep-data/lowdb.before-switch
```

Then lift the internet block, run the installer, and block again:

```
sh /home/dac/free-sleep/scripts/unblock_internet_access.sh
```

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/jalen-cheng/sevensleep/main/scripts/install.sh)"
```

```
sh /home/dac/free-sleep/scripts/block_internet_access.sh
```

It ends with `Installation complete!`. Open `http://<pod-ip>:3000`; the Status page shows the
version. On a Pod 3 or 4, read
[what changes](POD_MODELS.md#things-to-know-before-updating-from-the-original) first.

## Going back to Free Sleep

Lift the block, update from the original project, and block again:

```
sh /home/dac/free-sleep/scripts/unblock_internet_access.sh
```

```
FREE_SLEEP_REPO=throwaway31265/free-sleep sh /home/dac/free-sleep/scripts/update.sh
```

```
sh /home/dac/free-sleep/scripts/block_internet_access.sh
```

Later updates then come from Free Sleep too. Your settings and schedules stay; the ones only
SevenSleep uses are left in the file and ignored. If you switched on a watchdog or Tailscale,
remove them first with `setup_watchdog.sh remove` and `setup_tailscale.sh remove`.

If Free Sleep does not start, put your copy back and restart:

```
cp -r /persistent/free-sleep-data/lowdb.before-switch/. /persistent/free-sleep-data/lowdb/
```

```
systemctl restart free-sleep
```

Going back to Eight Sleep's own software is in
[the install guide](../INSTALLATION.md#going-back-to-eight-sleep).

If you make the switch, either way, please
[say how it went](https://github.com/jalen-cheng/sevensleep/issues).
