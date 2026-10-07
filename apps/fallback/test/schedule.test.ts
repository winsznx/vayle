import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  scheduleAdvice,
  type CloseAhead,
  type KnownWindow,
  type Schedule,
} from "../src/schedule.ts";

const LIVENESS = getAddress("0x00000000000000000000000000000000000000cc");
const MINUTE = 60n;
const HOUR = 3600n;
const WEEK = 7n * 86_400n;
// Fri Oct 9 2026 16:00 EDT, and the Friday closes either side of it.
const CLOSE = 1_791_576_000n;
const PREVIOUS = CLOSE - WEEK;
const NEXT = CLOSE + WEEK;

// The schedule as the market reports it at `now`, with the deployed contracts' constants and a
// keeper that checkpointed a minute ago. A week ends at every close unless a test says otherwise.
function at(
  now: bigint,
  overrides: Partial<Schedule> = {},
  ahead: Partial<CloseAhead> = {},
): Schedule {
  return {
    now,
    liveness: LIVENESS,
    lastSeen: now - MINUTE,
    gapThreshold: 300n,
    lookback: 1800n,
    recency: 300n,
    extensionCap: 86_400n,
    ahead: {
      close: now <= CLOSE ? CLOSE : NEXT,
      windowLength: 7200n,
      gapSeconds: 0n,
      lastClear: 0n,
      pausedSeen: false,
      ...ahead,
    },
    behind: { close: now >= CLOSE ? CLOSE : PREVIOUS, windowLength: 7200n },
    ...overrides,
  };
}

function advise(s: Schedule, known: readonly KnownWindow[] = []) {
  return scheduleAdvice(s, known, "NVDA");
}

const IDLE = "Nothing needs a checkpoint right now, though anyone can send one at any time.";

describe("checkpoints before a close", () => {
  it("aren't needed until the keeper's 45 minutes before it", () => {
    // #when
    const advice = advise(at(CLOSE - 45n * MINUTE - 1n));
    // #then
    assert.deepEqual(advice.checkpoint, [
      `${IDLE} They matter again from Fri, Oct 9, 2026, 15:15 EDT (2026-10-09 19:15 UTC).`,
    ]);
  });

  it("are asked for from 45 minutes before it", () => {
    // #when
    const advice = advise(at(CLOSE - 45n * MINUTE));
    // #then
    assert.deepEqual(advice.checkpoint, [
      "Checkpoint now, and at least every 5 minutes until the close.",
    ]);
  });

  it("start earlier if the market's lookback is longer, keeping the keeper's 15 minutes ahead of it", () => {
    // #given
    const hourLookback = { lookback: HOUR };
    // #when
    const steps = [CLOSE - 75n * MINUTE - 1n, CLOSE - 75n * MINUTE].map(
      (now) => advise(at(now, hourLookback)).checkpoint[0],
    );
    // #then
    assert.deepEqual(steps, [
      `${IDLE} They matter again from Fri, Oct 9, 2026, 14:45 EDT (2026-10-09 18:45 UTC).`,
      "Checkpoint now, and at least every 5 minutes until the close.",
    ]);
  });

  it("can follow quiet time, as long as the first one lands before the half hour", () => {
    // #when
    const advice = advise(at(CLOSE - 40n * MINUTE, { lastSeen: CLOSE - 3n * HOUR }));
    // #then
    assert.deepEqual(advice.checkpoint, [
      "Checkpoint now, and at least every 5 minutes until the close. The quiet time before it is recorded as a gap, which does no harm as long as it lands by Fri, Oct 9, 2026, 15:30 EDT (2026-10-09 19:30 UTC).",
    ]);
  });

  it("come from the observations inside the half hour", () => {
    // #when
    const advice = advise(at(CLOSE - 10n * MINUTE));
    // #then
    assert.deepEqual(advice.checkpoint, [
      "Observing the close is a checkpoint too, so that's the one to send until the close.",
    ]);
  });
});

describe("the close observation", () => {
  it("is open only in the last 30 minutes before the close, as the market takes it", () => {
    // #when
    const open = [CLOSE - 30n * MINUTE - 1n, CLOSE - 30n * MINUTE, CLOSE].map(
      (now) => advise(at(now)).observe.open,
    );
    // #then
    assert.deepEqual(open, [false, true, true]);
  });

  it("says when it opens before then", () => {
    // #when
    const advice = advise(at(CLOSE - HOUR));
    // #then
    assert.deepEqual(advice.observe, {
      open: false,
      refused: false,
      text: "The market takes this from Fri, Oct 9, 2026, 15:30 EDT (2026-10-09 19:30 UTC) until the close. Read again then to send it.",
    });
  });

  it("asks for one in the last 5 minutes when the latest clear one is older", () => {
    // #when
    const advice = advise(at(CLOSE - 10n * MINUTE, {}, { lastClear: CLOSE - 11n * MINUTE }));
    // #then
    assert.deepEqual(advice.observe, {
      open: true,
      refused: false,
      text: "Observe it now, and at least every 5 minutes until the close. The week needs one that finds NVDA's price feed running in the last 5 minutes, from Fri, Oct 9, 2026, 15:55 EDT (2026-10-09 19:55 UTC) on. The last one that did was at Fri, Oct 9, 2026, 15:49 EDT (2026-10-09 19:49 UTC).",
    });
  });

  it("says whether one has counted yet, from exactly 5 minutes before the close as the market does", () => {
    // #when
    const endings = [0n, CLOSE - 5n * MINUTE - 1n, CLOSE - 5n * MINUTE].map((lastClear) => {
      const text = advise(at(CLOSE - 30n, {}, { lastClear })).observe.text;
      return text.slice(text.lastIndexOf(" on. ") + 5);
    });
    // #then
    assert.deepEqual(endings, [
      "Nobody has observed this close yet.",
      "The last one that did was at Fri, Oct 9, 2026, 15:54 EDT (2026-10-09 19:54 UTC).",
      "One did at Fri, Oct 9, 2026, 15:55 EDT (2026-10-09 19:55 UTC).",
    ]);
  });

  it("is refused once quiet time reaches into the half hour, since the next checkpoint records it", () => {
    // #when
    const advice = advise(at(CLOSE - 20n * MINUTE, { lastSeen: CLOSE - 31n * MINUTE }));
    // #then
    assert.deepEqual(advice.observe, {
      open: false,
      refused: true,
      text: "The week that starts at this close can't open, because nobody has checkpointed since Fri, Oct 9, 2026, 15:29 EDT (2026-10-09 19:29 UTC), and that gap reaches into the 30 minutes before it.",
    });
  });

  it("counts quiet time as the contract does: over 5 minutes, and ending inside the half hour", () => {
    // #given
    const schedules = [
      at(CLOSE - 10n * MINUTE, { lastSeen: CLOSE - 15n * MINUTE }),
      at(CLOSE - 10n * MINUTE, { lastSeen: CLOSE - 15n * MINUTE - 1n }),
      // A checkpoint in this very second would end the quiet time right where the half hour starts.
      at(CLOSE - 30n * MINUTE, { lastSeen: CLOSE - 40n * MINUTE }),
    ];
    // #when
    const open = schedules.map((s) => advise(s).observe.open);
    // #then
    assert.deepEqual(open, [true, false, true]);
  });

  it("is refused after an observation saw the feed paused, or a gap was recorded", () => {
    // #when
    const texts = [{ pausedSeen: true }, { gapSeconds: 420n }].map(
      (ahead) => advise(at(CLOSE - 10n * MINUTE, {}, ahead)).observe.text,
    );
    // #then
    assert.deepEqual(texts, [
      "The week that starts at this close can't open, because an observation found NVDA's price feed paused in the 30 minutes before it.",
      "The week that starts at this close can't open, because the chain went more than 5 minutes without a checkpoint in the 30 minutes before it.",
    ]);
  });

  it("leaves checkpoints wanted after a refusal only while a window opens at the close", () => {
    // #when
    const advice = [7200n, null].map(
      (windowLength) =>
        advise(at(CLOSE - 10n * MINUTE, {}, { pausedSeen: true, windowLength })).checkpoint,
    );
    // #then
    assert.deepEqual(advice, [
      ["Checkpoints still keep quiet time out of the exercise window that opens at the close."],
      [IDLE],
    ]);
  });

  it("has nothing to observe once the calendar runs out", () => {
    // #when
    const advice = advise(at(CLOSE - 3n * HOUR, { ahead: null }));
    // #then
    assert.deepEqual(
      [advice.ahead, advice.around, advice.observe],
      [
        "The market's calendar has no close after Fri, Oct 9, 2026, 13:00 EDT (2026-10-09 17:00 UTC).",
        [],
        { open: false, refused: false, text: "There's no close ahead to observe." },
      ],
    );
  });
});

describe("checkpoints after a close", () => {
  it("run through the window and the keeper's half hour after it, 150 minutes in all", () => {
    // #when
    const steps = [CLOSE + HOUR, CLOSE + 150n * MINUTE, CLOSE + 150n * MINUTE + 1n].map(
      (now) => advise(at(now)).checkpoint[0],
    );
    // #then
    assert.deepEqual(steps, [
      "The week that ended at Fri, Oct 9, 2026, 16:00 EDT (2026-10-09 20:00 UTC) is in its exercise window until at least Fri, Oct 9, 2026, 18:00 EDT (2026-10-09 22:00 UTC). Quiet time holds it open, up to 24 hours in total, so checkpoint at least every 5 minutes until Fri, Oct 9, 2026, 18:30 EDT (2026-10-09 22:30 UTC).",
      "The week that ended at Fri, Oct 9, 2026, 16:00 EDT (2026-10-09 20:00 UTC) had its exercise window until at least Fri, Oct 9, 2026, 18:00 EDT (2026-10-09 22:00 UTC). In case quiet time is holding it open, checkpoint at least every 5 minutes until Fri, Oct 9, 2026, 18:30 EDT (2026-10-09 22:30 UTC).",
      `${IDLE} They matter again from Fri, Oct 16, 2026, 15:15 EDT (2026-10-16 19:15 UTC).`,
    ]);
  });

  it("follow the account's own series while its window is held open longer", () => {
    // #given
    const held = [{ opened: CLOSE, end: CLOSE + 5n * HOUR, closed: false }];
    // #when
    const advice = advise(at(CLOSE + 4n * HOUR), held);
    // #then
    assert.deepEqual(advice.checkpoint, [
      "The week that ended at Fri, Oct 9, 2026, 16:00 EDT (2026-10-09 20:00 UTC) is in its exercise window until at least Fri, Oct 9, 2026, 21:00 EDT (2026-10-10 01:00 UTC). Quiet time holds it open, up to 24 hours in total, so checkpoint at least every 5 minutes until Fri, Oct 9, 2026, 21:00 EDT (2026-10-10 01:00 UTC).",
    ]);
  });

  it("stop once the week's window is over for good", () => {
    // #given
    const finalized = [{ opened: CLOSE, end: CLOSE + 2n * HOUR, closed: true }];
    // #when
    const advice = advise(at(CLOSE + 2n * HOUR + 10n * MINUTE), finalized);
    // #then
    assert.equal(advice.checkpoint[0]?.startsWith(IDLE), true);
  });

  it("aren't asked for when no week ended at the close", () => {
    // #when
    const advice = advise(
      at(CLOSE + 10n * MINUTE, { behind: { close: CLOSE, windowLength: null } }),
    );
    // #then
    assert.equal(advice.checkpoint[0]?.startsWith(IDLE), true);
  });
});

describe("the schedule around the close ahead", () => {
  it("is laid out from the market's own numbers, on the keeper's timing", () => {
    // #when
    const advice = advise(at(CLOSE - 3n * HOUR));
    // #then
    assert.deepEqual(
      [advice.ahead, ...advice.around],
      [
        "The next close is Fri, Oct 9, 2026, 16:00 EDT (2026-10-09 20:00 UTC).",
        "From 45 minutes before it until 30 minutes before, checkpoint at least every 5 minutes. After a quiet stretch, the first one has to land by Fri, Oct 9, 2026, 15:30 EDT (2026-10-09 19:30 UTC).",
        "In the last 30 minutes, observe the close at least every 5 minutes, with one in the last 5 minutes. Each observation is a checkpoint too.",
        "For 2 hours 30 minutes after it, checkpoint at least every 5 minutes. That covers the exercise window of the week that ends then, which runs at least 2 hours, longer while the chain is quiet.",
      ],
    );
  });

  it("says when no exercise window opens after the close", () => {
    // #when
    const advice = advise(at(CLOSE - 3n * HOUR, {}, { windowLength: null }));
    // #then
    assert.equal(
      advice.around[2],
      "No week ends at this close, so no exercise window opens after it.",
    );
  });

  it("explains why the calls exist with the market's numbers", () => {
    // #when
    const advice = advise(at(CLOSE - 3n * HOUR));
    // #then
    assert.equal(
      advice.why,
      "A week opens at a close only if the chain was checkpointed, with no gap longer than 5 minutes, through the 30 minutes before it, and an observation in its last 5 minutes found NVDA's price feed running. Vayle's keeper makes these calls and keeps checkpointing through each exercise window, and when it's down anyone can make them here.",
    );
  });
});

describe("the last checkpoint", () => {
  it("gives the time the next one has to land by while checkpoints matter", () => {
    // #when
    const advice = advise(at(CLOSE - 40n * MINUTE, { lastSeen: CLOSE - 41n * MINUTE }));
    // #then
    assert.equal(
      advice.lastCheckpoint,
      "The last checkpoint landed at Fri, Oct 9, 2026, 15:19 EDT (2026-10-09 19:19 UTC). The next one has to land by Fri, Oct 9, 2026, 15:24 EDT (2026-10-09 19:24 UTC), or the quiet time is recorded as a gap.",
    );
  });

  it("warns that the next one records a gap once the chain has gone quiet", () => {
    // #when
    const advice = advise(at(CLOSE - 40n * MINUTE, { lastSeen: CLOSE - 3n * HOUR }));
    // #then
    assert.equal(
      advice.lastCheckpoint,
      "The last checkpoint landed at Fri, Oct 9, 2026, 13:00 EDT (2026-10-09 17:00 UTC). That's more than 5 minutes ago, so the next one records the quiet time as a gap.",
    );
  });

  it("is just a time when nothing needs one", () => {
    // #when
    const advice = advise(at(CLOSE - 2n * 86_400n, { lastSeen: CLOSE - 3n * 86_400n }));
    // #then
    assert.equal(
      advice.lastCheckpoint,
      "The last checkpoint landed at Tue, Oct 6, 2026, 16:00 EDT (2026-10-06 20:00 UTC).",
    );
  });
});
