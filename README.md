# Lifescale HQ

A menu bar app for Lucas and Seva. Click the icon at the top of your Mac's screen to see:

- **Team**: who's online, what they're working on today, if they're in flow (live timer), what they're listening to, their local time.
- **Me**: your flow timer, today's focus, wins counter, and "what did you get done" notes.
- **Board**: this month's leaderboard and last month's Employee of the Month.

Every day the first time you open it, it asks: *what are you working on today?*

## Scoring

| What | Points |
| --- | --- |
| Each minute of flow | 1 |
| Each win logged | 25 |
| Each full day (checked in and wrote what you did) | 15 |

The flow timer stops itself after 10 minutes with no keyboard or mouse input, and if your Mac sleeps or the app is closed. You can't win by leaving it running. Change the numbers in `src/config.js`.

## One-time setup (Supabase)

1. Supabase → **SQL Editor** → New query → paste all of `supabase/schema.sql` → **Run**.
2. Supabase → **Authentication → Sign In / Providers → Email**: turn **off** "Confirm email" (easiest), or leave it on and click the link Supabase emails you.
3. Once you've both made accounts: **Authentication → Sign In / Providers**, turn **off** "Allow new users to sign up". Then nobody else can get in.

## Install

1. Go to the **Releases** page of this repo and download the `.dmg`.
2. Open it and drag **Lifescale HQ** into Applications.
3. Open it. macOS will say it can't be opened because it's from an unidentified developer. Fix:
   - **System Settings → Privacy & Security**, scroll down, click **Open Anyway**.
   - If it says the app is "damaged", run this once in Terminal instead:
     `xattr -cr "/Applications/Lifescale HQ.app"`
4. The first time music is detected, macOS asks to let it control Spotify / Music. Click **OK** (it only reads what's playing).

Optional: System Settings → General → **Login Items** → add Lifescale HQ so it starts with your Mac.

## Shipping a new version

Every push to `main` makes GitHub build the Mac app (Apple Silicon + Intel) and put it on the Releases page under the version in `src-tauri/tauri.conf.json`. Bump that version (and `package.json`) when you want a new release instead of replacing the current one. You can also run the **Build Mac app** workflow by hand from the Actions tab.

## Developing locally

```
npm install
npm run tauri dev
```

Needs Rust (`curl https://sh.rustup.rs -sSf | sh`) and Node 20+.
