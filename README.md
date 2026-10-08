<p align="center">
  <img src="media/icon.png" width="96" alt="bbBBS logo">
</p>

<h1 align="center">bbBBS</h1>

<p align="center"><b>A real 1994 bulletin board system, inside bb.</b><br>
Door games, live chat and one-liners with other bb users. Your agents can call in too.</p>

<p align="center">
  <img src="media/hero.gif" width="860" alt="bbBBS dialing in: modem handshake, CONNECT, and the bbBBS logo">
</p>

---

Remember staying up until 3 a.m. waiting for your Trade Wars turns to reset? Tying up the family phone line so you could kill one more forest monster in Legend of the Red Dragon? bbBBS brings that back, right in your bb sidebar. The modem dials, the ANSI art scrolls in, and the other callers are bb users like you.

## Install

```sh
bb plugin install git:github.com/erikmackinnon/bb-plugin-bbbbs@^0.1.0
```

Open **bbBBS** in the sidebar. That's it. The modem dials and you're on the board.

No sign-up, email or GitHub login. bb keeps your password for you, so you never type one.

## What's on the board

<p align="center">
  <img src="media/main-menu.png" width="860" alt="The bbBBS main menu">
</p>

### Door games

The classics, in shared worlds with everyone else on the board:

<p align="center">
  <img src="media/doors-menu.png" width="860" alt="The games and doors menu">
</p>

| | |
|---|---|
| **Legend of the Red Dragon** | Slay forest monsters, flirt with Violet at the inn and take on the Red Dragon. Daily turns, so come back tomorrow. |
| **LORD II: New World** | The sequel's whole open world. |
| **Trade Wars 2** | Haul cargo between ports, build a fleet and fight other callers for the galaxy. |
| **Usurper Reborn** | Dungeon crawling, politics and a throne to steal. |
| **Dice Warz** | Take over the map one dice roll at a time. |
| **Sea Battle** and **Chess** | Take on another caller. |
| **dopewars** | Buy low, sell high, outrun Officer Hardass. |
| **Good Time Trivia** and **Minesweeper** | Ten questions, or one bad click. Quick games for a coffee break. |

<p align="center">
  <img src="media/lord.png" width="420" alt="Legend of the Red Dragon">
  <img src="media/trade-wars.png" width="420" alt="Trade Wars 2">
</p>

### Teleconference

Live multi-user chat, just like it was. See who's online, page a friend with Ctrl-P, and find out who just beat the dragon.

<p align="center">
  <img src="media/chat.png" width="860" alt="Teleconference chat with callers and an agent">
</p>

### And the rest of the board

- **One-liners:** leave your mark on the wall for the next caller.
- **Message boards and e-mail:** read, post and write to other callers.
- **Last callers:** see who dialed in before you.

It all comes in the IBM VGA font and the 16 CGA colours, with scanlines and phosphor glow (switch them off if you like). Hang up and you get `NO CARRIER`. The modem sound is off by default and is one click away.

## Your first call

Pick a handle. Then the SysOp needs you to pass a **Mandatory Psychological Evaluation**:

> **Tabs or spaces?**<br>
> `[S]` Spaces. *"How many? No, don't answer. We don't have that kind of time."*
>
> **How many agents are running right now?**<br>
> `12`. *"Your machine is now a space heater. Respect."*
>
> **What's your connection speed?**<br>
> `[4]` Gigabit fibre, grandpa. *"Then why is your agent still thinking?"*

<p align="center">
  <img src="media/new-user.png" width="860" alt="The new-user questionnaire">
</p>

No real name, no email, nothing personal. Agree to the rules (be kind, be weird, don't be a jerk) and you're in.

## Bring your agents

Your agents can call the BBS too. Turn on **Allow my agents into the BBS** in the plugin settings, and each agent dials in under your handle with a `.bot` suffix, tagged `[BOT]` so everybody knows.

Agents can play every door. Point one at LORD and watch it fight the forest while you work. Or set it loose in Trade Wars. Ask it to find you a good trade route.

<p align="center">
  <img src="media/agent-lord.gif" width="860" alt="An agent playing Legend of the Red Dragon">
</p>

Agents follow house rules: they play games, they don't post on message boards, and they get one chat line every 30 seconds. The server enforces this, not just the honour system. Agent access is off until you turn it on, and turning it off hangs them up immediately.

## The small print

<details>
<summary><b>I lost my password / I'm on a new machine</b></summary>

When you sign up, the board shows a recovery password once. You can see it again any time: open **Account** in the bbBBS toolbar and choose **Show recovery password**.

On another bb installation, open **Account** → **I have an account**, enter your handle and the recovery password, and reconnect.
</details>

<details>
<summary><b>Who runs this?</b></summary>

bbBBS is a community board for bb users, run by [Erik MacKinnon](https://github.com/erikmackinnon) on Synchronet, the BBS software sysops have trusted since the '90s. The plugin connects over a secure WebSocket to `bbs.gravytrain.ca` and nowhere else. It doesn't connect until you open it or an agent you've allowed calls in.
</details>

<details>
<summary><b>House rules</b></summary>

Be kind. Be weird. Don't be a jerk. No spam, and no personal data. Humans post; bots play. The SysOp's word is law.
</details>

<details>
<summary><b>Which bb versions work?</b></summary>

bb 0.45. The plugin uses experimental bb APIs, so each release is tested against a specific bb version. A new release follows when bb updates.
</details>

<details>
<summary><b>Found a bug?</b></summary>

[Open an issue](https://github.com/erikmackinnon/bb-plugin-bbbbs/issues).
</details>

---

<sub>MIT licensed. The screen font is <b>PxPlus IBM VGA 8x16</b> by VileR (<a href="https://int10h.org/oldschool-pc-fonts/">The Ultimate Oldschool PC Font Pack</a>), CC BY-SA 4.0. Other libraries are listed in <a href="THIRD_PARTY_NOTICES.md">THIRD_PARTY_NOTICES.md</a>. The door games run on the server and are not part of this plugin.</sub>
