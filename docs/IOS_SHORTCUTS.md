# Control your Pod from iPhone with Apple Shortcuts

SevenSleep has a local API, so the Shortcuts app can control the bed without opening a browser.
You do not need an Apple developer account. Shortcuts also run from the Home Screen, the Lock
Screen, Control Center, the Action button, Siri, and Automations (for example "when my Sleep Focus
turns on").

## Ready-made Shortcuts

**Most people need none of these to use the bed.** The app does everything, and it installs as
an icon ([Install it as an app](USING.md#install-it-as-an-app)). Away from home, either leave
Tailscale's **VPN On Demand** on, so the one icon works everywhere
([REMOTE_ACCESS.md](REMOTE_ACCESS.md)), or use Open SevenSleep below.

Two Shortcuts do what the app cannot. Open a link on the iPhone, tap the download in Safari,
then **Add Shortcut**; each asks once for what differs from one home to the next.

- **[Send sleep to SevenSleep](https://github.com/jalen-cheng/sevensleep/raw/main/docs/shortcuts/Send%20sleep%20to%20SevenSleep.shortcut)** sends last night's sleep from Apple Health, which a web
  page cannot read. Run it at home; one run sends the last two weeks, so tap it every week or so
  ([Connections](CONNECTIONS.md#link-apple-health)).

  > [!WARNING]
  > **IT NEEDS ONE IPHONE SETTING, OR EVERY RUN SENDS NOTHING:** Settings > Apps > Shortcuts >
  > Advanced > **Allow Sharing Large Amounts of Data**.
- **[Open SevenSleep](https://github.com/jalen-cheng/sevensleep/raw/main/docs/shortcuts/Open%20SevenSleep.shortcut)** opens the app from one icon: straight away on your home Wi-Fi,
  and after connecting Tailscale anywhere else. It asks for your Pod's address at home
  (`http://sevensleep.local`), its address over Tailscale (`http://sevensleep:3000`; over
  Tailscale the port is needed) and your home Wi-Fi's name.

Four more are optional, for Siri and automations. They talk to the Pod at its home address, so
they work on your home network:
[Bed temperature](https://github.com/jalen-cheng/sevensleep/raw/main/docs/shortcuts/Bed%20temperature.shortcut) (asks for -10 to 10),
[Bed alarm](https://github.com/jalen-cheng/sevensleep/raw/main/docs/shortcuts/Bed%20alarm.shortcut) (asks for a time),
[Bed status](https://github.com/jalen-cheng/sevensleep/raw/main/docs/shortcuts/Bed%20status.shortcut) and
[Bed off](https://github.com/jalen-cheng/sevensleep/raw/main/docs/shortcuts/Bed%20off.shortcut).

They are made by `scripts/build_shortcuts.py` and signed with `shortcuts sign` on a Mac. All six
were added and run in Xcode's iPhone simulator (iOS 27.2) against a stand-in for the Pod, with
two exceptions the simulator cannot do. It has no Wi-Fi, so the step that reads the Wi-Fi's name
in the first two was stood in for by hand. And it cannot install Tailscale, so Open SevenSleep's
Tailscale step, which is written from Tailscale's published list of Shortcuts actions, has not
run: if it shows as "Unknown Action" on your phone, delete it and add Tailscale's own
**Connect** in its place. The sections below build the same things by hand.

## Which address to put in a shortcut

Every shortcut below uses `<pod>`. Replace it with one of these, most stable first:

| Use | Works | Keeps working when |
|---|---|---|
| `sevensleep:3000` | Anywhere, while Tailscale is connected on the phone. Over Tailscale the port is needed | The Pod's address, your router or your network changes |
| `sevensleep.local` | At home | The Pod's address or your router changes. Shortcuts run by a Home automation have been reported to fail on `.local` names; if yours does, use one of the others |
| The Pod's home address, for example `192.168.1.50` | At home; anywhere with Tailscale if you set up the one-link route | Only while that address stays the same, so reserve it in the router |

`sevensleep` is the name the installer gives the Pod; run `hostname` on the Pod to check yours. Setting up Tailscale, the
one-link route and a reserved address is in [REMOTE_ACCESS.md](REMOTE_ACCESS.md).

The first run of a shortcut asks for permission to connect to devices on your local network; allow it.

## Open the app: one icon for home and away

A web page cannot tell which Wi-Fi the phone is on or switch a VPN on, but a shortcut can. This
one opens the app directly at home, and away from home offers to connect Tailscale first, so
Tailscale is only on when you ask for it. It needs Tailscale set up as in
[REMOTE_ACCESS.md](REMOTE_ACCESS.md).

1. Open **Shortcuts** and tap **+**.
2. Add **Get Network Details**. Leave it on **Wi-Fi** and **Network Name**.
3. Add **If**. Set it to: **Network Name** **is** the name of your home Wi-Fi.
4. Under **If**, add **Open URLs** with `http://sevensleep.local`.
5. Under **Otherwise**, add **Choose from Menu** with the prompt "Not at home" and two options:
   "Connect Tailscale" and "Cancel".
6. Under "Connect Tailscale", add Tailscale's **Connect** action (search for "Tailscale"), then
   **Wait** 2 seconds, then **Open URLs** with `http://sevensleep:3000`.
7. Name it "Bed", tap the share button and choose **Add to Home Screen**.

To switch Tailscale off again without thinking about it, add an automation: **Automation** >
**+** > **App** > Safari > **Is Closed** > run Tailscale's **Disconnect** action. Or make a
second shortcut with only **Disconnect**.

The steps above were written from the actions Shortcuts and Tailscale provide and have not been
run on a phone.

## 1. Set the temperature (-10 to +10)

Asks for a number on the same scale as Eight Sleep's own app, turns the bed on, and sets it.

1. Open **Shortcuts** and tap **+**.
2. Add **Ask for Input**. Set the type to **Number**, the prompt to "Bed temperature, -10 to 10", and
   switch on **Allow Negative Numbers**.
3. Add **Get Contents of URL** and set the URL to `http://<pod>/api/deviceStatus/dial`.
4. Expand it and set **Method** to `POST` and **Request Body** to `JSON`.
5. Add a **Number** field `dial` and pick **Provided Input** (the answer from step 2) as its value.
6. Name it "Bed temperature".

-10 is coldest, 0 is neutral, +10 is hottest. Halves such as 2.5 work. Anything outside -10 to 10
is refused. The bed stays on for the time set in **Settings > General > Auto-off after**: 3, 6 or 12 hours.

## 2. Set an alarm

Asks for a time and sets a one-time alarm. Your weekly schedule is not changed.

1. Open **Shortcuts** and tap **+**.
2. Add **Ask for Input**. Set the type to **Time** and the prompt to "Alarm time".
3. Add **Get Contents of URL** and set the URL to `http://<pod>/api/alarm/time`.
4. Expand it and set **Method** to `POST` and **Request Body** to `JSON`.
5. Add a **Text** field `time` and pick **Provided Input** (the answer from step 2) as its value.
6. Name it "Bed alarm".

How the time is understood:

- **AM and PM** come from the time picker (or from what you tell Siri, such as "ten AM"). The Pod
  reads the time however the phone writes it: `22:00`, `10:00 PM`, or a full date containing either.
- **The day is worked out for you**: the alarm goes off the next time the clock shows that time. Ask
  for 10 AM at 1 AM and it goes off that same morning. Ask for 6:30 AM at 11 PM and it goes off tomorrow.
- Running it again replaces the alarm you set before.
- The scheduled alarm of that same morning is skipped, whether it is earlier or up to 6 hours
  later, and its warm-up moves to the new time.
- It goes off even if the bed is off. If the bed is on, it stays on for the alarm and turns off 30
  minutes after it.
- The app shows the waiting alarm on the **Temperature** page. Tap its time there to change it or
  go back to the schedule.

## 3. Check the bed

Says what the bed is set to and what it has reached, on the -10 to +10 scale.

1. Open **Shortcuts** and tap **+**.
2. Add **Get Contents of URL** and set the URL to `http://<pod>/api/deviceStatus/dial`.
   Leave the method as `GET`.
3. Add **Get Dictionary Value** and set it to get the value for `summary`.
4. Add **Show Result** (or **Speak Text** for Siri).
5. Name it "Bed status".

It answers with a sentence such as "Both sides set to -2, now at -3" or "Left set to +5, now at +4. Right off."

## More one-step shortcuts

Each is one **Get Contents of URL** action with **Method** `POST` and **Request Body** `JSON`,
built the same way as shortcut 1 but with fixed values instead of a question.

| Shortcut | URL | JSON fields |
|---|---|---|
| Turn the bed off | `http://<pod>/api/deviceStatus` | Dictionary `left` with Boolean `isOn` = false, and the same for `right` |
| Stop a vibrating alarm | `http://<pod>/api/deviceStatus` | Dictionary `left` with Boolean `isAlarmVibrating` = false |
| Next alarm 30 minutes later | `http://<pod>/api/alarm/time` | Number `shiftMinutes` = 30 (negative for earlier) |
| Cancel the one-time alarm | `http://<pod>/api/alarm/time/cancel` | None. The app has no button for this; it also brings back an alarm skipped from the app |
| Change the weekly wake-up time | `http://<pod>/api/alarm/time` | Text `time`, and Array `days` of Text such as `monday`. The bed's off time moves with it |

**A refused request is silent.** These shortcuts do not show the Pod's answer, so when the Pod
refuses a request the shortcut ends without a message and nothing changes. The usual case is
"Change the weekly wake-up time" with a time less than 1 hour or more than 23 hours after that
night's Bed on. To see the reason, add **Get Dictionary Value** for `details` after the request,
then **Show Result**: it reads, for example, "The wake-up time must be 1 to 23 hours after the
bed-on time (left monday)". When the request is accepted there is no `details`, and nothing is shown.

Stopping an alarm on one side stops both when the sides are linked. Everything the app can do is
in [server/API.md](../server/API.md), including whether someone is in bed
(`GET /api/metrics/presence/sensors`, Pod 5).

## One side only

Add a **Text** field `side` with the value `left` or `right` to shortcut 1 or 2. If the sides are
linked in the app, both sides change anyway.

## Troubleshooting

- **The shortcut times out**: check that `http://<pod>` opens in Safari on the same phone. A Pod installed before version 3.2.0 needs `:3000` after the name until it is updated. If
  you used `sevensleep:3000`, check Tailscale is connected.
- **The shortcut runs but nothing changes**: the Pod refused the request. Show `details` as
  described under "A refused request is silent" to read why.
- **"Invalid request data" (HTTP 400)**: a field has the wrong type or value, or a weekly wake-up
  time is under 1 hour or over 23 hours after Bed on. `dial` must be a Number
  field from -10 to 10; `side` and `time` must be Text fields, and `time` must contain a time of day.
- **It stopped working after a while**: if the shortcut uses a number, the Pod's address changed.
  Switch to a name from the table above, or reserve the address in your router.
