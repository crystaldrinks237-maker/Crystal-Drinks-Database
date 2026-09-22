# Auto-starting Crystal Drinks when your laptop boots

This makes the server start by itself whenever the laptop turns on / you log
in, so you never have to open a terminal and type `npm start` again. Pick the
section for your operating system.

In all cases: you can check it's running by opening `http://localhost:3000` in
a browser a minute or two after starting up.

---

## Windows

**Easiest option — Startup folder shortcut:**
1. Press `Win + R`, type `shell:startup`, press Enter. This opens your Startup folder.
2. Right-click inside that folder → New → Shortcut.
3. Browse to and select `scripts/start-windows-silent.vbs` inside your
   `crystal-drinks` folder.
4. Finish. From now on, Windows will silently start the server (no visible
   black window) every time you log in.

To stop it: open Task Manager, find `node.exe`, and End Task. To temporarily
disable auto-start, delete the shortcut from the Startup folder.

**Alternative — Task Scheduler** (gives you more control, e.g. delayed start):
1. Open Task Scheduler → Create Basic Task.
2. Trigger: "When I log on".
3. Action: "Start a program" → Browse to `scripts\start-windows.bat` inside
   your `crystal-drinks` folder.
4. Finish. (Check "Run whether user is logged on or not" in the task's
   Properties if you want it to run even before login, though this needs your
   Windows password saved in the task.)

---

## Mac

1. Open `scripts/com.crystaldrinks.server.plist` in a text editor.
2. Find your Node.js install path by running `which node` in Terminal
   (usually `/usr/local/bin/node` or `/opt/homebrew/bin/node`), and replace
   `/usr/local/bin/node` in the file with that.
3. Replace both instances of `/REPLACE/WITH/FULL/PATH/TO/crystal-drinks` with
   the actual full path to your project folder, e.g.
   `/Users/yourname/Desktop/crystal-drinks`.
4. Copy the file into your LaunchAgents folder and load it:
   ```
   cp scripts/com.crystaldrinks.server.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.crystaldrinks.server.plist
   ```
5. It will now start automatically at every login, and restart itself if it
   ever crashes.

To stop it permanently:
```
launchctl unload ~/Library/LaunchAgents/com.crystaldrinks.server.plist
rm ~/Library/LaunchAgents/com.crystaldrinks.server.plist
```

---

## Linux (systemd)

1. Open `scripts/crystal-drinks.service` in a text editor and replace both
   `/REPLACE/WITH/FULL/PATH/TO/crystal-drinks` placeholders with the actual
   full path to your project folder.
2. Run:
   ```
   mkdir -p ~/.config/systemd/user
   cp scripts/crystal-drinks.service ~/.config/systemd/user/
   systemctl --user enable --now crystal-drinks.service
   ```
3. It will now start at login and restart itself automatically if it crashes.
   To also have it start even before anyone logs in, additionally run:
   ```
   sudo loginctl enable-linger $USER
   ```

To check status or logs:
```
systemctl --user status crystal-drinks.service
journalctl --user -u crystal-drinks.service -f
```

To stop it permanently:
```
systemctl --user disable --now crystal-drinks.service
```
