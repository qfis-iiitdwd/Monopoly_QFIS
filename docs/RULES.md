# MarketVerse — Rules for Teams

*(Publish before Round 1. Numbers below match the default settings in `config/game.json`; update them if you change the settings.)*

## The basics
- Every team starts with **₹1,00,00,000** in virtual cash, no shares and no debt. The money is fictional.
- All five members share **one team portfolio**. Any member can trade; each trade shows who placed it.
- There are **10 rounds** and **20 fictional companies**. The team with the highest **net worth** after Round 10 wins.

**Net worth = cash + (shares × official price) − loan principal − interest owed.**

## Each round
1. The newspaper is sent to your team on WhatsApp. Most stories are jokes; a few contain real clues. Some clues pay off
   rounds later.
2. **Trading is open for 5 minutes.** The countdown follows the server's clock, not your phone's.
   Orders that arrive after the deadline are rejected.
3. Trading closes and the news segment plays.
4. New prices are calculated, and every portfolio updates on screen.

## Trading
- **Buy** or **sell** whole shares. Doing nothing means you **hold**; you never need to submit a hold.
- Orders execute **immediately and in full** at the **round's official price** (the price set at the
  end of the previous round), or they're rejected with a reason. There are no partial fills.
- Prices **don't change during the trading window**, so placing your order first doesn't get you a better price.
- **Fee:** 0.10% of the order value, on buys and sells.
- Each company has a **maximum order size** and a limited number of shares **on the exchange**. If
  everyone rushes one stock, it can sell out. That part *is* first come, first served.
- No short selling, no fractional shares, no limit orders.
- Your order isn't done until the app says **Executed ✓**. If your connection drops, check the
  History tab. A retried order can never execute twice.

## How prices move
After trading closes, each price changes by:
- **news events** (the clues in the newspaper),
- **trading pressure**: if teams bought more of a stock than they sold this round, its price is pushed
  up, by at most 8%. Heavy net selling pushes it down the same way.

Event effects are fixed **before** the game starts. Organisers only change one to correct a typing
mistake in the plan, and every such correction is logged.

## Rankings and ties
Teams don't see a live leaderboard. Organisers track rankings and announce results on the big
screen at their discretion. Ties are broken by: (1) lower debt, (2) more cash, (3) higher realised trading profit. If
teams are still tied, the result is a tie.

## Margin Bank *(off by default; applies only if organisers announce it)*
- Borrow up to **50%** of the value of shares you **pledge**. Maximum ₹50,00,000 per team.
- Interest: **2% of the loan per round** (simple interest).
- New loans are available only during trading, up to **Round 6**. Repay in full by **Round 8**.
- Pledged shares still count toward your net worth, but you can't sell them until the loan is repaid.
- **If you don't repay in time,** the bank sells your pledged shares at the official price at Round 8's
  update to cover the debt. Any shortfall stays on your books as a liability.

## Quests and quizzes
Rewards are small, capped (₹2,00,000 max each), and paid once per team per quest. They're recorded
like every other transaction.

## Fair play
- Use only your own team's login. Don't share your password.
- Organisers will **pause** trading if something goes wrong. When trading resumes, every team gets the same extension.
- Trades count only if the app shows them as executed. Verbal or unofficial trades are not accepted.
- If you make a genuine mistake (for example 1000 instead of 100), tell an organiser **during that round**.
  They may reverse the trade exactly, fee included, if your team still holds those shares or that cash.
  Reversals are shown in your History with the reason. Teams may not coordinate their trading to move prices.
